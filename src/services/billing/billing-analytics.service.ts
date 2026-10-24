/**
 * @file The billing analytics events, emitted as product domain events after
 * the change they report has committed (or, for a refusal, after its
 * transaction rolled back), never inside a transaction. The analytics
 * forwarder turns each into an outbox row plus its workspace's group marker.
 *
 * Attribution: a member's own action (a checkout, a cancel, a refused
 * invite) is that member's. A change the provider, a job or the reconcile
 * made is attributed to a person when one is known: the owner who started
 * the checkout for an activation, an interval change or a first charge, the
 * payer for the rest, the trial's owner for a trial's events (then the payer
 * and the checkout's starter, for a trial staff gave). A soft-deleted
 * account is never named; the next person is, and only an event with no such
 * person left is a system event. Staff are never named: a staff member's own
 * action sends no product event (its audit entry is forwarded already), and
 * a staff-made change is sent as the person the rules attribute it to. An
 * invitee refused at the door is not a member, so that refusal is a system
 * event with no use or cap.
 *
 * Every event carries the workspace's plan and billing state after the
 * change. An event fixed by a stamp (the row's version, a subscription, a
 * dispute, a trial's end) carries a dedupe key and a time taken from the same
 * stable data, never the clock, so the same change sent twice, before or
 * after the outbox drained, is one event to PostHog (it dedupes on uuid,
 * timestamp, event and distinct id). `plan_feature_blocked` and
 * `plan_limit_approaching` are sent at most once per workspace, key and hour:
 * a Redis key claimed before the outbox write and released when the write
 * fails; when Redis fails, the event is skipped and the request goes on.
 *
 * An owner's or a staff cancel leaves a short-lived marker (`markCancel`)
 * before it calls the provider, so a cancel the provider's webhook brings in
 * first is still sent as theirs (`by: owner` as the owner, `by: staff` as the
 * payer). A staff resync with no marker reads the provider's real cause.
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
import { UserRepository } from '@/repositories/user.repository'
import { productEventRows } from '@/services/analytics/analytics-forwarder.service'
import { enqueueAnalyticsOrThrow } from '@/services/analytics/analytics-outbox.service'
import { getEffectiveEntitlements, type LimitCheck } from '@/services/billing/entitlements.service'
import { recordLimitHit } from '@/services/billing/plan-limit-hits.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { logger } from '@/services/logger.service'
import { waitForRedisWrite, withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import type { SourcedEntitlements } from '@/types/billing'
import type { BillingDomainEvent, BillingEventDetail } from '@/types/domain-event'
import {
  billingActorOf,
  billingDiffEvents,
  type BillingAttribution,
} from '@/utilities/billing-analytics.utilities'
import { limitUsage, planKeyForState } from '@/utilities/billing-rules.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a throttled event stays quiet for one workspace and key.
 */
const THROTTLE_SECONDS = 60 * 60

/**
 * How long a cancel marker lives: past the provider call and its
 * webhook's arrival.
 */
const CANCEL_MARKER_SECONDS = 15 * 60

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
 * The first of the candidates whose account exists and is not soft-deleted.
 * @param candidates - User ids, most fitting first; null for an empty slot.
 * @returns The id, or null when none is a live account.
 */
async function firstLiveUser(candidates: readonly (string | null)[]): Promise<string | null> {
  for (const id of candidates) {
    if (id !== null && (await userRepository.findById(id)) !== undefined) return id
  }
  return null
}

/**
 * The person an attribution names on a row, skipping soft-deleted accounts.
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
      return firstLiveUser([row.checkoutStartedBy, row.payerUserId])
    }
    case 'payer': {
      const found = await firstLiveUser([row.payerUserId, row.checkoutStartedBy])
      return found ?? firstLiveUser([await trialUserId()])
    }
    case 'trial': {
      // A trial staff gave a workspace that paid before has no claimant: its payer, else its starter, as for `trial_extended`.
      return firstLiveUser([await trialUserId(), row.payerUserId, row.checkoutStartedBy])
    }
  }
}

/**
 * Who a cancel marker records: an owner by id, or staff, who are never named.
 */
type CancelMarker = { by: 'owner'; userId: string } | { by: 'staff' }

/**
 * The cancel marker for one subscription.
 * @param tenantId - The workspace.
 * @param subscriptionId - The subscription.
 * @returns The Redis key.
 */
function cancelMarkerKey(tenantId: string, subscriptionId: string): string {
  return redisKey('billing', 'cancel-marker', tenantId, subscriptionId)
}

