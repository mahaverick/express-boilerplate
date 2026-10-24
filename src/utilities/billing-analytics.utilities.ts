/**
 * @file Which billing analytics events a committed change sends, read only
 * from the row before and after it and the source of the change. Pure: the
 * caller reads the workspace's lifecycle and the prices' intervals and
 * passes them in, then resolves each event's attribution to a person. Each
 * rule fires on one column's move, so a write that repeats the same state
 * sends nothing.
 *
 * - `subscription_activated`: the row becomes `active` from a state other
 *   than `past_due` with a new current subscription. Attributed to the owner
 *   who started the checkout.
 * - `subscription_recovered`: a `past_due` row is `active` again.
 * - `subscription_renewed`: an `active` row's paid period moves forward on
 *   the same subscription. The first charge after an upgrade during a trial
 *   counts too: it moves the period from the trial's end, and it (with a
 *   failure or halt of it) is attributed to the checkout's starter.
 * - `payment_failed`: `pastDueSince` is set; its code says whether the
 *   provider still retries, gave up (halted) or the payer paused.
 * - `subscription_halted`: `haltedAt` is set.
 * - `subscription_cancel_scheduled`: `cancelAtPeriodEnd` turns on and no
 *   switch or resubscribe continues Paid, or an owner cancels a subscription
 *   before its first charge, or staff cancel one now (the row leaves Paid at
 *   once). `by` comes from an owner's own write (`isOwnerAct`), from an
 *   owner's or staff cancel on record (`isOwnerCancel`, `isStaffCancel`), and
 *   from the lifecycle for a suspended or archived workspace. A sync an owner
 *   or staff member ran reads the provider's own cause.
 * - `subscription_interval_change_scheduled`: the next subscription is first
 *   authenticated on another interval than the current one.
 * - `trial_ended`: a trialing row moves to Free.
 * - `downgraded_to_free`: the row becomes `free`, with its cause.
 * - `billing_reconciled`: the reconcile changed a column the members see;
 *   `field` names the first that changed, in `RECONCILE_FIELDS` order.
 *
 * Every event but the activation, the interval change and a trial's end is
 * attributed to the payer.
 */
import type { BillingHistorySource, BillingInterval } from '@/constants/billing.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import type { ProviderSubscription } from '@/types/billing'
import type { BillingEventDetail, CancelScheduledBy } from '@/types/domain-event'
import { isPeriodEndAtOrBeforeSync } from '@/utilities/billing-rules.utilities'
import {
  downgradeCauseOf,
  isContinued,
  type DowngradeCause,
} from '@/utilities/billing-transitions.utilities'

/**
 * Who an event is attributed to: the owner who started the checkout, the
 * payer, or the user whose trial it is.
 */
export type BillingAttribution = 'checkout' | 'payer' | 'trial'

/**
 * One analytics event a change sends, before its person and plan are filled in.
 */
export interface BillingDiffEvent {
  detail: BillingEventDetail
  attribution: BillingAttribution
}

/**
 * What the rules need besides the rows.
 */
export interface BillingAnalyticsContext {
  /**
   * Whether the workspace is active: not suspended or archived.
   */
  isWorkspaceActive: boolean
  /**
   * Whether the change is an owner's own write: their cancel, or another
   * write they made. A sync an owner's request ran is not one: it only brings
   * in what the provider did, so its source names who asked, not who acted.
   */
  isOwnerAct?: boolean
  /**
   * The interval a price bills, or undefined for an unknown price.
   */
  intervalOf: (priceId: string | null) => BillingInterval | undefined
  /**
   * Whether an owner's cancel of the current subscription is on record (a
   * short-lived marker `cancelPaid` sets before it calls the provider), so a
   * cancel the provider's webhook brings in first is still the owner's.
   */
  isOwnerCancel?: boolean
  /**
   * Whether the change is a staff member's own cancel write: the staff
   * cancel passes it. A staff resync without it reads the provider's real
   * cause.
   */
  isStaffCancel?: boolean
  /**
   * Whether a staff cancel of the current subscription is on record (the
   * short-lived marker the staff cancel sets before it calls the provider),
   * so a cancel the provider's webhook brings in first is still staff's. On
   * a suspended or archived workspace the suspension's cancel wins over it,
   * since the marker may outlive a cancel that failed.
   */
  hasStaffCancelMarker?: boolean
  /**
   * Whether the change's paid period is the first paid cycle of a
   * subscription adopted before that cycle was paid (`isFirstPaidCycle`):
   * the period end it moves from was a stand-in, so it is no renewal.
   */
  isFirstPaidCycle?: boolean
}

