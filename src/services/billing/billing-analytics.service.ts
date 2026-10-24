/**
 * @file The billing analytics events, emitted as product domain events after
 * the change they report has committed (or, for a refusal, after its
 * transaction rolled back), never inside a transaction. The analytics
 * forwarder turns each into an outbox row plus its workspace's group marker.
 *
 * Attribution: a member's own action (a checkout, a cancel, a refused
 * invite) is that member's. A change the provider, a job or the reconcile
 * made is attributed to a person when one is known: the owner who started
 * the checkout for an activation or an interval change, the payer for the
 * rest, the trial's owner for a trial's events. Only an event with no such
 * person left is a system event. A staff member's own action in a customer
 * workspace sends no product event: its audit entry is forwarded already.
 *
 * Every event carries the workspace's plan and billing state after the
 * change. An event fixed by a stamp (the row's version, a subscription, a
 * trial's end) carries a dedupe key, so the same change passed in twice is
 * written once. `plan_feature_blocked` and `plan_limit_approaching` are sent
 * at most once per workspace, key and hour (a Redis key; when Redis fails,
 * the event is skipped and the request goes on).
 *
 * Every function here returns at once while analytics is off, and never
 * rejects: a failure is logged with ids only.
 */
import { isAnalyticsEnabled } from '@/configs/analytics.config'
import type { BillingHistorySource, BillingInterval } from '@/constants/billing.constants'
import { ENTITLEMENTS, type EntitlementDefinition } from '@/constants/entitlements.constants'
import type { TenantBillingRecord, UpgradeRequest } from '@/database/models/billing.model'
import { redactedForLog } from '@/errors/postgres-errors'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { recordLimitHit } from '@/services/billing/plan-limit-hits.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { logger } from '@/services/logger.service'
import { withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import type { BillingDomainEvent, BillingEventDetail } from '@/types/domain-event'
import { billingDiffEvents, type BillingAttribution } from '@/utilities/billing-analytics.utilities'
import { planKeyForState } from '@/utilities/billing-rules.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a throttled event stays quiet for one workspace and key.
 */
const THROTTLE_SECONDS = 60 * 60

/**
 * Who an event is from, and the facts it carries besides its own fields.
 */
interface EventSource {
  tenantId: string
  userId: string | null
  attributedUserId: string | null
  plan: BillingDomainEvent['plan']
  billingState: BillingDomainEvent['billingState']
  dedupeKey?: string
  at: Date
}

/**
 * The plan and state a stored row reads as.
 * @param row - The billing row.
 * @returns Its plan key and state.
 */
function traitsOf(row: TenantBillingRecord): Pick<EventSource, 'plan' | 'billingState'> {
  return { plan: planKeyForState(row.state), billingState: row.state }
}

/**
 * Emit one billing event.
 * @param source - Its workspace, people, plan, key and time.
 * @param detail - Its type and fields.
 */
async function emit(source: EventSource, detail: BillingEventDetail): Promise<void> {
  const event: BillingDomainEvent = { ...source, ...detail }
  await emitDomainEvent(event, { access: 'member' })
}

/**
 * Log an event that could not be sent, by ids.
 * @param error - What went wrong.
 * @param tenantId - The workspace.
 * @param event - The event type.
 */
function logFailure(error: unknown, tenantId: string, event: string): void {
  logger.warn('Could not send a billing analytics event', {
    error: redactedForLog(error),
    tenantId,
    event,
  })
}

/**
 * The person an attribution names on a row.
 * @param row - The billing row after the change.
 * @param attribution - Who the event is attributed to.
 * @param trialUserId - The trial's owner, read only when needed.
 * @returns The user's id, or null when nobody is known.
 */
async function attributedOf(
  row: TenantBillingRecord,
  attribution: BillingAttribution,
  trialUserId: () => Promise<string | null>
): Promise<string | null> {
  switch (attribution) {
    case 'checkout': {
      return row.checkoutStartedBy ?? row.payerUserId
    }
    case 'payer': {
      return row.payerUserId ?? row.checkoutStartedBy ?? (await trialUserId())
    }
    case 'trial': {
      return trialUserId()
    }
  }
}

/**
 * What a committed change passes besides its rows.
 */
export interface BillingAnalyticsExtras {
  /**
   * The member whose own action made the change, such as the owner who cancelled.
   */
  actorUserId?: string
  /**
   * The upgrade requests the change fulfilled.
   */
  fulfilledRequests?: readonly UpgradeRequest[]
}

/**
 * Send the analytics events a committed billing change calls for
 * (`billingDiffEvents`), and an `upgrade_request_fulfilled` per fulfilled
 * request, attributed to its requester. Each event's dedupe key is the
 * workspace, the event and the row version the change wrote, so the same
 * change passed in again writes nothing.
 * @param before - The row before the change.
 * @param after - The row after it.
 * @param source - What made the change.
 * @param extras - The acting member and the fulfilled requests.
 */
export async function emitBillingDiffAnalytics(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  source: BillingHistorySource,
  extras: BillingAnalyticsExtras = {}
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  const { tenantId } = after
  try {
    const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId)
    if (tenant === undefined || tenant.isPlatform) return
    const priceIds = [after.priceId, after.nextPriceId].filter((id) => id !== null)
    const prices = await planRepository.findPricesByIds(priceIds)
    const intervals = new Map<string, BillingInterval>(
      prices.map((price) => [price.id, price.interval])
    )
    const events = billingDiffEvents(before, after, source, {
      isWorkspaceActive: tenant.lifecycleState === 'active' && tenant.deletedAt === null,
      intervalOf: (priceId) => (priceId === null ? undefined : intervals.get(priceId)),
    })
    let trialUser: string | null | undefined
    /**
     * The trial's owner, read once.
     * @returns Their id, or null.
     */
    const trialUserId = async (): Promise<string | null> => {
      trialUser ??= (await billingRepository.findTrialUserId(tenantId)) ?? null
      return trialUser
    }
    const base = { tenantId, ...traitsOf(after), at: after.updatedAt }
    for (const { detail, attribution } of events) {
      await emit(
        {
          ...base,
          userId: extras.actorUserId ?? null,
          attributedUserId: await attributedOf(after, attribution, trialUserId),
          dedupeKey: `${tenantId}:${detail.type}:${String(after.version)}`,
        },
        detail
      )
    }
    for (const request of extras.fulfilledRequests ?? []) {
      await emit(
        {
          ...base,
          userId: null,
          attributedUserId: request.requestedBy,
          dedupeKey: `${tenantId}:upgrade_request_fulfilled:${request.id}`,
        },
        { type: 'upgrade_request_fulfilled' }
      )
    }
  } catch (error) {
    logFailure(error, tenantId, 'billing_diff')
  }
}

