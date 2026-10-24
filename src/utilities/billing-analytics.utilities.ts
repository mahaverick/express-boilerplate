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
 *   counts too: it moves the period from the trial's end.
 * - `payment_failed`: `pastDueSince` is set; its code says whether the
 *   provider still retries, gave up (halted) or the payer paused.
 * - `subscription_halted`: `haltedAt` is set.
 * - `subscription_cancel_scheduled`: `cancelAtPeriodEnd` turns on and no
 *   switch or resubscribe continues Paid, or an owner cancels a subscription
 *   before its first charge (the row leaves Paid at once). `by` comes from
 *   the source, and from the lifecycle for a suspended or archived workspace.
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
 * Who scheduled a cancel.
 * @param source - What made the change.
 * @param isWorkspaceActive - Whether the workspace is active.
 * @returns The `by` value.
 */
function cancelledBy(source: BillingHistorySource, isWorkspaceActive: boolean): CancelScheduledBy {
  if (source === 'owner') return 'owner'
  if (source === 'staff') return 'staff'
  if (!isWorkspaceActive) return 'suspension'
  return 'customer_bank'
}

/**
 * Whether a change scheduled a cancel: the period-end cancel turned on
 * without a switch continuing Paid, or an owner ended a subscription before
 * its first charge.
 * @param before - The row before.
 * @param after - The row after.
 * @param source - What made the change.
 * @returns True when a cancel was scheduled.
 */
function isCancelScheduled(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  source: BillingHistorySource
): boolean {
  if (!before.cancelAtPeriodEnd && after.cancelAtPeriodEnd) return !isContinued(after)
  return (
    source === 'owner' &&
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
    add({ type: 'subscription_renewed' })
  }
  if (before.pastDueSince === null && after.pastDueSince !== null) {
    let failureCode: 'retrying' | 'halted' | 'paused' = 'retrying'
    if (after.haltedAt !== null) failureCode = 'halted'
    else if (after.pausedAt !== null) failureCode = 'paused'
    add({ type: 'payment_failed', failureCode })
  }
  if (before.haltedAt === null && after.haltedAt !== null) add({ type: 'subscription_halted' })
  if (isCancelScheduled(before, after, source)) {
    add({
      type: 'subscription_cancel_scheduled',
      by: cancelledBy(source, context.isWorkspaceActive),
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
        : downgradeCauseOf(before, source)
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
