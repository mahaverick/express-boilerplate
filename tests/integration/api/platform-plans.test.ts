/**
 * @file The staff plan, price, billing settings and alert routes, end to end
 * against the real database and Redis: the plan list with prices, subscriber
 * and tenant counts; the preview of a plan change; the plan edit, which
 * applies to every tenant on the plan at once and tells their open apps; a
 * new price, which retires the active one while subscribers keep theirs; the
 * billing settings; and the alerts list. Every write is audited. These tests
 * edit the seeded plans, prices and settings, which every later file in the
 * worker reads, so each test puts back what migration 0033 seeds. The route gates are pinned in
 * `platform-route-gates.test.ts`; the alert list's paging in
 * `list-contract.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import { emitEntitlementsChanged } from '@/services/notification-emitter.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  deleteTrackedTenants,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  plans,
  readBilling,
  setBilling,
  workspace,
} from '../../helpers/billing-api'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  recentAuthTokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

vi.mock('@/services/billing/billing-provider.service', async () => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  return fakeProviderModule()
})

vi.mock('@/services/notification-emitter.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/notification-emitter.service')>()
  return { ...actual, emitEntitlementsChanged: vi.fn(actual.emitEntitlementsChanged) }
})

const app = createApp()
const REASON = 'Pricing review, ticket 5120'
const DAY_MS = 24 * 60 * 60 * 1000
/**
 * `expect.any(String)` typed as `string`, because vitest types it as `any`.
 */
const ANY_STRING = expect.any(String) as unknown as string
/**
 * `expect.any(Number)` typed as `number`, because vitest types it as `any`.
 */
const ANY_NUMBER = expect.any(Number) as unknown as number

/**
 * The settings migration 0033 seeds.
 */
const SEED_SETTINGS = { trialEnabled: true, trialDays: 14, pastDueGraceDays: 7 }

/**
 * Put the plans, prices and settings back to what migration 0033 seeds:
 * Paid's first monthly and yearly prices active and every later price gone,
 * both plans' names and values, and the settings. Tenants that hold a later
 * price must be deleted first.
 */
async function restoreSeed(): Promise<void> {
  await sql`
    with paid as (select id from plans where key = 'paid'),
    seed as (
      select distinct on (interval) id from plan_prices
      where plan_id = (select id from paid) order by interval, created_at, id
    )
    delete from plan_prices where id not in (select id from seed)`
  await sql`update plan_prices set active = true, retired_at = null`
  await sql`update plans set name = 'Free', description = null,
    entitlements = '{"members": 3, "advanced_example": false}'::jsonb where key = 'free'`
  await sql`update plans set name = 'Paid', description = null,
    entitlements = '{"members": null, "advanced_example": true}'::jsonb where key = 'paid'`
  await sql`update billing_settings set trial_enabled = ${SEED_SETTINGS.trialEnabled},
    trial_days = ${SEED_SETTINGS.trialDays}, past_due_grace_days = ${SEED_SETTINGS.pastDueGraceDays},
    updated_by = null`
}

beforeAll(async () => {
  await restoreSeed()
  await loadPlans()
})

afterEach(async () => {
  vi.mocked(emitEntitlementsChanged).mockClear()
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
  await sql`delete from billing_alerts where message like 'plans-test %'`
  await restoreSeed()
})

afterAll(async () => {
  await forgetProviderPlans()
  await closeQueue()
  await closeRedis()
})

/**
 * The `data` of a success response.
 * @param body - The response body.
 * @returns Its data.
 */
function dataOf<T = Record<string, unknown>>(body: unknown): T {
  return (body as { data: T }).data
}

/**
 * One plan as the staff routes answer it.
 */
interface StaffPlanBody {
  id: string
  key: string
  name: string
  description: string
  version: number
  entitlements: Record<string, unknown>
  prices: {
    id: string
    interval: string
    amountMinor: number
    currency: string
    active: boolean
    createdAt: string
    retiredAt: string | null
    subscribers: number
  }[]
  tenantCounts: Record<string, number>
}

/**
 * The current version of a plan.
 * @param planId - The plan.
 * @returns Its version.
 */
