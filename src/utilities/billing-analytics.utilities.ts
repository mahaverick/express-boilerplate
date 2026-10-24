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
 *   once). `by` comes from
 *   the source, from an owner's or staff cancel on record (`isOwnerCancel`,
 *   `isStaffCancel`), and from
 *   the lifecycle for a suspended or archived workspace.
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
import type { BillingEventDetail, CancelScheduledBy } from '@/types/domain-event'
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
   * Whether the change is a staff member's own cancel: the staff cancel
   * passes it, and a cancel the provider's webhook brings in first carries
   * it from the staff cancel marker. A staff resync without it reads the
   * provider's real cause.
   */
  isStaffCancel?: boolean
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
 * Who scheduled a cancel. A staff source alone is not a staff cancel: a
 * staff resync only brings in what the provider did.
 * @param source - What made the change.
 * @param isWorkspaceActive - Whether the workspace is active.
 * @param marker - Whether an owner's or a staff member's own cancel is on record.
 * @param marker.isOwnerCancel - An owner's cancel is on record.
 * @param marker.isStaffCancel - The change is a staff member's own cancel.
 * @returns The `by` value.
 */
function cancelledBy(
  source: BillingHistorySource,
  isWorkspaceActive: boolean,
  marker: { isOwnerCancel: boolean; isStaffCancel: boolean }
): CancelScheduledBy {
  const { isOwnerCancel, isStaffCancel } = marker
  if (source === 'owner') return 'owner'
  if (isStaffCancel) return 'staff'
  // A suspension's cancel wins over an owner's marker: the marker may outlive a cancel that failed.
  if (!isWorkspaceActive) return 'suspension'
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
 * @param source - What made the change.
 * @param isStaffCancel - Whether the change is a staff member's own cancel.
 * @returns True when a cancel was scheduled.
 */
function isCancelScheduled(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  source: BillingHistorySource,
  isStaffCancel: boolean
): boolean {
  if (!before.cancelAtPeriodEnd && after.cancelAtPeriodEnd) return !isContinued(after)
  return (
    (source === 'owner' || isStaffCancel) &&
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
    after.currentPeriodEnd > before.currentPeriodEnd
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
  const isStaffCancel = context.isStaffCancel === true
  if (isCancelScheduled(before, after, source, isStaffCancel)) {
    add({
      type: 'subscription_cancel_scheduled',
      by: cancelledBy(source, context.isWorkspaceActive, {
        isOwnerCancel: context.isOwnerCancel === true,
        isStaffCancel,
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
    const cause: DowngradeCause =
      !context.isWorkspaceActive && isPaying(before.state)
        ? 'lifecycle'
        : downgradeCauseOf(before, isStaffCancel)
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
