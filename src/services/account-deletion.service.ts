/**
 * @file A customer's request to delete their account. The request opens a
 * row due `ACCOUNT_DELETION_DAYS` later and audits it in one transaction;
 * after commit, and only for a new request, it mails the customer a receipt
 * and alerts every platform admin. A second request returns the open one and
 * sends nothing. Staff complete the request by deleting the account.
 */
import { getEnv } from '@/configs/env.config'
import type { AccountDeletionRequest } from '@/database/models/account-deletion-request.model'
import { HttpError } from '@/errors/http-error'
import { addEmailJob } from '@/jobs/email.job'
import { addNotificationJob } from '@/jobs/notification.job'
import { accountDeletionRequestRepository } from '@/repositories/account-deletion-request.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
import { appNameFor, MISSING_FIRST_NAME_FALLBACK } from '@/services/frontend-links.service'
import { logger } from '@/services/logger.service'
import {
  ACCOUNT_DELETION_ALERT_TEMPLATE_KEY,
  accountDeletionAlertSummary,
} from '@/templates/email/account-deletion-alert.template'
import { ACCOUNT_DELETION_REQUESTED_TEMPLATE_KEY } from '@/templates/email/account-deletion-requested.template'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { supportAddress } from '@/utilities/email-sender.utilities'

const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()

/**
 * The in-app title of the staff alert, also the alert mail's subject.
 */
const ALERT_TITLE = 'Account deletion requested'

/**
 * Open a deletion request for the signed-in customer, or return the one
 * already open. The transaction locks the user row `FOR NO KEY UPDATE`, so a
 * staff deletion running at the same time waits for the request, then
 * completes it; two requests at once serialize, and the second finds the
 * first. A new request is audited in that transaction (the reason is not:
 * a customer's own words may name them). The receipt and the staff alerts
 * are queued after commit, each failure logged and skipped: the request is
 * already recorded.
 * @param userId - The customer.
 * @param reason - Why they are leaving, or null.
 * @returns The open request, and whether this call created it.
 * @throws {HttpError} 401 when the account was deleted or deactivated meanwhile.
 */
export async function requestAccountDeletion(
  userId: string,
  reason: string | null
): Promise<{ request: AccountDeletionRequest; created: boolean }> {
  const days = getEnv().ACCOUNT_DELETION_DAYS
  const outcome = await withTransaction(async (tx) => {
    const user = await userRepository.lockById(userId, 'no key update', tx)
    if (!user?.active) throw new HttpError('Sign in to continue.', 401)
    const inserted = await accountDeletionRequestRepository.insertOpen(userId, reason, days, tx)
    if (!inserted) {
      const open = await accountDeletionRequestRepository.findOpen(userId, tx)
      if (!open) throw new Error('No open deletion request after the insert was refused')
      return { request: open, created: false, user }
    }
    const platform = await tenantRepository.findPlatformTenant(tx)
    if (!platform) throw new Error('The platform tenant is missing')
    await record(
      {
        action: 'user.account_deletion_requested',
        actor: { userId },
        access: 'member',
        tenantId: platform.id,
        targetId: userId,
        metadata: { requestId: inserted.id },
      },
      tx
    )
    return { request: inserted, created: true, user }
  })
  if (outcome.created) {
    await mailReceipt(outcome.user, outcome.request)
    await alertAdmins(outcome.request)
  }
  return { request: outcome.request, created: outcome.created }
}

/**
 * The signed-in customer's open request.
 * @param userId - The customer.
 * @returns The request, or undefined when none is open.
 */
export async function findOpenDeletionRequest(
  userId: string
): Promise<AccountDeletionRequest | undefined> {
  return accountDeletionRequestRepository.findOpen(userId)
}

/**
 * Queue the customer's receipt on the normal email queue, so a full
 * maintenance holds it with the rest of customer mail. A failure is logged.
 * @param user - The customer, as the request's transaction read them.
 * @param user.id - Their id.
 * @param user.email - Their address.
 * @param user.firstName - Their first name, if any.
 * @param request - The new request.
 */
async function mailReceipt(
  user: { id: string; email: string; firstName: string | null },
  request: AccountDeletionRequest
): Promise<void> {
  const env = getEnv()
  try {
    await addEmailJob(
      {
        to: user.email.toLowerCase(),
        templateKey: ACCOUNT_DELETION_REQUESTED_TEMPLATE_KEY,
        variables: {
          firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
          appName: appNameFor('web', env),
          dueAt: formatUtcDateTime(request.dueAt),
          supportEmail: supportAddress(env),
        },
      },
      user.id
    )
  } catch (error) {
    logger.error('An account deletion receipt could not be queued', {
      error,
      requestId: request.id,
    })
  }
}

/**
 * Queue one staff-only notification, with its email, for every live, active
 * platform admin. A failed lookup or enqueue is logged and skipped.
 * @param request - The new request.
 */
async function alertAdmins(request: AccountDeletionRequest): Promise<void> {
  try {
    const recipients = await accountDeletionRequestRepository.listAccountDeletionRecipients()
    const dueAt = formatUtcDateTime(request.dueAt)
    const appName = appNameFor('apex')
    for (const recipient of recipients) {
      try {
        await addNotificationJob({
          userId: recipient.id,
          type: 'account_deletion_requested',
          title: ALERT_TITLE,
          body: accountDeletionAlertSummary(dueAt),
          metadata: {
            templateKey: ACCOUNT_DELETION_ALERT_TEMPLATE_KEY,
            requestId: request.id,
            userId: request.userId,
          },
          email: {
            to: recipient.email,
            templateKey: ACCOUNT_DELETION_ALERT_TEMPLATE_KEY,
            variables: {
              firstName: recipient.firstName ?? MISSING_FIRST_NAME_FALLBACK,
              appName,
              dueAt,
            },
          },
        })
      } catch (error) {
        logger.error('An account deletion alert could not be queued', {
          error,
          recipientId: recipient.id,
          requestId: request.id,
        })
      }
    }
  } catch (error) {
    logger.error('Account deletion alerts could not be queued after the request committed', {
      error,
      requestId: request.id,
    })
  }
}