async function versionOf(planId: string): Promise<number> {
  const [row] = await sql<{ version: number }[]>`select version from plans where id = ${planId}`
  if (!row) throw new Error('setup: no such plan')
  return row.version
}

/**
 * The settings row's version.
 * @returns The version.
 */
async function settingsVersion(): Promise<number> {
  const [row] = await sql<{ version: number }[]>`select version from billing_settings`
  if (!row) throw new Error('setup: no settings row')
  return row.version
}

/**
 * Live customer tenants by stored billing state.
 * @param state - The stored state.
 * @returns How many hold it.
 */
async function liveTenantsIn(state: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from tenant_billing b join tenants t on t.id = b.tenant_id
    where t.deleted_at is null and not t.is_platform and b.state = ${state}`
  return row?.count ?? 0
}

/**
 * The platform-wide audit entries of one action, oldest first.
 * @param action - The action.
 * @returns Each entry's target, access and metadata.
 */
async function auditOf(
  action: string
): Promise<{ targetType: string; targetId: string; tenantId: string; metadata: unknown }[]> {
  return sql`
    select target_type as "targetType", target_id as "targetId", tenant_id as "tenantId", metadata
    from audit_logs where action = ${action} order by occurred_at, id`
}

/**
 * An admin's token, signed in just now.
 * @returns The token.
 */
async function adminToken(): Promise<string> {
  const { token } = await createTrackedStaff('admin')
  return token
}

/**
 * Send a JSON body to a staff path.
 * @param method - The HTTP method.
 * @param token - The staff token.
 * @param path - The path under `/api/v1/platform`.
 * @param body - The JSON body.
 * @returns The response.
 */
function send(method: 'post' | 'patch', token: string, path: string, body: object) {
  return request(app)
    [method](`/api/v1/platform${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

/**
 * GET a staff path.
 * @param token - The staff token.
 * @param path - The path under `/api/v1/platform`.
 * @returns The response.
 */
function read(token: string, path: string) {
  return request(app).get(`/api/v1/platform${path}`).set('Authorization', `Bearer ${token}`)
}

describe('GET /api/v1/platform/plans', () => {
  it('lists both plans with every price, its subscribers and the tenant counts', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const { token } = await createTrackedStaff('viewer')

    const response = await read(token, '/plans')

    expect(response.status).toBe(200)
    const data = dataOf<{
      plans: StaffPlanBody[]
      catalog: unknown[]
      priceWarningAboveMinor: number
    }>(response.body)
    expect(data.priceWarningAboveMinor).toBe(1_500_000)
    expect(data.catalog).toEqual([
      { key: 'members', kind: 'limit', label: 'Members', description: ANY_STRING },
      {
        key: 'advanced_example',
        kind: 'feature',
        label: 'Workspace insights',
        description: ANY_STRING,
      },
    ])
    expect(data.plans.map((plan) => plan.key)).toEqual(['free', 'paid'])
    const [free, paid] = data.plans
    expect(free).toMatchObject({
      id: plans.freeId,
      name: 'Free',
      version: ANY_NUMBER,
      entitlements: { members: 3, advanced_example: false },
      prices: [],
    })
    expect(paid?.entitlements).toEqual({ members: null, advanced_example: true })
    const month = paid?.prices.find((price) => price.id === plans.monthPriceId)
    expect(month).toEqual({
      id: plans.monthPriceId,
      interval: 'month',
      amountMinor: 99_900,
      currency: 'INR',
      active: true,
      createdAt: ANY_STRING,
      retiredAt: null,
      subscribers: ANY_NUMBER,
    })
    const [held] = await sql<{ count: number }[]>`
      select count(*)::int as count from tenant_billing b join tenants t on t.id = b.tenant_id
      where t.deleted_at is null and not t.is_platform and b.state in ('active', 'past_due')
        and b.price_id = ${plans.monthPriceId}`
    expect(month?.subscribers).toBe(held?.count)
    expect(month?.subscribers).toBeGreaterThanOrEqual(1)
    expect(free?.tenantCounts).toEqual({
      trialing: 0,
      free: await liveTenantsIn('free'),
      active: 0,
      past_due: 0,
    })
    expect(paid?.tenantCounts).toEqual({
      trialing: await liveTenantsIn('trialing'),
      free: 0,
      active: await liveTenantsIn('active'),
      past_due: await liveTenantsIn('past_due'),
    })
  })
})

describe('POST /api/v1/platform/plans/:id/preview', () => {
  it('marks a raised limit an increase and a lowered one a decrease, with the tenants affected', async () => {
    await workspace()
    const token = await adminToken()

    const up = await send('post', token, `/plans/${plans.freeId}/preview`, {
      entitlements: { members: 5 },
    })
    const down = await send('post', token, `/plans/${plans.freeId}/preview`, {
      entitlements: { members: 2, advanced_example: true },
    })

    expect(up.status).toBe(200)
    const affected = {
      trialing: 0,
      active: 0,
      past_due: 0,
      free: await liveTenantsIn('free'),
    }
    expect(affected.free).toBeGreaterThanOrEqual(1)
    expect(dataOf(up.body)).toEqual({
      changes: [{ key: 'members', from: 3, to: 5, direction: 'increase' }],
      affected,
    })
    expect(dataOf(down.body)).toEqual({
      changes: [
        { key: 'members', from: 3, to: 2, direction: 'decrease' },
        { key: 'advanced_example', from: false, to: true, direction: 'increase' },
      ],
      affected,
    })
  })

  it('reads a cap lifted to unlimited as an increase and a cap set on unlimited as a decrease', async () => {
    const token = await adminToken()

    const lifted = await send('post', token, `/plans/${plans.freeId}/preview`, {
      entitlements: { members: null },
    })
    const capped = await send('post', token, `/plans/${plans.paidId}/preview`, {
      entitlements: { members: 50, advanced_example: false },
    })

    expect(dataOf<{ changes: unknown }>(lifted.body).changes).toEqual([
      { key: 'members', from: 3, to: null, direction: 'increase' },
    ])
    expect(dataOf<{ changes: unknown }>(capped.body).changes).toEqual([
      { key: 'members', from: null, to: 50, direction: 'decrease' },
      { key: 'advanced_example', from: true, to: false, direction: 'decrease' },
    ])
    expect(dataOf<{ affected: unknown }>(capped.body).affected).toEqual({
      trialing: await liveTenantsIn('trialing'),
      active: await liveTenantsIn('active'),
      past_due: await liveTenantsIn('past_due'),
      free: 0,
    })
  })

  it('lists nothing for values the plan already has, and changes nothing', async () => {
    const token = await adminToken()
    const before = await versionOf(plans.freeId)

    const response = await send('post', token, `/plans/${plans.freeId}/preview`, {
      entitlements: { members: 3 },
    })

    expect(dataOf<{ changes: unknown }>(response.body).changes).toEqual([])
    expect(await versionOf(plans.freeId)).toBe(before)
  })

  it('answers plan_not_found for an unknown plan', async () => {
    const response = await send(
      'post',
      await adminToken(),
      '/plans/00000000-0000-7000-8000-000000000000/preview',
      { entitlements: { members: 5 } }
    )

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'plan_not_found' })
  })
})