/**
 * A marker as stored: `owner:<id>` or `staff`.
 * @param marker - The marker.
 * @returns The stored text.
 */
function markerText(marker: CancelMarker): string {
  return marker.by === 'owner' ? `owner:${marker.userId}` : 'staff'
}

/**
 * Read a stored marker.
 * @param text - The stored text.
 * @returns The marker, or null for text in no known shape.
 */
function parseMarker(text: string): CancelMarker | null {
  if (text === 'staff') return { by: 'staff' }
  if (text.startsWith('owner:') && text.length > 'owner:'.length) {
    return { by: 'owner', userId: text.slice('owner:'.length) }
  }
  return null
}

/**
 * Record, before the provider is asked, who is cancelling a subscription
 * (an owner, or staff), so whichever write lands the cancel first sends it
 * as theirs: `by: owner` as that owner, `by: staff` as the payer. Lives
 * `CANCEL_MARKER_SECONDS`. Never rejects; a failure leaves the event to the
 * usual rules.
 * @param tenantId - The workspace.
 * @param subscriptionId - The subscription being cancelled.
 * @param marker - Who is cancelling.
 */
export async function markCancel(
  tenantId: string,
  subscriptionId: string,
  marker: CancelMarker
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  try {
    await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.set(cancelMarkerKey(tenantId, subscriptionId), markerText(marker), {
        expiration: { type: 'EX', value: CANCEL_MARKER_SECONDS },
      })
    }, 'billing cancel marker')
  } catch (error) {
    logger.warn('Could not mark a cancel', { error: redactedForLog(error), tenantId })
  }
}

/**
 * Forget a cancel marker when the cancel did not happen. Best effort: a
 * failure leaves the marker to expire.
 * @param tenantId - The workspace.
 * @param subscriptionId - The subscription.
 */
export async function clearCancelMarker(tenantId: string, subscriptionId: string): Promise<void> {
  if (!isAnalyticsEnabled()) return
  try {
    await waitForRedisWrite(
      async () => {
        const redis = await getRedis()
        return redis.del(cancelMarkerKey(tenantId, subscriptionId))
      },
      'billing cancel marker release',
      () => {}
    )
  } catch (error) {
    logger.warn('Could not clear a cancel marker', {
      error: redactedForLog(error),
      tenantId,
    })
  }
}

/**
 * The cancel of a subscription on record, and who made it.
 * @param tenantId - The workspace.
 * @param subscriptionId - The subscription, or null.
 * @returns The marker, or null when none is on record or Redis failed.
 */
async function cancelMarkerOf(
  tenantId: string,
  subscriptionId: string | null
): Promise<CancelMarker | null> {
  if (subscriptionId === null) return null
  try {
    const text = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.get(cancelMarkerKey(tenantId, subscriptionId))
    }, 'billing cancel marker read')
    return text === null ? null : parseMarker(text)
  } catch (error) {
    logger.warn('Could not read a cancel marker', { error: redactedForLog(error), tenantId })
    return null
  }
}

/**
 * Whether a state pays.
 * @param state - The state.
 * @returns True for `active` and `past_due`.
 */
function isPaying(state: TenantBillingRecord['state']): boolean {
  return state === 'active' || state === 'past_due'
}

/**
 * Whether a change may be a cancel: the period-end cancel turned on, or the
 * row left a paying state.
 * @param before - The row before.
 * @param after - The row after.
 * @returns True when a cancel marker is worth reading.
 */
function canBeCancel(before: TenantBillingRecord, after: TenantBillingRecord): boolean {
  return (
    (!before.cancelAtPeriodEnd && after.cancelAtPeriodEnd) ||
    (isPaying(before.state) && !isPaying(after.state))
  )
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
  /**
   * The change is a staff member's own cancel, not a resync of the
   * provider's: its events read `by: staff` and cause `staff`.
   */
  isStaffCancel?: boolean
}

