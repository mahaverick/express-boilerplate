/**
 * @file The billing emails and notifications a committed billing change
 * sends, called by `emitBillingDiff` after the commit and never inside a
 * transaction. Which change sends what is `billingTransitions`'s rule; this
 * file finds the recipients, builds each message and enqueues it once.
 *
 * Recipients: the workspace's active owners, one mail each by address case
 * blind, and the billing address when it is no owner's. A fulfilled upgrade
 * request mails its requester alone. A type with a notification (payment
 * failed) reaches each owner as a notification job carrying the email, so the
 * email is not also sent directly; the billing address has no account, so it
 * gets the email directly.
 *
 * Once: every mail's job key, and a notification's dedupe key, is built from
 * the workspace, the transition's own stamp (the subscription id, the halt
 * time, the row version) and the recipient. The key is the message row's
 * `job_key`, which outlives the job, so a re-run of the same change, before
 * or after the mail went out, enqueues nothing new (`addEmailJobOnce`).
 *
 * A failed send is logged with ids only and never fails the billing change.
 */
import { createHash } from 'node:crypto'
import { getEnv } from '@/configs/env.config'
import type { BillingHistorySource } from '@/constants/billing.constants'
import {
  ENTITLEMENTS,
  type EntitlementDefinition,
  type EntitlementKey,
} from '@/constants/entitlements.constants'
import type { NotificationType } from '@/constants/notification.constants'
import type {
  PlanPrice,
  TenantBillingRecord,
  UpgradeRequest,
} from '@/database/models/billing.model'
import type { Tenant } from '@/database/models/tenant.model'
import { redactedForLog } from '@/errors/postgres-errors'
import { addEmailJobOnce } from '@/jobs/email.job'
import { addNotificationJob } from '@/jobs/notification.job'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { billingTimeZone } from '@/services/billing/billing-dates.service'
import { buildBillingLink, buildTenantHomeLink } from '@/services/billing/billing-links.service'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { logger } from '@/services/logger.service'
import type { MailMessage } from '@/services/mailer.service'
import { countOf } from '@/templates/email/billing-layout.template'
import { graceEndsAt } from '@/utilities/billing-rules.utilities'
import {
  billingTransitions,
  type BillingTransition,
  type DowngradeCause,
} from '@/utilities/billing-transitions.utilities'
import { formatDateInZone } from '@/utilities/date-text.utilities'
import type { EmailTemplateKey } from '@/utilities/email-template.utilities'

const tenantRepository = new TenantRepository()
const membershipRepository = new UserMembershipRepository()
const planRepository = new PlanRepository()
const userRepository = new UserRepository()

/**
 * What a committed change carries besides its rows.
 */
export interface BillingDiffExtras {
  /**
   * The upgrade requests the change fulfilled: each requester is told.
   */
  fulfilledRequests?: readonly UpgradeRequest[]
}

/**
 * One person a billing mail goes to.
 */
interface BillingRecipient {
  /**
   * Their account, or `''` for the billing address, which has none.
   */
  userId: string
  email: string
}

/**
 * What every message for one workspace needs.
 */
interface MailContext {
  tenant: Tenant
  /**
   * The workspace's time zone, for its billing dates.
   */
  timeZone: string
  appName: string
  owners: BillingRecipient[]
  /**
   * The billing address when it is no owner's, else null.
   */
  billingAddress: string | null
}

/**
 * A message for one recipient's address.
 */
type MessageFor = (to: string) => MailMessage

/**
 * An amount in paise as rupees, grouped the Indian way, without the sign.
 * @param amountMinor - The amount in paise.
 * @returns For example "999", "9,990" or "1,49,999.50".
 */
function formatRupees(amountMinor: number): string {
  const hasPaise = amountMinor % 100 !== 0
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}

/**
 * A short, fixed key for one send, from the workspace, the transition's
 * stamp and the recipient: a hash, so it fits `job_key` and holds no address.
 * @param parts - What makes the send distinct.
 * @returns 32 hex characters.
 */
function sendKey(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
}

/**
 * The workspace's active owners, once each by address, and the billing
 * address when it is no owner's.
 * @param tenantId - The workspace.
 * @param billingEmail - The address the payer gave, if any.
 * @returns The owners and the extra billing address.
 */