/**
 * Whether the provider's current cycle is the first paid one after an
 * adoption: the sync took over an active subscription whose cycle was not
 * paid yet and stored a stand-in period end of that moment, which lies
 * inside the cycle. A renewal's cycle starts where the stored paid period
 * ended, or later. When the provider gives no cycle start, a stored end no
 * later than the last sync (`isPeriodEndAtOrBeforeSync`) stands in for it.
 * @param before - The row before the change.
 * @param current - The row's current subscription as the provider read it.
 * @returns True when the stored period end lies inside the current cycle.
 */
export function isFirstPaidCycle(
  before: TenantBillingRecord,
  current: ProviderSubscription | undefined
): boolean {
  if (
    current === undefined ||
    current.id !== before.providerSubscriptionId ||
    before.currentPeriodEnd === null
  ) {
    return false
  }
  // With no cycle start to compare, a stored end no later than the sync that stored it is the stand-in.
  if (current.currentStart === null) return isPeriodEndAtOrBeforeSync(before)
  return before.currentPeriodEnd > current.currentStart
}

/**
 * The columns a reconcile repair is reported by, most telling first, and
 * the name each is reported under.
 */
const RECONCILE_FIELDS = [
  ['state', 'state'],
  ['priceId', 'price_id'],
  ['currentPeriodEnd', 'current_period_end'],
  ['cancelAtPeriodEnd', 'cancel_at_period_end'],
  ['pastDueSince', 'past_due_since'],
  ['haltedAt', 'halted_at'],
  ['pausedAt', 'paused_at'],
  ['nextPriceId', 'next_price_id'],
  ['nextAuthenticatedAt', 'next_authenticated_at'],
] as const satisfies readonly (readonly [keyof TenantBillingRecord, string])[]

/**
 * Whether a state pays.
 * @param state - The state.
 * @returns True for `active` and `past_due`.
 */
function isPaying(state: TenantBillingRecord['state']): boolean {
  return state === 'active' || state === 'past_due'
}

/**
 * Whether two column values are the same.
 * @param a - One value.
 * @param b - The other.
 * @returns True when equal; dates compare by time.
 */
function isSameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

/**
 * Who scheduled a cancel. A staff or owner source alone is not their cancel:
 * a sync either of them ran only brings in what the provider did.
 * @param isWorkspaceActive - Whether the workspace is active.
 * @param marker - Whether an owner's or a staff member's own cancel is on record.
 * @param marker.isOwnerAct - The change is an owner's own write.
 * @param marker.isOwnerCancel - An owner's cancel is on record.
 * @param marker.isStaffCancel - The change is a staff member's own cancel write.
 * @param marker.hasStaffCancelMarker - A staff member's cancel is on record.
 * @returns The `by` value.
 */
function cancelledBy(
  isWorkspaceActive: boolean,
  marker: {
    isOwnerAct: boolean
    isOwnerCancel: boolean
    isStaffCancel: boolean
    hasStaffCancelMarker: boolean
  }
): CancelScheduledBy {
  const { isOwnerAct, isOwnerCancel, isStaffCancel, hasStaffCancelMarker } = marker
  if (isOwnerAct) return 'owner'
  if (isStaffCancel) return 'staff'
  // A suspension's cancel wins over an owner's or staff marker: the marker may outlive a cancel that failed.
  if (!isWorkspaceActive) return 'suspension'
  if (hasStaffCancelMarker) return 'staff'
  return isOwnerCancel ? 'owner' : 'customer_bank'
}

/**
 * Whether a row's current subscription has not been charged yet: an upgrade
 * during a trial, whose paid period is set to start at the trial's end.
 * @param row - The row.
 * @returns True before the first charge.
 */
function isBeforeFirstCharge(row: TenantBillingRecord): boolean {
  return (
    row.providerSubscriptionId !== null &&
    row.trialEndsAt !== null &&
    row.currentPeriodEnd !== null &&
    row.currentPeriodEnd <= row.trialEndsAt
  )
}

/**
 * The member a change's events are sent as: the member whose own action
 * made it, never staff. A staff-made change is sent as the person the rules
 * attribute it to.
 * @param source - What made the change.
 * @param actorUserId - The member who acted, if any.
 * @returns Their id, or null.
 */
export function billingActorOf(
  source: BillingHistorySource,
  actorUserId: string | undefined
): string | null {
  return source === 'staff' ? null : (actorUserId ?? null)
}

/**
 * Whether a change scheduled a cancel: the period-end cancel turned on
 * without a switch continuing Paid, or an owner or staff ended a
 * subscription at once (before its first charge, or staff cancelling now).
 * @param before - The row before.
 * @param after - The row after.
 * @param isOwnerAct - Whether the change is an owner's own write.
 * @param isStaffCancel - Whether the change is a staff member's own cancel.
 * @returns True when a cancel was scheduled.
 */
