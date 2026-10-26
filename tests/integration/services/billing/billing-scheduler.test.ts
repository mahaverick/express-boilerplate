/**
 * @file The billing schedulers against this worker's database and the fake
 * provider in Redis, each with a fixed `now`: a lapsed trial moves to Free
 * once, grace, a cancelling period and an interval switch reach the sync,
 * a suspended or archived workspace's subscription is cancelled once, grants
 * and upgrade requests expire, two frequent runs at once act once, and one
 * failing step leaves the others running. The daily run queues the reconcile
 * syncs, which the test runs through the billing job's processor.
 */
import { randomUUID } from 'node:crypto'
import type { Job } from 'bullmq'
import { sql as drizzleSql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { getEnv } from '@/configs/env.config'
import { ProviderError } from '@/errors/billing-provider-errors'
import {
  BILLING_SCHEDULER_DAILY_JOB,
  BILLING_SCHEDULER_FREQUENT_JOB,
  ensureBillingSchedules,
  type BillingSyncTenantJobData,
} from '@/jobs/billing.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import {
  runDailyBilling,
  runFrequentBilling,
  runLifecycleCancelFor,
  type BillingRunReport,
} from '@/services/billing/billing-scheduler.service'
import { FakeBillingProvider } from '@/services/billing/fake-billing-provider.service'
import { sql, withTransaction } from '@/services/database.service'
import {
  closeNotificationSubscriber,
  offEntitlementsChanged,
  offNotification,
  onEntitlementsChanged,
  onNotification,
  type EntitlementsChange,
} from '@/services/notification-emitter.service'
import { closeQueue, getBillingQueue } from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import type { BillingProviderClient, ProviderSubscription } from '@/types/billing'
import { processBillingJob } from '@/workers/billing.worker'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import {
  deleteTrackedTenants,
  fake,
  fakeSubscription,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  paymentsSwitch,
  plans,
  readBilling,
  setBilling,
  workspace,
} from '../../../helpers/billing-api'
import { withMutatedMethod } from '../../../helpers/mutate'
import { waitForNotificationSubscriber } from '../../../helpers/notification-subscriber'
import { deleteTrackedUsers } from '../../../helpers/platform-users'
import { queuedJobs } from '../../../helpers/queue-jobs'
import { waitUntil } from '../../../helpers/timing'

/**
 * A provider that replaces the fake for one test, such as a Razorpay stand-in.
 */
const override = vi.hoisted(() => ({ provider: undefined as BillingProviderClient | undefined }))

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../../helpers/billing-api')
  const base = fakeProviderModule()
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    getBillingProvider: () => override.provider ?? base.getBillingProvider(),
  }
})

const DAY = 24 * 60 * 60 * 1000
const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()

/**
 * Alert texts this file raised with no workspace, deleted after each test.
 */
const tenantlessAlertTexts: string[] = []

beforeAll(async () => {
  await loadPlans()
  await waitForNotificationSubscriber({ onNotification, offNotification }, getRedis)
})

afterEach(async () => {
  override.provider = undefined
  for (const text of tenantlessAlertTexts) {
    await sql`delete from billing_alerts where tenant_id is null and strpos(message, ${text}) > 0`
  }
  tenantlessAlertTexts.length = 0
  await getBillingQueue().obliterate({ force: true })
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
})

afterAll(async () => {
  await getBillingQueue().obliterate({ force: true })
  await closeQueue()
  await closeNotificationSubscriber()
  await forgetProviderPlans()
  await closeRedis()
})

/**
 * A workspace's state history, oldest first, as from, to, cause and source.
 * @param tenantId - The workspace.
 * @returns The rows.
 */
async function historyOf(tenantId: string): Promise<string[][]> {
  const rows = await billingRepository.listHistory(tenantId, 20)
  return rows
    .toReversed()
    .filter((row) => row.fromState !== null)
    .map((row) => [row.fromState ?? '', row.toState, row.cause, row.source])
}

/**
 * A workspace's billing state.
 * @param tenantId - The workspace.
 * @returns The state.
 */
async function stateOf(tenantId: string): Promise<string> {
  const row = await readBilling(tenantId)
  return row.state
}

/**
 * When a workspace's lifecycle cancel was claimed.
 * @param tenantId - The workspace.
 * @returns The claim time, or null.
 */
async function lifecycleClaimOf(tenantId: string): Promise<Date | null> {
  const row = await readBilling(tenantId)
  return row.lifecycleCancelSentAt
}

/**
 * A subscription's status on the fake.
 * @param subscriptionId - The subscription.
 * @returns Its status.
 */
async function statusOf(subscriptionId: string): Promise<string> {
  const sub = await fake.fetchSubscription(subscriptionId)
  return sub.status
}

/**
 * A workspace's staff alerts, as kind and message.
 * @param tenantId - The workspace.
 * @returns The alerts.
 */
async function alertsOf(tenantId: string): Promise<{ kind: string; message: string }[]> {
  return [
    ...(await sql<{ kind: string; message: string }[]>`
    select kind, message from billing_alerts where tenant_id = ${tenantId} order by at, id`),
  ]
}

