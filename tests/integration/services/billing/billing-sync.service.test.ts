/**
 * @file The single sync path against this worker's database and the fake
 * provider in Redis: a checkout becomes Paid with one history row, a provider
 * failure writes nothing, a row that moved between the read and the lock is
 * synced again once, a duplicate subscription is cancelled and refunded, grace
 * ends with a cancel, the interval switch hands over, and members' open apps
 * hear about each change. The billing config is mocked to the fake provider.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { billingProviderConfig, type BillingProviderConfig } from '@/configs/billing.config'
import {
  billingAlertModel,
  tenantBillingModel,
  upgradeRequestModel,
  type NewTenantBilling,
  type TenantBillingRecord,
} from '@/database/models/billing.model'
import { ProviderError } from '@/errors/billing-provider-errors'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import {
  BillingSyncConflictError,
  syncTenantBilling,
} from '@/services/billing/billing-sync.service'
import { FakeBillingProvider } from '@/services/billing/fake-billing-provider.service'
import { db, sql } from '@/services/database.service'
import {
  closeNotificationSubscriber,
  offEntitlementsChanged,
  offNotification,
  onEntitlementsChanged,
  onNotification,
  type EntitlementsChange,
} from '@/services/notification-emitter.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import type { ProviderSubscription } from '@/types/billing'
import { withMutatedMethod, withMutatedModule } from '../../../helpers/mutate'
import { waitForNotificationSubscriber } from '../../../helpers/notification-subscriber'
import { waitUntil } from '../../../helpers/timing'

vi.mock('@/configs/billing.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/billing.config')>()
  return {
    ...actual,
    billingProviderConfig: () =>
      actual.billingProviderConfig({
        BILLING_FAKE_PROVIDER: true,
        BILLING_GST_REGISTERED: false,
        RAZORPAY_KEY_ID: undefined,
        RAZORPAY_KEY_SECRET: undefined,
        RAZORPAY_WEBHOOK_SECRET: undefined,
        RAZORPAY_WEBHOOK_SECRET_PREVIOUS: undefined,
      }),
  }
})

const DAY = 24 * 60 * 60 * 1000
const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

const createdTenantIds: string[] = []
const createdUserIds: string[] = []

/**
 * The fake provider's config, as the mocked app builds it.
 * @returns The config.
 * @throws {Error} When the fake config is missing.
 */
function fakeConfig(): BillingProviderConfig {
  const config = billingProviderConfig()
  if (config === null) throw new Error('setup: the fake config is missing')
  return config
}

/**
 * The test's own handle on the fake: it shares the app's Redis state.
 */
const fake = new FakeBillingProvider(fakeConfig())

const plans = { freeId: '', paidId: '', monthPriceId: '', yearPriceId: '' }

beforeAll(async () => {
  const free = await planRepository.findPlanByKey('free')
  const paid = await planRepository.findPlanByKey('paid')
  if (!free || !paid) throw new Error('setup: the billing migration seeds both plans')
  const month = await planRepository.activePrice(paid.id, 'INR', 'month')
  const year = await planRepository.activePrice(paid.id, 'INR', 'year')
  if (!month || !year) throw new Error('setup: the billing migration seeds both prices')
  Object.assign(plans, {
    freeId: free.id,
    paidId: paid.id,
    monthPriceId: month.id,
    yearPriceId: year.id,
  })
  await waitForNotificationSubscriber({ onNotification, offNotification }, getRedis)
})