async function billingRecipients(
  tenantId: string,
  billingEmail: string | null
): Promise<{ owners: BillingRecipient[]; billingAddress: string | null }> {
  const members = await membershipRepository.listByTenant(tenantId)
  const byAddress = new Map<string, BillingRecipient>()
  for (const { membership, user } of members) {
    if (membership.role !== 'owner' || !user.active) continue
    const address = user.email.toLowerCase()
    if (!byAddress.has(address)) byAddress.set(address, { userId: user.id, email: user.email })
  }
  const isOwnersAddress = billingEmail !== null && byAddress.has(billingEmail.toLowerCase())
  return {
    owners: [...byAddress.values()],
    billingAddress: billingEmail === null || isOwnersAddress ? null : billingEmail,
  }
}

/**
 * Read what every message for the workspace needs.
 * @param tenant - The workspace.
 * @param billingEmail - The address the payer gave, if any.
 * @returns The context.
 */
async function loadContext(tenant: Tenant, billingEmail: string | null): Promise<MailContext> {
  return {
    tenant,
    timeZone: await billingTimeZone(tenant.id),
    appName: getEnv().APP_NAME,
    ...(await billingRecipients(tenant.id, billingEmail)),
  }
}

/**
 * Enqueue one mail once, logging a failure with ids only.
 * @param context - The workspace.
 * @param templateKey - The template.
 * @param stamp - What fixes this transition, such as a subscription id.
 * @param recipient - Who it goes to.
 * @param messageFor - The message for their address.
 */
async function mailOnce(
  context: MailContext,
  templateKey: EmailTemplateKey,
  stamp: string,
  recipient: BillingRecipient,
  messageFor: MessageFor
): Promise<void> {
  const tenantId = context.tenant.id
  const who = recipient.userId === '' ? 'billing-address' : recipient.userId
  try {
    await addEmailJobOnce(messageFor(recipient.email), recipient.userId, {
      jobId: `billing-${templateKey}-${sendKey(tenantId, stamp, who)}`,
      context: { tenantId, linkApp: 'web' },
    })
  } catch (error) {
    logger.error('Could not queue a billing email', {
      error: redactedForLog(error),
      tenantId,
      templateKey,
      userId: recipient.userId === '' ? null : recipient.userId,
    })
  }
}

/**
 * Mail the owners and the billing address.
 * @param context - The workspace.
 * @param templateKey - The template.
 * @param stamp - What fixes this transition.
 * @param messageFor - The message for one address.
 */
async function mailOwners(
  context: MailContext,
  templateKey: EmailTemplateKey,
  stamp: string,
  messageFor: MessageFor
): Promise<void> {
  const recipients =
    context.billingAddress === null
      ? context.owners
      : [...context.owners, { userId: '', email: context.billingAddress }]
  for (const recipient of recipients) {
    await mailOnce(context, templateKey, stamp, recipient, messageFor)
  }
}

/**
 * Notify each owner, the notification carrying the email, and mail the
 * billing address directly.
 * @param context - The workspace.
 * @param notice - The notification and its email.
 * @param notice.type - The notification type.
 * @param notice.templateKey - The email's template.
 * @param notice.stamp - What fixes this transition.
 * @param notice.title - The in-app title.
 * @param notice.body - The in-app body.
 * @param notice.messageFor - The email for one address.
 */
async function notifyOwners(
  context: MailContext,
  notice: {
    type: NotificationType
    templateKey: EmailTemplateKey
    stamp: string
    title: string
    body: string
    messageFor: MessageFor
  }
): Promise<void> {
  const tenantId = context.tenant.id
  for (const owner of context.owners) {
    const dedupeKey = `billing-${notice.type}-${sendKey(tenantId, notice.stamp, owner.userId)}`
    try {
      await addNotificationJob(
        {
          userId: owner.userId,
          type: notice.type,
          title: notice.title,
          body: notice.body,
          metadata: { tenantId, slug: context.tenant.slug },
          email: notice.messageFor(owner.email),
          emailContext: { tenantId, linkApp: 'web' },
          dedupeKey,
        },
        { jobId: dedupeKey }
      )
    } catch (error) {
      logger.error('Could not queue a billing notification', {
        error: redactedForLog(error),
        tenantId,
        type: notice.type,
        userId: owner.userId,
      })
    }
  }
  if (context.billingAddress !== null) {
    await mailOnce(
      context,
      notice.templateKey,
      notice.stamp,
      { userId: '', email: context.billingAddress },
      notice.messageFor
    )
  }
}

