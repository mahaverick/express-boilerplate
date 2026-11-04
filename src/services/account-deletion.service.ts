/**
 * @file A customer's request to delete their account. The request opens a
 * row due `ACCOUNT_DELETION_DAYS` later and audits it in one transaction;
 * after commit, and only for a new request, it mails the customer a receipt
 * and alerts every platform owner and admin. A second request returns the open one and
 * sends nothing. Staff complete the request by deleting the account
 * (`deleteUser`, platform-user.service.ts), which mails the customer a
 * confirmation (`mailAccountDeleted`). A daily run alerts the staff again,
 * once per request, when one falls due within five days
 * (`alertDueSoonDeletions`).
 */
import { getEnv } from '@/configs/env.config'
import type { AccountDeletionRequest } from '@/database/models/account-deletion-request.model'
import { HttpError } from '@/errors/http-error'
import { addEmailJob } from '@/jobs/email.job'
import { addNotificationJob } from '@/jobs/notification.job'
import { accountDeletionRequestRepository } from '@/repositories/account-deletion-request.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
import { appNameFor, MISSING_FIRST_NAME_FALLBACK } from '@/services/frontend-links.service'
import { logger } from '@/services/logger.service'
import { claimCooldown, releaseCooldown } from '@/services/mail-cooldown.service'
import type { MailMessage } from '@/services/mailer.service'
import { ACCOUNT_DELETED_TEMPLATE_KEY } from '@/templates/email/account-deleted.template'
import {
  ACCOUNT_DELETION_ALERT_TEMPLATE_KEY,
  accountDeletionAlertSummary,
} from '@/templates/email/account-deletion-alert.template'
import {
  ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY,
  ACCOUNT_DELETION_DUE_SOON_TITLE,
  accountDeletionDueSoonSummary,
  type AccountDeletionDueSoonVariables,
  type AccountDeletionDueState,
} from '@/templates/email/account-deletion-due-soon.template'
import { ACCOUNT_DELETION_REQUESTED_TEMPLATE_KEY } from '@/templates/email/account-deletion-requested.template'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { supportAddress } from '@/utilities/email-sender.utilities'
import type { ListPage } from '@/utilities/list-page.utilities'
import type { PlatformDeletionRequestListQuery } from '@/validators/platform.validators'

const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * The in-app title of the staff alert, also the alert mail's subject.
 */
const ALERT_TITLE = 'Account deletion requested'

/**
 * How close to its due date an open request must be for the due-soon alert.
 */
const DUE_SOON_WINDOW_MS = 5 * 86_400_000

/**
 * How long the due-soon dedupe key outlives the request's due date. A
 * request is alerted at most 5 days before it is due, so a key that lasts
 * until 30 days after `due_at` covers the whole window; an open request
 * still overdue past that is alerted once more.
 */
const DUE_SOON_KEY_MARGIN_MS = 30 * 86_400_000

/**
 * The dedupe key's scope: `redisKey('account-deletion-due-soon', requestId)`.
 */
const DUE_SOON_SCOPE = 'account-deletion-due-soon'

/**
 * One kind of staff alert: the in-app title and body, and the mail's
 * template, which renders the same summary from the same due date.
 */
interface StaffAlert {
  title: string
  summary: (dueAt: string, dueState: AccountDeletionDueState) => string
  templateKey:
    | typeof ACCOUNT_DELETION_ALERT_TEMPLATE_KEY
    | typeof ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY
  /**
   * The mail for one recipient, built from what every alert knows.
   */
  mail: (to: string, variables: AccountDeletionDueSoonVariables) => MailMessage
}

/**
 * The alert for a new request. A new request is never overdue, so its
 * template takes no `dueState`.
 */
const REQUESTED_ALERT: StaffAlert = {
  title: ALERT_TITLE,
  summary: accountDeletionAlertSummary,
  templateKey: ACCOUNT_DELETION_ALERT_TEMPLATE_KEY,
  mail: (to, { firstName, appName, dueAt }) => ({
    to,
    templateKey: ACCOUNT_DELETION_ALERT_TEMPLATE_KEY,
    variables: { firstName, appName, dueAt },
  }),
}

/**
 * The alert for an open request due within five days, or overdue.
 */
const DUE_SOON_ALERT: StaffAlert = {
  title: ACCOUNT_DELETION_DUE_SOON_TITLE,
  summary: accountDeletionDueSoonSummary,
  templateKey: ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY,
  mail: (to, variables) => ({ to, templateKey: ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY, variables }),
}

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
    await alertStaff(outcome.request, REQUESTED_ALERT, new Date())
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
 * Alert the platform owners and admins, once per request, about every open request due
 * within five days of `now`, overdue ones included. Each request is claimed
 * first under `redisKey('account-deletion-due-soon', requestId)`, `SET NX`
 * with a TTL lasting until 30 days past its `due_at` (`claimCooldown`), so a
 * later run skips it for as long as it can still be in the window. When no
 * alert of a request could be queued the key is released, so the next run
 * tries again; when Redis cannot be reached the request is skipped until
 * then. Under full maintenance the run's queue is paused, and so is the
 * notification queue its alerts wait on.
 * @param now - The run's clock: the scheduled job passes the current time, a test a fixed one.
 * @returns The ids of the requests alerted by this run, soonest due first.
 * @throws {Error} When the open requests cannot be read, so the job retries.
 */
