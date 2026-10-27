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
 * grants and upgrade requests lapse; the trial reminders go out (three days
 * before the end, except for a trial of three days or less; on the last day
 * in the workspace's time zone; halfway through a trial longer than six days).
 * Daily: the reconcile queues a sync for every row that holds a subscription,
 * for each running subscription whose notes name a workspace whose row does
 * not hold it, and for each workspace whose webhook event failed in the last
 * three days; with GST registration on, a tax run is queued for each
 * workspace with a processed refund in the last three days, hinted with
 * those payments, and once per registration date for every workspace that
 * tracks a subscription; the yearly renewal reminder and the day-7 and
 * day-30 win-back emails go out. A reminder is claimed before it is sent,
 * and a suspended or archived workspace is never claimed.
 *
 * The lifecycle transactions (suspend, archive) never touch the billing row:
 * an invite locks the billing row before invitation rows, and an archive
 * locks the tenant row and then invitation rows, so a billing write there
 * would invert the order. This job cancels for them instead, and so does the
 * prompt cancel job each one queues after its commit (`runLifecycleCancelFor`),
 * which takes the same claim.
 */
import { gstSellerConfig } from '@/configs/billing.config'
import { getEnv } from '@/configs/env.config'
import { CANCEL_BUFFER_DAYS } from '@/constants/billing.constants'
import { TAX_REFUND_SWEEP_DAYS } from '@/constants/gst.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import { isUnknownIdError } from '@/errors/billing-provider-errors'
import { addBillingSyncJob, addTaxReconcileJob } from '@/jobs/billing.job'
import { BillingRepository, type ProviderScope } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TaxRepository } from '@/repositories/tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { record } from '@/services/audit.service'
import { billingTimeZone } from '@/services/billing/billing-dates.service'
import {
  sendRenewalUpcoming,
  sendTrialEnding,
  sendTrialEndsToday,
  sendTrialMidpoint,
  sendWinback,
} from '@/services/billing/billing-emails.service'
import {
  emitBillingDiff,
  publishEntitlementsChanged,
} from '@/services/billing/billing-events.service'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import {
  BillingSyncConflictError,
  syncTenantBilling,
} from '@/services/billing/billing-sync.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { waitForRedisWrite, withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import type { BillingProviderClient, ProviderSubscription } from '@/types/billing'
import {
  BILLING_ALERT_TEXT,
  cancelFailedMarker,
  legacyCancelFailedMarker,
  LIFECYCLE_ALERT_TEXT,
  readFailedMarker,
} from '@/utilities/billing-alert-text.utilities'
import { isOtherProvider } from '@/utilities/billing-rules.utilities'
import { isRunning } from '@/utilities/billing-state-machine.utilities'
import { formatDateInZone } from '@/utilities/date-text.utilities'
import { istDate } from '@/utilities/gst.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()
const taxRepository = new TaxRepository()

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
 * How many reminders one claim takes.
 */
const REMINDER_CLAIM_SIZE = 25

/**
 * How many days before a yearly plan renews its reminder goes out.
 */
const RENEWAL_REMINDER_DAYS = 7

/**
 * When each win-back email goes out: from its day after the workspace fell
 * to Free, for a week, so a missed daily run still sends it and a workspace
 * long on Free gets none.
 */