/**
 * What Free takes away from a workspace whose trial ended: each limit it is
 * over, and the Paid features it lost, one fact per line.
 * @param tenant - The workspace.
 * @returns The lines, joined by newlines.
 */
async function trialSummary(tenant: Tenant): Promise<string> {
  const entitlements = await getEffectiveEntitlements(tenant.id)
  const lines: string[] = []
  for (const [key, usage] of Object.entries(entitlements.limits)) {
    if (usage.limit === null || usage.used <= usage.limit) continue
    const noun = ENTITLEMENTS[key as EntitlementKey].label.toLowerCase().replace(/s$/, '')
    lines.push(
      `Free allows ${countOf(String(usage.limit), noun)}, and ${tenant.name} has ${String(usage.used)}. No one new can join while it has ${String(usage.limit)} or more.`
    )
  }
  const lost = (Object.keys(ENTITLEMENTS) as EntitlementKey[]).filter((key) => {
    // Widened, so a feature added with another Paid default is read, not assumed.
    const definition: EntitlementDefinition = ENTITLEMENTS[key]
    return (
      definition.kind === 'feature' &&
      definition.defaults.paid === true &&
      entitlements.features[key] !== true
    )
  })
  if (lost.length > 0) {
    lines.push(
      `These Paid features are off: ${lost.map((key) => ENTITLEMENTS[key].label).join(', ')}.`
    )
  }
  if (lines.length === 0) lines.push(`${tenant.name} is within every Free limit.`)
  return lines.join('\n')
}

/**
 * Send what one transition sends.
 * @param context - The workspace.
 * @param transition - The transition.
 * @param after - The row after the change.
 * @param prices - The prices the row names, by id.
 */
async function sendTransition(
  context: MailContext,
  transition: BillingTransition,
  after: TenantBillingRecord,
  prices: ReadonlyMap<string, PlanPrice>
): Promise<void> {
  const { tenant, appName, timeZone } = context
  const tenantName = tenant.name
  const tenantId = tenant.id
  /**
   * A billing date in the workspace's time zone.
   * @param date - The moment.
   * @returns The date alone.
   */
  const dateOf = (date: Date): string => formatDateInZone(date, timeZone)
  const price = after.priceId === null ? undefined : prices.get(after.priceId)
  switch (transition.kind) {
    case 'paid_welcome': {
      if (price === undefined || after.currentPeriodEnd === null) break
      const nextChargeOn = dateOf(after.currentPeriodEnd)
      await mailOwners(context, 'paid_welcome', after.providerSubscriptionId ?? '', (to) => ({
        to,
        templateKey: 'paid_welcome',
        variables: {
          appName,
          tenantName,
          amount: formatRupees(price.amountMinor),
          interval: price.interval,
          nextChargeOn,
          billingLink: buildBillingLink(tenant.slug, 'paid_welcome'),
        },
      }))
      return
    }
    case 'payment_failed': {
      const settings = await planRepository.getSettings()
      const graceEnd = graceEndsAt(after, settings.pastDueGraceDays)
      if (price === undefined || graceEnd === null || after.haltedAt === null) break
      const amount = formatRupees(price.amountMinor)
      const graceEndsOn = dateOf(graceEnd)
      await notifyOwners(context, {
        type: 'billing_payment_failed',
        templateKey: 'payment_failed',
        stamp: String(after.haltedAt.getTime()),
        title: `Your payment of ₹${amount} failed`,
        body: `Update your card by ${graceEndsOn} to keep Paid. After that, ${tenantName} moves to Free.`,
        messageFor: (to) => ({
          to,
          templateKey: 'payment_failed',
          variables: {
            appName,
            tenantName,
            amount,
            graceEndsOn,
            billingLink: buildBillingLink(tenant.slug, 'payment_failed'),
          },
        }),
      })
      return
    }
    case 'paid_cancelled': {
      if (after.currentPeriodEnd === null) break
      const endsOn = dateOf(after.currentPeriodEnd)
      await mailOwners(context, 'paid_cancelled', after.providerSubscriptionId ?? '', (to) => ({
        to,
        templateKey: 'paid_cancelled',
        variables: {
          appName,
          tenantName,
          endsOn,
          billingLink: buildBillingLink(tenant.slug, 'paid_cancelled'),
        },
      }))
      return
    }
    case 'interval_switch_scheduled': {
      const next = after.nextPriceId === null ? undefined : prices.get(after.nextPriceId)
      if (next === undefined || after.currentPeriodEnd === null) break
      const switchOn = dateOf(after.currentPeriodEnd)
      await mailOwners(
        context,
        'interval_switch_scheduled',
        after.nextSubscriptionId ?? '',
        (to) => ({
          to,
          templateKey: 'interval_switch_scheduled',
          variables: {
            appName,
            tenantName,
            interval: next.interval,
            switchOn,
            amount: formatRupees(next.amountMinor),
            billingLink: buildBillingLink(tenant.slug, 'interval_switch_scheduled'),
          },
        })
      )
      return
    }
    case 'moved_to_free': {
      await sendMovedToFree(context, transition.cause, after)
      return
    }
  }
  logger.warn('A billing email had no date or price to send with', {
    tenantId,
    transition: transition.kind,
  })
}

