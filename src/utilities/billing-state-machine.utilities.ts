/**
 * @file The pure mapping from a workspace's billing row and the provider's
 * view of its subscriptions to the row's next values, the history cause and
 * the follow-up actions the sync runs after it commits. No I/O.
 *
 * Provider facts the mapping relies on:
 * - A cycle's end counts as paid through only while the subscription is
 *   `active` and that cycle's invoice is paid: the provider moves
 *   `currentEnd` forward before the money arrives.
 * - A deferred start (an upgrade during a trial) reads `authenticated` with
 *   its first charge at `startAt`; the workspace is active from then, and the
 *   trial end is kept so a cancel before that charge can return it to the trial.
 * - A cancelled or expired checkout (the pending or next subscription) only
 *   clears its id.
 * - The next subscription's first authenticated read is stamped in
 *   `nextAuthenticatedAt`, which a scheduled switch or resubscribe shows from;
 *   it clears when the next subscription ends or takes over.
 * - A cancel scheduled for the cycle end does not show at the provider, so
 *   `cancelAtPeriodEnd` is our own record: only a new current subscription
 *   resets it.
 *
 * The caller has already dropped subscriptions whose notes name another
 * workspace or an unknown price, and sets the plan id from the result.
 */
import type { BillingAlertKind, BillingState } from '@/constants/billing.constants'
import type { NewTenantBilling, TenantBillingRecord } from '@/database/models/billing.model'
import type { ProviderSubscription, ProviderSubscriptionStatus } from '@/types/billing'
import { effectiveBillingState, graceEndsAt } from '@/utilities/billing-rules.utilities'

/**
 * Work the sync does after its transaction commits.
 */
export type SyncAction =
  | { kind: 'cancel_now'; subscriptionId: string }
  | { kind: 'cancel_current_at_cycle_end'; subscriptionId: string }
  | { kind: 'promote_next' }
  | { kind: 'refund_duplicate'; subscriptionId: string }
  | {
      kind: 'alert'
      alert: BillingAlertKind
      message: string
      /**
       * The subscription the alert names, so the caller can skip an alert
       * already raised for it.
       */
      subscriptionId?: string
    }

/**
 * Why a workspace's billing state changed, as its history records it. The
 * causes of a move to Free are the downgrade causes.
 */
type BillingSyncCause =
  | 'subscription_activated'
  | 'subscription_recovered'
  | 'payment_failed'
  | 'subscription_halted'
  | 'subscription_paused'
  | 'cancelled'
  | 'grace_ended'
  | 'subscription_completed'
  | 'subscription_expired'
  | 'interval_switch'

/**
 * The provider's view of a workspace's subscriptions: the ones its row
 * holds, and any the reconcile sweep found that it does not.
 */
export interface BillingSubscriptions {
  /**
   * The subscription in `providerSubscriptionId`.
   */
  current?: ProviderSubscription
  /**
   * The checkout in `pendingSubscriptionId`.
   */
  pending?: ProviderSubscription
  /**
   * The interval switch in `nextSubscriptionId`.
   */
  next?: ProviderSubscription
  /**
   * Subscriptions for this workspace that the row does not hold, in the
   * order offered: the reconcile's sweep offers them oldest first by the
   * provider's creation time, so the first running one is adopted.
   */
  swept?: readonly ProviderSubscription[]
}

/**
 * The mapping's answer.
 */
export interface NextBillingRow {
  /**
   * Only the columns whose value changes.
   */
  patch: Partial<NewTenantBilling>
  /**
   * The history cause, or null when the state did not change and no
   * subscription took over.
   */
  cause: BillingSyncCause | null
  /**
   * What to do after the write commits, in order.
   */
  actions: SyncAction[]
}

/**
 * The row columns the mapping may change.
 */
type Draft = Pick<
  TenantBillingRecord,
  | 'state'
  | 'priceId'
  | 'currentPeriodEnd'
  | 'cancelAtPeriodEnd'
  | 'pastDueSince'
  | 'haltedAt'
  | 'pausedAt'
  | 'providerSubscriptionId'
  | 'pendingSubscriptionId'
  | 'nextSubscriptionId'
  | 'nextPriceId'
  | 'nextAuthenticatedAt'
>

/**
 * The columns of `Draft`, for the diff.
 */