/**
 * Read a workspace's billing row for an event that is not a diff.
 * @param tenantId - The workspace.
 * @returns The row, or undefined for a workspace with none.
 */
async function rowOf(tenantId: string): Promise<TenantBillingRecord | undefined> {
  return billingRepository.findByTenantId(tenantId)
}

/**
 * Send `trial_started` for a workspace whose trial just started, as the user
 * who started it: its creator, or the owner whose acceptance started it.
 * Once per trial start.
 * @param tenantId - The workspace.
 * @param userId - The user.
 */
export async function trackTrialStarted(tenantId: string, userId: string): Promise<void> {
  if (!isAnalyticsEnabled()) return
  try {
    const row = await rowOf(tenantId)
    if (row?.state !== 'trialing' || row.trialStartedAt === null) return
    await emit(
      {
        tenantId,
        userId,
        attributedUserId: null,
        ...traitsOf(row),
        dedupeKey: `${tenantId}:trial_started:${String(row.trialStartedAt.getTime())}`,
        at: row.trialStartedAt,
      },
      { type: 'trial_started' }
    )
  } catch (error) {
    logFailure(error, tenantId, 'trial_started')
  }
}

/**
 * Send `trial_reminder_sent` for a trial reminder that went out, with the
 * whole days left, attributed to the trial's owner. Once per reminder and
 * trial end.
 * @param row - The trial's row.
 * @param reminder - Which reminder, for the dedupe key.
 * @param now - When it went out.
 */