afterEach(async () => {
  if (createdTenantIds.length > 0) {
    await sql`delete from billing_alerts where tenant_id = any(${createdTenantIds})`
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (createdUserIds.length > 0) {
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  }
})

afterAll(async () => {
  await closeNotificationSubscriber()
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
  await closeRedis()
})

/**
 * A new workspace on Free, with its owner.
 * @returns The workspace's id and slug, and the owner's id.
 */
async function createWorkspace(): Promise<{ tenantId: string; slug: string; ownerId: string }> {
  const owner = await userRepository.create({ email: `billing-sync-${randomUUID()}@example.test` })
  createdUserIds.push(owner.id)
  const tenant = await tenantRepository.create({
    name: 'Acme Inc',
    slug: `billing-sync-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  return { tenantId: tenant.id, slug: tenant.slug, ownerId: owner.id }
}

/**
 * Create a subscription on the fake, as a checkout would.
 * @param notes - The notes it carries: the workspace and price ids.
 * @param notes.tenantId - The workspace the notes name.
 * @param notes.priceId - The price the notes name.
 * @param interval - Which seeded price's provider plan to bill.
 * @param startAt - The deferred first charge, or null.
 * @returns Its id.
 */
async function createSubscription(
  notes: { tenantId: string; priceId: string },
  interval: 'month' | 'year' = 'month',
  startAt: Date | null = null
): Promise<string> {
  const price = await planRepository.activePrice(plans.paidId, 'INR', interval)
  if (!price) throw new Error('setup: missing price')
  const providerPlanId = await fake.ensurePlan(price, 'Paid')
  const created = await fake.createSubscription({
    providerPlanId,
    totalCount: 60,
    expireBy: new Date(Date.now() + 60 * 60 * 1000),
    startAt,
    notes,
  })
  return created.id
}

/**
 * Set a workspace's billing columns directly, as earlier writes would have.
 * @param tenantId - The workspace.
 * @param patch - The columns.
 */
async function setBilling(tenantId: string, patch: Partial<NewTenantBilling>): Promise<void> {
  await db.update(tenantBillingModel).set(patch).where(eq(tenantBillingModel.tenantId, tenantId))
}

/**
 * A workspace's billing row.
 * @param tenantId - The workspace.
 * @returns The row.
 * @throws {Error} When it has none.
 */
async function readBilling(tenantId: string): Promise<TenantBillingRecord> {
  const row = await billingRepository.findByTenantId(tenantId)
  if (!row) throw new Error('setup: the workspace has no billing row')
  return row
}

/**
 * A workspace's staff alerts, oldest first.
 * @param tenantId - The workspace.
 * @returns Each alert's kind and message.
 */
async function alertsOf(tenantId: string): Promise<{ kind: string; message: string }[]> {
  return db
    .select({ kind: billingAlertModel.kind, message: billingAlertModel.message })
    .from(billingAlertModel)
    .where(eq(billingAlertModel.tenantId, tenantId))
    .orderBy(billingAlertModel.at, billingAlertModel.id)
}

/**
 * A paying workspace: its current subscription is active and paid on the fake.
 * @returns The workspace and its subscription id.
 */
async function createPayingWorkspace(): Promise<{
  tenantId: string
  slug: string
  ownerId: string
  subscriptionId: string
}> {
  const workspace = await createWorkspace()
  const subscriptionId = await createSubscription({
    tenantId: workspace.tenantId,
    priceId: plans.monthPriceId,
  })
  const active = await fake.fakeAdvance(subscriptionId, 'active')
  await setBilling(workspace.tenantId, {
    state: 'active',
    planId: plans.paidId,
    priceId: plans.monthPriceId,
    providerSubscriptionId: subscriptionId,
    currentPeriodEnd: active.currentEnd,
  })
  return { ...workspace, subscriptionId }
}

describe('syncTenantBilling', () => {
  it('makes a paid checkout current and Paid, with one history row, and fulfils upgrade requests', async () => {
    const { tenantId, ownerId } = await createWorkspace()
    const subscriptionId = await createSubscription({ tenantId, priceId: plans.monthPriceId })
    await setBilling(tenantId, { pendingSubscriptionId: subscriptionId })
    await billingRepository.openUpgradeRequest({
      tenantId,
      requestedBy: ownerId,
      surface: 'members',
      expiresAt: new Date(Date.now() + 30 * DAY),
    })
    const active = await fake.fakeAdvance(subscriptionId, 'active')
    const before = await readBilling(tenantId)

    const result = await syncTenantBilling(tenantId, 'confirm')

    const after = await readBilling(tenantId)
    expect(result).toMatchObject({ outcome: 'synced', changed: true })
    expect(after).toMatchObject({
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      providerSubscriptionId: subscriptionId,
      pendingSubscriptionId: null,
      currentPeriodEnd: active.currentEnd,
      version: before.version + 1,
    })
    expect(after.syncedAt).not.toBeNull()
    const history = await billingRepository.listHistory(tenantId, 20)
    expect(
      history.map(({ fromState, toState, cause, source }) => ({
        fromState,
        toState,
        cause,
        source,
      }))
    ).toStrictEqual([
      { fromState: 'free', toState: 'active', cause: 'subscription_activated', source: 'confirm' },
    ])
    const [request] = await db
      .select()
      .from(upgradeRequestModel)
      .where(eq(upgradeRequestModel.tenantId, tenantId))
    expect(request?.fulfilledAt).not.toBeNull()
  })

  it('records no history for a change of period end alone', async () => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    const subscription = await fake.fetchSubscription(subscriptionId)
    await setBilling(tenantId, { currentPeriodEnd: new Date(Date.now() - DAY) })

    await syncTenantBilling(tenantId, 'webhook')

    const synced = await readBilling(tenantId)
    expect(synced.currentPeriodEnd).toStrictEqual(subscription.currentEnd)
    expect(await billingRepository.listHistory(tenantId, 20)).toHaveLength(0)
  })

  it('records one history row per state change', async () => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'pending')
    await syncTenantBilling(tenantId, 'webhook')
    const failed = await readBilling(tenantId)
    expect(failed.state).toBe('past_due')

    await fake.fakeAdvance(subscriptionId, 'active')
    await syncTenantBilling(tenantId, 'reconcile')
    await syncTenantBilling(tenantId, 'reconcile')

    const history = await billingRepository.listHistory(tenantId, 20)
    expect(history.map(({ toState, cause, source }) => [toState, cause, source])).toStrictEqual([
      ['active', 'subscription_recovered', 'reconcile'],
      ['past_due', 'payment_failed', 'webhook'],
    ])
    expect(await readBilling(tenantId)).toMatchObject({ state: 'active', pastDueSince: null })
  })

  it.each([
    ['a 400', () => new ProviderError('GET /subscriptions/x', 400, { code: 'BAD_REQUEST_ERROR' })],
    ['a 502', () => new ProviderError('GET /subscriptions/x', 502)],
    ['a timeout', () => new ProviderError('GET /subscriptions/x', 'timeout')],
    ['a network failure', () => new ProviderError('GET /subscriptions/x', 'network')],
  ])('writes nothing when the provider answers %s', async (_label, failure) => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'cancelled')
    const before = await readBilling(tenantId)

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'fetchSubscription',
      () => Promise.reject(failure()),
      async () => {
        await expect(syncTenantBilling(tenantId, 'webhook')).rejects.toBeInstanceOf(ProviderError)
      }
    )

    expect(await readBilling(tenantId)).toStrictEqual(before)
    expect(await billingRepository.listHistory(tenantId, 20)).toHaveLength(0)
    expect(await alertsOf(tenantId)).toHaveLength(0)
  })

  it('writes nothing when the stored subscription is unknown to the provider', async () => {
    const { tenantId } = await createPayingWorkspace()
    await setBilling(tenantId, { providerSubscriptionId: `sub_FAKE${randomUUID().slice(0, 8)}` })
    const before = await readBilling(tenantId)

    await expect(syncTenantBilling(tenantId, 'reconcile')).rejects.toBeInstanceOf(ProviderError)

    expect(await readBilling(tenantId)).toStrictEqual(before)
  })

  it('syncs again once when the row changes between the read and the lock', async () => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'pending')
    const original = FakeBillingProvider.prototype.fetchSubscription
    const fetches = { count: 0 }
    const before = await readBilling(tenantId)

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'fetchSubscription',
      async function (this: FakeBillingProvider, id: string): Promise<ProviderSubscription> {
        fetches.count += 1
        // Another writer commits while this sync waits on the provider.
        if (fetches.count === 1) {
          await sql`update tenant_billing set version = version + 1 where tenant_id = ${tenantId}`
        }
        return original.call(this, id)
      },
      async () => {
        await syncTenantBilling(tenantId, 'webhook')
      }
    )

    expect(fetches.count).toBe(2)
    expect(await readBilling(tenantId)).toMatchObject({
      state: 'past_due',
      version: before.version + 2,
    })
    expect(await billingRepository.listHistory(tenantId, 20)).toHaveLength(1)
  })

  it('gives up with a conflict when the row changes again on the retry', async () => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'pending')
    const original = FakeBillingProvider.prototype.fetchSubscription

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'fetchSubscription',
      async function (this: FakeBillingProvider, id: string): Promise<ProviderSubscription> {
        await sql`update tenant_billing set version = version + 1 where tenant_id = ${tenantId}`
        return original.call(this, id)
      },
      async () => {
        await expect(syncTenantBilling(tenantId, 'webhook')).rejects.toBeInstanceOf(
          BillingSyncConflictError
        )
      }
    )

    const untouched = await readBilling(tenantId)
    expect(untouched.state).toBe('active')
    expect(await billingRepository.listHistory(tenantId, 20)).toHaveLength(0)
  })

  it('does nothing when payments are off', async () => {
    const { tenantId } = await createWorkspace()
    const before = await readBilling(tenantId)

    await withMutatedModule(
      '@/services/billing/billing-provider.service',
      { getBillingProvider: () => null },
      () => import('@/services/billing/billing-sync.service'),
      async (subject) => {
        expect(await subject.syncTenantBilling(tenantId, 'reconcile')).toMatchObject({
          outcome: 'payments_off',
          changed: false,
        })
      }
    )

    expect(await readBilling(tenantId)).toStrictEqual(before)
  })

  it('tells members their entitlements changed', async () => {
    const { tenantId, slug, ownerId, subscriptionId } = await createPayingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'halted')
    const received: EntitlementsChange[] = []
    /**
     * Records each change the owner hears.
     */
    const handler = (change: EntitlementsChange): void => {
      received.push(change)
    }
    onEntitlementsChanged(ownerId, handler)
    try {
      await syncTenantBilling(tenantId, 'webhook')
      await waitUntil(() => received.length > 0, { message: 'the owner hears the change' })
      expect(received).toStrictEqual([{ tenantId, slug }])
    } finally {
      offEntitlementsChanged(ownerId, handler)
    }
  })

  it('cancels and refunds a second paid subscription, alerts staff, and refunds it once', async () => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    const duplicateId = await createSubscription({ tenantId, priceId: plans.monthPriceId })
    await fake.fakeAdvance(duplicateId, 'active')
    await setBilling(tenantId, { pendingSubscriptionId: duplicateId })
    const original = FakeBillingProvider.prototype.refundLatestPayment
    const refund = vi.fn(async function (this: FakeBillingProvider, id: string) {
      return original.call(this, id)
    })

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'refundLatestPayment',
      refund,
      async () => {
        await syncTenantBilling(tenantId, 'confirm')
        await syncTenantBilling(tenantId, 'reconcile', { extraSubscriptionIds: [duplicateId] })
      }
    )

    expect(refund.mock.calls).toStrictEqual([[duplicateId]])
    const duplicate = await fake.fetchSubscription(duplicateId)
    expect(duplicate.status).toBe('cancelled')
    expect(await readBilling(tenantId)).toMatchObject({
      state: 'active',
      providerSubscriptionId: subscriptionId,
      pendingSubscriptionId: null,
    })
    const alerts = await alertsOf(tenantId)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.kind).toBe('duplicate_refunded')
    expect(alerts[0]?.message).toContain(duplicateId)
  })

  it('adopts a paid subscription the sweep found for a workspace on Free', async () => {
    const { tenantId } = await createWorkspace()
    const foundId = await createSubscription({ tenantId, priceId: plans.yearPriceId }, 'year')
    await fake.fakeAdvance(foundId, 'active')

    await syncTenantBilling(tenantId, 'reconcile', { extraSubscriptionIds: [foundId] })

    expect(await readBilling(tenantId)).toMatchObject({
      state: 'active',
      planId: plans.paidId,
      priceId: plans.yearPriceId,
      providerSubscriptionId: foundId,
      provider: 'fake',
      providerMode: 'test',
    })
  })

  it('fetches and writes nothing for a row of another provider mode', async () => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'halted')
    await setBilling(tenantId, { provider: 'fake', providerMode: 'live' })
    const before = await readBilling(tenantId)
    const fetch = vi.fn(() => Promise.reject(new Error('the sync must not fetch')))

    await withMutatedMethod(FakeBillingProvider.prototype, 'fetchSubscription', fetch, async () => {
      const result = await syncTenantBilling(tenantId, 'reconcile')
      expect(result).toMatchObject({ outcome: 'provider_mismatch', changed: false })
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(await readBilling(tenantId)).toStrictEqual(before)
  })

  it('refunds a duplicate once when two syncs handle it at the same time', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { tenantId } = await createPayingWorkspace()
      const duplicateId = await createSubscription({ tenantId, priceId: plans.monthPriceId })
      await fake.fakeAdvance(duplicateId, 'active')
      await setBilling(tenantId, { pendingSubscriptionId: duplicateId })
      const original = FakeBillingProvider.prototype.refundLatestPayment
      const refunds: unknown[] = []
      const refund = vi.fn(async function (this: FakeBillingProvider, id: string) {
        const answer = await original.call(this, id)
        refunds.push(answer)
        return answer
      })

      await withMutatedMethod(
        FakeBillingProvider.prototype,
        'refundLatestPayment',
        refund,
        async () => {
          const options = { extraSubscriptionIds: [duplicateId] }
          await Promise.all([
            syncTenantBilling(tenantId, 'confirm', options),
            syncTenantBilling(tenantId, 'webhook', options),
          ])
        }
      )

      expect(refunds.filter((answer) => answer !== null)).toHaveLength(1)
      const alerts = await alertsOf(tenantId)
      expect(alerts.map((alert) => alert.kind)).toStrictEqual(['duplicate_refunded'])
    }
  })

  it('refunds once and raises no cancel alert when a second sync reads the duplicate before its cancel shows', async () => {
    const { tenantId } = await createPayingWorkspace()
    const duplicateId = await createSubscription({ tenantId, priceId: plans.monthPriceId })
    const stale = await fake.fakeAdvance(duplicateId, 'active')
    await setBilling(tenantId, { pendingSubscriptionId: duplicateId })
    const original = FakeBillingProvider.prototype.fetchSubscription
    const reads = { duplicate: 0 }
    const refunds: unknown[] = []
    const originalRefund = FakeBillingProvider.prototype.refundLatestPayment

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'fetchSubscription',
      async function (this: FakeBillingProvider, id: string): Promise<ProviderSubscription> {
        if (id !== duplicateId) return original.call(this, id)
        reads.duplicate += 1
        // The first two reads (one per sync) still see it running, as a provider lagging behind the cancel would.
        return reads.duplicate <= 2 ? stale : original.call(this, id)
      },
      async () => {
        await withMutatedMethod(
          FakeBillingProvider.prototype,
          'refundLatestPayment',
          async function (this: FakeBillingProvider, id: string) {
            const answer = await originalRefund.call(this, id)
            refunds.push(answer)
            return answer
          },
          async () => {
            await syncTenantBilling(tenantId, 'confirm')
            await syncTenantBilling(tenantId, 'reconcile', { extraSubscriptionIds: [duplicateId] })
          }
        )
      }
    )

    expect(refunds).toHaveLength(2)
    expect(refunds.filter((answer) => answer !== null)).toHaveLength(1)
    const alerts = await alertsOf(tenantId)
    expect(alerts.map((alert) => alert.kind)).toStrictEqual(['duplicate_refunded'])
  })

  it('raises the alert for an ignored subscription once across syncs', async () => {
    const { tenantId } = await createWorkspace()
    const other = await createWorkspace()
    const foreignId = await createSubscription({
      tenantId: other.tenantId,
      priceId: plans.monthPriceId,
    })
    await setBilling(tenantId, { pendingSubscriptionId: foreignId })

    await syncTenantBilling(tenantId, 'reconcile')
    await syncTenantBilling(tenantId, 'reconcile')

    const alerts = await alertsOf(tenantId)
    expect(alerts.map((alert) => alert.kind)).toStrictEqual(['reconcile_repair'])
    const kept = await readBilling(tenantId)
    expect(kept.pendingSubscriptionId).toBe(foreignId)
  })

  it('maps neither the switch nor the checkout when the current subscription is foreign', async () => {
    const { tenantId } = await createWorkspace()
    const other = await createWorkspace()
    const foreignId = await createSubscription({
      tenantId: other.tenantId,
      priceId: plans.monthPriceId,
    })
    const charged = await fake.fakeAdvance(foreignId, 'active')
    const nextId = await createSubscription({ tenantId, priceId: plans.yearPriceId }, 'year')
    await fake.fakeAdvance(nextId, 'authenticated')
    const pendingId = await createSubscription({ tenantId, priceId: plans.monthPriceId })
    await fake.fakeAdvance(pendingId, 'active')
    await setBilling(tenantId, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      providerSubscriptionId: foreignId,
      currentPeriodEnd: charged.currentEnd,
      nextSubscriptionId: nextId,
      nextPriceId: plans.yearPriceId,
      pendingSubscriptionId: pendingId,
    })
    const cancel = vi.fn(() => Promise.reject(new Error('the sync must not cancel')))

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'cancelSubscription',
      cancel,
      async () => {
        await syncTenantBilling(tenantId, 'reconcile')
      }
    )

    expect(cancel).not.toHaveBeenCalled()
    expect(await readBilling(tenantId)).toMatchObject({
      providerSubscriptionId: foreignId,
      nextSubscriptionId: nextId,
      pendingSubscriptionId: pendingId,
      cancelAtPeriodEnd: false,
    })
    const alerts = await alertsOf(tenantId)
    expect(alerts.map((alert) => alert.message)).toStrictEqual([
      `Ignored subscription ${foreignId}: its notes name another workspace.`,
    ])
  })

  it('cancels a halted subscription once grace ends, then moves the workspace to Free', async () => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'halted')
    const now = new Date()
    await setBilling(tenantId, {
      state: 'past_due',
      pastDueSince: new Date(now.getTime() - 10 * DAY),
      haltedAt: new Date(now.getTime() - 8 * DAY),
    })

    await syncTenantBilling(tenantId, 'job', { now })

    const cancelled = await fake.fetchSubscription(subscriptionId)
    expect(cancelled.status).toBe('cancelled')
    expect(await readBilling(tenantId)).toMatchObject({
      state: 'free',
      planId: plans.freeId,
      haltedAt: null,
      pastDueSince: null,
      providerSubscriptionId: subscriptionId,
    })
    const history = await billingRepository.listHistory(tenantId, 20)
    expect(
      history.map(({ fromState, toState, cause }) => [fromState, toState, cause])
    ).toStrictEqual([['past_due', 'free', 'grace_ended']])
  })

  it('keeps a workspace past due and alerts staff when the grace cancel fails', async () => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'halted')
    const now = new Date()
    await setBilling(tenantId, {
      state: 'past_due',
      pastDueSince: new Date(now.getTime() - 10 * DAY),
      haltedAt: new Date(now.getTime() - 8 * DAY),
    })

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'cancelSubscription',
      () => Promise.reject(new ProviderError('POST /subscriptions/x/cancel', 502)),
      async () => {
        await syncTenantBilling(tenantId, 'job', { now })
      }
    )

    const stillPastDue = await readBilling(tenantId)
    expect(stillPastDue.state).toBe('past_due')
    const alerts = await alertsOf(tenantId)
    expect(alerts.map((alert) => alert.kind)).toStrictEqual(['reconcile_repair'])
    expect(alerts[0]?.message).toContain(subscriptionId)
  })

  it('cancels the current subscription at cycle end for a switch, then hands over', async () => {
    const { tenantId, subscriptionId } = await createPayingWorkspace()
    const current = await readBilling(tenantId)
    const nextId = await createSubscription(
      { tenantId, priceId: plans.yearPriceId },
      'year',
      current.currentPeriodEnd
    )
    await setBilling(tenantId, { nextSubscriptionId: nextId, nextPriceId: plans.yearPriceId })
    await fake.fakeAdvance(nextId, 'authenticated')
    const original = FakeBillingProvider.prototype.cancelSubscription
    const cancel = vi.fn(async function (
      this: FakeBillingProvider,
      id: string,
      isAtCycleEnd: boolean
    ) {
      return original.call(this, id, isAtCycleEnd)
    })

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'cancelSubscription',
      cancel,
      async () => {
        await syncTenantBilling(tenantId, 'confirm')
        await syncTenantBilling(tenantId, 'reconcile')
      }
    )

    expect(cancel.mock.calls).toStrictEqual([[subscriptionId, true]])
    expect(await readBilling(tenantId)).toMatchObject({
      state: 'active',
      cancelAtPeriodEnd: true,
      providerSubscriptionId: subscriptionId,
      nextSubscriptionId: nextId,
    })

    await fake.fakeAdvance(subscriptionId, 'cancelled')
    const charged = await fake.fakeAdvance(nextId, 'active')
    await syncTenantBilling(tenantId, 'webhook')

    expect(await readBilling(tenantId)).toMatchObject({
      state: 'active',
      planId: plans.paidId,
      priceId: plans.yearPriceId,
      providerSubscriptionId: nextId,
      nextSubscriptionId: null,
      nextPriceId: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: charged.currentEnd,
    })
    const history = await billingRepository.listHistory(tenantId, 20)
    expect(
      history.map(({ fromState, toState, cause }) => [fromState, toState, cause])
    ).toStrictEqual([['active', 'active', 'interval_switch']])
  })

  it('ignores a subscription whose notes name another workspace, and alerts staff', async () => {
    const { tenantId } = await createWorkspace()
    const other = await createWorkspace()
    const foreignId = await createSubscription({
      tenantId: other.tenantId,
      priceId: plans.monthPriceId,
    })
    await fake.fakeAdvance(foreignId, 'active')
    await setBilling(tenantId, { pendingSubscriptionId: foreignId })

    await syncTenantBilling(tenantId, 'confirm')

    expect(await readBilling(tenantId)).toMatchObject({
      state: 'free',
      providerSubscriptionId: null,
    })
    const alerts = await alertsOf(tenantId)
    expect(alerts.map((alert) => alert.kind)).toStrictEqual(['reconcile_repair'])
    expect(alerts[0]?.message).toContain(foreignId)
  })

  it('does not adopt a subscription whose price is unknown, and alerts staff', async () => {
    const { tenantId } = await createWorkspace()
    const unknownPriceId = await createSubscription({ tenantId, priceId: randomUUID() })
    await fake.fakeAdvance(unknownPriceId, 'active')
    await setBilling(tenantId, { pendingSubscriptionId: unknownPriceId })

    await syncTenantBilling(tenantId, 'confirm')

    const unchanged = await readBilling(tenantId)
    expect(unchanged.state).toBe('free')
    const alerts = await alertsOf(tenantId)
    expect(alerts.map((alert) => alert.kind)).toStrictEqual(['reconcile_repair'])
  })

  it('answers no_row for a workspace with no billing row', async () => {
    expect(await syncTenantBilling(randomUUID(), 'reconcile')).toMatchObject({
      outcome: 'no_row',
      changed: false,
    })
  })
})
