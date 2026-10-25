/**
 * @file Exercises `runBillingSeed` and `runBillingTimeTravel` against this
 * worker's database and the fake provider in Redis: the seed's 13
 * workspaces and the state each is in, its refusals, that it sends nothing,
 * that a rerun puts every workspace back, and that time travel moves a trial
 * past its end so the next run moves it to Free. No worker runs: the test
 * runs the queued billing jobs through the processor.
 */
import type { Job } from 'bullmq'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import type { BillingState } from '@/constants/billing.constants'
import { BILLING_SCHEDULER_FREQUENT_JOB, BILLING_SYNC_TENANT_JOB } from '@/jobs/billing.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { runBillingSeed, SEED_TENANTS } from '@/scripts/billing-seed'
import { runBillingTimeTravel } from '@/scripts/billing-time-travel'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { sql } from '@/services/database.service'
import { closeNotificationSubscriber } from '@/services/notification-emitter.service'
import {
  closeQueue,
  getBillingQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import { effectiveBillingState } from '@/utilities/billing-rules.utilities'
import { processBillingJob } from '@/workers/billing.worker'
import {
  fake,
  forgetProviderPlans,
  loadPlans,
  readBilling,
  setBilling,
} from '../../helpers/billing-api'
import { queuedJobs } from '../../helpers/queue-jobs'

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

// On, so an analytics event the seed queued would leave an outbox row.
vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true }
})

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()

/**
 * The environment the seed runs under on a developer's machine.
 */
const SEED_ENV = { APP_ENV: 'local', BILLING_FAKE_PROVIDER: true } as const

/**
 * The effective state each seeded workspace must be in.
 */
const EXPECTED_STATES: Record<string, BillingState> = {
  'billing-trial-10-days': 'trialing',
  'billing-trial-1-day': 'trialing',
  'billing-trial-ended': 'free',
  'billing-free-under-limit': 'free',
  'billing-free-over-limit': 'free',
  'billing-active-monthly': 'active',
  'billing-yearly-cancelling': 'active',
  'billing-past-due-pending': 'past_due',
  'billing-past-due-halted': 'past_due',
  'billing-customer-cancelled': 'active',
  'billing-interval-switch': 'active',
  'billing-free-grant': 'free',
  'billing-upgrade-request': 'free',
}

const DAY_MS = 24 * 60 * 60 * 1000

beforeAll(async () => {
  await loadPlans()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await getBillingQueue().obliterate({ force: true })
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
})

afterAll(async () => {
  await deleteSeed()
  await closeQueue()
  await closeNotificationSubscriber()
  await forgetProviderPlans()
  await closeRedis()
})

/**
 * Delete the seeded workspaces and people, alerts first.
 */
async function deleteSeed(): Promise<void> {
  const tenants = await seededTenants()
  const ids = tenants.map((tenant) => tenant.id)
  await sql`delete from billing_alerts where tenant_id = any(${ids})`
  await sql`delete from tenants where id = any(${ids})`
  await sql`delete from users where email ~ '^billing-(owner|member-[0-9]+)@example\.test$'`
}

/**
 * The live seeded workspaces.
 * @returns Their ids and slugs.
 */
async function seededTenants(): Promise<{ id: string; slug: string }[]> {
  return sql<{ id: string; slug: string }[]>`
    select id, slug from tenants
    where slug = any(${Object.keys(EXPECTED_STATES)}) and deleted_at is null order by slug`
}

/**
 * The seeded workspace with a slug.
 * @param slug - The slug.
 * @returns Its id.
 */
async function tenantId(slug: string): Promise<string> {
  const tenants = await seededTenants()
  const found = tenants.find((tenant) => tenant.slug === slug)
  if (!found) throw new Error(`setup: ${slug} was not seeded`)
  return found.id
}

/**
 * Each seeded workspace's effective state, by slug.
 * @returns The states.
 */
async function effectiveStates(): Promise<Record<string, BillingState>> {
  const { pastDueGraceDays } = await planRepository.getSettings()
  const now = new Date()
  const states: Record<string, BillingState> = {}
  for (const tenant of await seededTenants()) {
    const row = await readBilling(tenant.id)
    states[tenant.slug] = effectiveBillingState(row, now, pastDueGraceDays)
  }
  return states
}

/**
 * How many rows the tables a send would write hold.
 * @returns The counts.
 */
async function sendCounts(): Promise<{ outbox: number; email: number; notification: number }> {
  const [row] = await sql<{ outbox: number; email: number; notification: number }[]>`
    select (select count(*)::int from analytics_outbox) as outbox,
           (select count(*)::int from email_messages) as email,
           (select count(*)::int from notifications) as notification`
  if (!row) throw new Error('count returned no row')
  return row
}

