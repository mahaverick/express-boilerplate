/**
 * @file The billing schedulers' work: the frequent run (every 15 minutes)
 * and the daily run (03:30 UTC) that make time-based billing changes
 * durable. Each run is a list of independent named steps: one that fails is
 * logged and reported, and the next still runs. Every step is safe when two
 * runs overlap: a step either claims its rows, re-checks them under the row
 * lock, or hands them to `syncTenantBilling`, whose versioned write and
 * idempotent provider follow-ups act once.
 *
 * Frequent: lapsed trials move to Free; grace endings, cancelling periods
 * past their buffer and due interval switches are synced; the subscriptions
 * of suspended (cycle end) and archived (now) workspaces are cancelled;
 * grants and upgrade requests lapse. Daily: the reconcile queues a sync for
 * every row that holds a subscription, for each running subscription whose
 * notes name a workspace whose row does not hold it, and for each workspace
 * whose webhook event failed in the last three days.
 *
 * The lifecycle transactions (suspend, archive) never touch the billing row:
 * an invite locks the billing row before invitation rows, and an archive
 * locks the tenant row and then invitation rows, so a billing write there
 * would invert the order. This job cancels for them instead.
 */
import { getEnv } from '@/configs/env.config'
import { CANCEL_BUFFER_DAYS } from '@/constants/billing.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import { ProviderError } from '@/errors/billing-provider-errors'
import { addBillingSyncJob } from '@/jobs/billing.job'
import { BillingRepository, type ProviderScope } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { record } from '@/services/audit.service'
import {
  emitBillingDiff,
  publishEntitlementsChanged,
} from '@/services/billing/billing-events.service'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { withTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import type { BillingProviderClient, ProviderSubscription } from '@/types/billing'
import { isRunning } from '@/utilities/billing-state-machine.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How many rows one page of a step reads.
 */
const PAGE_SIZE = 100

/**
 * How many lifecycle cancels one claim takes.
 */
const LIFECYCLE_CLAIM_SIZE = 25

/**
 * How far back the reconcile looks for new subscriptions and failed events.
 * Razorpay's list is all-or-nothing, so the window stays short.
 */
const RECONCILE_LOOKBACK_DAYS = 3

/**
 * The longest message `billing_alerts.message` stores.
 */
const ALERT_MESSAGE_MAX_LENGTH = 280

/**
 * Provider statuses after which a subscription can no longer be cancelled.
 */
const ENDED_STATUSES: ReadonlySet<ProviderSubscription['status']> = new Set([
  'cancelled',
  'completed',
  'expired',
])

/**
 * What one step did: rows it changed or queued, rows it passed over, and
 * rows whose handling failed.
 */
interface StepCounts {
  acted: number
  skipped: number
  failed: number
}

/**
 * One step's outcome in a run's report. `failed` means the step itself
 * threw; its counts are what it did before that.
 */
interface StepReport extends StepCounts {
  status: 'ok' | 'failed'
}

/**
 * A run's report: each step's outcome by its name.
 */
export type BillingRunReport = Record<string, StepReport>

/**
 * One named step of a run.
 */
interface BillingStep {
  name: string
  /**
   * Do the step's work, adding to `counts` as it goes.
   */
  run: (now: Date, counts: StepCounts) => Promise<void>
}

/**
 * The running provider, its mode and kind as a query scope.
 * @returns The provider and its scope, or undefined when payments are off.
 */
function runningProvider(): { provider: BillingProviderClient; scope: ProviderScope } | undefined {
  const provider = getBillingProvider()
  if (provider === null) return undefined
  return { provider, scope: { kind: provider.kind, mode: provider.mode } }
}

/**
 * Run each step in turn. A step that throws is logged with its name and
 * reported failed; the rest still run.
 * @param run - The run's name, for the log.
 * @param steps - The steps, in order.
 * @param now - The run's time.
 * @returns Each step's outcome.
 */
async function runSteps(
  run: string,
  steps: readonly BillingStep[],
  now: Date
): Promise<BillingRunReport> {
  const report: BillingRunReport = {}
  for (const step of steps) {
    const counts: StepCounts = { acted: 0, skipped: 0, failed: 0 }
    try {
      await step.run(now, counts)
      report[step.name] = { status: 'ok', ...counts }
    } catch (error) {
      logger.error('A billing scheduler step failed', { error, run, step: step.name })
      report[step.name] = { status: 'failed', ...counts }
    }
  }
  logger.info('Billing scheduler run finished', { run, report })
  return report
}

/**
 * Walk every row a paged query returns, acting on each. A row whose
 * handling throws is logged by its workspace id and counted failed; the walk
 * goes on.
 * @param step - The step's name, for the log.
 * @param counts - The step's counts, added to.
 * @param listPage - Reads the page after a workspace id (null for the first).
 * @param act - Handles one row; answers whether it acted or skipped it.
 */
async function eachRow(
  step: string,
  counts: StepCounts,
  listPage: (afterTenantId: string | null) => Promise<TenantBillingRecord[]>,
  act: (row: TenantBillingRecord) => Promise<'acted' | 'skipped'>
): Promise<void> {
  let after: string | null = null
  for (;;) {
    const rows = await listPage(after)
    for (const row of rows) {
      try {
        counts[await act(row)] += 1
      } catch (error) {
        counts.failed += 1
        logger.warn('A billing scheduler step failed for a workspace', {
          error,
          step,
          tenantId: row.tenantId,
        })
      }
    }
    if (rows.length < PAGE_SIZE) return
    after = rows.at(-1)?.tenantId ?? null
  }
}

/**
 * Sync a row's workspace for a scheduled step.
 * @param row - The due row.
 * @param now - The run's time.
 * @returns `acted` once the sync ran.
 */
async function syncRow(row: TenantBillingRecord, now: Date): Promise<'acted'> {
  await syncTenantBilling(row.tenantId, 'job', { now })
  return 'acted'
}

/**
 * Insert a staff alert unless the workspace already has one with the same
 * message. A failure is logged: what it reports has already happened.
 * @param tenantId - The workspace, or null for an alert about no one workspace.
 * @param message - The message.
 */
async function alertOnce(tenantId: string | null, message: string): Promise<void> {
  const text = message.slice(0, ALERT_MESSAGE_MAX_LENGTH)
  try {
    if (await billingRepository.hasAlertNaming(tenantId, 'reconcile_repair', text)) return
    await billingRepository.insertAlert({ kind: 'reconcile_repair', tenantId, message: text })
  } catch (error) {
    logger.error('Could not record a billing alert', { error, tenantId })
  }
}

/**
 * Whether a sync failure leaves the workspace's subscriptions unknown for
 * now: a provider error a retry can change. A refusal (an id the provider
 * does not know) cannot change, so it is not.
 * @param error - What the sync threw.
 * @returns True when a later run should try again before acting.
 */
function isTransientSyncFailure(error: unknown): boolean {
  return !(error instanceof ProviderError) || error.retryable
}

/**
 * Move one lapsed trial to Free. A row that holds a subscription is synced
 * first, so a paid checkout makes it active instead; the move happens only
 * if the row is still a lapsed trial under the lock, so two runs move it once.
 * @param row - The due row, read without a lock.
 * @param now - The run's time.
 * @param freePlanId - The Free plan's id.
 * @returns `acted` when this call moved it.
 * @throws {Error} When a sync fails in a way a later run may resolve; nothing is written.
 */
async function endTrial(
  row: TenantBillingRecord,
  now: Date,
  freePlanId: string
): Promise<'acted' | 'skipped'> {
  const hasSubscription =
    row.providerSubscriptionId !== null ||
    row.pendingSubscriptionId !== null ||
    row.nextSubscriptionId !== null
  if (hasSubscription) {
    try {
      await syncTenantBilling(row.tenantId, 'job', { now })
    } catch (error) {
      if (isTransientSyncFailure(error)) throw error
      logger.warn('A lapsed trial holds a subscription the provider refused to read', {
        error,
        tenantId: row.tenantId,
      })
    }
  }
  const written = await withTransaction(async (tx) => {
    const locked = await billingRepository.lockByTenantId(row.tenantId, tx)
    if (locked?.state !== 'trialing') return
    if (locked.trialEndsAt === null || locked.trialEndsAt > now) return
    const after = await billingRepository.updateVersioned(
      locked.tenantId,
      locked.version,
      { state: 'free', planId: freePlanId, priceId: null },
      tx
    )
    if (after === undefined) return
    await billingRepository.appendHistory(
      {
        tenantId: locked.tenantId,
        fromState: 'trialing',
        toState: 'free',
        cause: 'trial_ended',
        source: 'job',
      },
      tx
    )
    return { before: locked, after }
  })
  if (written === undefined) return 'skipped'
  await emitBillingDiff(written.before, written.after, 'job')
  return 'acted'
}

/**
 * Cancel one subscription for a lifecycle change. A cancel refused because
 * the subscription has ended is fine; any other failure alerts staff once,
 * since the claim is kept and the job does not try again.
 * @param provider - The payment provider.
 * @param tenantId - The workspace.
 * @param subscriptionId - The subscription.
 * @param isAtCycleEnd - True to keep it until its cycle ends.
 * @returns True when the cancel went through.
 */
async function didCancelForLifecycle(
  provider: BillingProviderClient,
  tenantId: string,
  subscriptionId: string,
  isAtCycleEnd: boolean
): Promise<boolean> {
  try {
    await provider.cancelSubscription(subscriptionId, isAtCycleEnd)
    return true
  } catch (error) {
    try {
      const sub = await provider.fetchSubscription(subscriptionId)
      if (ENDED_STATUSES.has(sub.status)) return false
    } catch (readError) {
      logger.warn('Could not read a subscription after its cancel failed', {
        error: readError,
        tenantId,
        subscriptionId,
      })
    }
    logger.error('Could not cancel the subscription of a suspended or archived workspace', {
      error,
      tenantId,
      subscriptionId,
    })
    await alertOnce(
      tenantId,
      `Could not cancel subscription ${subscriptionId} of a suspended or archived workspace. Cancel it at the provider.`
    )
    return false
  }
}

/**
 * Record a cycle-end cancel on the row, which the provider does not show,
 * when the row still holds that subscription.
 * @param tenantId - The workspace.
 * @param subscriptionId - The subscription cancelled at its cycle end.
 */
async function markCancelling(tenantId: string, subscriptionId: string): Promise<void> {
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
  if (written !== undefined) await emitBillingDiff(written.before, written.after, 'job')
}

/**
 * Cancel what a claimed suspended or archived workspace still holds, then
 * sync it. The current subscription is cancelled at its cycle end for a
 * suspension and now for an archive; a deferred start (no cycle yet), a
 * scheduled switch and a checkout are always cancelled now, since the
 * provider refuses a cycle-end cancel without a cycle and no card may be
 * charged later.
 * @param provider - The payment provider.
 * @param row - The claimed row, with the workspace's lifecycle state.
 * @param now - The run's time.
 * @returns `acted`.
 */
async function cancelLifecycleRow(
  provider: BillingProviderClient,
  row: TenantBillingRecord & { lifecycleState: 'suspended' | 'archived' },
  now: Date
): Promise<'acted'> {
  const { tenantId } = row
  const currentId =
    (row.state === 'active' || row.state === 'past_due') && !row.cancelAtPeriodEnd
      ? row.providerSubscriptionId
      : null
  if (currentId !== null) {
    const current = await provider.fetchSubscription(currentId)
    if (!ENDED_STATUSES.has(current.status)) {
      const hasCycle = current.status !== 'created' && current.status !== 'authenticated'
      const isAtCycleEnd = row.lifecycleState === 'suspended' && hasCycle
      const cancelled = await didCancelForLifecycle(provider, tenantId, currentId, isAtCycleEnd)
      if (cancelled && isAtCycleEnd) await markCancelling(tenantId, currentId)
    }
  }
  for (const id of [row.nextSubscriptionId, row.pendingSubscriptionId]) {
    if (id !== null) await didCancelForLifecycle(provider, tenantId, id, false)
  }
  await syncTenantBilling(tenantId, 'job', { now })
  return 'acted'
}

/**
 * The lifecycle step: release the claims of workspaces that are active
 * again, then claim and cancel for each suspended or archived one. A claim
 * is committed before any provider call, so two runs never cancel the same
 * workspace's subscriptions.
 * @param provider - The payment provider.
 * @param scope - Its query scope.
 * @param now - The run's time.
 * @param counts - The step's counts, added to.
 */
async function runLifecycleCancels(
  provider: BillingProviderClient,
  scope: ProviderScope,
  now: Date,
  counts: StepCounts
): Promise<void> {
  const released = await billingRepository.releaseLifecycleCancelClaims()
  if (released > 0) logger.info('Released lifecycle cancel claims', { released })
  for (;;) {
    const claimed = await withTransaction((tx) =>
      billingRepository.claimLifecycleCancels(scope, LIFECYCLE_CLAIM_SIZE, tx)
    )
    for (const row of claimed) {
      try {
        await cancelLifecycleRow(provider, row, now)
        counts.acted += 1
      } catch (error) {
        counts.failed += 1
        logger.warn('A lifecycle cancel failed for a workspace', {
          error,
          tenantId: row.tenantId,
        })
      }
    }
    if (claimed.length < LIFECYCLE_CLAIM_SIZE) return
  }
}

/**
 * The grants step: mark each lapsed grant once, audit it as the system in
 * the same transaction, then tell each workspace's members.
 * @param now - The run's time.
 * @param counts - The step's counts, added to.
 */
async function expireGrants(now: Date, counts: StepCounts): Promise<void> {
  const expired = await withTransaction(async (tx) => {
    const grants = await planRepository.expireDueGrants(now, tx)
    for (const grant of grants) {
      await record(
        {
          action: 'billing.grant_expired',
          actor: 'system',
          access: 'system',
          tenantId: grant.tenantId,
          targetId: grant.tenantId,
          metadata: { grantId: grant.id, key: grant.key },
        },
        tx
      )
    }
    return grants
  })
  counts.acted += expired.length
  for (const tenantId of new Set(expired.map((grant) => grant.tenantId))) {
    try {
      await publishEntitlementsChanged(tenantId)
    } catch (error) {
      logger.error('Could not push an entitlements change', { error, tenantId })
    }
  }
}

/**
 * The frequent run's steps, in order. Each is independent of the others.
 */
const FREQUENT_STEPS: readonly BillingStep[] = [
  {
    name: 'trial_ends',
    run: async (now, counts) => {
      const free = await planRepository.findPlanByKey('free')
      if (free === undefined) throw new Error('The free plan is missing')
      await eachRow(
        'trial_ends',
        counts,
        (after) => billingRepository.listEndedTrials(now, after, PAGE_SIZE),
        (row) => endTrial(row, now, free.id)
      )
    },
  },
  {
    name: 'grace',
    run: async (now, counts) => {
      const running = runningProvider()
      if (running === undefined) return
      const { pastDueGraceDays } = await planRepository.getSettings()
      await eachRow(
        'grace',
        counts,
        (after) =>
          billingRepository.listGraceEnded(now, pastDueGraceDays, running.scope, after, PAGE_SIZE),
        (row) => syncRow(row, now)
      )
    },
  },
  {
    name: 'cancelling_ended',
    run: async (now, counts) => {
      const running = runningProvider()
      if (running === undefined) return
      await eachRow(
        'cancelling_ended',
        counts,
        (after) =>
          billingRepository.listCancellingEnded(
            now,
            CANCEL_BUFFER_DAYS,
            running.scope,
            after,
            PAGE_SIZE
          ),
        (row) => syncRow(row, now)
      )
    },
  },
  {
    name: 'interval_switches',
    run: async (now, counts) => {
      const running = runningProvider()
      if (running === undefined) return
      await eachRow(
        'interval_switches',
        counts,
        (after) => billingRepository.listSwitchesDue(now, running.scope, after, PAGE_SIZE),
        (row) => syncRow(row, now)
      )
    },
  },
  {
    name: 'lifecycle_cancels',
    run: async (now, counts) => {
      const running = runningProvider()
      if (running === undefined) return
      await runLifecycleCancels(running.provider, running.scope, now, counts)
    },
  },
  { name: 'grants', run: expireGrants },
  {
    name: 'upgrade_requests',
    run: async (now, counts) => {
      counts.acted += await billingRepository.deleteExpiredUpgradeRequests(now)
    },
  },
]

/**
 * Whether a row's subscriptions live with another provider or mode than the
 * running one, whose ids this provider cannot read.
 * @param row - The row.
 * @param scope - The running provider and mode.
 * @returns True when the row names a different provider or mode.
 */
function isOtherProvider(row: TenantBillingRecord, scope: ProviderScope): boolean {
  return (
    (row.provider !== null && row.provider !== scope.kind) ||
    (row.providerMode !== null && row.providerMode !== scope.mode)
  )
}

/**
 * The reconcile's row pass: queue a sync for every row that holds a
 * subscription. It skips, and counts, a row of another provider or mode, and
 * a Free row whose only subscription is its current one: the sync moved it to
 * Free because that subscription ended.
 * @param scope - The running provider and mode.
 * @param counts - The step's counts, added to.
 */
async function reconcileRows(scope: ProviderScope, counts: StepCounts): Promise<void> {
  await eachRow(
    'reconcile',
    counts,
    (after) => billingRepository.listWithSubscriptions(after, PAGE_SIZE),
    async (row) => {
      const isEndedFree =
        row.state === 'free' &&
        row.pendingSubscriptionId === null &&
        row.nextSubscriptionId === null
      if (isOtherProvider(row, scope) || isEndedFree) return 'skipped'
      await addBillingSyncJob({ tenantId: row.tenantId, source: 'reconcile' })
      return 'acted'
    }
  )
}

/**
 * The reconcile's sweep: every running subscription created in the lookback
 * window whose notes name a customer workspace of this environment, and that
 * no row holds, is offered to that workspace's sync, which adopts it or
 * cancels and refunds it as a duplicate. A failed list alerts staff once a
 * day and fails the step.
 * @param provider - The payment provider.
 * @param now - The run's time.
 * @param counts - The step's counts, added to.
 * @throws {ProviderError} When the provider's list fails.
 */
async function sweepSubscriptions(
  provider: BillingProviderClient,
  now: Date,
  counts: StepCounts
): Promise<void> {
  let subs: ProviderSubscription[]
  try {
    subs = await provider.listRecentSubscriptions(
      new Date(now.getTime() - RECONCILE_LOOKBACK_DAYS * DAY_MS)
    )
  } catch (error) {
    await alertOnce(
      null,
      `The reconcile could not list recent subscriptions on ${now.toISOString().slice(0, 10)}. Check the provider, then resync workspaces with a recent checkout.`
    )
    throw error
  }
  const { APP_ENV } = getEnv()
  const extrasByTenant = new Map<string, string[]>()
  for (const sub of subs) {
    const { tenantId, appEnv } = sub.notes
    if (tenantId === undefined || appEnv !== APP_ENV || !isRunning(sub)) {
      counts.skipped += 1
      continue
    }
    if ((await billingRepository.findBySubscriptionId(sub.id)) !== undefined) {
      counts.skipped += 1
      continue
    }
    const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId)
    if (tenant === undefined || tenant.isPlatform) {
      counts.skipped += 1
      continue
    }
    extrasByTenant.set(tenantId, [...(extrasByTenant.get(tenantId) ?? []), sub.id])
  }
  for (const [tenantId, extraSubscriptionIds] of extrasByTenant) {
    await addBillingSyncJob({ tenantId, source: 'reconcile', extraSubscriptionIds })
    counts.acted += 1
  }
}