describe('plan entitlement validation', () => {
  it.each([
    ['an unknown key', { bogus: 1 }],
    ['a limit of 0', { members: 0 }],
    ['a fractional limit', { members: 2.5 }],
    ['a limit over the cap', { members: 1_000_001 }],
    ['a limit given as text', { members: '5' }],
    ['a feature given as a number', { advanced_example: 1 }],
    ['a feature given as null', { advanced_example: null }],
  ])('refuses %s on the preview and the edit', async (_label, entitlements) => {
    const token = await adminToken()
    const version = await versionOf(plans.freeId)

    const preview = await send('post', token, `/plans/${plans.freeId}/preview`, { entitlements })
    const edit = await send('patch', token, `/plans/${plans.freeId}`, {
      version,
      entitlements,
      reason: REASON,
    })

    for (const response of [preview, edit]) {
      expect(response.status).toBe(400)
      expect((response.body as { errors: { entitlements: string[] } }).errors.entitlements).toEqual(
        [ANY_STRING]
      )
    }
    expect(await versionOf(plans.freeId)).toBe(version)
  })

  it('reports every bad key and every bad field at once', async () => {
    const response = await send('patch', await adminToken(), `/plans/${plans.freeId}`, {
      version: await versionOf(plans.freeId),
      name: '',
      entitlements: { bogus: 1, members: 0, advanced_example: 'yes' },
      reason: '',
    })

    expect(response.status).toBe(400)
    const errors = (response.body as { errors: Record<string, string[]> }).errors
    expect(errors.entitlements).toHaveLength(3)
    expect(errors.name).toEqual([ANY_STRING])
    expect(errors.reason).toEqual([ANY_STRING])
  })

  it('accepts a feature turned off and a limit at the cap or unlimited', async () => {
    const response = await send('post', await adminToken(), `/plans/${plans.paidId}/preview`, {
      entitlements: { members: 1_000_000, advanced_example: false },
    })

    expect(response.status).toBe(200)
  })
})