/**
 * A workspace on a trial that ended an hour before `now`.
 * @param now - The run's time.
 * @returns The workspace and its owner.
 */
async function lapsedTrial(now: Date): Promise<{ tenantId: string; ownerId: string }> {
  const { tenant, owner } = await workspace()
  await setBilling(tenant.id, {
    state: 'trialing',
    planId: plans.paidId,
    trialStartedAt: new Date(now.getTime() - 14 * DAY),
    trialEndsAt: new Date(now.getTime() - 60 * 60 * 1000),
  })
  return { tenantId: tenant.id, ownerId: owner.id }
}

/**
 * A paying workspace whose subscription halted eight days before `now`, past the seven-day grace.
 * @param now - The run's time.
 * @returns The workspace and its subscription.
 */
async function graceEnded(now: Date): Promise<{ tenantId: string; subscriptionId: string }> {
  const { tenant } = await workspace()
  const { subscriptionId } = await makePaying(tenant.id)
  await fake.fakeAdvance(subscriptionId, 'halted')
  await setBilling(tenant.id, {
    state: 'past_due',
    pastDueSince: new Date(now.getTime() - 10 * DAY),
    haltedAt: new Date(now.getTime() - 8 * DAY),
  })
  return { tenantId: tenant.id, subscriptionId }
}

/**
 * A grant for a workspace that lapsed a minute before `now`.
 * @param tenantId - The workspace.
 * @param now - The run's time.
 * @returns The grant's id.
 */