const WINBACK_WINDOWS = {
  '7d': { fromDays: 7, toDays: 14 },
  '30d': { fromDays: 30, toDays: 37 },
} as const

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
 * Move one lapsed trial to Free. A row that holds a subscription is synced
 * first, so a paid checkout makes it active instead; the move happens only
 * if the row is still a lapsed trial under the lock, so two runs move it once.
 * @param row - The due row, read without a lock.
 * @param now - The run's time.
 * @param freePlanId - The Free plan's id.
 * @returns `acted` when this call moved it.
 * @throws {Error} When the sync fails for any reason but an unknown subscription id; staff are alerted once and nothing is written, so a later run tries again.
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
      if (error instanceof BillingSyncConflictError) {
        await alertOnce(row.tenantId, BILLING_ALERT_TEXT.trialEndConflict())
        throw error
      }
      if (!isUnknownIdError(error)) {
        await alertOnce(row.tenantId, BILLING_ALERT_TEXT.trialEndSyncFailed())
        throw error
      }
      logger.warn('A lapsed trial holds a subscription the provider does not know', {
        error,
        tenantId: row.tenantId,
      })
      await alertOnce(row.tenantId, BILLING_ALERT_TEXT.trialEndUnknownSubscription())
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
    await alertOnce(tenantId, BILLING_ALERT_TEXT.lifecycleCancelFailed(subscriptionId))
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
 * Bring in a paid checkout or switch of a claimed workspace before its
 * lifecycle cancel, so the cancel never discards a payment: when the
 * checkout or the switch reads as running, the workspace is synced first,
 * which adopts it (and the current subscription's rule then applies) or
 * refunds it as a duplicate, and the row is read again. One that cannot be
 * read alerts staff once, and is cancelled as before.
 * @param provider - The payment provider.
 * @param row - The claimed row.
 * @param now - The run's time.
 * @returns The row to cancel from, and whether a sync ran.
 * @throws {Error} When the sync fails; staff are alerted once and nothing is cancelled, so the claim's retry tries again.
 */
async function bringInPaidCheckouts(
  provider: BillingProviderClient,
  row: TenantBillingRecord,
  now: Date
): Promise<{ row: TenantBillingRecord; hasSynced: boolean }> {
  const { tenantId } = row
  let isPaid = false
  for (const id of [row.pendingSubscriptionId, row.nextSubscriptionId]) {
    if (id === null) continue
    try {
      if (isRunning(await provider.fetchSubscription(id))) isPaid = true
    } catch (error) {
      logger.warn('Could not read a checkout before its lifecycle cancel', {
        error,
        tenantId,
        subscriptionId: id,
      })
      await alertOnce(tenantId, BILLING_ALERT_TEXT.lifecycleCheckoutReadFailed(id))
    }
  }
  if (!isPaid) return { row, hasSynced: false }
  try {
    await syncTenantBilling(tenantId, 'job', { now })
  } catch (error) {
    await alertOnce(tenantId, BILLING_ALERT_TEXT.lifecycleCheckoutSyncFailed())
    throw error
  }
  return { row: (await billingRepository.findByTenantId(tenantId)) ?? row, hasSynced: true }
}

/**
 * The row to cancel from after the sync of a paid checkout, when this run
 * still holds the lifecycle claim. That sync releases the claim when it
 * adopts a subscription (and queues another cancel job): this run takes it
 * again, unless another job took it first, which then cancels instead, so
 * no cancel goes out twice.
 * @param scope - The running provider's query scope.
 * @param claimed - The row as this run claimed it.
 * @param fresh - The row after the sync.
 * @returns The row, claimed by this run, or undefined when another job holds the claim or nothing is left to claim.
 */
async function holdClaim(
  scope: ProviderScope,
  claimed: TenantBillingRecord,
  fresh: TenantBillingRecord
): Promise<TenantBillingRecord | undefined> {
  const sentAt = fresh.lifecycleCancelSentAt
  if (sentAt !== null) {
    return sentAt.getTime() === claimed.lifecycleCancelSentAt?.getTime() ? fresh : undefined
  }
  const [again] = await withTransaction((tx) =>
    billingRepository.claimLifecycleCancels(scope, 1, tx, fresh.tenantId)
  )
  return again
}

/**
 * Cancel what a claimed suspended or archived workspace still holds, then
 * sync it. The workspace's lifecycle state is read again first: one that is
 * active again has its claim released and is skipped. A paid checkout or
 * switch is brought in first (`bringInPaidCheckouts`). The current
 * subscription, whatever the row's state, is cancelled at its cycle end for
 * a suspension of a paying workspace and now for an archive, which also
 * replaces a suspension's cycle-end cancel; one a Free workspace still holds
 * (a halted one after a failed cancel), a deferred start (no cycle yet), a
 * scheduled switch and a checkout are always cancelled now, since their paid
 * time is over or the provider refuses a cycle-end cancel without a cycle,
 * and no card may be charged later. When the current subscription cannot be
 * read, an archive cancels it now anyway, and a suspension alerts staff once.
 * After a sync that brought a paid checkout in, the lifecycle state is read
 * again (a workspace reactivated meanwhile is skipped and released) and
 * the claim is held again (`holdClaim`) before any cancel.
 * @param provider - The payment provider.
 * @param claimed - The claimed row.
 * @param now - The run's time.
 * @returns `acted`, or `skipped` for a workspace that is active again or gone, or whose claim another job holds.
 */
async function cancelLifecycleRow(
  provider: BillingProviderClient,
  claimed: TenantBillingRecord,
  now: Date
): Promise<'acted' | 'skipped'> {
  const { tenantId } = claimed
  const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId)
  if (tenant === undefined) return 'skipped'
  if (tenant.lifecycleState === 'active') {
    await billingRepository.releaseLifecycleCancelClaim(tenantId)
    return 'skipped'
  }
  let isArchived = tenant.lifecycleState === 'archived'
  const brought = await bringInPaidCheckouts(provider, claimed, now)
  let { row } = brought
  if (brought.hasSynced) {
    const again = await tenantRepository.findByIdIncludingDeleted(tenantId)
    if (again === undefined) return 'skipped'
    if (again.lifecycleState === 'active') {
      await billingRepository.releaseLifecycleCancelClaim(tenantId)
      return 'skipped'
    }
    isArchived = again.lifecycleState === 'archived'
    const held = await holdClaim({ kind: provider.kind, mode: provider.mode }, claimed, row)
    if (held === undefined) return 'skipped'
    row = held
  }
  const isPaying = row.state === 'active' || row.state === 'past_due'
  const currentId = isArchived || !row.cancelAtPeriodEnd ? row.providerSubscriptionId : null
  if (currentId !== null) {
    let current: ProviderSubscription | undefined
    try {
      current = await provider.fetchSubscription(currentId)
    } catch (error) {
      logger.warn('Could not read a subscription before its lifecycle cancel', {
        error,
        tenantId,
        subscriptionId: currentId,
      })
      if (isArchived) await didCancelForLifecycle(provider, tenantId, currentId, false)
      else await alertOnce(tenantId, BILLING_ALERT_TEXT.lifecycleReadFailed(currentId))
    }
    if (current !== undefined && !ENDED_STATUSES.has(current.status)) {
      const hasCycle = current.status !== 'created' && current.status !== 'authenticated'
      const isAtCycleEnd = !isArchived && hasCycle && isPaying
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
 * again, of workspaces archived after a suspension's claim (so the
 * archive's immediate cancel runs), and of cancels that failed and alerted
 * staff more than a day ago (so each is retried once a day), then claim and
 * cancel for each suspended or archived one. A claim
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
  const retried = await billingRepository.releaseFailedLifecycleCancelClaims(
    now,
    LIFECYCLE_ALERT_TEXT
  )
  if (retried > 0) logger.info('Released failed lifecycle cancel claims to retry', { retried })
  for (;;) {
    const claimed = await withTransaction((tx) =>
      billingRepository.claimLifecycleCancels(scope, LIFECYCLE_CLAIM_SIZE, tx)
    )
    for (const row of claimed) {
      try {
        counts[await cancelLifecycleRow(provider, row, now)] += 1
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
 * The prompt cancel a suspend or archive queues after its commit: the
 * lifecycle step for one workspace, run now instead of on the next frequent
 * run. It releases the workspace's claim if that no longer stands (active
 * again, or archived after a suspension's cycle-end cancel), then claims and
 * cancels through the same claim as the step, so the step and the job cancel
 * once between them. Does nothing when payments are off or nothing is left
 * to cancel.
 * @param tenantId - The workspace.
 * @param now - The run's time; defaults to now.
 * @returns `acted` when it cancelled, else `skipped`.
 * @throws {Error} When the sync after the cancel fails; the claim is kept, as in the step.
 */
export async function runLifecycleCancelFor(
  tenantId: string,
  now = new Date()
): Promise<'acted' | 'skipped'> {
  const running = runningProvider()
  if (running === undefined) return 'skipped'
  await billingRepository.releaseLifecycleCancelClaims(undefined, tenantId)
  const [row] = await withTransaction((tx) =>
    billingRepository.claimLifecycleCancels(running.scope, 1, tx, tenantId)
  )
  if (row === undefined) return 'skipped'
  return cancelLifecycleRow(running.provider, row, now)
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
 * Claim reminders in batches and send each claimed one. A claim commits
 * before its send, so two runs never send the same reminder; a send that
 * fails is logged by the sender and its claim stands, since its once-only
 * key would stop a second send anyway.
 * @param counts - The step's counts, added to.
 * @param claim - Claims up to `REMINDER_CLAIM_SIZE` rows in the transaction.
 * @param send - Sends one claimed row's reminder; never rejects.
 */
async function claimAndSend(
  counts: StepCounts,
  claim: (tx: DbTransaction) => Promise<TenantBillingRecord[]>,
  send: (row: TenantBillingRecord) => Promise<void>
): Promise<void> {
  for (;;) {
    const claimed = await withTransaction(claim)
    for (const row of claimed) {
      await send(row)
      counts.acted += 1
    }
    if (claimed.length < REMINDER_CLAIM_SIZE) return
  }
}

/**
 * Send one trial's last-day reminder when its trial ends today in the
 * workspace's time zone, claiming it first.
 * @param row - A candidate trial, read without a lock.
 * @param now - The run's time.
 * @returns `acted` when this call sent it.
 */
async function remindLastDay(row: TenantBillingRecord, now: Date): Promise<'acted' | 'skipped'> {
  if (row.trialEndsAt === null) return 'skipped'
  const timeZone = await billingTimeZone(row.tenantId)
  if (formatDateInZone(row.trialEndsAt, timeZone) !== formatDateInZone(now, timeZone)) {
    return 'skipped'
  }
  const claimed = await withTransaction((tx) =>
    billingRepository.claimTrialLastDayReminder(row.tenantId, now, tx)
  )
  if (claimed === undefined) return 'skipped'
  await sendTrialEndsToday(claimed, now)
  return 'acted'
}

/**
 * The win-back step for one of the two emails.
 * @param day - Which email.
 * @returns The step.
 */
function winbackStep(day: keyof typeof WINBACK_WINDOWS): BillingStep {
  const { fromDays, toDays } = WINBACK_WINDOWS[day]
  return {
    name: `winback_${day}`,
    run: (now, counts) =>
      claimAndSend(
        counts,
        (tx) =>
          billingRepository.claimWinbacks(day, now, fromDays, toDays, REMINDER_CLAIM_SIZE, tx),
        (row) => sendWinback(row, day, now)
      ),
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
  {
    name: 'trial_ending_reminders',
    run: (now, counts) =>
      claimAndSend(
        counts,
        (tx) => billingRepository.claimTrialEndingReminders(now, REMINDER_CLAIM_SIZE, tx),
        (row) => sendTrialEnding(row, now)
      ),
  },
  {
    name: 'trial_last_day_reminders',
    run: (now, counts) =>
      eachRow(
        'trial_last_day_reminders',
        counts,
        (after) => billingRepository.listTrialLastDayCandidates(now, after, PAGE_SIZE),
        (row) => remindLastDay(row, now)
      ),
  },
  {
    name: 'trial_midpoint_reminders',
    run: (now, counts) =>
      claimAndSend(
        counts,
        (tx) => billingRepository.claimTrialMidpointReminders(now, REMINDER_CLAIM_SIZE, tx),
        (row) => sendTrialMidpoint(row, now)
      ),
  },
]

/**
 * Whether a Free row holds only a current subscription that was seen ended:
 * the sync moved it to Free because that subscription ended. One that a
 * cancel failed to end, which a staff alert names, has not been.
 * @param row - The row.
 * @returns True when the reconcile can skip it.
 */
async function isEndedFree(row: TenantBillingRecord): Promise<boolean> {
  if (row.state !== 'free' || row.pendingSubscriptionId !== null) return false
  if (row.nextSubscriptionId !== null) return false
  if (row.providerSubscriptionId === null) return true
  const id = row.providerSubscriptionId
  // An alert raised before the current wording names the failed cancel in its own words.
  for (const marker of [
    cancelFailedMarker(id),
    readFailedMarker(id),
    legacyCancelFailedMarker(id),
  ]) {
    if (await billingRepository.hasAlertNaming(row.tenantId, 'reconcile_repair', marker)) {
      return false
    }
  }
  return true
}

/**
 * The reconcile's row pass: queue a sync for every row that holds a
 * subscription. It skips, and counts, a row of another provider or mode, and
 * a Free row whose only subscription is its current one: the sync moved it to
 * Free because that subscription ended. A Free row whose current
 * subscription a cancel failed to end (a staff alert names it) is synced
 * still, so the sync tries the cancel again.
 * @param scope - The running provider and mode.
 * @param counts - The step's counts, added to.
 */
async function reconcileRows(scope: ProviderScope, counts: StepCounts): Promise<void> {
  await eachRow(
    'reconcile',
    counts,
    (after) => billingRepository.listWithSubscriptions(after, PAGE_SIZE),
    async (row) => {
      if (isOtherProvider(row, scope) || (await isEndedFree(row))) return 'skipped'
      await addBillingSyncJob({ tenantId: row.tenantId, source: 'reconcile' })
      return 'acted'
    }
  )
}

/**
 * The reconcile's sweep: every running subscription created in the lookback
 * window whose notes name a customer workspace of this environment, and that
 * no row holds, is offered to that workspace's sync, oldest first by the
 * provider's creation time, which adopts the first when the workspace has no
 * running one and cancels and refunds the rest as duplicates. A failed list alerts staff once a
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
    await alertOnce(null, BILLING_ALERT_TEXT.reconcileListFailed(now.toISOString().slice(0, 10)))
    throw error
  }
  const { APP_ENV } = getEnv()
  const extrasByTenant = new Map<string, string[]>()
  // Oldest first: the sync keeps the first running one it is offered and refunds the rest.
  const oldestFirst = subs.toSorted(
    (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
  )
  for (const sub of oldestFirst) {
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
 * The tax refund sweep: every processed refund created in the last
 * `TAX_REFUND_SWEEP_DAYS` whose payment was invoiced or held here queues one
 * tax run per workspace, hinted with those payments, so a missed webhook or
 * an old payment's refund is still credited. Nothing with registration off.
 * @param provider - The payment provider.
 * @param scope - The running provider and mode.
 * @param now - The run's time.
 * @param counts - The step's counts: workspaces queued, refunds passed over.
 * @throws {ProviderError} When the provider's list fails.
 */
async function sweepTaxRefunds(
  provider: BillingProviderClient,
  scope: ProviderScope,
  now: Date,
  counts: StepCounts
): Promise<void> {
  if (gstSellerConfig() === null) return
  const refunds = await provider.listRecentRefunds(
    new Date(now.getTime() - TAX_REFUND_SWEEP_DAYS * DAY_MS)
  )
  const paymentsByTenant = new Map<string, Set<string>>()
  for (const refund of refunds) {
    const tenantId =
      refund.status === 'processed'
        ? await taxRepository.findTenantIdForPayment(scope, refund.paymentId)
        : undefined
    if (tenantId === undefined) {
      counts.skipped += 1
      continue
    }
    paymentsByTenant.set(
      tenantId,
      (paymentsByTenant.get(tenantId) ?? new Set()).add(refund.paymentId)
    )
  }
  for (const [tenantId, paymentIds] of paymentsByTenant) {
    await addTaxReconcileJob({ tenantId, paymentIds: [...paymentIds] })
    counts.acted += 1
  }
}

/**
 * The one-time tax backfill: on the first daily run after the registration
 * date gets a new value, queue a tax run for every customer workspace that
 * tracks a subscription, so one whose subscriptions all ended before
 * registration, which no sync reaches again, is still invoiced. A Redis
 * marker per registration date (`SET NX`, no expiry) makes it once; losing
 * it only runs the step again, which issues nothing twice. A failure after
 * the claim releases the marker, so the next run backfills again.
 * @param scope - The running provider and mode.
 * @param counts - The step's counts: workspaces queued.
 */
async function backfillTaxDocuments(scope: ProviderScope, counts: StepCounts): Promise<void> {
  const seller = gstSellerConfig()
  if (seller === null) return
  const key = redisKey('billing-tax-backfill', istDate(seller.effectiveFrom))
  const claimed = await withRedisDeadline(async () => {
    const redis = await getRedis()
    return redis.set(key, '1', { condition: 'NX' })
  }, 'tax backfill marker')
  if (claimed !== 'OK') return
  try {
    for (const tenantId of await billingRepository.listTenantIdsWithTrackedSubscriptions(scope)) {
      await addTaxReconcileJob({ tenantId })
      counts.acted += 1
    }
  } catch (error) {
    await releaseBackfillMarker(key)
    throw error
  }
}

/**
 * Log a backfill marker release that failed, before or after the deadline.
 * @param error - What the delete rejected with.
 */
function reportBackfillReleaseFailure(error: unknown): void {
  logger.error('Could not release the tax backfill marker; delete it to backfill again', {
    error,
  })
}

/**
 * Delete the tax backfill marker after the step failed part way, so the
 * next daily run queues the workspaces it missed; the ones it queued run
 * twice, which issues nothing twice. A failed delete is logged.
 * @param key - The marker's key.
 */
async function releaseBackfillMarker(key: string): Promise<void> {
  try {
    await waitForRedisWrite(
      async () => {
        const redis = await getRedis()
        return redis.del(key)
      },
      'tax backfill marker release',
      reportBackfillReleaseFailure
    )
  } catch (error) {
    reportBackfillReleaseFailure(error)
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
  {
    name: 'tax_refunds',
    run: async (now, counts) => {
      const running = runningProvider()
      if (running === undefined) return
      await sweepTaxRefunds(running.provider, running.scope, now, counts)
    },
  },
  {
    name: 'tax_backfill',
    run: async (_now, counts) => {
      const running = runningProvider()
      if (running === undefined) return
      await backfillTaxDocuments(running.scope, counts)
    },
  },
  {
    name: 'renewal_reminders',
    run: (now, counts) =>
      claimAndSend(
        counts,
        (tx) =>
          billingRepository.claimRenewalReminders(
            now,
            RENEWAL_REMINDER_DAYS,
            REMINDER_CLAIM_SIZE,
            tx
          ),
        sendRenewalUpcoming
      ),
  },
  winbackStep('7d'),
  winbackStep('30d'),
]

/**
 * The frequent run, every 15 minutes: lapsed trials, grace endings,
 * cancelling periods past their buffer, due interval switches, lifecycle
 * cancels, lapsed grants, expired upgrade requests and the trial reminders.
 * Never rejects.
 * @param now - The run's time; defaults to now.
 * @returns Each step's outcome.
 */
export async function runFrequentBilling(now = new Date()): Promise<BillingRunReport> {
  return runSteps('frequent', FREQUENT_STEPS, now)
}

/**
 * The daily run, at 03:30 UTC: the reconcile's row pass, its sweep of recent
 * subscriptions, and a resync for each recently failed webhook event, which
 * queue `sync-tenant` jobs so the syncs spread over the billing Worker; the
 * tax refund sweep and the one-time tax backfill, which queue `tax-reconcile`
 * jobs; then
 * the yearly renewal reminders and the win-back emails. Never rejects.
 * @param now - The run's time; defaults to now.
 * @returns Each step's outcome.
 */
export async function runDailyBilling(now = new Date()): Promise<BillingRunReport> {
  return runSteps('daily', DAILY_STEPS, now)
}