/**
 * How many people belong to a seeded workspace.
 * @param slug - The slug.
 * @returns The member count.
 */
async function memberCount(slug: string): Promise<number> {
  const id = await tenantId(slug)
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_memberships where tenant_id = ${id}`
  return row?.count ?? 0
}

describe('runBillingSeed', () => {
  it('refuses outside local, seeding nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(await runBillingSeed([], { APP_ENV: 'dev', BILLING_FAKE_PROVIDER: true })).toBe(1)

    expect(stderr).toHaveBeenCalledOnce()
    expect(await seededTenants()).toHaveLength(0)
  })

  it('refuses without the fake provider, seeding nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(await runBillingSeed([], { APP_ENV: 'local', BILLING_FAKE_PROVIDER: false })).toBe(1)

    expect(stderr).toHaveBeenCalledOnce()
    expect(await seededTenants()).toHaveLength(0)
  })

  it('seeds the 13 workspaces, each in its state, and sends nothing', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const before = await sendCounts()

    expect(await runBillingSeed([], SEED_ENV)).toBe(0)

    expect(SEED_TENANTS).toHaveLength(13)
    expect(await effectiveStates()).toStrictEqual(EXPECTED_STATES)
    expect(await sendCounts()).toStrictEqual(before)
    expect(await queuedJobs(getEmailQueue())).toHaveLength(0)
    expect(await queuedJobs(getNotificationQueue())).toHaveLength(0)
    expect(await queuedJobs(getBillingQueue())).toHaveLength(0)
  })

  it('gives each workspace the people, grant, request and alert its state needs', async () => {
    expect(await memberCount('billing-free-under-limit')).toBe(2)
    expect(await memberCount('billing-free-over-limit')).toBe(5)
    expect(await memberCount('billing-upgrade-request')).toBe(3)

    const grantTenant = await tenantId('billing-free-grant')
    const grants = await planRepository.listActiveGrants(grantTenant)
    expect(grants).toHaveLength(1)
    expect(grants[0]?.key).toBe('members')
    expect(grants[0]?.value).toBe(10)
    const expiresIn = (grants[0]?.expiresAt?.getTime() ?? 0) - Date.now()
    expect(expiresIn).toBeGreaterThan(2 * DAY_MS)
    expect(expiresIn).toBeLessThanOrEqual(3 * DAY_MS)

    const requestTenant = await tenantId('billing-upgrade-request')
    const requests = await billingRepository.listOpenUpgradeRequests(requestTenant)
    expect(requests).toHaveLength(1)
    const [requester] = await sql<{ role: string }[]>`
      select role from user_memberships
      where tenant_id = ${requestTenant} and user_id = ${requests[0]?.requestedBy ?? ''}`
    expect(requester?.role).not.toBe('owner')

    const alerts = await sql<{ slug: string }[]>`
      select t.slug from billing_alerts a join tenants t on t.id = a.tenant_id
      where a.kind = 'duplicate_refunded' and t.slug = any(${Object.keys(EXPECTED_STATES)})`
    expect(alerts.map((alert) => alert.slug)).toStrictEqual(['billing-active-monthly'])

    const switching = await readBilling(await tenantId('billing-interval-switch'))
    expect(switching.nextSubscriptionId).not.toBeNull()
    expect(switching.nextAuthenticatedAt).not.toBeNull()

    const halted = await readBilling(await tenantId('billing-past-due-halted'))
    const { pastDueGraceDays } = await planRepository.getSettings()
    const graceLeft = (halted.haltedAt?.getTime() ?? 0) + pastDueGraceDays * DAY_MS - Date.now()
    expect(graceLeft).toBeGreaterThan(DAY_MS)
    expect(graceLeft).toBeLessThanOrEqual(2 * DAY_MS)
  })

  it('leaves each row as a sync of its fake subscriptions would, so a sync sends nothing', async () => {
    const before = await sendCounts()
    for (const tenant of await seededTenants()) {
      const { syncedAt: _s, version: _v, updatedAt: _u, ...seeded } = await readBilling(tenant.id)
      await syncTenantBilling(tenant.id, 'job')
      const {
        syncedAt: _s2,
        version: _v2,
        updatedAt: _u2,
        ...synced
      } = await readBilling(tenant.id)
      expect({ slug: tenant.slug, ...synced }).toStrictEqual({ slug: tenant.slug, ...seeded })
    }
    expect(await sendCounts()).toStrictEqual(before)
    expect(await queuedJobs(getEmailQueue())).toHaveLength(0)
    expect(await queuedJobs(getNotificationQueue())).toHaveLength(0)
  })

  it('puts back the same 13 workspaces on a rerun', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const firstIds = await seededTenants()
    const moved = await tenantId('billing-trial-10-days')
    await setBilling(moved, { state: 'free', trialEndsAt: new Date(Date.now() - DAY_MS) })
    await sql`delete from user_memberships where tenant_id = ${await tenantId('billing-free-over-limit')} and role <> 'owner'`
    const suspended = await tenantId('billing-past-due-halted')
    await sql`update tenants set lifecycle_state = 'suspended', name = 'Renamed' where id = ${suspended}`
    const before = await sendCounts()

    expect(await runBillingSeed(['--'], SEED_ENV)).toBe(0)

    expect(await seededTenants()).toStrictEqual(firstIds)
    expect(await effectiveStates()).toStrictEqual(EXPECTED_STATES)
    expect(await memberCount('billing-free-over-limit')).toBe(5)
    const [tenantRow] = await sql<{ lifecycleState: string; name: string }[]>`
      select lifecycle_state as "lifecycleState", name from tenants where id = ${suspended}`
    expect(tenantRow).toStrictEqual({
      lifecycleState: 'active',
      name: SEED_TENANTS.find((spec) => spec.slug === 'billing-past-due-halted')?.name,
    })
    expect(await sendCounts()).toStrictEqual(before)
    const alerts = await sql<{ count: number }[]>`
      select count(*)::int as count from billing_alerts a join tenants t on t.id = a.tenant_id
      where t.slug = any(${Object.keys(EXPECTED_STATES)})`
    expect(alerts[0]?.count).toBe(1)
  })

  it('refuses a workspace with a seed slug that someone else owns, changing nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const taken = await tenantId('billing-free-grant')
    const [stranger] = await sql<{ id: string }[]>`
      insert into users (email) values ('seed-stranger@example.test') returning id`
    if (!stranger) throw new Error('setup: no user row')
    await sql`update user_memberships set role = 'editor' where tenant_id = ${taken} and role = 'owner'`
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${stranger.id}, ${taken}, 'owner')`
    const moved = await tenantId('billing-trial-10-days')
    await setBilling(moved, { state: 'free' })

    try {
      expect(await runBillingSeed([], SEED_ENV)).toBe(1)

      expect(stderr).toHaveBeenCalledOnce()
      const untouched = await readBilling(moved)
      expect(untouched.state).toBe('free')
    } finally {
      await sql`delete from users where id = ${stranger.id}`
      await sql`update user_memberships set role = 'owner' where tenant_id = ${taken} and role = 'editor' and user_id = (select id from users where email = 'billing-owner@example.test')`
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await runBillingSeed([], SEED_ENV)).toBe(0)
  })

  it('ends the fake subscriptions a rerun replaces, so no old one still runs', async () => {
    const tenants = await seededTenants()
    const ids = new Set(tenants.map((tenant) => tenant.id))
    const held = new Set<string>()
    for (const id of ids) {
      const row = await readBilling(id)
      for (const sub of [row.providerSubscriptionId, row.nextSubscriptionId]) {
        if (sub !== null) held.add(sub)
      }
    }
    const all = await fake.listRecentSubscriptions(new Date(0))
    const running = all.filter(
      (sub) =>
        ids.has(sub.notes.tenantId ?? '') &&
        !held.has(sub.id) &&
        !['cancelled', 'completed', 'expired'].includes(sub.status)
    )
    expect(running).toStrictEqual([])
  })
})

