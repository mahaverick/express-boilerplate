/**
 * @file Which billing emails a committed change sends, read only from the
 * row before and after it and the source of the change. Pure: the caller
 * reads the workspace's lifecycle and the prices' intervals and passes them
 * in. Each rule fires on one column's move, so a write that repeats the same
 * state fires none.
 *
 * A suspended or archived workspace gets no mail that asks its owners to act
 * in Billing: the only one it gets is the move to Free of a paying row, cause
 * `lifecycle`, which carries no button. For an active workspace:
 *
 * - Paid welcome: the row is `active` on a subscription with a known period
 *   end, and either it became active from another state on a new
 *   subscription, or the period end just became known on the subscription it
 *   was already active on (`isActivationPending`: Razorpay can report the
 *   first payment before the activation, so the end can arrive one sync
 *   late). A recovery on the same subscription, a handover while active and a
 *   resubscribe during a cancel buffer are not new starts.
 * - Payment stopped: `haltedAt` is set (the payment failed) or `pausedAt` is
 *   set (paused from the payer's bank or UPI app), once per stamp. Both start
 *   the grace period.
 * - Paid cancelled: `cancelAtPeriodEnd` turns on while Paid runs, unless a
 *   scheduled switch or resubscribe continues it. Its variant before the
 *   first charge: a deferred start is cancelled and the row goes back from
 *   `active` to `trialing`, so no charge was made and the trial goes on.
 * - Interval switch scheduled: the next subscription is first authenticated
 *   and bills another interval than the current one. A resubscribe on the
 *   same interval sends nothing.
 * - Moved to Free: the row becomes `free`. Its cause, first match wins:
 *   `staff` for a staff cancel (`isStaffCancel`; a staff resync that brings
 *   in the provider's change reads the real cause); `trial_ended` from a trial;
 *   `cancelled` for an owner's own cancel (`isOwnerCancel`), a past-due one
 *   included; `payment_failed` from a past-due, halted or paused row;
 *   `cancelled` otherwise (a cancelled, completed or expired subscription).
 */
import type {
  BillingHistorySource,
  BillingInterval,
  BillingState,
} from '@/constants/billing.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import type { CancelMarker } from '@/utilities/billing-rules.utilities'

/**
 * Why a workspace moved to Free, for its email: a trial's end has its own.
 */
export type DowngradeCause = 'trial_ended' | 'payment_failed' | 'cancelled' | 'staff' | 'lifecycle'

/**
 * One email-worthy change.
 */
export type BillingTransition =
  | { kind: 'paid_welcome' }
  | { kind: 'payment_failed'; stoppedBy: 'halted' | 'paused' }
  | {
      kind: 'paid_cancelled'
      /**
       * A deferred start cancelled before its first charge: the workspace
       * is back on its trial, not cancelling a paid period.
       */
      beforeFirstCharge: boolean
    }
  | { kind: 'interval_switch_scheduled' }
  | { kind: 'moved_to_free'; cause: DowngradeCause }

/**
 * What the rules need besides the rows.
 */
export interface TransitionContext {
  /**
   * Whether the workspace is active: not suspended or archived.
   */
  isWorkspaceActive: boolean
  /**
   * The interval a price bills, or undefined for an unknown price.
   */
  intervalOf: (priceId: string | null) => BillingInterval | undefined
  /**
   * Whether the row's current subscription became current in a move to
   * `active` from another state (`wasActivatedWithSubscription`). Only a
   * welcome deferred for a missing period end needs it; false or absent
   * means the period-end rule never fires.
   */
  isActivationPending?: boolean
  /**
   * Whether the change is a staff member's own cancel (`cancelSubscriptions`
   * on the staff path), as opposed to a staff resync that only brought in
   * what the provider did.
   */
  isStaffCancel?: boolean
  /**
   * Whether the change is an owner's own cancel write: an owner who cancels a
   * past-due subscription chose to, so its move to Free reads `cancelled`,
   * not `payment_failed`. Counts only with source `owner`.
   */
  isOwnerCancel?: boolean
  /**
   * The cancel on record for the row's current subscription before the
   * change (`cancelMarkerOf`), whatever made the change: a cancel the
   * provider's webhook brings in before the owner's or staff member's own
   * write still reads as theirs, as analytics reads it.
   */
  cancelMarker?: CancelMarker | null
}

/**
 * The states in which a workspace pays.
 */
const PAYING_STATES: ReadonlySet<BillingState> = new Set(['active', 'past_due'])

/**
 * Why an active workspace moved to Free.
 * @param before - The row it left.
 * @param isStaffCancel - Whether a staff member's own cancel made the move.
 * @param isOwnerCancel - Whether an owner's own cancel made it.
 * @returns The cause.
 */