const DRAFT_KEYS = [
  'state',
  'priceId',
  'currentPeriodEnd',
  'cancelAtPeriodEnd',
  'pastDueSince',
  'haltedAt',
  'pausedAt',
  'providerSubscriptionId',
  'pendingSubscriptionId',
  'nextSubscriptionId',
  'nextPriceId',
  'nextAuthenticatedAt',
] as const satisfies readonly (keyof Draft)[]

/**
 * How each status reads for a subscription that is current or about to be.
 */
type StatusClass = 'not_started' | 'live' | 'ended'

/**
 * Every provider status, classified. A new status fails to compile until it
 * is listed here.
 */
const STATUS_CLASS = {
  created: 'not_started',
  authenticated: 'live',
  active: 'live',
  pending: 'live',
  halted: 'live',
  paused: 'live',
  cancelled: 'ended',
  completed: 'ended',
  expired: 'ended',
} as const satisfies Record<ProviderSubscriptionStatus, StatusClass>

/**
 * Statuses that only follow a failed or stopped charge.
 */
const FAILED_CHARGE_STATUSES: ReadonlySet<ProviderSubscriptionStatus> = new Set([
  'pending',
  'halted',
  'paused',
])

/**
 * Whether the payer ever authenticated the subscription. A snapshot cannot
 * show the status history, so a subscription with no customer and no paid
 * cycle is read as one that went straight from `created` to a failure: a
 * failed checkout, not a failed renewal.
 * @param sub - The subscription.
 * @returns True once a customer is attached or a cycle was paid.
 */
function wasAuthenticated(sub: ProviderSubscription): boolean {
  return sub.customerId !== null || sub.paidCount > 0
}

/**
 * Whether a subscription runs, or could run, for this workspace: live, and
 * not a failed checkout. Only a running subscription can become current.
 * @param sub - The subscription.
 * @returns True for a running subscription.
 */
export function isRunning(sub: ProviderSubscription): boolean {
  if (STATUS_CLASS[sub.status] !== 'live') return false
  return !FAILED_CHARGE_STATUSES.has(sub.status) || wasAuthenticated(sub)
}

/**
 * The end of a subscription's cycle when that cycle is paid.
 * @param sub - The subscription.
 * @returns The paid-through time, or null when the cycle is not paid.
 */
