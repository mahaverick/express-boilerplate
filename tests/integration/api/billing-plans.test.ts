/**
 * @file `GET /api/v1/plans`, the public plan list, through the real app and
 * the seeded plans: no sign-in needed, both plans with their seeded prices
 * and every entitlement, the catalog without registry internals, the trial
 * and payment switches, a public cache header, no provider ids anywhere, and
 * the answer still served in `full` maintenance. Also the slugs reserved for
 * the pricing pages.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { PlanRepository } from '@/repositories/plan.repository'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { closeRedis } from '@/services/redis.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { paymentsSwitch } from '../../helpers/billing-api'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { createTrackedUser, deleteTrackedUsers, tokenFor } from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { clearRateLimiter } from '../../helpers/sign-in'

vi.mock('@/services/billing/billing-provider.service', async () => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  return fakeProviderModule()
})

const app = createApp()
const planRepository = new PlanRepository()

/**
 * The provider-side names a public answer must never carry.
 */
const PROVIDER_FIELDS = ['provider', 'providerMode', 'providerPlanId', 'provider_plan_id']

beforeEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
})

afterEach(async () => {
  paymentsSwitch.on = true
  await clearRateLimiter(RATE_LIMITS.publicPlans.name)
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  await closeRedis()
})

/**
 * Every object key anywhere inside a JSON value.
 * @param value - The parsed JSON.
 * @returns The keys, nested ones included.
 */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keysIn(item))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysIn(inner)])
}

describe('GET /api/v1/plans', () => {
  it('lists both plans with their prices and entitlements, signed out, with a public cache header', async () => {
    const response = await request(app).get('/api/v1/plans')

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('public, max-age=60')
    const { data } = response.body as { data: Record<string, unknown> }
    const plans = data.plans as {
      key: string
      name: string
      description: string
      sortOrder: number
      entitlements: Record<string, unknown>
      prices: { id: string; interval: string; amountMinor: number; currency: string }[]
    }[]
    expect(plans.map((plan) => plan.key)).toEqual(['free', 'paid'])
    const [free, paid] = plans
    expect(free).toMatchObject({
      entitlements: { members: 3, advanced_example: false },
      prices: [],
    })
    expect(typeof free?.description).toBe('string')
    expect(paid?.entitlements).toEqual({ members: null, advanced_example: true })
    expect(
      paid?.prices.map(({ interval, amountMinor, currency }) => [interval, amountMinor, currency])
    ).toEqual([
      ['month', 99_900, 'INR'],
      ['year', 999_000, 'INR'],
    ])
    expect(data.catalog).toEqual([
      {
        key: 'members',
        kind: 'limit',
        label: 'Members',
        description: 'People in the workspace, counting pending invitations.',
      },
      {
        key: 'advanced_example',
        kind: 'feature',
        label: 'Workspace insights',
        description: 'Who joined and how many invitations went out in the last 30 days.',
      },
    ])
    const settings = await planRepository.getSettings()
    expect(data.trial).toEqual({ enabled: settings.trialEnabled, days: settings.trialDays })
    expect(data.paymentsEnabled).toBe(true)
    expect(data.gstRegistered).toBe(false)
  })

  it('carries no provider field anywhere in the answer', async () => {
    const response = await request(app).get('/api/v1/plans')

    expect(response.status).toBe(200)
    const keys = keysIn(response.body)
    for (const field of PROVIDER_FIELDS) expect(keys).not.toContain(field)
    expect(JSON.stringify(response.body)).not.toMatch(/plan_FAKE|plan_[A-Za-z0-9]{14}/)
  })

  it('says payments are off when no payment provider is set up', async () => {
    paymentsSwitch.on = false

    const response = await request(app).get('/api/v1/plans')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { paymentsEnabled: false } })
  })

  it('is still served in full maintenance', async () => {
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()

    const response = await request(app).get('/api/v1/plans')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { paymentsEnabled: true } })
  })
})

describe('slugs reserved for the pricing pages', () => {
  it.each(['pricing', 'checkout', 'upgrade'])('refuses a workspace slugged %s', async (slug) => {
    const user = await createTrackedUser()

    const response = await request(app)
      .post('/api/v1/tenants')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ name: 'Acme Inc', slug })

    expect(response.status).toBe(400)
  })
})