/**
 * The daily run's steps, in order. Each is independent of the others.
 */
const DAILY_STEPS: readonly BillingStep[] = [
  {
    name: 'reconcile',
    run: async (_now, counts) => {
      const running = runningProvider()
      if (running === undefined) return
      await reconcileRows(running.scope, counts)
    },
  },
  {
    name: 'sweep',
    run: async (now, counts) => {
      const running = runningProvider()
      if (running === undefined) return
      await sweepSubscriptions(running.provider, now, counts)
    },
  },
  {
    name: 'failed_events',
    run: async (now, counts) => {
      const running = runningProvider()
      if (running === undefined) return
      const since = new Date(now.getTime() - RECONCILE_LOOKBACK_DAYS * DAY_MS)
      const tenantIds = await billingRepository.listFailedEventTenantIds(since, running.scope)
      for (const tenantId of tenantIds) {
        await addBillingSyncJob({ tenantId, source: 'reconcile' })
        counts.acted += 1
      }
    },
  },
]

/**
 * The frequent run, every 15 minutes: lapsed trials, grace endings,
 * cancelling periods past their buffer, due interval switches, lifecycle
 * cancels, lapsed grants and expired upgrade requests. Never rejects.
 * @param now - The run's time; defaults to now.
 * @returns Each step's outcome.
 */
export async function runFrequentBilling(now = new Date()): Promise<BillingRunReport> {
  return runSteps('frequent', FREQUENT_STEPS, now)
}

/**
 * The daily run, at 03:30 UTC: the reconcile's row pass, its sweep of recent
 * subscriptions, and a resync for each recently failed webhook event. Each
 * queues `sync-tenant` jobs, so the syncs spread over the billing Worker.
 * Never rejects.
 * @param now - The run's time; defaults to now.
 * @returns Each step's outcome.
 */
export async function runDailyBilling(now = new Date()): Promise<BillingRunReport> {
  return runSteps('daily', DAILY_STEPS, now)
}