export function downgradeCauseOf(
  before: TenantBillingRecord,
  isStaffCancel: boolean,
  isOwnerCancel = false
): DowngradeCause {
  if (isStaffCancel) return 'staff'
  if (before.state === 'trialing') return 'trial_ended'
  if (isOwnerCancel) return 'cancelled'
  if (before.state === 'past_due' || before.haltedAt !== null || before.pausedAt !== null) {
    return 'payment_failed'
  }
  return 'cancelled'
}

/**
 * What a suspended or archived workspace is told: only that a paying row
 * moved to Free, since its owners can't act in Billing.
 * @param before - The row before the change.
 * @param after - The row after it.
 * @returns The lifecycle move, or nothing.
 */
function inactiveTransitions(
  before: TenantBillingRecord,
  after: TenantBillingRecord
): BillingTransition[] {
  return PAYING_STATES.has(before.state) && after.state === 'free'
    ? [{ kind: 'moved_to_free', cause: 'lifecycle' }]
    : []
}

/**
 * Whether a switch or resubscribe continues Paid after the current
 * subscription ends.
 * @param after - The row after the change.
 * @returns True when an authenticated next subscription is scheduled.
 */
export function isContinued(after: TenantBillingRecord): boolean {
  return after.nextSubscriptionId !== null && after.nextAuthenticatedAt !== null
}

/**
 * Whether the change completes a welcome to Paid: the row is active on a
 * subscription with a known period end, and either the row just became
 * active on a new subscription, or the period end just became known on the
 * subscription it was already active on, where that subscription started
 * Paid (`isActivationPending`). Razorpay can report the first payment before
 * it activates the subscription, so the period end may arrive one sync after
 * the row turns active. A handover or a resubscribe while the row stays
 * active gets no welcome.
 * @param before - The row before the change.
 * @param after - The row after it.
 * @param context - The workspace facts.
 * @returns True when the welcome is due.
 */
function isWelcomeDue(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  context: TransitionContext
): boolean {
  if (
    after.state !== 'active' ||
    after.providerSubscriptionId === null ||
    after.currentPeriodEnd === null
  ) {
    return false
  }
  const isNewSubscription =
    before.state !== 'active' && after.providerSubscriptionId !== before.providerSubscriptionId
  const isPeriodEndKnownNow =
    before.state === 'active' &&
    after.providerSubscriptionId === before.providerSubscriptionId &&
    before.currentPeriodEnd === null &&
    context.isActivationPending === true
  return isNewSubscription || isPeriodEndKnownNow
}

/**
 * The email-worthy changes between two rows, in the order they are sent.
 * @param before - The row before the change.
 * @param after - The row after it.
 * @param source - What made the change.
 * @param context - The workspace's lifecycle and the prices' intervals.
 * @returns Each transition once; none when nothing an email reports changed.
 */
export function billingTransitions(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  source: BillingHistorySource,
  context: TransitionContext
): BillingTransition[] {
  if (!context.isWorkspaceActive) return inactiveTransitions(before, after)
  const transitions: BillingTransition[] = []
  if (isWelcomeDue(before, after, context)) transitions.push({ kind: 'paid_welcome' })
  if (before.haltedAt === null && after.haltedAt !== null) {
    transitions.push({ kind: 'payment_failed', stoppedBy: 'halted' })
  }
  if (before.pausedAt === null && after.pausedAt !== null) {
    transitions.push({ kind: 'payment_failed', stoppedBy: 'paused' })
  }
  if (
    !before.cancelAtPeriodEnd &&
    after.cancelAtPeriodEnd &&
    PAYING_STATES.has(after.state) &&
    !isContinued(after)
  ) {
    transitions.push({ kind: 'paid_cancelled', beforeFirstCharge: false })
  }
  if (PAYING_STATES.has(before.state) && after.state === 'trialing') {
    transitions.push({ kind: 'paid_cancelled', beforeFirstCharge: true })
  }
  if (before.nextAuthenticatedAt === null && after.nextAuthenticatedAt !== null) {
    const next = context.intervalOf(after.nextPriceId)
    const current = context.intervalOf(after.priceId)
    if (next !== undefined && current !== undefined && next !== current) {
      transitions.push({ kind: 'interval_switch_scheduled' })
    }
  }
  if (before.state !== 'free' && after.state === 'free') {
    const marker = context.cancelMarker ?? null
    const isStaffCancel =
      (source === 'staff' && context.isStaffCancel === true) || marker?.by === 'staff'
    const isOwnerCancel =
      (source === 'owner' && context.isOwnerCancel === true) || marker?.by === 'owner'
    transitions.push({
      kind: 'moved_to_free',
      cause: downgradeCauseOf(before, isStaffCancel, isOwnerCancel),
    })
  }
  return transitions
}