export async function alertDueSoonDeletions(now: Date): Promise<string[]> {
  const due = await accountDeletionRequestRepository.listOpenDueBy(
    new Date(now.getTime() + DUE_SOON_WINDOW_MS)
  )
  const alerted: string[] = []
  for (const request of due) {
    const ttlMs = Math.max(request.dueAt.getTime() - now.getTime(), 0) + DUE_SOON_KEY_MARGIN_MS
    const claim = await claimCooldown(DUE_SOON_SCOPE, request.id, ttlMs, 'skip')
    if (!claim.claimed) continue
    if ((await alertStaff(request, DUE_SOON_ALERT, now)) === 0) {
      await releaseCooldown(DUE_SOON_SCOPE, request.id)
      continue
    }
    alerted.push(request.id)
  }
  return alerted
}

/**
 * Queue the `account_deleted` confirmation on the normal email queue, after
 * the staff delete that completed the customer's open request committed. A
 * failure is logged: the account is already deleted.
 * @param user - The customer as the delete's transaction read them, before the soft delete.
 * @param user.id - Their id.
 * @param user.email - Their address, which the soft delete leaves as it was.
 * @param user.firstName - Their first name, if any.
 */
export async function mailAccountDeleted(user: {
  id: string
  email: string
  firstName: string | null
}): Promise<void> {
  const env = getEnv()
  try {
    await addEmailJob(
      {
        to: user.email.toLowerCase(),
        templateKey: ACCOUNT_DELETED_TEMPLATE_KEY,
        variables: {
          firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
          appName: appNameFor('web', env),
          supportEmail: supportAddress(env),
        },
      },
      user.id
    )
  } catch (error) {
    logger.error('An account deleted confirmation could not be queued', {
      error,
      userId: user.id,
    })
  }
}

/**
 * Queue one staff-only notification, with its email, for every live, active
 * platform owner and admin but the requester. The in-app body and the mail's
 * summary come from the one `alert.summary`, which says the request is
 * overdue once `due_at` is at or before `now`. A request with no one to
 * alert is logged as a warning naming only its id. A failed lookup or
 * enqueue is logged and skipped.
 * @param request - The request.
 * @param alert - Which alert: a new request, or one due soon.
 * @param now - The clock the overdue test reads.
 * @returns How many alerts were queued.
 */
async function alertStaff(
  request: AccountDeletionRequest,
  alert: StaffAlert,
  now: Date
): Promise<number> {
  try {
    const recipients = await accountDeletionRequestRepository.listAccountDeletionRecipients(
      request.userId
    )
    if (recipients.length === 0) {
      logger.warn('An account deletion request has no platform owner or admin to alert', {
        requestId: request.id,
      })
      return 0
    }
    const dueAt = formatUtcDateTime(request.dueAt)
    const dueState: AccountDeletionDueState =
      request.dueAt.getTime() <= now.getTime() ? 'overdue' : 'upcoming'
    const appName = appNameFor('apex')
    let queued = 0
    for (const recipient of recipients) {
      try {
        await addNotificationJob({
          userId: recipient.id,
          type: 'account_deletion_requested',
          title: alert.title,
          body: alert.summary(dueAt, dueState),
          metadata: {
            templateKey: alert.templateKey,
            requestId: request.id,
            userId: request.userId,
          },
          email: alert.mail(recipient.email, {
            firstName: recipient.firstName ?? MISSING_FIRST_NAME_FALLBACK,
            appName,
            dueAt,
            dueState,
          }),
        })
        queued += 1
      } catch (error) {
        logger.error('An account deletion alert could not be queued', {
          error,
          recipientId: recipient.id,
          requestId: request.id,
        })
      }
    }
    return queued
  } catch (error) {
    logger.error('Account deletion alerts could not be queued', {
      error,
      requestId: request.id,
    })
    return 0
  }
}

/**
 * One open request as the staff list returns it: the requester and the
 * workspaces they solely own, which block the staff delete until someone else
 * owns them.
 */
export interface DeletionRequestRow {
  id: string
  requestedAt: Date
  dueAt: Date
  reason: string | null
  user: { id: string; email: string; firstName: string | null; lastName: string | null }
  soleOwnedWorkspaces: { id: string; name: string }[]
}

/**
 * One page of the open deletion requests, soonest due first by default. One
 * query finds the sole-owned workspaces of every requester on the page, the
 * same one the staff delete's last-owner refusal uses.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listOpenDeletionRequests(
  query: PlatformDeletionRequestListQuery
): Promise<ListPage<DeletionRequestRow>> {
  const page = await accountDeletionRequestRepository.listOpen(query.params)
  const owned = await userMembershipRepository.listSoleOwnedTenants(
    page.items.map((item) => item.user.id)
  )
  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      soleOwnedWorkspaces: (owned.get(item.user.id) ?? []).map((tenant) => ({
        id: tenant.tenantId,
        name: tenant.tenantName,
      })),
    })),
  }
}