describe('PATCH /api/v1/platform/plans/:id', () => {
  it('refuses a stale version with PLAN_VERSION_CONFLICT and changes nothing', async () => {
    const token = await adminToken()
    const stale = await versionOf(plans.freeId)
    const first = await send('patch', token, `/plans/${plans.freeId}`, {
      version: stale,
      entitlements: { members: 4 },
      reason: REASON,
    })
    expect(first.status).toBe(200)

    const response = await send('patch', token, `/plans/${plans.freeId}`, {
      version: stale,
      entitlements: { members: 5 },
      reason: REASON,
    })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'PLAN_VERSION_CONFLICT' })
    expect(await versionOf(plans.freeId)).toBe(stale + 1)
    const [plan] = await sql<{ entitlements: unknown }[]>`
      select entitlements from plans where id = ${plans.freeId}`
    expect(plan?.entitlements).toEqual({ members: 4, advanced_example: false })
    expect(await auditOf('plan.updated')).toHaveLength(1)
  })

  it('applies at once: a Free tenant reads the new limit and its members are told', async () => {
    const { tenant, owner } = await workspace()
    const { token } = await createTrackedStaff('admin')
    const version = await versionOf(plans.freeId)

    const response = await send('patch', token, `/plans/${plans.freeId}`, {
      version,
      name: 'Starter',
      description: 'For small teams.',
      entitlements: { members: 5 },
      reason: REASON,
    })

    expect(response.status).toBe(200)
    expect(dataOf<StaffPlanBody>(response.body)).toMatchObject({
      id: plans.freeId,
      key: 'free',
      name: 'Starter',
      description: 'For small teams.',
      version: version + 1,
      entitlements: { members: 5, advanced_example: false },
    })
    const entitlements = await request(app)
      .get(`/api/v1/tenants/${tenant.slug}/entitlements`)
      .set('Authorization', `Bearer ${recentAuthTokenFor(owner)}`)
    expect(entitlements.status).toBe(200)
    expect(
      dataOf<{ limits: { members: { limit: number } } }>(entitlements.body).limits.members.limit
    ).toBe(5)
    expect(vi.mocked(emitEntitlementsChanged)).toHaveBeenCalledWith(owner.id, {
      tenantId: tenant.id,
      slug: tenant.slug,
    })
    const platform = await platformTenant()
    const [entry, ...rest] = await auditOf('plan.updated')
    expect(rest).toEqual([])
    expect(entry).toEqual({
      targetType: 'plan',
      targetId: plans.freeId,
      tenantId: platform.id,
      metadata: {
        before: {
          name: 'Free',
          description: ANY_STRING,
          entitlements: { members: 3, advanced_example: false },
        },
        after: {
          name: 'Starter',
          description: 'For small teams.',
          entitlements: { members: 5, advanced_example: false },
        },
        affected: {
          trialing: 0,
          active: 0,
          past_due: 0,
          free: await liveTenantsIn('free'),
        },
        reason: REASON,
      },
    })
  })

  it('tells a trialing tenant when Paid changes, and leaves a Free tenant alone', async () => {
    const trial = await workspace()
    const free = await workspace()
    await setBilling(trial.tenant.id, {
      state: 'trialing',
      planId: plans.paidId,
      trialStartedAt: new Date(),
      trialEndsAt: new Date(Date.now() + 7 * DAY_MS),
    })

    const response = await send('patch', await adminToken(), `/plans/${plans.paidId}`, {
      version: await versionOf(plans.paidId),
      entitlements: { members: 500 },
      reason: REASON,
    })

    expect(response.status).toBe(200)
    const told = vi.mocked(emitEntitlementsChanged).mock.calls.map(([userId]) => userId)
    expect(told).toContain(trial.owner.id)
    expect(told).not.toContain(free.owner.id)
  })

  it('tells a tenant whose trial lapsed before the job ran when Free changes', async () => {
    const lapsed = await workspace()
    await setBilling(lapsed.tenant.id, {
      state: 'trialing',
      planId: plans.paidId,
      trialStartedAt: new Date(Date.now() - 20 * DAY_MS),
      trialEndsAt: new Date(Date.now() - DAY_MS),
    })

    await send('patch', await adminToken(), `/plans/${plans.freeId}`, {
      version: await versionOf(plans.freeId),
      entitlements: { members: 4 },
      reason: REASON,
    })

    const told = vi.mocked(emitEntitlementsChanged).mock.calls.map(([userId]) => userId)
    expect(told).toContain(lapsed.owner.id)
  })

  it('keeps an over-limit tenant whole after a decrease', async () => {
    const { tenant } = await workspace()
    const member = await createTrackedUser()
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${member.id}, ${tenant.id}, 'viewer')`
    const before = await sql<{ count: number }[]>`
      select count(*)::int as count from user_memberships where tenant_id = ${tenant.id}`
    expect(before).toEqual([{ count: 2 }])

    const response = await send('patch', await adminToken(), `/plans/${plans.freeId}`, {
      version: await versionOf(plans.freeId),
      entitlements: { members: 1 },
      reason: REASON,
    })

    expect(response.status).toBe(200)
    expect(
      await sql`select count(*)::int as count from user_memberships where tenant_id = ${tenant.id}`
    ).toEqual(before)
  })
})

describe('POST /api/v1/platform/plans/:id/prices', () => {
  it('retires the active price, and a subscriber keeps the old one', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)

    const response = await send('post', await adminToken(), `/plans/${plans.paidId}/prices`, {
      interval: 'month',
      amountMinor: 129_900,
      reason: REASON,
    })

    expect(response.status).toBe(200)
    const prices = dataOf<StaffPlanBody>(response.body).prices
    const created = prices.find((price) => price.amountMinor === 129_900)
    const old = prices.find((price) => price.id === plans.monthPriceId)
    expect(created).toMatchObject({ interval: 'month', active: true, retiredAt: null })
    expect(old).toMatchObject({ active: false, retiredAt: ANY_STRING })
    expect(old?.subscribers).toBeGreaterThanOrEqual(1)
    expect(created?.subscribers).toBe(0)
    expect(prices.find((price) => price.id === plans.yearPriceId)?.active).toBe(true)
    const billing = await readBilling(tenant.id)
    expect(billing.priceId).toBe(plans.monthPriceId)
    const [entry] = await auditOf('plan.price_created')
    expect(entry).toMatchObject({
      targetType: 'plan',
      targetId: plans.paidId,
      metadata: { interval: 'month', amountMinor: 129_900, reason: REASON },
    })
  })

  it.each([99, 10_000_001, 999.5, '1000'])('refuses an amount of %s', async (amountMinor) => {
    const response = await send('post', await adminToken(), `/plans/${plans.paidId}/prices`, {
      interval: 'year',
      amountMinor,
      reason: REASON,
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { amountMinor: [ANY_STRING] } })
  })

  it.each([100, 10_000_000])('accepts an amount of %s, above the warning too', async (amount) => {
    const response = await send('post', await adminToken(), `/plans/${plans.paidId}/prices`, {
      interval: 'year',
      amountMinor: amount,
      reason: REASON,
    })

    expect(response.status).toBe(200)
  })

  it('refuses a price on Free with 400', async () => {
    const response = await send('post', await adminToken(), `/plans/${plans.freeId}/prices`, {
      interval: 'month',
      amountMinor: 49_900,
      reason: REASON,
    })

    expect(response.status).toBe(400)
    const [count] = await sql<{ count: number }[]>`
      select count(*)::int as count from plan_prices where plan_id = ${plans.freeId}`
    expect(count?.count).toBe(0)
  })
})

describe('/api/v1/platform/billing-settings', () => {
  it('reads the settings with their version', async () => {
    const version = await settingsVersion()

    const { token } = await createTrackedStaff('viewer')

    const response = await read(token, '/billing-settings')

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toEqual({
      ...SEED_SETTINGS,
      version,
      updatedAt: ANY_STRING,
      updatedBy: null,
    })
  })

  it('changes the trial length the public plan list shows, and audits the fields', async () => {
    const { user, token } = await createTrackedStaff('admin', { firstName: 'Ria' })
    const version = await settingsVersion()

    const response = await send('patch', token, '/billing-settings', {
      version,
      trialDays: 30,
      reason: REASON,
    })

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({
      trialDays: 30,
      version: version + 1,
      updatedBy: { userId: user.id, name: 'Ria' },
    })
    const plansPage = await request(app).get('/api/v1/plans')
    expect(dataOf<{ trial: { days: number } }>(plansPage.body).trial.days).toBe(30)
    const [entry] = await auditOf('billing.settings_updated')
    expect(entry?.metadata).toEqual({ changedFields: ['trialDays'], reason: REASON })
  })

  it.each([
    ['trialDays', 0],
    ['trialDays', 91],
    ['trialDays', 1.5],
    ['pastDueGraceDays', 0],
    ['pastDueGraceDays', 31],
    ['trialEnabled', 'yes'],
  ])('refuses %s of %s', async (field, value) => {
    const response = await send('patch', await adminToken(), '/billing-settings', {
      version: await settingsVersion(),
      [field]: value,
      reason: REASON,
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { [field]: [ANY_STRING] } })
  })

  it('accepts each range end', async () => {
    const token = await adminToken()
    for (const body of [
      { trialDays: 1, pastDueGraceDays: 1 },
      { trialDays: 90, pastDueGraceDays: 30, trialEnabled: false },
    ]) {
      const response = await send('patch', token, '/billing-settings', {
        version: await settingsVersion(),
        ...body,
        reason: REASON,
      })
      expect(response.status).toBe(200)
    }
  })

  it('refuses a stale version with PLAN_VERSION_CONFLICT', async () => {
    const token = await adminToken()
    const stale = await settingsVersion()
    const first = await send('patch', token, '/billing-settings', {
      version: stale,
      trialDays: 21,
      reason: REASON,
    })
    expect(first.status).toBe(200)

    const response = await send('patch', token, '/billing-settings', {
      version: stale,
      trialDays: 20,
      reason: REASON,
    })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'PLAN_VERSION_CONFLICT' })
    expect(await settingsVersion()).toBe(stale + 1)
    const [settings] = await sql<{ trialDays: number }[]>`
      select trial_days as "trialDays" from billing_settings`
    expect(settings?.trialDays).toBe(21)
  })

  it('refuses a body that changes nothing', async () => {
    const response = await send('patch', await adminToken(), '/billing-settings', {
      version: await settingsVersion(),
      reason: REASON,
    })

    expect(response.status).toBe(400)
  })
})

describe('GET /api/v1/platform/billing/alerts', () => {
  it('lists alerts newest first, naming a live tenant and nothing for a gone one', async () => {
    const { tenant } = await workspace()
    await sql`insert into billing_alerts (kind, tenant_id, message, at) values
      ('dispute', ${tenant.id}, 'plans-test dispute opened', now() - interval '1 minute'),
      ('webhook_failing', null, 'plans-test webhook failing', now())`

    const response = await read(await adminToken(), '/billing/alerts?search=plans-test')

    expect(response.status).toBe(200)
    expect(dataOf<{ items: unknown[] }>(response.body).items).toEqual([
      {
        id: ANY_STRING,
        kind: 'webhook_failing',
        tenant: null,
        message: 'plans-test webhook failing',
        at: ANY_STRING,
      },
      {
        id: ANY_STRING,
        kind: 'dispute',
        tenant: { id: tenant.id, name: tenant.name },
        message: 'plans-test dispute opened',
        at: ANY_STRING,
      },
    ])
  })
})