/**
 * Send the analytics events a committed billing change calls for
 * (`billingDiffEvents`), and an `upgrade_request_fulfilled` per fulfilled
 * request, attributed to its requester. Each event's dedupe key is the
 * workspace, the event and the row version the change wrote, and its time is
 * that write's, so the same change passed in again is the same event. A
 * staff-made change names no member: it goes to the person the rules
 * attribute it to.
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
    const marker = canBeCancel(before, after)
      ? await cancelMarkerOf(tenantId, before.providerSubscriptionId)
      : null
    const cancellingOwner = marker?.by === 'owner' ? marker.userId : null
    const actor = billingActorOf(source, extras.actorUserId)
    const events = billingDiffEvents(before, after, source, {
      isWorkspaceActive: tenant.lifecycleState === 'active' && tenant.deletedAt === null,
      intervalOf: (priceId) => (priceId === null ? undefined : intervals.get(priceId)),
      // A sync an owner's request ran names no actor: it brings in what the provider did.
      isOwnerAct: actor !== null,
      isOwnerCancel: cancellingOwner !== null,
      isStaffCancel: extras.isStaffCancel === true,
      hasStaffCancelMarker: marker?.by === 'staff',
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
      const isOwnersCancel =
        detail.type === 'subscription_cancel_scheduled' && detail.by === 'owner'
      await emit(
        {
          ...base,
          userId: isOwnersCancel ? (actor ?? cancellingOwner) : actor,
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
          attributedUserId: await firstLiveUser([request.requestedBy]),
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
 * Once per trial start, timed at the start.
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
 * The trial reminders, and how long before the trial's end each is timed.
 */
const REMINDER_LEAD_MS = {
  trial_ending: 3 * DAY_MS,
  trial_ends_today: DAY_MS,
} as const

/**
 * Which trial reminder went out.
 */
export type TrialReminder = 'trial_midpoint' | keyof typeof REMINDER_LEAD_MS

/**
 * A reminder's event time, fixed by the trial: halfway through it for the
 * midpoint (a week before the end without a start), else a fixed lead before
 * its end. Never the clock, so a repeat is the same event.
 * @param row - The trial's row.
 * @param trialEndsAt - Its end.
 * @param reminder - Which reminder.
 * @returns The time.
 */
function reminderTime(row: TenantBillingRecord, trialEndsAt: Date, reminder: TrialReminder): Date {
  const end = trialEndsAt.getTime()
  if (reminder !== 'trial_midpoint') return new Date(end - REMINDER_LEAD_MS[reminder])
  const start = row.trialStartedAt?.getTime() ?? end - 14 * DAY_MS
  return new Date(start + Math.floor((end - start) / 2))
}

/**
 * Send `trial_reminder_sent` for a trial reminder that went out, with the
 * whole days left, attributed to the trial's owner, else the payer or the
 * owner who started a checkout (as `trial_extended`), else it is a system
 * event. Once per reminder and trial end.
 * @param row - The trial's row.
 * @param reminder - Which reminder.
 * @param now - When it went out, for the days left.
 */
export async function trackTrialReminder(
  row: TenantBillingRecord,
  reminder: TrialReminder,
  now: Date
): Promise<void> {
  if (!isAnalyticsEnabled() || row.trialEndsAt === null) return
  const { tenantId, trialEndsAt } = row
  try {
    const daysLeft = Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS))
    await emit(
      {
        tenantId,
        userId: null,
        attributedUserId: await firstLiveUser([
          (await billingRepository.findTrialUserId(tenantId)) ?? null,
          row.payerUserId,
          row.checkoutStartedBy,
        ]),
        ...traitsOf(row),
        dedupeKey: `${tenantId}:trial_reminder_sent:${reminder}:${String(trialEndsAt.getTime())}`,
        at: reminderTime(row, trialEndsAt, reminder),
      },
      { type: 'trial_reminder_sent', daysLeft }
    )
  } catch (error) {
    logFailure(error, tenantId, 'trial_reminder_sent')
  }
}

/**
 * Send `trial_extended` for a trial staff extended, with the days added.
 * Staff are never named: the event is attributed to the trial's owner,
 * else the payer or the owner who started a checkout, else it is a system
 * event. Once per extension, timed at the write that made it.
 * @param row - The row the extension wrote.
 * @param days - The days added.
 */
export async function trackTrialExtended(row: TenantBillingRecord, days: number): Promise<void> {
  if (!isAnalyticsEnabled()) return
  const { tenantId } = row
  try {
    await emit(
      {
        tenantId,
        userId: null,
        attributedUserId: await firstLiveUser([
          (await billingRepository.findTrialUserId(tenantId)) ?? null,
          row.payerUserId,
          row.checkoutStartedBy,
        ]),
        ...traitsOf(row),
        dedupeKey: `${tenantId}:trial_extended:${String(row.version)}`,
        at: row.updatedAt,
      },
      { type: 'trial_extended', days }
    )
  } catch (error) {
    logFailure(error, tenantId, 'trial_extended')
  }
}

