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
 * gets the email directly. A requester who is no longer a member is told
 * nothing, and a suspended or archived workspace gets only its move to Free,
 * with no button (`billingTransitions`).
 *
 * Once: every mail's job key, and a notification's dedupe key, is built from
 * the workspace, the transition's own stamp (the subscription id, the halt
 * time, the row version) and the recipient. The key is the message row's
 * `job_key`, which outlives the job, so a re-run of the same change, before
 * or after the mail went out, enqueues nothing new (`addEmailJobOnce`).
 *
 * The same helpers send the mail no billing change carries: the schedulers'
 * trial, renewal and win-back reminders, each claimed first; the trial's
 * start, after the commit that started it; a join refused for the members
 * limit (an in-app notice alone, once a day); and the payer's leaving while a
 * subscription runs, to the remaining owners only.
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
import { displayName } from '@/presenters/billing.presenter'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { trackPayerLeft, trackTrialReminder } from '@/services/billing/billing-analytics.service'
import { billingTimeZone } from '@/services/billing/billing-dates.service'
import { buildBillingLink, buildTenantHomeLink } from '@/services/billing/billing-links.service'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { logger } from '@/services/logger.service'
import type { MailMessage } from '@/services/mailer.service'
import { graceEndsAt, mergeEntitlements } from '@/utilities/billing-rules.utilities'
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
const billingRepository = new BillingRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How a payer who gave no name is named.
 */
const UNNAMED_PAYER = 'A teammate'

/**
 * What a committed change carries besides its rows.
 */