export async function trackTrialReminder(
  row: TenantBillingRecord,
  reminder: string,
  now: Date
): Promise<void> {
  if (!isAnalyticsEnabled() || row.trialEndsAt === null) return
  const { tenantId } = row
  try {
    const daysLeft = Math.max(0, Math.ceil((row.trialEndsAt.getTime() - now.getTime()) / DAY_MS))
    await emit(
      {
        tenantId,
        userId: null,
        attributedUserId: (await billingRepository.findTrialUserId(tenantId)) ?? null,
        ...traitsOf(row),
        dedupeKey: `${tenantId}:trial_reminder_sent:${reminder}:${String(row.trialEndsAt.getTime())}`,
        at: now,
      },
      { type: 'trial_reminder_sent', daysLeft }
    )
  } catch (error) {
    logFailure(error, tenantId, 'trial_reminder_sent')
  }
}

/**
 * Send `checkout_started` as the owner who opened an upgrade checkout.
 * @param row - The row the checkout was stored on.
 * @param input - The owner, and what the checkout charges.
 * @param input.userId - The owner.
 * @param input.interval - How often it bills.
 * @param input.amountMinor - The price in paise.
 * @param input.currency - The price's currency.
 * @param input.duringTrial - Whether a trial was running.
 */
export async function trackCheckoutStarted(
  row: TenantBillingRecord,
  input: {
    userId: string
    interval: BillingInterval
    amountMinor: number
    currency: string
    duringTrial: boolean
  }
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  const { tenantId } = row
  try {
    await emit(
      {
        tenantId,
        userId: input.userId,
        attributedUserId: null,
        ...traitsOf(row),
        at: row.updatedAt,
      },
      {
        type: 'checkout_started',
        interval: input.interval,
        amountMinor: input.amountMinor,
        currency: input.currency,
        duringTrial: input.duringTrial,
      }
    )
  } catch (error) {
    logFailure(error, tenantId, 'checkout_started')
  }
}

/**
 * Send `checkout_confirmed` as the owner whose upgrade checkout the
 * provider's answer confirmed, with the workspace as the sync left it. Once
 * per subscription.
 * @param tenantId - The workspace.
 * @param userId - The owner.
 * @param subscriptionId - The confirmed subscription.
 */
export async function trackCheckoutConfirmed(
  tenantId: string,
  userId: string,
  subscriptionId: string
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  try {
    const row = await rowOf(tenantId)
    if (row === undefined) return
    await emit(
      {
        tenantId,
        userId,
        attributedUserId: null,
        ...traitsOf(row),
        dedupeKey: `${tenantId}:checkout_confirmed:${subscriptionId}`,
        at: new Date(),
      },
      { type: 'checkout_confirmed' }
    )
  } catch (error) {
    logFailure(error, tenantId, 'checkout_confirmed')
  }
}

/**
 * Claim a throttle key for an hour.
 * @param parts - What the key throttles.
 * @returns True when this is the first claim in the hour; false when it is not, or Redis failed.
 */
async function isFirstThisHour(...parts: string[]): Promise<boolean> {
  try {
    const reply = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.set(redisKey('billing', 'analytics-throttle', ...parts), '1', {
        condition: 'NX',
        expiration: { type: 'EX', value: THROTTLE_SECONDS },
      })
    }, 'billing analytics throttle')
    return reply !== null
  } catch (error) {
    logger.warn('Billing analytics throttle unavailable; skipping the event', {
      error,
      tenantId: parts[1],
    })
    return false
  }
}

/**
 * A plan refusal to report.
 */
export interface PlanRefusal {
  tenantId: string
  /**
   * `limit` for a members-style cap, `feature` for a Paid feature.
   */
  kind: 'limit' | 'feature'
  key: string
  /**
   * The person refused, when known: a member, or an invitee who has an account.
   */
  userId: string | null
  /**
   * How the refused person reached the workspace: staff (`platform`) send nothing.
   */
  access: 'member' | 'platform'
}

/**
 * Report a plan refusal after its transaction rolled back, with the
 * workspace's plan, state and use as they are now: `plan_limit_reached`
 * every time, `plan_feature_blocked` at most once per workspace, key and
 * hour. Each one sent counts toward the group's `limit_hits_30d`. A staff
 * refusal sends nothing.
 * @param refusal - What was refused, and for whom.
 */