/**
 * A workspace's history row times, oldest first.
 * @param id - The workspace.
 * @returns Each row's time in milliseconds.
 */
async function historyTimes(id: string): Promise<number[]> {
  const rows = await sql<{ ms: string }[]>`
    select (extract(epoch from at) * 1000)::bigint::text as ms
    from billing_state_history where tenant_id = ${id} order by at, id`
  return rows.map((row) => Number(row.ms))
}

describe('runBillingTimeTravel', () => {
  it('moves a trial past its end, queues a sync and a run, and the run moves it to Free', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const id = await tenantId('billing-trial-1-day')
    const before = await readBilling(id)

    const code = await runBillingTimeTravel(
      ['--', '--tenant', 'billing-trial-1-day', '--days', '2'],
      SEED_ENV
    )

    expect(code).toBe(0)
    const after = await readBilling(id)
    expect(after.trialEndsAt?.getTime()).toBe((before.trialEndsAt?.getTime() ?? 0) - 2 * DAY_MS)
    expect(after.trialStartedAt?.getTime()).toBe(
      (before.trialStartedAt?.getTime() ?? 0) - 2 * DAY_MS
    )
    const jobs = await queuedJobs<{ tenantId?: string }>(getBillingQueue())
    expect(jobs.map((job) => job.name).toSorted()).toStrictEqual([
      BILLING_SCHEDULER_FREQUENT_JOB,
      BILLING_SYNC_TENANT_JOB,
    ])
    expect(jobs.find((job) => job.name === BILLING_SYNC_TENANT_JOB)?.data.tenantId).toBe(id)

    for (const job of jobs) await processBillingJob(job as Job)

    const moved = await readBilling(id)
    expect(moved.state).toBe('free')
  })

  it('shifts a paid workspace and its fake subscription together, so a sync agrees', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const id = await tenantId('billing-past-due-halted')
    const before = await readBilling(id)
    const subBefore = await fake.fetchSubscription(before.providerSubscriptionId ?? '')

    expect(
      await runBillingTimeTravel(['--tenant', 'billing-past-due-halted', '--days', '1'], SEED_ENV)
    ).toBe(0)

    const after = await readBilling(id)
    const subAfter = await fake.fetchSubscription(before.providerSubscriptionId ?? '')
    expect(after.haltedAt?.getTime()).toBe((before.haltedAt?.getTime() ?? 0) - DAY_MS)
    expect(after.pastDueSince?.getTime()).toBe((before.pastDueSince?.getTime() ?? 0) - DAY_MS)
    expect(after.currentPeriodEnd?.getTime()).toBe(
      (before.currentPeriodEnd?.getTime() ?? 0) - DAY_MS
    )
    expect(subAfter.currentEnd?.getTime()).toBe((subBefore.currentEnd?.getTime() ?? 0) - DAY_MS)
  })

  it("shifts the renewal reminder's period end and the workspace's history with the dates", async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const id = await tenantId('billing-past-due-halted')
    await sql`update tenant_billing set renewal_reminder_for_period_end = current_period_end where tenant_id = ${id}`
    const before = await readBilling(id)
    const historyBefore = await historyTimes(id)
    expect(historyBefore.length).toBeGreaterThan(0)

    expect(
      await runBillingTimeTravel(['--tenant', 'billing-past-due-halted', '--days', '1'], SEED_ENV)
    ).toBe(0)

    const after = await readBilling(id)
    expect(after.renewalReminderForPeriodEnd?.getTime()).toBe(
      (before.renewalReminderForPeriodEnd?.getTime() ?? 0) - DAY_MS
    )
    // Still the same period end, so a reminder already sent stays sent.
    expect(after.renewalReminderForPeriodEnd).toStrictEqual(after.currentPeriodEnd)
    expect(await historyTimes(id)).toStrictEqual(historyBefore.map((at) => at - DAY_MS))
  })

  it('changes no row when the fake subscriptions cannot be moved', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(fake, 'fakeShiftBack').mockRejectedValue(new Error('Redis is down'))
    const id = await tenantId('billing-yearly-cancelling')
    const before = await readBilling(id)

    expect(
      await runBillingTimeTravel(['--tenant', 'billing-yearly-cancelling', '--days', '2'], SEED_ENV)
    ).toBe(1)

    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/run it again\.\n$/))
    const after = await readBilling(id)
    expect(after.currentPeriodEnd).toStrictEqual(before.currentPeriodEnd)
    expect(after.version).toBe(before.version)
    expect(await queuedJobs(getBillingQueue())).toHaveLength(0)
  })

  it('refuses a workspace on a real provider, changing nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const id = await tenantId('billing-active-monthly')
    await setBilling(id, { provider: 'razorpay' })
    const before = await readBilling(id)

    expect(
      await runBillingTimeTravel(['--tenant', 'billing-active-monthly', '--days', '3'], SEED_ENV)
    ).toBe(1)

    expect(stderr).toHaveBeenCalledOnce()
    const after = await readBilling(id)
    expect(after.currentPeriodEnd).toStrictEqual(before.currentPeriodEnd)
    expect(await queuedJobs(getBillingQueue())).toHaveLength(0)
    await setBilling(id, { provider: 'fake' })
  })

  it('refuses outside local, changing nothing', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const id = await tenantId('billing-trial-10-days')
    const before = await readBilling(id)

    expect(
      await runBillingTimeTravel(['--tenant', 'billing-trial-10-days', '--days', '3'], {
        APP_ENV: 'qa',
      })
    ).toBe(1)

    const after = await readBilling(id)
    expect(after.trialEndsAt).toStrictEqual(before.trialEndsAt)
  })

  it.each([
    [['--tenant', 'billing-trial-10-days']],
    [['--tenant', 'billing-trial-10-days', '--days', '0']],
    [['--tenant', 'billing-trial-10-days', '--days', 'two']],
    [['--tenant', 'billing-no-such-workspace', '--days', '1']],
    [['--days', '1']],
    [['--tenant', '--days', '3']],
    [['--tenant', 'billing-trial-10-days', '--days', '--tenant']],
  ])('exits 1 for the arguments %j', async (argv) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(await runBillingTimeTravel(argv, SEED_ENV)).toBe(1)
  })
})