/**
 * Tell the owners their workspace moved to Free: the trial's end with its
 * summary, or the move with its cause.
 * @param context - The workspace.
 * @param cause - Why it moved.
 * @param after - The row after the change.
 */
async function sendMovedToFree(
  context: MailContext,
  cause: DowngradeCause,
  after: TenantBillingRecord
): Promise<void> {
  const { tenant, appName } = context
  const stamp = String(after.version)
  if (cause === 'trial_ended') {
    const summary = await trialSummary(tenant)
    await mailOwners(context, 'trial_ended', stamp, (to) => ({
      to,
      templateKey: 'trial_ended',
      variables: {
        appName,
        tenantName: tenant.name,
        summary,
        billingLink: buildBillingLink(tenant.slug, 'trial_ended'),
      },
    }))
    return
  }
  await mailOwners(context, 'moved_to_free', stamp, (to) => ({
    to,
    templateKey: 'moved_to_free',
    variables: {
      appName,
      tenantName: tenant.name,
      downgradeCause: cause,
      billingLink: buildBillingLink(tenant.slug, 'moved_to_free'),
    },
  }))
}

/**
 * Tell each member whose upgrade request the change fulfilled, once per
 * request. A requester whose account is gone or inactive is skipped.
 * @param context - The workspace.
 * @param requests - The fulfilled requests.
 */
async function sendRequestsFulfilled(
  context: MailContext,
  requests: readonly UpgradeRequest[]
): Promise<void> {
  const { tenant, appName } = context
  for (const request of requests) {
    const requester = await userRepository.findById(request.requestedBy)
    if (requester === undefined || !requester.active) continue
    await mailOnce(
      context,
      'upgrade_request_fulfilled',
      request.id,
      { userId: requester.id, email: requester.email },
      (to) => ({
        to,
        templateKey: 'upgrade_request_fulfilled',
        variables: {
          appName,
          tenantName: tenant.name,
          tenantLink: buildTenantHomeLink(tenant.slug, 'upgrade_request_fulfilled'),
        },
      })
    )
  }
}

/**
 * Send the emails and notifications a committed billing change calls for.
 * Never rejects: a failure is logged with ids only, and the change stands.
 * @param before - The row before the change.
 * @param after - The row after it.
 * @param source - What made the change.
 * @param extras - The upgrade requests it fulfilled.
 */
export async function sendBillingDiffEmails(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  source: BillingHistorySource,
  extras: BillingDiffExtras = {}
): Promise<void> {
  const tenantId = after.tenantId
  try {
    const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId)
    if (tenant === undefined || tenant.isPlatform) return
    const priceIds = [after.priceId, after.nextPriceId].filter((id) => id !== null)
    const priceRows = await planRepository.findPricesByIds(priceIds)
    const prices = new Map(priceRows.map((price) => [price.id, price]))
    const transitions = billingTransitions(before, after, source, {
      isWorkspaceActive: tenant.lifecycleState === 'active' && tenant.deletedAt === null,
      intervalOf: (priceId) => (priceId === null ? undefined : prices.get(priceId)?.interval),
    })
    const fulfilled = extras.fulfilledRequests ?? []
    if (transitions.length === 0 && fulfilled.length === 0) return
    const context = await loadContext(tenant, after.billingEmail)
    for (const transition of transitions) {
      await sendTransition(context, transition, after, prices)
    }
    await sendRequestsFulfilled(context, fulfilled)
  } catch (error) {
    logger.error('Could not send the billing emails for a change', {
      error: redactedForLog(error),
      tenantId,
    })
  }
}