export async function emitPlanRefusal(refusal: PlanRefusal): Promise<void> {
  if (!isAnalyticsEnabled() || refusal.access === 'platform') return
  const { tenantId, key } = refusal
  const type = refusal.kind === 'limit' ? 'plan_limit_reached' : 'plan_feature_blocked'
  try {
    if (refusal.kind === 'feature' && !(await isFirstThisHour(type, tenantId, key))) return
    const entitlements = await getEffectiveEntitlements(tenantId)
    const source: EventSource = {
      tenantId,
      userId: refusal.userId,
      attributedUserId: null,
      plan: entitlements.plan.key,
      billingState: entitlements.state,
      at: new Date(),
    }
    if (refusal.kind === 'feature') {
      await emit(source, { type: 'plan_feature_blocked', key })
    } else {
      const usage = entitlements.limits[key]
      if (usage === undefined || usage.limit === null) return
      await emit(source, {
        type: 'plan_limit_reached',
        key,
        used: usage.used,
        limit: usage.limit,
      })
    }
    await recordLimitHit(tenantId)
  } catch (error) {
    logFailure(error, tenantId, type)
  }
}

/**
 * After a member's write that took one seat commits: send
 * `plan_limit_approaching` when it took the workspace's use across the
 * limit's soft line (`softAt` of the cap), at most once per workspace, key
 * and hour.
 * @param tenantId - The workspace.
 * @param key - The limit.
 * @param userId - The member who wrote.
 */
export async function trackLimitApproaching(
  tenantId: string,
  key: 'members',
  userId: string
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  try {
    const entitlements = await getEffectiveEntitlements(tenantId)
    const usage = entitlements.limits[key]
    if (usage === undefined || usage.limit === null) return
    const definition: EntitlementDefinition = ENTITLEMENTS[key]
    const line = usage.limit * (definition.softAt ?? 1)
    if (usage.used < line || usage.used - 1 >= line) return
    if (!(await isFirstThisHour('plan_limit_approaching', tenantId, key))) return
    await emit(
      {
        tenantId,
        userId,
        attributedUserId: null,
        plan: entitlements.plan.key,
        billingState: entitlements.state,
        at: new Date(),
      },
      { type: 'plan_limit_approaching', key, used: usage.used, limit: usage.limit }
    )
  } catch (error) {
    logFailure(error, tenantId, 'plan_limit_approaching')
  }
}

/**
 * Send `payer_left` for a payer who left a workspace while its subscription
 * runs. Once per workspace, payer and day.
 * @param row - The workspace's row.
 * @param payerUserId - The payer; null when the account was deleted, which makes it a system event.
 * @param leftOn - The day they left, for the dedupe key.
 * @param at - When they left.
 */
export async function trackPayerLeft(
  row: TenantBillingRecord,
  payerUserId: string | null,
  leftOn: string,
  at: Date
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  const { tenantId } = row
  try {
    await emit(
      {
        tenantId,
        userId: null,
        attributedUserId: payerUserId,
        ...traitsOf(row),
        dedupeKey: `${tenantId}:payer_left:${row.payerUserId ?? ''}:${leftOn}`,
        at,
      },
      { type: 'payer_left' }
    )
  } catch (error) {
    logFailure(error, tenantId, 'payer_left')
  }
}

/**
 * Send one event the provider caused on a workspace's current row,
 * attributed to the payer (or the checkout's starter). Once per stamp.
 * @param tenantId - The workspace.
 * @param type - The event.
 * @param stamp - What fixes it: the subscription or dispute id.
 */
export async function trackProviderEvent(
  tenantId: string,
  type: 'duplicate_subscription_refunded' | 'dispute_opened',
  stamp: string
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  try {
    const row = await rowOf(tenantId)
    if (row === undefined) return
    await emit(
      {
        tenantId,
        userId: null,
        attributedUserId: row.payerUserId ?? row.checkoutStartedBy,
        ...traitsOf(row),
        dedupeKey: `${tenantId}:${type}:${stamp}`,
        at: new Date(),
      },
      { type }
    )
  } catch (error) {
    logFailure(error, tenantId, type)
  }
}