/**
 * Send `checkout_started` as the owner who opened an upgrade checkout, timed
 * at the write that stored it.
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
 * Send `checkout_confirmed` for an upgrade checkout the provider's answer
 * confirmed, as the owner who started it (the same person its activation is
 * sent as), with the workspace as the sync left it. Once per subscription,
 * timed at the subscription's first cycle (or its first charge, when that
 * waits for a trial's end).
 * @param tenantId - The workspace.
 * @param confirmer - The owner who confirmed, named when the starter is gone.
 * @param subscription - The confirmed subscription as the provider read it.
 * @param subscription.id - Its id.
 * @param subscription.currentStart - When its first cycle started, if it did.
 * @param subscription.startAt - When its first charge is due, if deferred.
 * @param subscription.createdAt - When the provider created it, the time when it has neither.
 */
export async function trackCheckoutConfirmed(
  tenantId: string,
  confirmer: string,
  subscription: {
    id: string
    currentStart: Date | null
    startAt: Date | null
    createdAt: Date | null
  }
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  try {
    const row = await rowOf(tenantId)
    if (row === undefined) return
    const starter = await firstLiveUser([row.checkoutStartedBy])
    await emit(
      {
        tenantId,
        userId: starter ?? confirmer,
        attributedUserId: null,
        ...traitsOf(row),
        dedupeKey: `${tenantId}:checkout_confirmed:${subscription.id}`,
        at:
          subscription.currentStart ??
          subscription.startAt ??
          subscription.createdAt ??
          row.updatedAt,
      },
      { type: 'checkout_confirmed' }
    )
  } catch (error) {
    logFailure(error, tenantId, 'checkout_confirmed')
  }
}

/**
 * Send `upgrade_requested` for a request just opened, as the member who
 * asked, with the workspace as it stands. Once per request opening: the
 * dedupe key and the time are the request's id and creation time, so a
 * request reopened after it lapsed is a new event.
 * @param request - The request.
 */
export async function trackUpgradeRequested(request: UpgradeRequest): Promise<void> {
  if (!isAnalyticsEnabled()) return
  const { tenantId } = request
  try {
    const row = await rowOf(tenantId)
    if (row === undefined) return
    await emit(
      {
        tenantId,
        userId: request.requestedBy,
        attributedUserId: null,
        ...traitsOf(row),
        dedupeKey: `${tenantId}:upgrade_requested:${request.id}:${String(request.createdAt.getTime())}`,
        at: request.createdAt,
      },
      { type: 'upgrade_requested', key: request.entitlementKey, surface: request.surface }
    )
  } catch (error) {
    logFailure(error, tenantId, 'upgrade_requested')
  }
}

/**
 * Claim a throttle key for an hour.
 * @param key - The throttle key.
 * @returns True when this is the first claim in the hour; false when it is not, or Redis failed.
 */
async function isFirstThisHour(key: string): Promise<boolean> {
  try {
    const reply = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.set(key, '1', {
        condition: 'NX',
        expiration: { type: 'EX', value: THROTTLE_SECONDS },
      })
    }, 'billing analytics throttle')
    return reply !== null
  } catch (error) {
    logger.warn('Billing analytics throttle unavailable; skipping the event', {
      error: redactedForLog(error),
    })
    return false
  }
}

/**
 * Release a throttle key whose event was not written, so the next refusal
 * sends it. Best effort: a failure leaves the key to expire.
 * @param key - The throttle key.
 */
async function releaseThrottle(key: string): Promise<void> {
  try {
    await waitForRedisWrite(
      async () => {
        const redis = await getRedis()
        return redis.del(key)
      },
      'billing analytics throttle release',
      () => {}
    )
  } catch {
    // The key expires within the hour.
  }
}

/**
 * Send a throttled event: claim the hour's key, write the event's rows to
 * the outbox, and release the key when the write failed, so a failure never
 * silences the event for the hour.
 * @param event - The billing event.
 * @param keyParts - What the throttle is per: the event, the workspace and the key.
 * @returns True when the event was written.
 */