async function lapsedGrant(tenantId: string, now: Date): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into tenant_entitlement_grants (tenant_id, key, value, reason, expires_at)
    values (${tenantId}, 'members', '10'::jsonb, 'Test grant', ${new Date(now.getTime() - 60_000).toISOString()}::timestamptz)
    returning id`
  if (row === undefined) throw new Error('setup: the grant insert returned no row')
  return row.id
}

/**
 * The `billing.grant_expired` audit rows of a workspace.
 * @param tenantId - The workspace.
 * @returns Each row's actor kind, access and metadata.
 */
async function grantExpiredAudits(
  tenantId: string
): Promise<{ actor_kind: string; access: string; metadata: unknown }[]> {
  return [
    ...(await sql<{ actor_kind: string; access: string; metadata: unknown }[]>`
    select actor_kind, access, metadata from audit_logs
    where tenant_id = ${tenantId} and action = 'billing.grant_expired'`),
  ]
}

/**
 * Set a workspace's lifecycle state, as a staff suspend or archive would.
 * @param tenantId - The workspace.
 * @param state - The lifecycle state.
 */
async function setLifecycle(
  tenantId: string,
  state: 'active' | 'suspended' | 'archived'
): Promise<void> {
  // The database's clock, as the archive itself stamps deleted_at.
  await sql`update tenants set lifecycle_state = ${state}, deleted_at = case when ${state} = 'archived' then now() end where id = ${tenantId}`
}

/**
 * Run a callback while recording every cancel the fake receives.
 * @param run - The callback.
 * @returns Each cancel's subscription id and whether it was at cycle end.
 */
async function recordingCancels(run: () => Promise<unknown>): Promise<[string, boolean][]> {
  const original = FakeBillingProvider.prototype.cancelSubscription
  const calls: [string, boolean][] = []
  await withMutatedMethod(
    FakeBillingProvider.prototype,
    'cancelSubscription',
    async function (
      this: FakeBillingProvider,
      id: string,
      isAtCycleEnd: boolean
    ): Promise<ProviderSubscription> {
      calls.push([id, isAtCycleEnd])
      return original.call(this, id, isAtCycleEnd)
    },
    async () => {
      await run()
    }
  )
  return calls
}

/**
 * Create a monthly subscription on the fake whose notes name a workspace and
 * an environment, as a checkout does.
 * @param tenantId - The workspace.
 * @param appEnv - The environment.
 * @returns Its id.
 */
async function notedSubscription(tenantId: string, appEnv: string): Promise<string> {
  const price = await planRepository.activePrice(plans.paidId, 'INR', 'month')
  if (!price) throw new Error('setup: missing price')
  const created = await fake.createSubscription({
    providerPlanId: await fake.ensurePlan({ ...price, providerPlanId: null }, 'Paid'),
    totalCount: 60,
    expireBy: new Date(Date.now() + 60 * 60 * 1000),
    startAt: null,
    notes: { tenantId, priceId: plans.monthPriceId, appEnv },
  })
  return created.id
}

/**
 * The reconcile syncs queued for a workspace.
 * @param tenantId - The workspace.
 * @returns The jobs.
 */
async function syncJobsFor(tenantId: string): Promise<Job<BillingSyncTenantJobData>[]> {
  const jobs = await queuedJobs<BillingSyncTenantJobData>(getBillingQueue())
  return jobs.filter((job) => job.data.tenantId === tenantId)
}

/**
 * Run every reconcile sync queued for a workspace through the billing job's processor.
 * @param tenantId - The workspace.
 * @returns The jobs run.
 */
async function runSyncJobsFor(tenantId: string): Promise<Job<BillingSyncTenantJobData>[]> {
  const jobs = await syncJobsFor(tenantId)
  for (const job of jobs) await processBillingJob(job)
  return jobs
}

describe('runFrequentBilling', () => {
  it('moves a lapsed trial to Free with one history row', async () => {
    const now = new Date()
    const { tenantId } = await lapsedTrial(now)

    const report = await runFrequentBilling(now)

    expect(await readBilling(tenantId)).toMatchObject({ state: 'free', planId: plans.freeId })
    expect(await historyOf(tenantId)).toStrictEqual([['trialing', 'free', 'trial_ended', 'job']])
    expect(report.trial_ends?.acted).toBeGreaterThanOrEqual(1)
  })

  it('leaves a trial that has not ended', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    await setBilling(tenant.id, {
      state: 'trialing',
      planId: plans.paidId,
      trialEndsAt: new Date(now.getTime() + DAY),
    })

    await runFrequentBilling(now)

    expect(await stateOf(tenant.id)).toBe('trialing')
    expect(await historyOf(tenant.id)).toStrictEqual([])
  })

  it('tells members their entitlements changed when a trial ends', async () => {
    const now = new Date()
    const { tenantId, ownerId } = await lapsedTrial(now)
    const received: EntitlementsChange[] = []
    /**
     * Records each change the owner hears.
     */
    const handler = (change: EntitlementsChange): void => {
      received.push(change)
    }
    onEntitlementsChanged(ownerId, handler)
    try {
      await runFrequentBilling(now)
      await waitUntil(() => received.length > 0, { message: 'the owner hears the change' })
      expect(received.map((change) => change.tenantId)).toContain(tenantId)
    } finally {
      offEntitlementsChanged(ownerId, handler)
    }
  })

  it('syncs a lapsed trial whose checkout was paid instead of moving it to Free', async () => {
    const now = new Date()
    const { tenantId } = await lapsedTrial(now)
    const subscriptionId = await fakeSubscription({ tenantId, priceId: plans.monthPriceId })
    await fake.fakeAdvance(subscriptionId, 'active')
    await setBilling(tenantId, { pendingSubscriptionId: subscriptionId })

    await runFrequentBilling(now)

    expect(await readBilling(tenantId)).toMatchObject({
      state: 'active',
      providerSubscriptionId: subscriptionId,
    })
    expect(await historyOf(tenantId)).toStrictEqual([
      ['trialing', 'active', 'subscription_activated', 'job'],
    ])
  })

  it('moves a lapsed trial to Free when its checkout was never paid', async () => {
    const now = new Date()
    const { tenantId } = await lapsedTrial(now)
    const subscriptionId = await fakeSubscription({ tenantId, priceId: plans.monthPriceId })
    await setBilling(tenantId, { pendingSubscriptionId: subscriptionId })

    await runFrequentBilling(now)

    expect(await readBilling(tenantId)).toMatchObject({ state: 'free', planId: plans.freeId })
  })

  it('cancels a halted subscription once grace ends, then moves the workspace to Free', async () => {
    const now = new Date()
    const { tenantId, subscriptionId } = await graceEnded(now)

    await runFrequentBilling(now)

    expect(await statusOf(subscriptionId)).toBe('cancelled')
    expect(await readBilling(tenantId)).toMatchObject({ state: 'free', planId: plans.freeId })
    expect(await historyOf(tenantId)).toStrictEqual([['past_due', 'free', 'grace_ended', 'job']])
  })

  it('moves a cancelled subscription to Free once its period and buffer have passed', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await fake.fakeAdvance(subscriptionId, 'cancelled')
    await setBilling(tenant.id, {
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(now.getTime() - 4 * DAY),
    })

    await runFrequentBilling(now)

    expect(await readBilling(tenant.id)).toMatchObject({ state: 'free', planId: plans.freeId })
    expect(await historyOf(tenant.id)).toStrictEqual([['active', 'free', 'cancelled', 'job']])
  })

  it('hands an interval switch over once the current period has ended', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const nextId = await fakeSubscription(
      { tenantId: tenant.id, priceId: plans.yearPriceId },
      'year',
      new Date(now.getTime() - 60_000)
    )
    await fake.fakeAdvance(nextId, 'authenticated')
    await setBilling(tenant.id, {
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(now.getTime() - 60_000),
      nextSubscriptionId: nextId,
      nextPriceId: plans.yearPriceId,
      nextAuthenticatedAt: new Date(now.getTime() - DAY),
    })

    await runFrequentBilling(now)

    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: nextId,
      priceId: plans.yearPriceId,
      nextSubscriptionId: null,
      cancelAtPeriodEnd: false,
    })
    expect(await historyOf(tenant.id)).toStrictEqual([
      ['active', 'active', 'interval_switch', 'job'],
    ])
  })

  it('cancels an archived workspace subscription now, once', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setLifecycle(tenant.id, 'archived')

    const cancels = await recordingCancels(async () => {
      await runFrequentBilling(now)
      await runFrequentBilling(now)
    })

    expect(cancels).toStrictEqual([[subscriptionId, false]])
    expect(await statusOf(subscriptionId)).toBe('cancelled')
    const after = await readBilling(tenant.id)
    expect(after.lifecycleCancelSentAt).not.toBeNull()
    expect(after.cancelAtPeriodEnd).toBe(true)
  })

  it('cancels a suspended workspace subscription at its cycle end, and shows it cancelling', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setLifecycle(tenant.id, 'suspended')

    const cancels = await recordingCancels(() => runFrequentBilling(now))

    expect(cancels).toStrictEqual([[subscriptionId, true]])
    expect(await statusOf(subscriptionId)).toBe('active')
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      cancelAtPeriodEnd: true,
      providerSubscriptionId: subscriptionId,
    })
    expect(await lifecycleClaimOf(tenant.id)).not.toBeNull()
  })

  it('cancels a suspended workspace deferred start now, which returns it to its trial', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const trialEndsAt = new Date(now.getTime() + 5 * DAY)
    const subscriptionId = await fakeSubscription(
      { tenantId: tenant.id, priceId: plans.monthPriceId },
      'month',
      trialEndsAt
    )
    await fake.fakeAdvance(subscriptionId, 'authenticated')
    await setBilling(tenant.id, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      trialEndsAt,
      currentPeriodEnd: trialEndsAt,
      providerSubscriptionId: subscriptionId,
      provider: 'fake',
      providerMode: 'test',
    })
    await setLifecycle(tenant.id, 'suspended')

    const cancels = await recordingCancels(() => runFrequentBilling(now))

    expect(cancels).toStrictEqual([[subscriptionId, false]])
    expect(await readBilling(tenant.id)).toMatchObject({ state: 'trialing', priceId: null })
  })

  it('cancels a suspended workspace scheduled switch now', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId, periodEnd } = await makePaying(tenant.id)
    const nextId = await fakeSubscription(
      { tenantId: tenant.id, priceId: plans.yearPriceId },
      'year',
      periodEnd
    )
    await fake.fakeAdvance(nextId, 'authenticated')
    await setBilling(tenant.id, {
      cancelAtPeriodEnd: true,
      nextSubscriptionId: nextId,
      nextPriceId: plans.yearPriceId,
    })
    await setLifecycle(tenant.id, 'suspended')

    const cancels = await recordingCancels(() => runFrequentBilling(now))

    expect(cancels).toStrictEqual([[nextId, false]])
    expect(await statusOf(nextId)).toBe('cancelled')
    expect(await readBilling(tenant.id)).toMatchObject({
      providerSubscriptionId: subscriptionId,
      nextSubscriptionId: null,
    })
  })

  it('alerts staff once and keeps the claim when a lifecycle cancel fails', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setLifecycle(tenant.id, 'archived')

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'cancelSubscription',
      () => Promise.reject(new ProviderError('POST /subscriptions/x/cancel', 502)),
      async () => {
        await runFrequentBilling(now)
        await runFrequentBilling(now)
      }
    )

    const alerts = await alertsOf(tenant.id)
    expect(alerts.map((alert) => alert.kind)).toStrictEqual(['reconcile_repair'])
    expect(alerts[0]?.message).toContain(subscriptionId)
    expect(await lifecycleClaimOf(tenant.id)).not.toBeNull()
    expect(await statusOf(subscriptionId)).toBe('active')
  })

  it.each([
    ['a 401', new ProviderError('GET /subscriptions/x', 401, { code: 'BAD_REQUEST_ERROR' })],
    ['a 403', new ProviderError('GET /subscriptions/x', 403)],
    [
      'an unexpected answer',
      new ProviderError('subscription answer', 200, { code: 'UNEXPECTED_ANSWER' }),
    ],
    ['a 502', new ProviderError('GET /subscriptions/x', 502)],
  ])(
    'keeps a lapsed trial whose subscription read fails with %s, and alerts staff once',
    async (_label, failure) => {
      const now = new Date()
      const { tenantId } = await lapsedTrial(now)
      const subscriptionId = await fakeSubscription({ tenantId, priceId: plans.monthPriceId })
      await setBilling(tenantId, { pendingSubscriptionId: subscriptionId })

      await withMutatedMethod(
        FakeBillingProvider.prototype,
        'fetchSubscription',
        () => Promise.reject(failure),
        async () => {
          await runFrequentBilling(now)
          await runFrequentBilling(now)
        }
      )

      expect(await stateOf(tenantId)).toBe('trialing')
      const alerts = await alertsOf(tenantId)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.message).toContain('syncing its subscriptions failed')
    }
  )

  it('keeps a lapsed trial whose row kept changing during its sync, and says so in the alert', async () => {
    const now = new Date()
    const { tenantId } = await lapsedTrial(now)
    const subscriptionId = await fakeSubscription({ tenantId, priceId: plans.monthPriceId })
    await setBilling(tenantId, { pendingSubscriptionId: subscriptionId })
    const original = BillingRepository.prototype.findByTenantId

    await withMutatedMethod(
      BillingRepository.prototype,
      'findByTenantId',
      async function (this: BillingRepository, ...readArguments: Parameters<typeof original>) {
        const row = await original.apply(this, readArguments)
        // Every sync read looks stale under the lock, as when another write keeps landing.
        return row === undefined ? row : { ...row, version: row.version - 1 }
      },
      async () => {
        await runFrequentBilling(now)
      }
    )

    expect(await stateOf(tenantId)).toBe('trialing')
    const alerts = await alertsOf(tenantId)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.message).toContain('changed during every sync attempt')
    expect(alerts[0]?.message).not.toContain('syncing its subscriptions failed')
  })

  it('moves a lapsed trial to Free when the provider does not know its subscription, and alerts staff once', async () => {
    const now = new Date()
    const { tenantId } = await lapsedTrial(now)
    await setBilling(tenantId, { pendingSubscriptionId: 'sub_FAKEunknown0000' })

    await runFrequentBilling(now)

    expect(await stateOf(tenantId)).toBe('free')
    const alerts = await alertsOf(tenantId)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.message).toContain('does not know')
  })

  it('moves a lapsed trial that holds a subscription to Free with payments off', async () => {
    const now = new Date()
    const { tenantId } = await lapsedTrial(now)
    const subscriptionId = await fakeSubscription({ tenantId, priceId: plans.monthPriceId })
    await setBilling(tenantId, { pendingSubscriptionId: subscriptionId })
    paymentsSwitch.on = false
    try {
      await runFrequentBilling(now)
    } finally {
      paymentsSwitch.on = true
    }

    expect(await stateOf(tenantId)).toBe('free')
    expect(await alertsOf(tenantId)).toStrictEqual([])
  })

  it('cancels an archived workspace subscription now when it cannot be read first', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setLifecycle(tenant.id, 'archived')

    let cancels: [string, boolean][] = []
    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'fetchSubscription',
      () => Promise.reject(new ProviderError('GET /subscriptions/x', 502)),
      async () => {
        cancels = await recordingCancels(() => runFrequentBilling(now))
      }
    )

    expect(cancels).toStrictEqual([[subscriptionId, false]])
    expect(await statusOf(subscriptionId)).toBe('cancelled')
    expect(await alertsOf(tenant.id)).toStrictEqual([])
  })

  it('alerts staff once when a suspended workspace subscription cannot be read before its cancel', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setLifecycle(tenant.id, 'suspended')

    let cancels: [string, boolean][] = []
    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'fetchSubscription',
      () => Promise.reject(new ProviderError('GET /subscriptions/x', 502)),
      async () => {
        cancels = await recordingCancels(async () => {
          await runFrequentBilling(now)
          await runFrequentBilling(now)
        })
      }
    )

    expect(cancels).toStrictEqual([])
    const alerts = await alertsOf(tenant.id)
    expect(alerts.map((alert) => alert.kind)).toStrictEqual(['reconcile_repair'])
    expect(alerts[0]?.message).toContain(subscriptionId)
    expect(await lifecycleClaimOf(tenant.id)).not.toBeNull()
  })

  it('releases the claim and cancels nothing when the workspace is active again before the cancel', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    await setLifecycle(tenant.id, 'suspended')
    const original = BillingRepository.prototype.claimLifecycleCancels

    let cancels: [string, boolean][] = []
    await withMutatedMethod(
      BillingRepository.prototype,
      'claimLifecycleCancels',
      async function (this: BillingRepository, ...claimArguments: Parameters<typeof original>) {
        const claimed = await original.apply(this, claimArguments)
        // Staff reactivate the workspace between the claim and the cancel.
        await setLifecycle(tenant.id, 'active')
        return claimed
      },
      async () => {
        cancels = await recordingCancels(() => runFrequentBilling(now))
      }
    )

    expect(cancels).toStrictEqual([])
    expect(await lifecycleClaimOf(tenant.id)).toBeNull()
  })

  it('cancels now when a suspended workspace is archived after its cycle-end cancel', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setLifecycle(tenant.id, 'suspended')

    const cancels = await recordingCancels(async () => {
      await runFrequentBilling(now)
      await setLifecycle(tenant.id, 'archived')
      await runFrequentBilling(now)
      await runFrequentBilling(now)
    })

    expect(cancels).toStrictEqual([
      [subscriptionId, true],
      [subscriptionId, false],
    ])
    expect(await statusOf(subscriptionId)).toBe('cancelled')
    expect(await lifecycleClaimOf(tenant.id)).not.toBeNull()
  })

  it('retries once a day a suspended workspace cancel that failed and alerted staff, and never one that went through', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setLifecycle(tenant.id, 'suspended')
    const { tenant: done } = await workspace()
    const { subscriptionId: doneId } = await makePaying(done.id)
    await setLifecycle(done.id, 'suspended')
    const original = FakeBillingProvider.prototype.fetchSubscription
    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'fetchSubscription',
      async function (this: FakeBillingProvider, id: string) {
        if (id === subscriptionId) throw new ProviderError('GET /subscriptions/x', 502)
        return original.call(this, id)
      },
      async () => {
        await runFrequentBilling(now)
      }
    )
    expect(await statusOf(subscriptionId)).toBe('active')

    const cancels = await recordingCancels(async () => {
      // Within the day the claim stands.
      await runFrequentBilling(new Date(now.getTime() + 12 * 60 * 60 * 1000))
      await runFrequentBilling(new Date(now.getTime() + 25 * 60 * 60 * 1000))
    })

    expect(cancels).toStrictEqual([[subscriptionId, true]])
    expect(await readBilling(tenant.id)).toMatchObject({ cancelAtPeriodEnd: true })
    expect(await lifecycleClaimOf(tenant.id)).not.toBeNull()
    expect(cancels).not.toContainEqual([doneId, true])
  })

  it('cancels now when a suspension claim was taken while the archive transaction was open', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setLifecycle(tenant.id, 'suspended')

    const cancels = await recordingCancels(async () => {
      await withTransaction(async (tx) => {
        // Fix the archive transaction's start, then let the frequent run claim the suspension on another connection.
        await tx.execute(drizzleSql`select now()`)
        await runFrequentBilling(new Date())
        await tenantRepository.transitionLifecycle(tenant.id, ['suspended'], 'archived', tx)
      })
      await runLifecycleCancelFor(tenant.id)
    })

    expect(cancels).toStrictEqual([
      [subscriptionId, true],
      [subscriptionId, false],
    ])
    expect(await statusOf(subscriptionId)).toBe('cancelled')
  })

  it('releases the lifecycle claim of a workspace that is active again', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    await setBilling(tenant.id, { lifecycleCancelSentAt: new Date(now.getTime() - DAY) })

    await runFrequentBilling(now)

    expect(await lifecycleClaimOf(tenant.id)).toBeNull()
  })

  it('expires a lapsed grant once, audits it as the system, and tells members', async () => {
    const now = new Date()
    const { tenant, owner } = await workspace()
    const grantId = await lapsedGrant(tenant.id, now)
    const received: EntitlementsChange[] = []
    /**
     * Records each change the owner hears.
     */
    const handler = (change: EntitlementsChange): void => {
      received.push(change)
    }
    onEntitlementsChanged(owner.id, handler)
    try {
      await runFrequentBilling(now)
      await runFrequentBilling(now)
      await waitUntil(() => received.length > 0, { message: 'the owner hears the change' })
    } finally {
      offEntitlementsChanged(owner.id, handler)
    }

    expect(received).toStrictEqual([{ tenantId: tenant.id, slug: tenant.slug }])
    expect(await grantExpiredAudits(tenant.id)).toStrictEqual([
      { actor_kind: 'system', access: 'system', metadata: { grantId, key: 'members' } },
    ])
    const [grant] = await sql<{ expired_notified_at: Date | null }[]>`
      select expired_notified_at from tenant_entitlement_grants where id = ${grantId}`
    expect(grant?.expired_notified_at).not.toBeNull()
  })

  it('deletes open upgrade requests past their expiry and keeps the rest', async () => {
    const now = new Date()
    const { tenant, owner } = await workspace()
    const { tenant: other, owner: otherOwner } = await workspace()
    const past = new Date(now.getTime() - DAY).toISOString()
    const future = new Date(now.getTime() + DAY).toISOString()
    await sql`
      insert into upgrade_requests (tenant_id, requested_by, surface, expires_at, fulfilled_at)
      values
        (${tenant.id}, ${owner.id}, 'test', ${past}::timestamptz, null),
        (${other.id}, ${otherOwner.id}, 'test', ${future}::timestamptz, null),
        (${other.id}, ${owner.id}, 'test', ${past}::timestamptz, ${past}::timestamptz)`

    await runFrequentBilling(now)

    const rows = await sql<{ tenant_id: string; fulfilled: boolean }[]>`
      select tenant_id, fulfilled_at is not null as fulfilled from upgrade_requests
      where tenant_id = any(${[tenant.id, other.id]}) order by fulfilled`
    expect([...rows]).toStrictEqual([
      { tenant_id: other.id, fulfilled: false },
      { tenant_id: other.id, fulfilled: true },
    ])
  })

  it('acts once when two runs overlap', async () => {
    const now = new Date()
    const trial = await lapsedTrial(now)
    const grace = await graceEnded(now)
    const { tenant: archived } = await workspace()
    const { subscriptionId: archivedSub } = await makePaying(archived.id)
    await setLifecycle(archived.id, 'archived')
    const grantId = await lapsedGrant(trial.tenantId, now)

    const cancels = await recordingCancels(() =>
      Promise.all([runFrequentBilling(now), runFrequentBilling(now)])
    )

    expect(await historyOf(trial.tenantId)).toStrictEqual([
      ['trialing', 'free', 'trial_ended', 'job'],
    ])
    expect(await historyOf(grace.tenantId)).toStrictEqual([
      ['past_due', 'free', 'grace_ended', 'job'],
    ])
    expect(cancels.filter(([id]) => id === archivedSub)).toStrictEqual([[archivedSub, false]])
    expect(await alertsOf(grace.tenantId)).toStrictEqual([])
    expect(await alertsOf(archived.id)).toStrictEqual([])
    const audits = await grantExpiredAudits(trial.tenantId)
    expect(audits.map((audit) => audit.metadata)).toStrictEqual([{ grantId, key: 'members' }])
  })

  it('runs the other steps when one fails, and reports the failure', async () => {
    const now = new Date()
    const { tenantId } = await lapsedTrial(now)
    await lapsedGrant(tenantId, now)

    const reports: BillingRunReport[] = []
    await withMutatedMethod(
      PlanRepository.prototype,
      'expireDueGrants',
      () => Promise.reject(new Error('grants unavailable')),
      async () => {
        reports.push(await runFrequentBilling(now))
      }
    )
    const [report] = reports

    expect(report?.grants?.status).toBe('failed')
    expect(report?.trial_ends?.status).toBe('ok')
    expect(await stateOf(tenantId)).toBe('free')
  })

  it('moves trials and expires grants with payments off', async () => {
    const now = new Date()
    const { tenantId } = await lapsedTrial(now)
    paymentsSwitch.on = false
    try {
      await runFrequentBilling(now)
    } finally {
      paymentsSwitch.on = true
    }

    expect(await stateOf(tenantId)).toBe('free')
  })
})

describe('runDailyBilling', () => {
  it('repairs a paid workspace that holds only its pending checkout to active', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const subscriptionId = await fakeSubscription({
      tenantId: tenant.id,
      priceId: plans.monthPriceId,
    })
    await fake.fakeAdvance(subscriptionId, 'active')
    await setBilling(tenant.id, { pendingSubscriptionId: subscriptionId })

    await runDailyBilling(now)
    const jobs = await runSyncJobsFor(tenant.id)

    expect(jobs.length).toBeGreaterThanOrEqual(1)
    expect(jobs.every((job) => job.data.source === 'reconcile')).toBe(true)
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: subscriptionId,
      pendingSubscriptionId: null,
    })
    expect(await historyOf(tenant.id)).toStrictEqual([
      ['free', 'active', 'subscription_activated', 'reconcile'],
    ])
  })

  it('queues a sync for every row that holds a subscription', async () => {
    const now = new Date()
    const { tenant: paying } = await workspace()
    await makePaying(paying.id)
    const { tenant: plain } = await workspace()

    await runDailyBilling(now)

    expect(await syncJobsFor(paying.id)).toHaveLength(1)
    expect(await syncJobsFor(plain.id)).toStrictEqual([])
  })

  it('skips a Free row whose only subscription has ended', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await fake.fakeAdvance(subscriptionId, 'cancelled')
    await setBilling(tenant.id, { state: 'free', planId: plans.freeId })

    const report = await runDailyBilling(now)

    expect(await syncJobsFor(tenant.id)).toStrictEqual([])
    expect(report.reconcile?.skipped).toBeGreaterThanOrEqual(1)
  })

  it.each([
    ['the current', (id: string) => `Cancelling subscription ${id} failed. Cancel it in Razorpay.`],
    [
      'an earlier',
      (id: string) => `Could not cancel subscription ${id}. Cancel it at the provider.`,
    ],
    [
      'the read-failed',
      (id: string) =>
        `Reading subscription ${id} of a suspended or archived workspace from Razorpay failed, so we did not cancel it and it still charges. Cancel it in Razorpay.`,
    ],
  ])(
    'syncs a Free row whose current subscription a failed cancel left running, named in %s wording, so the cancel is tried again',
    async (_wording, messageFor) => {
      const now = new Date()
      const { tenant } = await workspace()
      const { subscriptionId } = await makePaying(tenant.id)
      await fake.fakeAdvance(subscriptionId, 'halted')
      await setBilling(tenant.id, { state: 'free', planId: plans.freeId, priceId: null })
      await billingRepository.insertAlert({
        kind: 'reconcile_repair',
        tenantId: tenant.id,
        message: messageFor(subscriptionId),
      })

      await runDailyBilling(now)
      await runSyncJobsFor(tenant.id)

      expect(await statusOf(subscriptionId)).toBe('cancelled')
    }
  )

  it('skips and counts a fake-provider row when the running provider is Razorpay', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    override.provider = {
      kind: 'razorpay',
      mode: 'test',
      listRecentSubscriptions: () => Promise.resolve([]),
    } as unknown as BillingProviderClient

    const report = await runDailyBilling(now)

    expect(await syncJobsFor(tenant.id)).toStrictEqual([])
    expect(report.reconcile?.skipped).toBeGreaterThanOrEqual(1)
  })

  it('finds a still-running old subscription after a new checkout was adopted, and cancels it', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const oldId = await notedSubscription(tenant.id, getEnv().APP_ENV)
    await fake.fakeAdvance(oldId, 'active')
    await fake.fakeAdvance(oldId, 'halted')
    const { subscriptionId: newId } = await makePaying(tenant.id)

    await runDailyBilling(now)
    const jobs = await syncJobsFor(tenant.id)
    expect(jobs.some((job) => job.data.extraSubscriptionIds?.includes(oldId) === true)).toBe(true)
    for (const job of jobs) await processBillingJob(job)

    expect(await statusOf(oldId)).toBe('cancelled')
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: newId,
    })
    const alerts = await alertsOf(tenant.id)
    expect(alerts.map((alert) => alert.kind)).toContain('duplicate_refunded')
  })

  it('offers swept subscriptions oldest first, so the sync keeps the first paid one and refunds the later', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const older = await notedSubscription(tenant.id, getEnv().APP_ENV)
    const newer = await notedSubscription(tenant.id, getEnv().APP_ENV)
    await fake.fakeAdvance(older, 'active')
    await fake.fakeAdvance(newer, 'active')
    await fake.fakeShiftBack(older, 60 * 60 * 1000)
    const original = FakeBillingProvider.prototype.listRecentSubscriptions

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'listRecentSubscriptions',
      async function (this: FakeBillingProvider, since: Date) {
        const found = await original.call(this, since)
        // The provider's list, newest first.
        return found.toSorted(
          (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
        )
      },
      async () => {
        await runDailyBilling(now)
      }
    )
    const jobs = await syncJobsFor(tenant.id)
    expect(jobs.map((job) => job.data.extraSubscriptionIds)).toStrictEqual([[older, newer]])
    await runSyncJobsFor(tenant.id)

    expect(await readBilling(tenant.id)).toMatchObject({ providerSubscriptionId: older })
    expect(await statusOf(newer)).toBe('cancelled')
  })

  it('ignores a swept subscription whose notes name another environment', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    const otherId = await notedSubscription(tenant.id, 'elsewhere')
    await fake.fakeAdvance(otherId, 'active')

    await runDailyBilling(now)

    expect(await syncJobsFor(tenant.id)).toStrictEqual([])
  })

  it('alerts staff once when the sweep cannot list subscriptions, and still queues the rows', async () => {
    const now = new Date()
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    tenantlessAlertTexts.push('Listing recent subscriptions from Razorpay failed')

    const reports: BillingRunReport[] = []
    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'listRecentSubscriptions',
      () => Promise.reject(new ProviderError('GET /subscriptions', 502)),
      async () => {
        reports.push(await runDailyBilling(now), await runDailyBilling(now))
      }
    )

    expect(reports[0]?.sweep?.status).toBe('failed')
    expect(reports[0]?.reconcile?.status).toBe('ok')
    const alerts = await sql<{ kind: string }[]>`
      select kind from billing_alerts where tenant_id is null and strpos(message, 'Listing recent subscriptions from Razorpay failed') > 0`
    expect([...alerts]).toStrictEqual([{ kind: 'reconcile_repair' }])
    const queued = await syncJobsFor(tenant.id)
    expect(queued.length).toBeGreaterThanOrEqual(1)
  })

  it('syncs the workspace of a webhook event that failed for good in the last three days', async () => {
    const now = new Date()
    const { tenant: recent } = await workspace()
    const { tenant: old } = await workspace()
    const { tenant: done } = await workspace()
    const rows = [
      { tenantId: recent.id, receivedAt: new Date(now.getTime() - DAY), error: 'boom' },
      { tenantId: old.id, receivedAt: new Date(now.getTime() - 5 * DAY), error: 'boom' },
      { tenantId: done.id, receivedAt: new Date(now.getTime() - DAY), error: null },
    ]
    for (const row of rows) {
      await sql`
        insert into billing_events (provider, mode, provider_event_id, type, tenant_id, received_at, error)
        values ('fake', 'test', ${`evt_FAKE${randomUUID().slice(0, 12)}`}, 'subscription.charged',
          ${row.tenantId}, ${row.receivedAt.toISOString()}::timestamptz, ${row.error})`
    }

    await runDailyBilling(now)

    expect(await syncJobsFor(recent.id)).toHaveLength(1)
    expect(await syncJobsFor(old.id)).toStrictEqual([])
    expect(await syncJobsFor(done.id)).toStrictEqual([])
  })
})

describe('billing scheduler jobs', () => {
  it('registers the two billing schedules once, however many times it is called', async () => {
    await ensureBillingSchedules()
    await ensureBillingSchedules()

    const queue = getBillingQueue()
    expect(await queue.getJobSchedulersCount()).toBe(2)
    expect(await queue.getJobScheduler(BILLING_SCHEDULER_FREQUENT_JOB)).toMatchObject({
      name: BILLING_SCHEDULER_FREQUENT_JOB,
      every: 15 * 60_000,
    })
    expect(await queue.getJobScheduler(BILLING_SCHEDULER_DAILY_JOB)).toMatchObject({
      name: BILLING_SCHEDULER_DAILY_JOB,
      pattern: '30 3 * * *',
      tz: 'UTC',
    })
  })

  it('runs the frequent steps for a scheduler-frequent job', async () => {
    const { tenantId } = await lapsedTrial(new Date())

    await processBillingJob({ name: BILLING_SCHEDULER_FREQUENT_JOB, data: {} } as Job)

    expect(await stateOf(tenantId)).toBe('free')
  })

  it('queues the reconcile for a scheduler-daily job', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)

    await processBillingJob({ name: BILLING_SCHEDULER_DAILY_JOB, data: {} } as Job)

    expect(await syncJobsFor(tenant.id)).toHaveLength(1)
  })
})
