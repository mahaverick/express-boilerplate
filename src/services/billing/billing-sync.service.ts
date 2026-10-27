/**
 * @file The one path by which provider state reaches a workspace's billing
 * row. Checkout confirm, webhooks, the scheduled jobs and the reconcile all
 * call `syncTenantBilling`, which:
 * 1. reads the row without a lock;
 * 2. fetches the subscriptions it holds from the provider, with no lock held;
 *    a provider error is rethrown and nothing is written;
 * 3. locks the row (`FOR NO KEY UPDATE`), maps it with `nextBillingRow` and
 *    writes it with the version check, adding a history row for a state change
 *    and fulfilling upgrade requests when it becomes active. A row that changed
 *    between the read and the lock was mapped from stale ids, so the whole sync
 *    runs again once, then gives up for the caller to retry. A write that gives
 *    a suspended or archived workspace a new current subscription, or an id it
 *    did not hold, also releases its lifecycle cancel claim;
 * 4. after the commit, inserts alerts, runs the follow-up provider calls
 *    (cancel, refund, the switch's cycle-end cancel), pushes the change to
 *    members and sends its emails (`emitBillingDiff`, which also tells each
 *    member whose upgrade request the write fulfilled), syncs once more
 *    after a handover or a cancel so the new provider state lands at once,
 *    and queues the prompt lifecycle cancel when it released the claim;
 * 5. once the whole call (its follow-up sync included) ends `synced`, queues
 *    one tax run for the workspace.
 *
 * A subscription whose notes name another workspace is never adopted, and one
 * whose notes name an unknown price is never made current: both are ignored
 * and alerted.
 */