async function didSendThrottled(
  event: BillingDomainEvent,
  keyParts: readonly string[]
): Promise<boolean> {
  const key = redisKey('billing', 'analytics-throttle', ...keyParts)
  if (!(await isFirstThisHour(key))) return false
  try {
    await enqueueAnalyticsOrThrow(productEventRows(event, 'member'))
    return true
  } catch (error) {
    await releaseThrottle(key)
    throw error
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
   * The member refused. Ignored for an outsider.
   */
  userId: string | null
  /**
   * Who was refused: a `member` (an inviter or a feature's user), an
   * `outsider` (an invitee refused at the door: a system event with no use
   * or cap), or `platform` staff, who send nothing.
   */
  audience: 'member' | 'outsider' | 'platform'
  /**
   * The entitlements the refusal was decided on, when the caller has them.
   */
  entitlements?: SourcedEntitlements
}

/**
 * Report a plan refusal after its transaction rolled back, with the
 * workspace's plan, state and use as they are now: `plan_limit_reached`
 * every time, `plan_feature_blocked` at most once per workspace, key and
 * hour. Every member or outsider refusal counts toward the group's
 * `limit_hits_30d`, a feature refusal the hour's throttle kept quiet too. A
 * staff refusal sends and counts nothing.
 * @param refusal - What was refused, and for whom.
 */
export async function emitPlanRefusal(refusal: PlanRefusal): Promise<void> {
  if (!isAnalyticsEnabled() || refusal.audience === 'platform') return
  const { tenantId, key } = refusal
  const type = refusal.kind === 'limit' ? 'plan_limit_reached' : 'plan_feature_blocked'
  try {
    const entitlements = refusal.entitlements ?? (await getEffectiveEntitlements(tenantId))
    const isOutsider = refusal.audience === 'outsider'
    const source: EventSource = {
      tenantId,
      userId: isOutsider ? null : refusal.userId,
      attributedUserId: null,
      plan: entitlements.plan.key,
      billingState: entitlements.state,
      at: new Date(),
    }
    if (refusal.kind === 'feature') {
      // Counted before the throttle: the group's count takes the hour's quiet refusals too.
      await recordLimitHit(tenantId)
      const event: BillingDomainEvent = { ...source, type: 'plan_feature_blocked', key }
      await didSendThrottled(event, [type, tenantId, key])
      return
    }
    const usage = entitlements.limits[key]
    if (usage === undefined || usage.limit === null) return
    await emit(source, {
      type: 'plan_limit_reached',
      key,
      ...(!isOutsider && { usage: { used: usage.used, limit: usage.limit } }),
    })
    await recordLimitHit(tenantId)
  } catch (error) {
    logFailure(error, tenantId, type)
  }
}

/**
 * After a member's write that took one seat commits: send
 * `plan_limit_approaching` when the seat moved the workspace into the
 * limit's "approaching" band, by the same rule the app shows
 * (`limitUsage`), at most once per workspace, key and hour. The use before
 * the write was read under the seat lock, so two writes at once each see
 * their own step and only the one that crosses sends.
 * @param tenantId - The workspace.
 * @param key - The limit.
 * @param userId - The member who wrote.
 * @param check - The use before the write, the cap, and the plan and state, read under the seat lock.
 * @param at - When the write that took the seat was made.
 */
export async function trackLimitApproaching(
  tenantId: string,
  key: 'members',
  userId: string,
  check: LimitCheck,
  at: Date
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  try {
    const definition: EntitlementDefinition = ENTITLEMENTS[key]
    const used = check.used + 1
    const isCrossing =
      limitUsage(check.limit, used, definition.softAt).approaching &&
      !limitUsage(check.limit, check.used, definition.softAt).approaching
    if (!isCrossing) return
    const event: BillingDomainEvent = {
      tenantId,
      userId,
      attributedUserId: null,
      plan: check.plan,
      billingState: check.state,
      at,
      type: 'plan_limit_approaching',
      key,
      used,
      limit: check.limit,
    }
    await didSendThrottled(event, ['plan_limit_approaching', tenantId, key])
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
 * Send one event the provider caused, reported by a committed write of the
 * workspace's row, attributed to the payer (or the checkout's starter). Once
 * per stamp, timed at that write.
 * @param row - The row the write left.
 * @param type - The event.
 * @param stamp - What fixes it: the subscription or dispute id.
 */
export async function trackProviderEvent(
  row: TenantBillingRecord,
  type: 'duplicate_subscription_refunded' | 'dispute_opened',
  stamp: string
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  const { tenantId } = row
  try {
    await emit(
      {
        tenantId,
        userId: null,
        attributedUserId: await firstLiveUser([row.payerUserId, row.checkoutStartedBy]),
        ...traitsOf(row),
        dedupeKey: `${tenantId}:${type}:${stamp}`,
        at: row.updatedAt,
      },
      { type }
    )
  } catch (error) {
    logFailure(error, tenantId, type)
  }
}