export interface BillingDiffExtras {
  /**
   * The upgrade requests the change fulfilled: each requester is told.
   */
  fulfilledRequests?: readonly UpgradeRequest[]
  /**
   * The member whose own action made the change, such as the owner who
   * cancelled; its analytics events are theirs.
   */
  actorUserId?: string
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
 * address when it is no owner's: an address a deactivated owner holds counts
 * as an owner's, so it is not mailed either.
 * @param tenantId - The workspace.
 * @param billingEmail - The address the payer gave, if any.
 * @returns The owners and the extra billing address.
 */
async function billingRecipients(
  tenantId: string,
  billingEmail: string | null
): Promise<{ owners: BillingRecipient[]; billingAddress: string | null }> {
  const members = await membershipRepository.listByTenant(tenantId)
  // Every owner's address, a deactivated owner's included: the billing address is never mailed in their place.
  const ownerAddresses = new Set<string>()
  const byAddress = new Map<string, BillingRecipient>()
  for (const { membership, user } of members) {
    if (membership.role !== 'owner') continue
    const address = user.email.toLowerCase()
    ownerAddresses.add(address)
    if (user.active && !byAddress.has(address)) {
      byAddress.set(address, { userId: user.id, email: user.email })
    }
  }
  const isOwnersAddress = billingEmail !== null && ownerAddresses.has(billingEmail.toLowerCase())
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
 * The email a notification carries.
 */
interface NoticeEmail {
  templateKey: EmailTemplateKey
  messageFor: MessageFor
}

/**
 * Notify each owner, the notification carrying the email when it has one,
 * and mail the billing address directly.
 * @param context - The workspace.
 * @param notice - The notification and its email.
 * @param notice.type - The notification type.
 * @param notice.stamp - What fixes this transition.
 * @param notice.title - The in-app title.
 * @param notice.body - The in-app body.
 * @param notice.email - The email it carries, or null for an in-app notice alone.
 */
async function notifyOwners(
  context: MailContext,
  notice: {
    type: NotificationType
    stamp: string
    title: string
    body: string
    email: NoticeEmail | null
  }
): Promise<void> {
  const tenantId = context.tenant.id
  const { email } = notice
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
          ...(email !== null && {
            email: email.messageFor(owner.email),
            emailContext: { tenantId, linkApp: 'web' as const },
          }),
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
  if (email !== null && context.billingAddress !== null) {
    await mailOnce(
      context,
      email.templateKey,
      notice.stamp,
      { userId: '', email: context.billingAddress },
      email.messageFor
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
    const definition: EntitlementDefinition = ENTITLEMENTS[key as EntitlementKey]
    const unit = definition.unit ?? { one: key, other: key }
    const allowed = usage.limit === 1 ? `1 ${unit.one}` : `${String(usage.limit)} ${unit.other}`
    lines.push(
      `Free allows ${allowed}, and ${tenant.name} has ${String(usage.used)}. No one new can join while it has ${String(usage.limit)} or more.`
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
      const { stoppedBy } = transition
      const stoppedAt = stoppedBy === 'paused' ? after.pausedAt : after.haltedAt
      const settings = await planRepository.getSettings()
      const graceEnd = graceEndsAt(after, settings.pastDueGraceDays)
      if (price === undefined || graceEnd === null || stoppedAt === null) break
      const amount = formatRupees(price.amountMinor)
      const graceEndsOn = dateOf(graceEnd)
      const isPaused = stoppedBy === 'paused'
      await notifyOwners(context, {
        type: 'billing_payment_failed',
        stamp: `${stoppedBy}-${String(stoppedAt.getTime())}`,
        title: isPaused ? 'Your Paid subscription is paused' : `Your payment of ₹${amount} failed`,
        body: `Update your ${isPaused ? 'payment method' : 'card'} by ${graceEndsOn} to keep Paid. After that, ${tenantName} moves to Free.`,
        email: {
          templateKey: 'payment_failed',
          messageFor: (to) => ({
            to,
            templateKey: 'payment_failed',
            variables: {
              appName,
              tenantName,
              amount,
              stoppedBy,
              graceEndsOn,
              billingLink: buildBillingLink(tenant.slug, 'payment_failed'),
            },
          }),
        },
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
 * request. A requester whose account is gone or inactive, or who is no
 * longer a member, is skipped.
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
    // A requester who left or was removed is told nothing about the workspace.
    const membership = await membershipRepository.findByUserAndTenant(requester.id, tenant.id)
    if (membership === undefined) continue
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
    const isWorkspaceActive = tenant.lifecycleState === 'active' && tenant.deletedAt === null
    const priceIds = [after.priceId, after.nextPriceId].filter((id) => id !== null)
    const priceRows = await planRepository.findPricesByIds(priceIds)
    const prices = new Map(priceRows.map((price) => [price.id, price]))
    const transitions = billingTransitions(before, after, source, {
      isWorkspaceActive,
      intervalOf: (priceId) => (priceId === null ? undefined : prices.get(priceId)?.interval),
    })
    // A suspended or archived workspace's members are not told it went Paid.
    const fulfilled = isWorkspaceActive ? (extras.fulfilledRequests ?? []) : []
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

/**
 * Read what a scheduled or member-action mail needs for one workspace: none
 * for a missing, platform, suspended or archived workspace, whose owners are
 * never asked to act in Billing.
 * @param tenantId - The workspace.
 * @param billingEmail - The address the payer gave, or null to mail owners alone.
 * @returns The context, or undefined when the workspace gets no such mail.
 */
async function activeContext(
  tenantId: string,
  billingEmail: string | null
): Promise<MailContext | undefined> {
  const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId)
  if (tenant === undefined || tenant.isPlatform) return undefined
  if (tenant.lifecycleState !== 'active' || tenant.deletedAt !== null) return undefined
  return loadContext(tenant, billingEmail)
}

/**
 * Paid's monthly and yearly prices, formatted.
 * @returns The prices, or undefined when Paid has no active INR price for either.
 */
async function paidPrices(): Promise<{ monthly: string; yearly: string } | undefined> {
  const paid = await planRepository.findPlanByKey('paid')
  if (paid === undefined) return undefined
  const monthly = await planRepository.activePrice(paid.id, 'INR', 'month')
  const yearly = await planRepository.activePrice(paid.id, 'INR', 'year')
  if (monthly === undefined || yearly === undefined) return undefined
  return { monthly: formatRupees(monthly.amountMinor), yearly: formatRupees(yearly.amountMinor) }
}

/**
 * The members limit a workspace will have on Free, its grants included, and
 * the seats it uses now.
 * @param tenantId - The workspace.
 * @param now - The time the grants are read at.
 * @returns The limit and the seats, or undefined when Free has no members limit.
 */
async function freeMembers(
  tenantId: string,
  now: Date
): Promise<{ limit: number; used: number } | undefined> {
  const free = await planRepository.findPlanByKey('free')
  if (free === undefined) return undefined
  const grants = await planRepository.listActiveGrants(tenantId)
  const limit = mergeEntitlements('free', free.entitlements, grants, now).values.members
  if (typeof limit !== 'number') return undefined
  const entitlements = await getEffectiveEntitlements(tenantId)
  return { limit, used: entitlements.limits.members?.used ?? 0 }
}

/**
 * A number of members, with the noun in the right form.
 * @param count - How many.
 * @returns For example "1 member" or "3 members".
 */
function membersCount(count: number): string {
  const { unit } = ENTITLEMENTS.members
  return `${String(count)} ${count === 1 ? unit.one : unit.other}`
}

/**
 * Log a scheduled or member-action mail that could not be sent, by ids.
 * @param error - What went wrong.
 * @param tenantId - The workspace.
 * @param templateKey - The mail.
 */
function logSendFailure(error: unknown, tenantId: string, templateKey: string): void {
  logger.error('Could not send a billing email', {
    error: redactedForLog(error),
    tenantId,
    templateKey,
  })
}

/**
 * Log a mail skipped because a value it states is missing, by ids.
 * @param tenantId - The workspace.
 * @param templateKey - The mail.
 */
function logSkipped(tenantId: string, templateKey: string): void {
  logger.warn('A billing email had no date or price to send with', { tenantId, templateKey })
}

/**
 * Re-read a claimed reminder's row and say whether it is still due: still in
 * `state`, on an active workspace. A workspace that changed between the
 * claim and the send loses the reminder, logged with ids.
 * @param row - The claimed row.
 * @param state - The state the reminder is for.
 * @param templateKey - The reminder, for the log.
 * @param isStillDue - Any further check on the fresh row.
 * @returns The fresh row, or undefined when the reminder is no longer due.
 */
async function stillDue(
  row: TenantBillingRecord,
  state: TenantBillingRecord['state'],
  templateKey: EmailTemplateKey,
  isStillDue: (fresh: TenantBillingRecord) => Promise<boolean> = () => Promise.resolve(true)
): Promise<TenantBillingRecord | undefined> {
  const fresh = await billingRepository.findByTenantId(row.tenantId)
  const tenant = await tenantRepository.findByIdIncludingDeleted(row.tenantId)
  const isActive = tenant?.lifecycleState === 'active' && tenant.deletedAt === null
  if (fresh?.state === state && isActive && (await isStillDue(fresh))) return fresh
  logger.warn('A claimed billing reminder is no longer due', {
    tenantId: row.tenantId,
    templateKey,
  })
  return undefined
}

/**
 * Remind the owners that the trial ends within three days: a notification
 * carrying the email, and the email to the billing address. Once per trial
 * end. Never rejects.
 * @param row - The claimed trial.
 * @param now - The run's time.
 */
export async function sendTrialEnding(row: TenantBillingRecord, now: Date): Promise<void> {
  const { tenantId } = row
  try {
    if ((await stillDue(row, 'trialing', 'trial_ending')) === undefined) return
    const context = await activeContext(tenantId, row.billingEmail)
    if (context === undefined) return
    const prices = await paidPrices()
    const members = await freeMembers(tenantId, now)
    if (row.trialEndsAt === null || prices === undefined || members === undefined) {
      logSkipped(tenantId, 'trial_ending')
      return
    }
    const { tenant, appName } = context
    const trialEndsOn = formatDateInZone(row.trialEndsAt, context.timeZone)
    const memberLimit = String(members.limit)
    const membersUsed = String(members.used)
    await notifyOwners(context, {
      type: 'billing_trial_ending',
      stamp: String(row.trialEndsAt.getTime()),
      title: `Your Paid trial ends on ${trialEndsOn}`,
      body: `After ${trialEndsOn}, ${tenant.name} moves to Free. Free allows ${membersCount(members.limit)}, and it has ${membersUsed}. To keep Paid, upgrade from Billing.`,
      email: {
        templateKey: 'trial_ending',
        messageFor: (to) => ({
          to,
          templateKey: 'trial_ending',
          variables: {
            appName,
            tenantName: tenant.name,
            trialEndsOn,
            memberLimit,
            membersUsed,
            monthlyPrice: prices.monthly,
            yearlyPrice: prices.yearly,
            billingLink: buildBillingLink(tenant.slug, 'trial_ending'),
          },
        }),
      },
    })
    await trackTrialReminder(row, 'trial_ending', now)
  } catch (error) {
    logSendFailure(error, tenantId, 'trial_ending')
  }
}

/**
 * Tell the owners and the billing address that the trial ends today. Once
 * per trial end. Never rejects.
 * @param row - The claimed trial.
 * @param now - The run's time.
 */
export async function sendTrialEndsToday(row: TenantBillingRecord, now: Date): Promise<void> {
  const { tenantId } = row
  try {
    if ((await stillDue(row, 'trialing', 'trial_ends_today')) === undefined) return
    const context = await activeContext(tenantId, row.billingEmail)
    if (context === undefined) return
    const prices = await paidPrices()
    const members = await freeMembers(tenantId, now)
    if (row.trialEndsAt === null || prices === undefined || members === undefined) {
      logSkipped(tenantId, 'trial_ends_today')
      return
    }
    const { tenant, appName } = context
    await mailOwners(context, 'trial_ends_today', String(row.trialEndsAt.getTime()), (to) => ({
      to,
      templateKey: 'trial_ends_today',
      variables: {
        appName,
        tenantName: tenant.name,
        memberLimit: String(members.limit),
        membersUsed: String(members.used),
        monthlyPrice: prices.monthly,
        yearlyPrice: prices.yearly,
        billingLink: buildBillingLink(tenant.slug, 'trial_ends_today'),
      },
    }))
    await trackTrialReminder(row, 'trial_ends_today', now)
  } catch (error) {
    logSendFailure(error, tenantId, 'trial_ends_today')
  }
}

/**
 * Up to three facts about what a workspace uses, one per line, such as
 * "2 members".
 * @param tenantId - The workspace.
 * @returns The lines, joined by newlines.
 */
async function usageSummary(tenantId: string): Promise<string> {
  const entitlements = await getEffectiveEntitlements(tenantId)
  const lines: string[] = []
  for (const [key, usage] of Object.entries(entitlements.limits)) {
    const definition: EntitlementDefinition = ENTITLEMENTS[key as EntitlementKey]
    const unit = definition.unit ?? { one: key, other: key }
    lines.push(`${String(usage.used)} ${usage.used === 1 ? unit.one : unit.other}`)
  }
  return lines.slice(0, 3).join('\n')
}

/**
 * Tell the owners and the billing address that half the trial has passed,
 * with what the workspace uses. Once per trial end. Never rejects.
 * @param row - The claimed trial.
 * @param now - The run's time.
 */
export async function sendTrialMidpoint(row: TenantBillingRecord, now: Date): Promise<void> {
  const { tenantId } = row
  try {
    if ((await stillDue(row, 'trialing', 'trial_midpoint')) === undefined) return
    const context = await activeContext(tenantId, row.billingEmail)
    if (context === undefined) return
    if (row.trialEndsAt === null) {
      logSkipped(tenantId, 'trial_midpoint')
      return
    }
    const { tenant, appName } = context
    const daysLeft = String(Math.ceil((row.trialEndsAt.getTime() - now.getTime()) / DAY_MS))
    const trialEndsOn = formatDateInZone(row.trialEndsAt, context.timeZone)
    const summary = await usageSummary(tenantId)
    await mailOwners(context, 'trial_midpoint', String(row.trialEndsAt.getTime()), (to) => ({
      to,
      templateKey: 'trial_midpoint',
      variables: {
        appName,
        tenantName: tenant.name,
        daysLeft,
        trialEndsOn,
        usageSummary: summary,
        billingLink: buildBillingLink(tenant.slug, 'trial_midpoint'),
      },
    }))
    await trackTrialReminder(row, 'trial_midpoint', now)
  } catch (error) {
    logSendFailure(error, tenantId, 'trial_midpoint')
  }
}

/**
 * Tell the owners and the billing address that a yearly plan renews soon,
 * for how much: only while the row is still active, not cancelling and on a
 * yearly price, on an active workspace. Once per period end. Never rejects.
 * @param row - The claimed row.
 */
export async function sendRenewalUpcoming(row: TenantBillingRecord): Promise<void> {
  const { tenantId } = row
  try {
    const due = await stillDue(row, 'active', 'renewal_upcoming', async (fresh) => {
      if (fresh.cancelAtPeriodEnd || fresh.priceId === null) return false
      const [price] = await planRepository.findPricesByIds([fresh.priceId])
      return price?.interval === 'year'
    })
    if (due === undefined) return
    const context = await activeContext(tenantId, row.billingEmail)
    if (context === undefined) return
    const [price] = row.priceId === null ? [] : await planRepository.findPricesByIds([row.priceId])
    if (row.currentPeriodEnd === null || price === undefined) {
      logSkipped(tenantId, 'renewal_upcoming')
      return
    }
    const { tenant, appName } = context
    const renewsOn = formatDateInZone(row.currentPeriodEnd, context.timeZone)
    await mailOwners(context, 'renewal_upcoming', String(row.currentPeriodEnd.getTime()), (to) => ({
      to,
      templateKey: 'renewal_upcoming',
      variables: {
        appName,
        tenantName: tenant.name,
        renewsOn,
        amount: formatRupees(price.amountMinor),
        billingLink: buildBillingLink(tenant.slug, 'renewal_upcoming'),
      },
    }))
  } catch (error) {
    logSendFailure(error, tenantId, 'renewal_upcoming')
  }
}

/**
 * Remind the owners and the billing address of a Free workspace what Paid
 * adds. Once per claim, so once per Free period and day. Never rejects.
 * @param row - The claimed row.
 * @param day - Which of the two win-back emails.
 * @param now - The run's time.
 */
export async function sendWinback(
  row: TenantBillingRecord,
  day: '7d' | '30d',
  now: Date
): Promise<void> {
  const { tenantId } = row
  try {
    if ((await stillDue(row, 'free', 'winback')) === undefined) return
    const context = await activeContext(tenantId, row.billingEmail)
    if (context === undefined) return
    const prices = await paidPrices()
    const members = await freeMembers(tenantId, now)
    const claimedAt = day === '7d' ? row.winback7dSentAt : row.winback30dSentAt
    if (prices === undefined || members === undefined || claimedAt === null) {
      logSkipped(tenantId, 'winback')
      return
    }
    const { tenant, appName } = context
    await mailOwners(context, 'winback', `${day}-${String(claimedAt.getTime())}`, (to) => ({
      to,
      templateKey: 'winback',
      variables: {
        appName,
        tenantName: tenant.name,
        memberLimit: String(members.limit),
        monthlyPrice: prices.monthly,
        billingLink: buildBillingLink(tenant.slug, 'winback'),
      },
    }))
  } catch (error) {
    logSendFailure(error, tenantId, 'winback')
  }
}

/**
 * Tell the owners and the billing address that the workspace's trial
 * started, and when it ends. Sent after the commit that started it; once per
 * trial start. A workspace not trialing is skipped. Never rejects.
 * @param tenantId - The workspace.
 */
export async function sendTrialStarted(tenantId: string): Promise<void> {
  try {
    const row = await billingRepository.findByTenantId(tenantId)
    if (row?.state !== 'trialing' || row.trialStartedAt === null || row.trialEndsAt === null) {
      return
    }
    const context = await activeContext(tenantId, row.billingEmail)
    if (context === undefined) return
    const { tenant, appName } = context
    const trialEndsOn = formatDateInZone(row.trialEndsAt, context.timeZone)
    await mailOwners(context, 'trial_started', String(row.trialStartedAt.getTime()), (to) => ({
      to,
      templateKey: 'trial_started',
      variables: {
        appName,
        tenantName: tenant.name,
        trialEndsOn,
        billingLink: buildBillingLink(tenant.slug, 'trial_started'),
      },
    }))
  } catch (error) {
    logSendFailure(error, tenantId, 'trial_started')
  }
}

/**
 * Tell the owners in the app that the workspace refused a join for its
 * members limit: the limit, the seats used and the next step, never who
 * tried to join. Once per owner and day in the workspace's time zone. Sent
 * after the refused join rolled back. Never rejects.
 * @param tenantId - The workspace.
 * @param now - The refusal's time.
 */
export async function sendWorkspaceFull(tenantId: string, now = new Date()): Promise<void> {
  try {
    const context = await activeContext(tenantId, null)
    if (context === undefined) return
    const entitlements = await getEffectiveEntitlements(tenantId)
    const usage = entitlements.limits.members
    if (usage === undefined || usage.limit === null) return
    const planName = entitlements.plan.name
    await notifyOwners(context, {
      type: 'workspace_full',
      stamp: formatDateInZone(now, context.timeZone),
      title: 'Your workspace is full',
      body: `Someone couldn't join ${context.tenant.name}. ${planName} allows ${membersCount(usage.limit)}, and it has ${String(usage.used)}. To add members, upgrade from Billing.`,
      email: null,
    })
  } catch (error) {
    logSendFailure(error, tenantId, 'workspace_full')
  }
}

/**
 * Tell the remaining owners that the person who paid left while the
 * subscription runs: a notification carrying the email. The billing address
 * is the payer's, so it is not mailed, and the payer's name stays out of the
 * stored notification. Nothing is sent unless `payerUserId` is still the
 * workspace's payer and a paid subscription is live (active or past due, not
 * cancelling). Once per workspace, payer and day. Never rejects.
 * @param tenantId - The workspace.
 * @param payerUserId - The person who left, deleted accounts included.
 * @param leftAt - When they left.
 */
export async function sendPayerLeft(
  tenantId: string,
  payerUserId: string,
  leftAt: Date
): Promise<void> {
  try {
    const row = await billingRepository.findByTenantId(tenantId)
    if (row === undefined || row.payerUserId !== payerUserId) return
    const isLive =
      (row.state === 'active' || row.state === 'past_due') &&
      row.providerSubscriptionId !== null &&
      !row.cancelAtPeriodEnd
    if (!isLive) return
    const context = await activeContext(tenantId, null)
    if (context === undefined) return
    const deadline = await keepPaidDeadline(row, leftAt)
    if (deadline === null) {
      logSkipped(tenantId, 'payer_left')
      return
    }
    const payer = await userRepository.findById(payerUserId, { includeDeleted: true })
    const payerName = payer === undefined ? '' : displayName(payer)
    const { tenant, appName } = context
    const leftOn = formatDateInZone(leftAt, context.timeZone)
    const keepPaidBy = formatDateInZone(deadline, context.timeZone)
    await notifyOwners(context, {
      type: 'billing_payer_left',
      stamp: `${payerUserId}-${leftOn}`,
      title: 'Your workspace needs a new card',
      body: `The person who paid for ${tenant.name} left on ${leftOn}. Add your card by ${keepPaidBy} to keep Paid.`,
      email: {
        templateKey: 'payer_left',
        messageFor: (to) => ({
          to,
          templateKey: 'payer_left',
          variables: {
            appName,
            tenantName: tenant.name,
            payerName: payerName === '' ? UNNAMED_PAYER : payerName,
            leftOn,
            periodEndsOn: keepPaidBy,
            billingLink: buildBillingLink(tenant.slug, 'payer_left'),
          },
        }),
      },
    })
    await trackPayerLeft(
      row,
      payer !== undefined && payer.deletedAt === null ? payerUserId : null,
      leftOn,
      leftAt
    )
  } catch (error) {
    logSendFailure(error, tenantId, 'payer_left')
  }
}

/**
 * The last day a workspace keeps Paid without a new card. Past due: the end
 * of grace after a halt or pause, or, while the provider still retries and
 * no grace has started, a full grace from `now` (the stored period end is
 * the last paid one, already over). Otherwise the end of the paid period.
 * @param row - The workspace's billing row.
 * @param now - When the payer left.
 * @returns The deadline, or null when an active row has no period end.
 */
async function keepPaidDeadline(row: TenantBillingRecord, now: Date): Promise<Date | null> {
  if (row.state !== 'past_due') return row.currentPeriodEnd
  const { pastDueGraceDays } = await planRepository.getSettings()
  return graceEndsAt(row, pastDueGraceDays) ?? new Date(now.getTime() + pastDueGraceDays * DAY_MS)
}

/**
 * Tell the remaining owners of every workspace a deleted user paid for with
 * a live subscription and was still a member of (`sendPayerLeft`): a
 * workspace they had already left was told then. Never rejects.
 * @param payerUserId - The deleted user.
 * @param memberOf - The workspaces they were a member of when deleted.
 * @param leftAt - When they were deleted.
 */
export async function sendPayerLeftEverywhere(
  payerUserId: string,
  memberOf: readonly string[],
  leftAt: Date
): Promise<void> {
  try {
    const paidFor = await billingRepository.listTenantIdsPaidBy(payerUserId)
    for (const tenantId of paidFor.filter((id) => memberOf.includes(id))) {
      await sendPayerLeft(tenantId, payerUserId, leftAt)
    }
  } catch (error) {
    logger.error('Could not send the payer left emails', {
      error: redactedForLog(error),
      userId: payerUserId,
    })
  }
}