import type { BillingAlertKind, BillingHistorySource } from '@/constants/billing.constants'
import type {
  NewTenantBilling,
  TenantBillingRecord,
  UpgradeRequest,
} from '@/database/models/billing.model'
import { addBillingLifecycleCancelJob } from '@/jobs/billing.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { trackProviderEvent } from '@/services/billing/billing-analytics.service'
import { emitBillingDiff } from '@/services/billing/billing-events.service'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { queueTaxReconcile } from '@/services/billing/tax-reconcile.service'
import { withTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import type {
  BillingProviderClient,
  ProviderRefundOutcome,
  ProviderSubscription,
} from '@/types/billing'
import { BILLING_ALERT_TEXT } from '@/utilities/billing-alert-text.utilities'
import { isFirstPaidCycle } from '@/utilities/billing-analytics.utilities'
import { heldSubscriptionIds, isOtherProvider } from '@/utilities/billing-rules.utilities'
import {
  isRunning,
  nextBillingRow,
  type BillingSubscriptions,
  type SyncAction,
} from '@/utilities/billing-state-machine.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

/**
 * How many times a sync reads and fetches before it gives up on a row that
 * keeps changing under it.
 */
const SYNC_ATTEMPTS = 2

/**
 * The longest message `billing_alerts.message` stores.
 */
const ALERT_MESSAGE_MAX_LENGTH = 280

/**
 * A row that changed between the sync's read and its lock on both attempts.
 * Nothing was written; the caller retries later.
 */
export class BillingSyncConflictError extends Error {
  /**
   * @param tenantId - The workspace whose row kept changing.
   */
  constructor(tenantId: string) {
    super(`Billing row of ${tenantId} kept changing during the sync`)
    this.name = 'BillingSyncConflictError'
  }
}

/**
 * What a sync did.
 */
interface SyncResult {
  /**
   * `payments_off` when no provider is configured, `no_row` when the
   * workspace has no billing row, `provider_mismatch` when the row belongs to
   * another provider or mode (nothing is fetched or written), else `synced`.
   */
  outcome: 'payments_off' | 'no_row' | 'provider_mismatch' | 'synced'
  /**
   * Whether any billing column other than the sync time changed.
   */
  changed: boolean
  /**
   * The row after the sync.
   */
  row: TenantBillingRecord | undefined
}

/**
 * A staff alert to insert after the commit.
 */
interface PendingAlert {
  kind: BillingAlertKind
  message: string
  /**
   * The subscription the alert names. Set on an alert a repeated sync would
   * raise again: one of the same kind with the same message is not inserted twice.
   */
  subscriptionId?: string
}

/**
 * What the sync read from the provider and the plans, before the lock.
 */
interface FetchedState {
  /**
   * The subscriptions this workspace may use.
   */
  subs: BillingSubscriptions
  /**
   * Alerts for the subscriptions that were ignored.
   */
  alerts: PendingAlert[]
  /**
   * The plan of each price the row or a subscription names.
   */
  planIdByPriceId: ReadonlyMap<string, string>
  /**
   * The Free plan's id.
   */
  freePlanId: string
  /**
   * Days of grace after a halt or pause.
   */
  graceDays: number
}

/**
 * A committed sync write.
 */
interface CommittedSync {
  before: TenantBillingRecord
  after: TenantBillingRecord
  actions: SyncAction[]
  changed: boolean
  /**
   * The upgrade requests the write fulfilled, so their requesters are told.
   */
  fulfilledRequests: UpgradeRequest[]
  /**
   * The write gave a suspended or archived workspace a new current
   * subscription or an id it did not hold, and released its lifecycle cancel
   * claim, so the prompt cancel job is queued after the commit.
   */
  needsLifecycleCancel: boolean
  /**
   * The paid period the write moved to is the first paid cycle of a
   * subscription adopted before it was paid, so it is reported as no renewal.
   */
  isFirstPaidCycle: boolean
}

/**
 * How one sync call runs.
 */
interface SyncRun {
  tenantId: string
  source: BillingHistorySource
  now: Date
  extraSubscriptionIds: readonly string[]
  /**
   * False for the follow-up sync, so it never starts another.
   */
  mayFollowUp: boolean
}

/**
 * Insert a staff alert, unless it names a subscription and the workspace
 * already has the same alert; a failure is logged, since the change it
 * reports is committed.
 * @param tenantId - The workspace.
 * @param alert - The alert.
 */
async function insertAlert(tenantId: string, alert: PendingAlert): Promise<void> {
  const message = alert.message.slice(0, ALERT_MESSAGE_MAX_LENGTH)
  try {
    if (
      alert.subscriptionId !== undefined &&
      (await billingRepository.hasAlertNaming(tenantId, alert.kind, message))
    ) {
      return
    }
    await billingRepository.insertAlert({
      kind: alert.kind,
      tenantId,
      message,
    })
  } catch (error) {
    logger.error('Could not record a billing alert', { error, tenantId, kind: alert.kind })
  }
}

/**
 * Read the provider's view of the subscriptions a row holds, plus any the
 * reconcile found, and the plans they name. Ignores, with an alert, a
 * subscription whose notes name another workspace, and a running checkout,
 * switch or found subscription whose price is unknown.
 * @param provider - The payment provider.
 * @param row - The row, read without a lock.
 * @param extraSubscriptionIds - Subscriptions the reconcile found for this workspace.
 * @returns The fetched state.
 * @throws {ProviderError} When any fetch fails; nothing is written.
 */
async function fetchState(
  provider: BillingProviderClient,
  row: TenantBillingRecord,
  extraSubscriptionIds: readonly string[]
): Promise<FetchedState> {
  const held = new Set(
    [row.providerSubscriptionId, row.pendingSubscriptionId, row.nextSubscriptionId].filter(
      (id): id is string => id !== null
    )
  )
  const sweptIds = [...new Set(extraSubscriptionIds)].filter((id) => !held.has(id))
  /**
   * The subscription a row column holds, or undefined for an empty column.
   */
  const fetchHeld = async (id: string | null): Promise<ProviderSubscription | undefined> =>
    id === null ? undefined : provider.fetchSubscription(id)
  const [current, pending, next, swept] = await Promise.all([
    fetchHeld(row.providerSubscriptionId),
    fetchHeld(row.pendingSubscriptionId),
    fetchHeld(row.nextSubscriptionId),
    Promise.all(sweptIds.map((id) => provider.fetchSubscription(id))),
  ])

  const alerts: PendingAlert[] = []
  const priceIds = [
    row.priceId,
    row.nextPriceId,
    ...[pending, next, ...swept].map((sub) => sub?.notes.priceId ?? null),
  ].filter((id): id is string => id !== null)
  const prices = await planRepository.findPricesByIds([...new Set(priceIds)])
  const planIdByPriceId = new Map(prices.map((price) => [price.id, price.planId]))

  /**
   * The subscription when its notes name this workspace.
   */
  const own = (sub: ProviderSubscription | undefined): ProviderSubscription | undefined => {
    if (sub === undefined || sub.notes.tenantId === row.tenantId) return sub
    alerts.push({
      kind: 'reconcile_repair',
      message: BILLING_ALERT_TEXT.foreignSubscription(sub.id),
      subscriptionId: sub.id,
    })
    return undefined
  }
  /**
   * The subscription unless it could become current with an unknown price.
   */
  const priced = (
    sub: ProviderSubscription | undefined,
    priceId: string | null | undefined
  ): ProviderSubscription | undefined => {
    if (sub === undefined || !isRunning(sub)) return sub
    if (priceId !== null && priceId !== undefined && planIdByPriceId.has(priceId)) return sub
    alerts.push({
      kind: 'reconcile_repair',
      message: BILLING_ALERT_TEXT.unknownPrice(sub.id),
      subscriptionId: sub.id,
    })
    return undefined
  }

  const subs: BillingSubscriptions = {}
  const currentSub = own(current)
  if (currentSub !== undefined) subs.current = currentSub
  // A foreign current subscription would read as no current one, which looks like a handover or a free slot.
  const isCurrentForeign = current !== undefined && currentSub === undefined
  if (!isCurrentForeign) {
    const ownPending = own(pending)
    const pendingSub = priced(ownPending, ownPending?.notes.priceId)
    if (pendingSub !== undefined) subs.pending = pendingSub
    const ownNext = own(next)
    const nextSub = priced(ownNext, row.nextPriceId ?? ownNext?.notes.priceId)
    if (nextSub !== undefined) subs.next = nextSub
    const sweptSubs = swept.flatMap((sub) => {
      const kept = priced(own(sub), sub.notes.priceId)
      return kept === undefined ? [] : [kept]
    })
    if (sweptSubs.length > 0) subs.swept = sweptSubs
  }

  const [settings, free] = await Promise.all([
    planRepository.getSettings(),
    planRepository.findPlanByKey('free'),
  ])
  if (free === undefined) throw new Error('The free plan is missing')
  return {
    subs,
    alerts,
    planIdByPriceId,
    freePlanId: free.id,
    graceDays: settings.pastDueGraceDays,
  }
}

/**
 * Whether a write changes the subscriptions the row holds in a way a spent
 * lifecycle cancel did not cover: a new current one (an adoption of the
 * held checkout, a promotion of the held switch, or one the sweep found), or
 * any id the row did not hold.
 * @param before - The row before the write.
 * @param after - The row's held ids after it.
 * @returns True when the write needs a new lifecycle cancel.
 */
function hasNewHeldId(
  before: TenantBillingRecord,
  after: Parameters<typeof heldSubscriptionIds>[0]
): boolean {
  if (
    after.providerSubscriptionId !== null &&
    after.providerSubscriptionId !== before.providerSubscriptionId
  ) {
    return true
  }
  const held = new Set(heldSubscriptionIds(before))
  return heldSubscriptionIds(after).some((id) => !held.has(id))
}

/**
 * Queue the prompt lifecycle cancel for a suspended or archived workspace
 * that a sync gave a new subscription. A failure is logged: the frequent run
 * claims the workspace anyway, since the sync released its claim.
 * @param tenantId - The workspace.
 */
async function queueLifecycleCancel(tenantId: string): Promise<void> {
  try {
    await addBillingLifecycleCancelJob({ tenantId })
  } catch (error) {
    logger.warn('Could not queue the lifecycle cancel of a subscription a sync brought in', {
      error,
      tenantId,
    })
  }
}

/**
 * Lock the row, map it and write it, unless it changed since it was read. A
 * subscription that becomes current records the running provider and mode.
 * When the workspace is suspended or archived and the write gives it a new
 * current subscription (an adoption or a promotion) or an id it did not
 * hold, the lifecycle cancel claim is released in the same write, so the
 * new subscription is cancelled too. An archived workspace that adopts a
 * paid checkout or a found subscription has it cancelled now and refunded
 * after the commit, with one staff alert for the refund's outcome.
 * @param provider - The payment provider.
 * @param run - The sync call.
 * @param readVersion - The version the fetch was based on.
 * @param fetched - The provider's view and the plans.
 * @returns The committed write, or undefined when the row was stale.
 */
async function commitSync(
  provider: BillingProviderClient,
  run: SyncRun,
  readVersion: number,
  fetched: FetchedState
): Promise<CommittedSync | undefined> {
  return withTransaction(async (tx) => {
    const locked = await billingRepository.lockByTenantId(run.tenantId, tx)
    if (locked === undefined || locked.version !== readVersion) return
    const mapped = nextBillingRow(locked, fetched.subs, run.now, fetched.graceDays)
    const patch: Partial<NewTenantBilling> = { ...mapped.patch, syncedAt: run.now }
    const state = patch.state ?? locked.state
    const priceId = patch.priceId === undefined ? locked.priceId : patch.priceId
    // A trialing or past-due row keeps its stored plan; reads derive the plan in force from the state.
    let planId = locked.planId
    if (state === 'active' && priceId !== null) {
      planId = fetched.planIdByPriceId.get(priceId) ?? planId
    }
    if (state === 'free') planId = fetched.freePlanId
    if (planId !== locked.planId) patch.planId = planId
    if (patch.providerSubscriptionId !== undefined && patch.providerSubscriptionId !== null) {
      if (locked.provider !== provider.kind) patch.provider = provider.kind
      if (locked.providerMode !== provider.mode) patch.providerMode = provider.mode
      // A new subscription with no payer on record (a stored checkout clears it) is paid for by the owner who started its checkout until a confirm says who paid; a payer the confirm set is never replaced.
      if (
        patch.providerSubscriptionId !== locked.providerSubscriptionId &&
        locked.payerUserId === null &&
        locked.checkoutStartedBy !== null &&
        // A starter whose account was deleted since is never made the payer.
        (await userRepository.findById(locked.checkoutStartedBy, {}, tx)) !== undefined
      ) {
        patch.payerUserId = locked.checkoutStartedBy
        // The address belongs to an earlier payer; the confirm sets the new one's.
        patch.billingEmail = null
      }
    }

    // A plain read of the workspace row, which takes no lock, so the lock order holds.
    const tenant = await tenantRepository.findByIdIncludingDeleted(run.tenantId, tx)
    const isNeedsLifecycleCancel =
      tenant !== undefined &&
      tenant.lifecycleState !== 'active' &&
      hasNewHeldId(locked, {
        providerSubscriptionId:
          patch.providerSubscriptionId === undefined
            ? locked.providerSubscriptionId
            : patch.providerSubscriptionId,
        pendingSubscriptionId:
          patch.pendingSubscriptionId === undefined
            ? locked.pendingSubscriptionId
            : patch.pendingSubscriptionId,
        nextSubscriptionId:
          patch.nextSubscriptionId === undefined
            ? locked.nextSubscriptionId
            : patch.nextSubscriptionId,
      })
    // A claim spent on the ids held before must not keep the new one from its cancel.
    if (isNeedsLifecycleCancel && locked.lifecycleCancelSentAt !== null) {
      patch.lifecycleCancelSentAt = null
    }
    const actions = [...mapped.actions]
    const adopted = patch.providerSubscriptionId
    // An archived workspace adopting a paid checkout (not a switch's handover) had no running subscription: nothing it can use was paid for.
    if (
      tenant?.lifecycleState === 'archived' &&
      typeof adopted === 'string' &&
      adopted !== locked.providerSubscriptionId &&
      adopted !== locked.nextSubscriptionId
    ) {
      // One alert, raised once the refund's outcome is known (`refundDuplicate`).
      actions.push({ kind: 'refund_duplicate', subscriptionId: adopted, cause: 'archived' })
    }

    const after = await billingRepository.updateVersioned(run.tenantId, locked.version, patch, tx)
    if (after === undefined) return
    if (mapped.cause !== null) {
      await billingRepository.appendHistory(
        {
          tenantId: run.tenantId,
          fromState: locked.state,
          toState: after.state,
          cause: mapped.cause,
          source: run.source,
        },
        tx
      )
    }
    const fulfilledRequests =
      after.state === 'active' && locked.state !== 'active'
        ? await billingRepository.fulfilUpgradeRequests(run.tenantId, tx)
        : []
    return {
      before: locked,
      after,
      // Read against the locked row: a stand-in period end it stored at an adoption.
      isFirstPaidCycle: isFirstPaidCycle(locked, fetched.subs.current),
      actions,
      changed: Object.keys(patch).some((key) => key !== 'syncedAt'),
      fulfilledRequests,
      needsLifecycleCancel: isNeedsLifecycleCancel,
    }
  })
}

/**
 * Statuses after which a subscription can no longer be cancelled.
 */
const ENDED_STATUSES: ReadonlySet<ProviderSubscription['status']> = new Set([
  'cancelled',
  'completed',
  'expired',
])

/**
 * A subscription read again after a cancel failed, when it has ended: another
 * sync, the payer or the provider ended it first.
 * @param provider - The payment provider.
 * @param subscriptionId - The subscription.
 * @returns The ended subscription, or undefined when it still runs or cannot be read.
 */
async function endedSubscription(
  provider: BillingProviderClient,
  subscriptionId: string
): Promise<ProviderSubscription | undefined> {
  try {
    const sub = await provider.fetchSubscription(subscriptionId)
    return ENDED_STATUSES.has(sub.status) ? sub : undefined
  } catch (error) {
    logger.warn('Could not read a subscription after its cancel failed', { error, subscriptionId })
    return undefined
  }
}

/**
 * Cancel a subscription now: after its grace ended, or because the workspace
 * is already on Free. A cancel that fails because the subscription has
 * already ended is not an error. Any move to Free waits for the follow-up
 * sync to read it ended.
 * @param provider - The payment provider.
 * @param tenantId - The workspace.
 * @param subscriptionId - The subscription.
 * @returns True when the subscription is cancelled or had already ended.
 */
async function didCancelNow(
  provider: BillingProviderClient,
  tenantId: string,
  subscriptionId: string
): Promise<boolean> {
  try {
    await provider.cancelSubscription(subscriptionId, false)
    return true
  } catch (error) {
    if ((await endedSubscription(provider, subscriptionId)) !== undefined) {
      logger.debug('A subscription to cancel had already ended', { tenantId, subscriptionId })
      return true
    }
    logger.error('Could not cancel a subscription', { error, tenantId, subscriptionId })
    await insertAlert(tenantId, {
      kind: 'reconcile_repair',
      message: BILLING_ALERT_TEXT.cancelFailed(subscriptionId),
      subscriptionId,
    })
    return false
  }
}

/**
 * Cancel the current subscription at its cycle end, once the switch's next
 * subscription is authenticated, and record the scheduled cancel on the row:
 * the provider does not show it.
 * @param provider - The payment provider.
 * @param run - The sync call.
 * @param subscriptionId - The current subscription.
 */
async function cancelAtCycleEnd(
  provider: BillingProviderClient,
  run: SyncRun,
  subscriptionId: string
): Promise<void> {
  const { tenantId } = run
  try {
    await provider.cancelSubscription(subscriptionId, true)
  } catch (error) {
    logger.error('Could not schedule the cancel of a switched subscription', {
      error,
      tenantId,
      subscriptionId,
    })
    await insertAlert(tenantId, {
      kind: 'reconcile_repair',
      message: BILLING_ALERT_TEXT.switchCancelFailed(subscriptionId),
      subscriptionId,
    })
    return
  }
  try {
    const written = await withTransaction(async (tx) => {
      const locked = await billingRepository.lockByTenantId(tenantId, tx)
      if (locked?.providerSubscriptionId !== subscriptionId || locked.cancelAtPeriodEnd) return
      const after = await billingRepository.updateVersioned(
        tenantId,
        locked.version,
        { cancelAtPeriodEnd: true },
        tx
      )
      return after === undefined ? undefined : { before: locked, after }
    })
    if (written !== undefined) await emitBillingDiff(written.before, written.after, run.source)
  } catch (error) {
    logger.error('Could not record a scheduled cancel', { error, tenantId, subscriptionId })
    await insertAlert(tenantId, {
      kind: 'reconcile_repair',
      message: BILLING_ALERT_TEXT.switchCancelNotRecorded(subscriptionId),
      subscriptionId,
    })
  }
}

/**
 * The staff alert for each outcome of cancelling and refunding a
 * subscription, by why it is refunded: a duplicate, or one an archived
 * workspace adopted.
 */
const REFUND_ALERTS = {
  duplicate: {
    cancelFailed: BILLING_ALERT_TEXT.duplicateCancelFailed,
    refundFailed: BILLING_ALERT_TEXT.duplicateRefundFailed,
    refunded: BILLING_ALERT_TEXT.duplicateRefunded,
    nothingPaid: BILLING_ALERT_TEXT.duplicateNothingPaid,
    partlyRefunded: BILLING_ALERT_TEXT.duplicatePartlyRefunded,
  },
  late_switch: {
    cancelFailed: BILLING_ALERT_TEXT.duplicateCancelFailed,
    refundFailed: BILLING_ALERT_TEXT.duplicateRefundFailed,
    refunded: BILLING_ALERT_TEXT.duplicateRefunded,
    nothingPaid: BILLING_ALERT_TEXT.duplicateNothingPaid,
    partlyRefunded: BILLING_ALERT_TEXT.duplicatePartlyRefunded,
  },
  archived: {
    cancelFailed: BILLING_ALERT_TEXT.archivedCancelFailed,
    refundFailed: BILLING_ALERT_TEXT.archivedRefundFailed,
    refunded: BILLING_ALERT_TEXT.archivedRefunded,
    nothingPaid: BILLING_ALERT_TEXT.archivedNothingPaid,
    partlyRefunded: BILLING_ALERT_TEXT.archivedPartlyRefunded,
  },
} as const

/**
 * Cancel a subscription now and refund its latest payment in full: a
 * duplicate, or one an archived workspace adopted. Safe to run twice at
 * once: a cancel that fails because the subscription has already ended is
 * not an error, and the provider refunds a payment once, so only the caller
 * that refunded raises the refund alert. Each outcome raises one alert,
 * worded for it and for the cause: refunded, nothing paid, refunded in part
 * (staff refund the rest), or a cancel or refund that failed (staff act at
 * the provider). Only a refund is reported to analytics, with its cause,
 * timed at the sync's write that found it.
 *
 * A duplicate or late switch is recorded for the tax run before the cancel.
 * If that record fails, the cancel and refund don't run and the error
 * reaches the caller; the next reconcile finds the subscription still
 * running and tries again, so a refund never goes out untracked.
 * @param provider - The payment provider.
 * @param reported - The workspace's row as the sync's write left it.
 * @param subscriptionId - The subscription.
 * @param cause - Why it is refunded.
 */
async function refundDuplicate(
  provider: BillingProviderClient,
  reported: TenantBillingRecord,
  subscriptionId: string,
  cause: 'duplicate' | 'archived' | 'late_switch'
): Promise<void> {
  const { tenantId } = reported
  const alerts = REFUND_ALERTS[cause]
  // Recorded before the cancel, so a cancel or refund failure still leaves the charge tracked for tax.
  if (cause !== 'archived') {
    await billingRepository.recordTrackedSubscription(
      tenantId,
      { kind: provider.kind, mode: provider.mode },
      subscriptionId,
      cause
    )
  }
  try {
    await provider.cancelSubscription(subscriptionId, false)
  } catch (error) {
    if ((await endedSubscription(provider, subscriptionId)) === undefined) {
      logger.error('Could not cancel a subscription to refund', {
        error,
        tenantId,
        subscriptionId,
        cause,
      })
      await insertAlert(tenantId, {
        kind: 'reconcile_repair',
        message: alerts.cancelFailed(subscriptionId),
        subscriptionId,
      })
      return
    }
    logger.debug('A subscription to refund had already ended', { tenantId, subscriptionId })
  }
  let outcome: ProviderRefundOutcome
  try {
    outcome = await provider.refundLatestPayment(subscriptionId)
  } catch (error) {
    logger.error('Could not refund a subscription', { error, tenantId, subscriptionId, cause })
    await insertAlert(tenantId, {
      kind: 'reconcile_repair',
      message: alerts.refundFailed(subscriptionId),
      subscriptionId,
    })
    return
  }
  // A duplicate's outcome is a duplicate_refunded alert; an archived workspace's is a repair note.
  const doneKind = cause === 'archived' ? 'reconcile_repair' : 'duplicate_refunded'
  switch (outcome.status) {
    case 'refunded': {
      await insertAlert(tenantId, {
        kind: doneKind,
        message: alerts.refunded(subscriptionId, outcome.amountMinor, outcome.refundId),
      })
      await trackProviderEvent(
        reported,
        { type: 'duplicate_subscription_refunded', refundCause: cause },
        subscriptionId
      )
      return
    }
    case 'nothing_paid': {
      await insertAlert(tenantId, {
        kind: doneKind,
        message: alerts.nothingPaid(subscriptionId),
        subscriptionId,
      })
      return
    }
    case 'already_refunded': {
      logger.debug('A subscription was refunded already', { tenantId, subscriptionId })
      return
    }
    case 'partly_refunded': {
      await insertAlert(tenantId, {
        kind: 'reconcile_repair',
        message: alerts.partlyRefunded(subscriptionId),
        subscriptionId,
      })
      break
    }
    default: {
      const unhandled: never = outcome
      throw new Error(`Unhandled refund outcome ${String(unhandled)}`)
    }
  }
}

/**
 * Run a committed sync's follow-ups: alerts, the members' push, and the
 * provider calls. None rejects; a failed provider call is logged and alerted,
 * and the committed state stands.
 * @param provider - The payment provider.
 * @param run - The sync call.
 * @param committed - The committed write.
 * @param alerts - Alerts from the fetch.
 * @returns Whether a follow-up sync should read the new provider state.
 */
async function runFollowUps(
  provider: BillingProviderClient,
  run: SyncRun,
  committed: CommittedSync,
  alerts: readonly PendingAlert[]
): Promise<{ shouldResync: boolean }> {
  const { tenantId } = run
  for (const alert of alerts) await insertAlert(tenantId, alert)
  for (const action of committed.actions) {
    if (action.kind === 'alert') {
      await insertAlert(tenantId, {
        kind: action.alert,
        message: action.message,
        ...(action.subscriptionId !== undefined && { subscriptionId: action.subscriptionId }),
      })
    }
  }
  await emitBillingDiff(committed.before, committed.after, run.source, {
    fulfilledRequests: committed.fulfilledRequests,
    isFirstPaidCycle: committed.isFirstPaidCycle,
  })
  let shouldResync = false
  for (const action of committed.actions) {
    switch (action.kind) {
      case 'cancel_now': {
        if (await didCancelNow(provider, tenantId, action.subscriptionId)) shouldResync = true
        break
      }
      case 'cancel_current_at_cycle_end': {
        await cancelAtCycleEnd(provider, run, action.subscriptionId)
        break
      }
      case 'refund_duplicate': {
        await refundDuplicate(
          provider,
          committed.after,
          action.subscriptionId,
          action.cause ?? 'duplicate'
        )
        break
      }
      case 'promote_next': {
        shouldResync = true
        break
      }
      case 'alert': {
        break
      }
    }
  }
  return { shouldResync }
}

/**
 * One sync call: read, fetch, commit, follow up.
 * @param run - The sync call.
 * @returns What the sync did.
 * @throws {ProviderError} When a fetch fails; nothing is written.
 * @throws {BillingSyncConflictError} When the row changed under both attempts.
 */
async function runSync(run: SyncRun): Promise<SyncResult> {
  const { tenantId } = run
  const provider = getBillingProvider()
  if (provider === null) {
    const row = await billingRepository.findByTenantId(tenantId)
    return { outcome: 'payments_off', changed: false, row }
  }
  for (let attempt = 1; attempt <= SYNC_ATTEMPTS; attempt += 1) {
    const row = await billingRepository.findByTenantId(tenantId)
    if (row === undefined) {
      logger.warn('A billing sync found no billing row', { tenantId })
      return { outcome: 'no_row', changed: false, row: undefined }
    }
    if (isOtherProvider(row, provider)) {
      logger.warn('A billing sync skipped a row of another provider or mode', {
        tenantId,
        rowProvider: row.provider,
        rowMode: row.providerMode,
        provider: provider.kind,
        mode: provider.mode,
      })
      return { outcome: 'provider_mismatch', changed: false, row }
    }
    const fetched = await fetchState(provider, row, run.extraSubscriptionIds)
    const committed = await commitSync(provider, run, row.version, fetched)
    if (committed === undefined) continue
    const { shouldResync } = await runFollowUps(provider, run, committed, fetched.alerts)
    if (committed.needsLifecycleCancel) await queueLifecycleCancel(tenantId)
    const result: SyncResult = {
      outcome: 'synced',
      changed: committed.changed,
      row: committed.after,
    }
    if (!shouldResync || !run.mayFollowUp) return result
    try {
      const followUp = await runSync({ ...run, extraSubscriptionIds: [], mayFollowUp: false })
      return { ...followUp, changed: result.changed || followUp.changed }
    } catch (error) {
      logger.warn('A follow-up billing sync failed; the next sync finishes it', {
        error,
        tenantId,
      })
      return result
    }
  }
  throw new BillingSyncConflictError(tenantId)
}

/**
 * Bring a workspace's billing row in line with its provider subscriptions.
 * The only writer of provider-driven billing state. With payments off, or for
 * a row of another provider or mode, it changes nothing. Every sync that
 * writes stamps `syncedAt`, so it moves the row's version; a concurrent writer
 * can therefore make a sync give up with `BillingSyncConflictError`, which a
 * job absorbs by retrying. A sync that ends `synced` queues one tax run,
 * here and not in the recursive `runSync`, so a follow-up sync queues none
 * of its own.
 * @param tenantId - The workspace.
 * @param source - What asked for the sync, for the history.
 * @param options - Optional inputs.
 * @param options.now - The current time; defaults to now.
 * @param options.extraSubscriptionIds - Subscriptions the reconcile found whose notes name this workspace but that its row does not hold: a running one is adopted when the workspace has none, else refunded as a duplicate.
 * @returns What the sync did and the row after it.
 * @throws {ProviderError} When a provider call to read state fails; nothing is written, and the caller retries.
 * @throws {BillingSyncConflictError} When the row kept changing; nothing is written, and the caller retries.
 */
export async function syncTenantBilling(
  tenantId: string,
  source: BillingHistorySource,
  options: { now?: Date; extraSubscriptionIds?: readonly string[] } = {}
): Promise<SyncResult> {
  const result = await runSync({
    tenantId,
    source,
    now: options.now ?? new Date(),
    extraSubscriptionIds: options.extraSubscriptionIds ?? [],
    mayFollowUp: true,
  })
  if (result.outcome === 'synced') await queueTaxReconcile(tenantId)
  return result
}