function isCancelScheduled(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  isOwnerAct: boolean,
  isStaffCancel: boolean
): boolean {
  if (!before.cancelAtPeriodEnd && after.cancelAtPeriodEnd) return !isContinued(after)
  return (
    (isOwnerAct || isStaffCancel) &&
    isPaying(before.state) &&
    !isPaying(after.state) &&
    !before.cancelAtPeriodEnd
  )
}

/**
 * The analytics events between two rows, in the order they are sent.
 * @param before - The row before the change.
 * @param after - The row after it.
 * @param source - What made the change.
 * @param context - The workspace's lifecycle and the prices' intervals.
 * @returns Each event once with its attribution; none when nothing an event reports changed.
 */
export function billingDiffEvents(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  source: BillingHistorySource,
  context: BillingAnalyticsContext
): BillingDiffEvent[] {
  const events: BillingDiffEvent[] = []
  // The first charge of an upgrade made during a trial belongs to the checkout, not to an older payer.
  const chargeAttribution: BillingAttribution = isBeforeFirstCharge(before) ? 'checkout' : 'payer'
  /**
   * Add one event.
   * @param detail - Its type and fields.
   * @param attribution - Who it is attributed to.
   */
  const add = (detail: BillingEventDetail, attribution: BillingAttribution = 'payer'): void => {
    events.push({ detail, attribution })
  }
  if (before.state === 'past_due' && after.state === 'active') {
    add({ type: 'subscription_recovered' })
  } else if (
    before.state !== 'active' &&
    after.state === 'active' &&
    after.providerSubscriptionId !== null &&
    after.providerSubscriptionId !== before.providerSubscriptionId
  ) {
    add(
      { type: 'subscription_activated', interval: context.intervalOf(after.priceId) ?? null },
      'checkout'
    )
  }
  if (
    before.state === 'active' &&
    after.state === 'active' &&
    after.providerSubscriptionId !== null &&
    after.providerSubscriptionId === before.providerSubscriptionId &&
    before.currentPeriodEnd !== null &&
    after.currentPeriodEnd !== null &&
    after.currentPeriodEnd > before.currentPeriodEnd &&
    context.isFirstPaidCycle !== true
  ) {
    add({ type: 'subscription_renewed' }, chargeAttribution)
  }
  if (before.pastDueSince === null && after.pastDueSince !== null) {
    let failureCode: 'retrying' | 'halted' | 'paused' = 'retrying'
    if (after.haltedAt !== null) failureCode = 'halted'
    else if (after.pausedAt !== null) failureCode = 'paused'
    add({ type: 'payment_failed', failureCode }, chargeAttribution)
  }
  if (before.haltedAt === null && after.haltedAt !== null) {
    add({ type: 'subscription_halted' }, chargeAttribution)
  }
  const hasStaffCancelMarker = context.hasStaffCancelMarker === true
  // Whether staff ended it, by their own write or by the marker of one.
  const isStaffCancel = context.isStaffCancel === true || hasStaffCancelMarker
  const isOwnerAct = source === 'owner' && context.isOwnerAct === true
  if (isCancelScheduled(before, after, isOwnerAct, isStaffCancel)) {
    add({
      type: 'subscription_cancel_scheduled',
      by: cancelledBy(context.isWorkspaceActive, {
        isOwnerAct,
        isOwnerCancel: context.isOwnerCancel === true,
        isStaffCancel: context.isStaffCancel === true,
        hasStaffCancelMarker,
      }),
    })
  }
  if (before.nextAuthenticatedAt === null && after.nextAuthenticatedAt !== null) {
    const next = context.intervalOf(after.nextPriceId)
    const current = context.intervalOf(after.priceId)
    if (next !== undefined && current !== undefined && next !== current) {
      add({ type: 'subscription_interval_change_scheduled' }, 'checkout')
    }
  }
  if (before.state !== 'free' && after.state === 'free') {
    // An owner's own cancel, by their write or the marker of one, a past-due one included.
    const isOwnersCancel = isOwnerAct || context.isOwnerCancel === true
    const cause: DowngradeCause =
      !context.isWorkspaceActive && isPaying(before.state)
        ? 'lifecycle'
        : downgradeCauseOf(before, isStaffCancel, isOwnersCancel)
    const attribution = cause === 'trial_ended' ? 'trial' : 'payer'
    if (cause === 'trial_ended') add({ type: 'trial_ended' }, 'trial')
    add({ type: 'downgraded_to_free', downgradeCause: cause }, attribution)
  }
  if (source === 'reconcile') {
    const changed = RECONCILE_FIELDS.find(([key]) => !isSameValue(before[key], after[key]))
    if (changed !== undefined) add({ type: 'billing_reconciled', field: changed[1] })
  }
  return events
}