function paidThrough(sub: ProviderSubscription): Date | null {
  return sub.status === 'active' && sub.latestInvoicePaid ? sub.currentEnd : null
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
 * The mapping's working state for one call.
 */
class BillingMapping {
  readonly draft: Draft
  readonly actions: SyncAction[] = []
  cause: BillingSyncCause | null = null
  hasSwitched = false
  /**
   * The current subscription belongs to a workspace already on Free and is
   * being cancelled, so it no longer counts as running.
   */
  hasLapsedCurrent = false

  /**
   * @param row - The locked row.
   * @param now - The current time.
   * @param graceDays - Days of grace after a halt or pause.
   */
  constructor(
    readonly row: TenantBillingRecord,
    readonly now: Date,
    readonly graceDays: number
  ) {
    this.draft = {
      state: row.state,
      priceId: row.priceId,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      pastDueSince: row.pastDueSince,
      haltedAt: row.haltedAt,
      pausedAt: row.pausedAt,
      providerSubscriptionId: row.providerSubscriptionId,
      pendingSubscriptionId: row.pendingSubscriptionId,
      nextSubscriptionId: row.nextSubscriptionId,
      nextPriceId: row.nextPriceId,
      nextAuthenticatedAt: row.nextAuthenticatedAt,
    }
  }

  /**
   * Move to a state, remembering why.
   * @param state - The new state.
   * @param cause - Why.
   */
  setState(state: BillingState, cause: BillingSyncCause): void {
    if (this.draft.state === state) return
    this.draft.state = state
    this.cause = cause
  }

  /**
   * Clear the failed-payment stamps.
   */
  clearPastDue(): void {
    this.draft.pastDueSince = null
    this.draft.haltedAt = null
    this.draft.pausedAt = null
  }

  /**
   * Move to `active` and clear the failed-payment stamps.
   */
  activate(): void {
    this.setState(
      'active',
      this.draft.state === 'past_due' ? 'subscription_recovered' : 'subscription_activated'
    )
    this.clearPastDue()
  }

  /**
   * Move to `free`, clearing the failed-payment stamps.
   * @param cause - Why.
   */
  downgrade(cause: BillingSyncCause): void {
    this.setState('free', cause)
    this.clearPastDue()
  }

  /**
   * Move to `past_due` from a failed or stopped charge, and cancel now once
   * grace has ended.
   * @param sub - The current subscription.
   * @param cause - Why.
   */
  markPastDue(sub: ProviderSubscription, cause: BillingSyncCause): void {
    this.setState('past_due', cause)
    this.draft.pastDueSince ??= this.now
    if (sub.status === 'halted') this.draft.haltedAt ??= this.now
    if (sub.status === 'paused') this.draft.pausedAt ??= this.now
    const ends = graceEndsAt(this.draft, this.graceDays)
    if (ends !== null && ends <= this.now) {
      this.actions.push({ kind: 'cancel_now', subscriptionId: sub.id })
    }
  }

  /**
   * A workspace already on Free, or back on a trial staff extended, whose
   * subscription still reads as a failed or stopped charge: its paid time is
   * over, so it never goes (back) to past due (that would start a fresh
   * grace window). The subscription is cancelled now instead, when the payer
   * ever authenticated it; the state and the failed-payment stamps stay as
   * they are.
   * @param sub - The current subscription, reading `pending`, `halted` or `paused`.
   * @returns True when the workspace is on Free or trialing and nothing else applies.
   */
  isCancelledWhileFree(sub: ProviderSubscription): boolean {
    if (this.draft.state !== 'free' && this.draft.state !== 'trialing') return false
    if (wasAuthenticated(sub)) this.actions.push({ kind: 'cancel_now', subscriptionId: sub.id })
    this.hasLapsedCurrent = true
    return true
  }

  /**
   * Make a subscription the current one and map its status. An active one
   * whose paid-through time is unknown gets a period end of now, never the
   * last one's.
   * @param sub - The subscription taking over.
   * @param priceId - Its price.
   */
  takeOver(sub: ProviderSubscription, priceId: string | null): void {
    this.draft.providerSubscriptionId = sub.id
    this.draft.priceId = priceId
    this.draft.cancelAtPeriodEnd = false
    if (sub.status === 'authenticated') this.draft.currentPeriodEnd = sub.startAt
    // An active one whose cycle is not paid yet: from now, so the buffer and grace bound it until its invoice is.
    if (sub.status === 'active' && paidThrough(sub) === null) this.draft.currentPeriodEnd = this.now
    this.mapCurrent(sub)
  }

  /**
   * Map the current subscription's status onto the row.
   * @param sub - The current subscription.
   */
  mapCurrent(sub: ProviderSubscription): void {
    const { status } = sub
    switch (status) {
      case 'created': {
        return
      }
      case 'authenticated': {
        this.draft.currentPeriodEnd ??= sub.startAt
        this.activate()
        return
      }
      case 'active': {
        this.draft.currentPeriodEnd = paidThrough(sub) ?? this.draft.currentPeriodEnd
        this.activate()
        return
      }
      case 'pending': {
        if (this.isCancelledWhileFree(sub)) return
        if (wasAuthenticated(sub)) this.markPastDue(sub, 'payment_failed')
        return
      }
      case 'halted': {
        if (this.isCancelledWhileFree(sub)) return
        this.markPastDue(sub, 'subscription_halted')
        return
      }
      case 'paused': {
        if (this.isCancelledWhileFree(sub)) return
        this.markPastDue(sub, 'subscription_paused')
        return
      }
      case 'cancelled': {
        this.endCancelled(sub)
        return
      }
      case 'completed': {
        if (this.draft.state !== 'active' && this.draft.state !== 'past_due') return
        this.downgrade('subscription_completed')
        this.actions.push({
          kind: 'alert',
          alert: 'subscription_completed',
          message: `Subscription ${sub.id} billed its last cycle, so the workspace moved to Free.`,
        })
        return
      }
      case 'expired': {
        if (this.draft.state === 'active' || this.draft.state === 'past_due') {
          this.downgrade('subscription_expired')
        }
        return
      }
      default: {
        const unhandled: never = status
        throw new Error(`Unhandled subscription status ${String(unhandled)}`)
      }
    }
  }

  /**
   * A cancelled current subscription. A past-due workspace goes to Free; a
   * deferred start cancelled before its first charge goes back to its trial;
   * otherwise the workspace keeps Paid, cancelling, until the period end and
   * buffer pass.
   * @param sub - The cancelled subscription.
   */
  endCancelled(sub: ProviderSubscription): void {
    const { draft } = this
    if (draft.state === 'past_due') {
      const ends = graceEndsAt(draft, this.graceDays)
      this.downgrade(ends !== null && ends <= this.now ? 'grace_ended' : 'cancelled')
      return
    }
    if (draft.state !== 'active') return
    const { trialEndsAt } = this.row
    if (sub.paidCount === 0 && trialEndsAt !== null && trialEndsAt > this.now) {
      this.setState('trialing', 'cancelled')
      draft.priceId = null
      draft.currentPeriodEnd = null
      draft.cancelAtPeriodEnd = false
      return
    }
    draft.cancelAtPeriodEnd = true
    const hasLapsed =
      draft.currentPeriodEnd === null ||
      effectiveBillingState(
        { ...draft, state: 'active', trialEndsAt },
        this.now,
        this.graceDays
      ) === 'free'
    if (hasLapsed) this.downgrade('cancelled')
  }

  /**
   * The interval switch: cancel the current subscription at cycle end once
   * the next one is authenticated, and hand over when the current one ends.
   * A next subscription paid only after the current one renewed is refunded
   * as a duplicate instead, and the current one kept.
   * Only an `authenticated` or `active` next subscription counts: one that
   * reads `pending`, `halted` or `paused` has a failed charge, and the switch
   * waits rather than cancel a paying subscription for it. Whether its payer
   * authenticated cannot tell this apart, since a switch shares the customer.
   * @param current - The current subscription, if fetched.
   * @param next - The next subscription.
   */
  mapNext(current: ProviderSubscription | undefined, next: ProviderSubscription): void {
    const { draft } = this
    switch (STATUS_CLASS[next.status]) {
      case 'not_started': {
        return
      }
      case 'ended': {
        draft.nextSubscriptionId = null
        draft.nextPriceId = null
        draft.nextAuthenticatedAt = null
        return
      }
      case 'live': {
        break
      }
    }
    if (next.status !== 'authenticated' && next.status !== 'active') return
    if (current !== undefined && this.hasRenewedPast(current, next)) {
      this.actions.push(
        { kind: 'refund_duplicate', subscriptionId: next.id },
        {
          kind: 'alert',
          alert: 'reconcile_repair',
          message: `Interval switch ${next.id} was paid after subscription ${current.id} renewed, so the switch was cancelled and refunded and ${current.id} kept.`,
          subscriptionId: next.id,
        }
      )
      draft.nextSubscriptionId = null
      draft.nextPriceId = null
      draft.nextAuthenticatedAt = null
      return
    }
    // The first read wins, so the switch shows from when it was first authenticated.
    draft.nextAuthenticatedAt ??= this.now
    const hasPeriodEnded = draft.currentPeriodEnd !== null && this.now >= draft.currentPeriodEnd
    const isHandover =
      current === undefined ||
      STATUS_CLASS[current.status] === 'ended' ||
      (draft.cancelAtPeriodEnd && hasPeriodEnded)
    if (isHandover) {
      const priceId = draft.nextPriceId ?? next.notes.priceId ?? null
      draft.nextSubscriptionId = null
      draft.nextPriceId = null
      draft.nextAuthenticatedAt = null
      this.takeOver(next, priceId)
      this.hasSwitched = true
      this.actions.push({ kind: 'promote_next' })
      return
    }
    if (!draft.cancelAtPeriodEnd && STATUS_CLASS[current.status] === 'live') {
      this.actions.push({ kind: 'cancel_current_at_cycle_end', subscriptionId: current.id })
    }
  }

  /**
   * Whether a running current subscription that is not cancelling has
   * already started the cycle the next subscription was to take over: its
   * new cycle began at or after the next one's start, or its paid cycle ends
   * after the stored period end. The switch was paid too late, and handing
   * over or cancelling the current one would waste a cycle already charged.
   * @param current - The current subscription.
   * @param next - The authenticated or active next subscription.
   * @returns True when the current subscription renewed past the switch.
   */
  hasRenewedPast(current: ProviderSubscription, next: ProviderSubscription): boolean {
    const { draft } = this
    if (draft.cancelAtPeriodEnd || STATUS_CLASS[current.status] !== 'live') return false
    if (
      next.startAt !== null &&
      current.currentStart !== null &&
      current.currentStart >= next.startAt
    ) {
      return true
    }
    const paid = paidThrough(current)
    return paid !== null && draft.currentPeriodEnd !== null && paid > draft.currentPeriodEnd
  }

  /**
   * A subscription the row does not hold as current: adopt it when the
   * workspace has no running one, refund it as a duplicate when it has.
   * @param sub - The pending or swept subscription, already known to be running.
   * @param current - The subscription that is current now, if running.
   * @returns The subscription that is current afterwards.
   */
  adoptOrRefund(
    sub: ProviderSubscription,
    current: ProviderSubscription | undefined
  ): ProviderSubscription {
    if (current !== undefined) {
      this.actions.push({ kind: 'refund_duplicate', subscriptionId: sub.id })
      return current
    }
    this.takeOver(sub, sub.notes.priceId ?? null)
    return sub
  }

  /**
   * The changed columns.
   * @returns The patch.
   */
  patch(): Partial<NewTenantBilling> {
    const patch: Partial<NewTenantBilling> = {}
    for (const key of DRAFT_KEYS) {
      if (!isSameValue(this.draft[key], this.row[key])) {
        Object.assign(patch, { [key]: this.draft[key] })
      }
    }
    return patch
  }
}

/**
 * The next values of a workspace's billing row, from the row and the
 * provider's view of its subscriptions. The interval switch is read first,
 * then the current subscription, then the pending checkout, then the
 * subscriptions the sweep found. The row's current subscription is the
 * earliest: a later running subscription is refunded as a duplicate.
 * @param row - The row, read under the lock.
 * @param subs - The fetched subscriptions, already checked to be this workspace's.
 * @param now - The current time.
 * @param graceDays - Days of grace after a halt or pause.
 * @returns The changed columns, the history cause and the follow-up actions.
 */
export function nextBillingRow(
  row: TenantBillingRecord,
  subs: BillingSubscriptions,
  now: Date,
  graceDays: number
): NextBillingRow {
  const mapping = new BillingMapping(row, now, graceDays)
  const { draft } = mapping
  let current = row.providerSubscriptionId === null ? undefined : subs.current

  if (row.nextSubscriptionId !== null && subs.next !== undefined) {
    mapping.mapNext(current, subs.next)
    if (mapping.hasSwitched) current = subs.next
  }
  if (!mapping.hasSwitched && current !== undefined) mapping.mapCurrent(current)

  // A lapsed current subscription is being cancelled, so a new checkout takes over rather than being refunded.
  let running =
    current !== undefined && isRunning(current) && !mapping.hasLapsedCurrent ? current : undefined
  const { pending } = subs
  if (row.pendingSubscriptionId !== null && pending !== undefined) {
    const pendingClass = STATUS_CLASS[pending.status]
    if (pendingClass === 'ended') draft.pendingSubscriptionId = null
    if (pendingClass === 'live' && isRunning(pending)) {
      draft.pendingSubscriptionId = null
      running = mapping.adoptOrRefund(pending, running)
    }
  }

  const held = new Set([
    row.providerSubscriptionId,
    row.pendingSubscriptionId,
    row.nextSubscriptionId,
  ])
  for (const found of subs.swept ?? []) {
    if (held.has(found.id) || !isRunning(found)) continue
    running = mapping.adoptOrRefund(found, running)
  }

  if (
    draft.state === 'active' &&
    draft.currentPeriodEnd === null &&
    draft.providerSubscriptionId !== null
  ) {
    mapping.actions.push({
      kind: 'alert',
      alert: 'reconcile_repair',
      message: `Workspace is active on subscription ${draft.providerSubscriptionId} with no paid period end. Check its invoices.`,
      subscriptionId: draft.providerSubscriptionId,
    })
  }

  const isStateChanged = draft.state !== row.state
  let cause: BillingSyncCause | null = null
  if (isStateChanged) cause = mapping.cause
  else if (mapping.hasSwitched) cause = 'interval_switch'
  return { patch: mapping.patch(), cause, actions: mapping.actions }
}
