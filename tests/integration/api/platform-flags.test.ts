/**
 * @file GET /api/v1/platform/flags and GET /api/v1/platform/flags/evaluate
 * through the real app and snapshot store. The list joins the registry with
 * the snapshot (each state, the condition summary, PostHog links, the
 * unregistered flags sorted, the traits, the snapshot block) and never calls
 * PostHog. Evaluate answers one user's traits and every flag's value and
 * reason, a holdout's recorded variant included, after its gates: 404 for an
 * unknown user, 400 for a tenant the user isn't in or a tenant with
 * `app=apex`, and is audited once per staff member, user, tenant and app
 * per throttle window. Flags are switched on with a mock; the project id and app host
 * come from a mocked `getEnv()`.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ isEnabled: true }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_APP_HOST: 'https://ph.example.test',
      POSTHOG_PROJECT_ID: 4321,
    }),
  }
})

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isFlagsEnabled: () => flags.isEnabled }
})

const { createApp } = await import('@/app')
const { TenantRepository } = await import('@/repositories/tenant.repository')
const { sql } = await import('@/services/database.service')
const { startFlagSnapshot, stopFlagSnapshot } =
  await import('@/services/flags/flag-snapshot.service')
const { truncateAuditLogs } = await import('../../helpers/audit-log')
const { betaPageDefinition, ctaExperimentDefinition, flagDefinition, loadFlagDefinitions } =
  await import('../../helpers/flag-definitions')
const { platformTenant } = await import('../../helpers/platform-staff')
const { createTrackedStaff, createTrackedUser, deleteTrackedUsers } =
  await import('../../helpers/platform-users')
const { clearFlagKeys } = await import('../../helpers/flag-redis')
const { request } = await import('../../helpers/request')

type FlagsList = import('@/types/flags').FlagsListResponse
type FlagsEvaluation = import('@/types/flags').FlagsEvaluateResponse

// eslint-disable-next-line unicorn/no-null -- JSON null, as the list carries it
const NONE = null

const app = createApp()
const tenantRepository = new TenantRepository()
const tenantIds: string[] = []

/**
 * GET a platform path as a staff member.
 * @param token - The staff bearer token.
 * @param path - The path under /api/v1/platform, with its query.
 * @returns The response.
 */
function staffGet(token: string, path: string): Promise<Response> {
  return request(app).get(`/api/v1/platform${path}`).set('Authorization', `Bearer ${token}`)
}

/**
 * The data of a 200 response.
 * @param response - The response.
 * @returns Its envelope's data.
 */
function dataOf<T>(response: Response): T {
  return (response.body as { data: T }).data
}

/**
 * A user who owns a fresh tenant.
 * @returns The user's id and the tenant's id.
 */
async function memberWithTenant(): Promise<{ userId: string; tenantId: string }> {
  const user = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Inspect Co',
    slug: `inspect-${randomUUID().slice(0, 8)}`,
    ownerId: user.id,
  })
  tenantIds.push(tenant.id)
  return { userId: user.id, tenantId: tenant.id }
}

/**
 * The `user.flags_evaluated` entries a staff member wrote.
 * @param actorId - The staff member's id.
 * @returns Each entry's tenant, target and metadata.
 */
async function evaluateAudits(actorId: string): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`
    select tenant_id as "tenantId", target_id as "targetId", metadata
    from audit_logs where actor_user_id = ${actorId} and action = 'user.flags_evaluated'`
}

beforeAll(async () => {
  await startFlagSnapshot()
})

beforeEach(async () => {
  flags.isEnabled = true
  await loadFlagDefinitions([betaPageDefinition(true), ctaExperimentDefinition()])
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await stopFlagSnapshot()
  await clearFlagKeys()
  await truncateAuditLogs()
  await sql`delete from tenants where id = any(${tenantIds})`
  await deleteTrackedUsers()
})

describe('GET /platform/flags', () => {
  it('lists every registered flag with its live state, links and condition summary', async () => {
    const beta = betaPageDefinition(true)
    await loadFlagDefinitions([beta])
    const { token } = await createTrackedStaff('viewer')

    const response = await staffGet(token, '/flags')

    expect(response.status).toBe(200)
    const { items } = dataOf<FlagsList>(response)
    expect(items).toEqual([
      {
        key: 'example_beta_page',
        description: expect.any(String) as unknown,
        kind: 'boolean',
        variants: NONE,
        scope: 'tenant',
        client: true,
        apps: ['react'],
        experiment: false,
        fallback: false,
        state: 'active',
        conditions: 1,
        maxRollout: 100,
        posthogUrl: `https://ph.example.test/project/4321/feature_flags/${String(beta.id)}`,
      },
      {
        key: 'example_cta_experiment',
        description: expect.any(String) as unknown,
        kind: 'multivariate',
        variants: ['control', 'bold'],
        scope: 'user',
        client: true,
        apps: ['react'],
        experiment: true,
        fallback: 'control',
        state: 'missing',
        conditions: 0,
        maxRollout: NONE,
        posthogUrl: NONE,
      },
    ])
  })

  it('marks an inactive flag and an unsupported one, with the reason', async () => {
    await loadFlagDefinitions([
      flagDefinition('example_beta_page', { active: false, groupIndex: 0, rolloutPercentage: 30 }),
      { ...ctaExperimentDefinition(), ensure_experience_continuity: true },
    ])
    const { token } = await createTrackedStaff('viewer')

    const { items } = dataOf<FlagsList>(await staffGet(token, '/flags'))

    expect(
      items.map(({ key, state, unsupportedReason, maxRollout }) => ({
        key,
        state,
        unsupportedReason,
        maxRollout,
      }))
    ).toEqual([
      { key: 'example_beta_page', state: 'inactive', unsupportedReason: undefined, maxRollout: 30 },
      {
        key: 'example_cta_experiment',
        state: 'unsupported',
        unsupportedReason: 'experience_continuity',
        maxRollout: 100,
      },
    ])
  })

  it('lists the flags PostHog has that the registry lacks, sorted by key', async () => {
    const zed = flagDefinition('zz_probe_flag', { active: false })
    const ant = flagDefinition('aa_probe_flag')
    await loadFlagDefinitions([zed, betaPageDefinition(true), ant])
    const { token } = await createTrackedStaff('viewer')

    const { unregistered } = dataOf<FlagsList>(await staffGet(token, '/flags'))

    expect(unregistered).toEqual([
      {
        key: 'aa_probe_flag',
        active: true,
        posthogUrl: `https://ph.example.test/project/4321/feature_flags/${String(ant.id)}`,
      },
      {
        key: 'zz_probe_flag',
        active: false,
        posthogUrl: `https://ph.example.test/project/4321/feature_flags/${String(zed.id)}`,
      },
    ])
  })

  it('links no PostHog page for a malformed flag, which has no numeric id', async () => {
    await loadFlagDefinitions([
      { ...flagDefinition('example_beta_page', { groupIndex: 0 }), id: undefined },
      { ...flagDefinition('mm_probe_flag'), id: undefined },
    ])
    const { token } = await createTrackedStaff('viewer')

    const list = dataOf<FlagsList>(await staffGet(token, '/flags'))

    expect(list.items[0]).toMatchObject({
      key: 'example_beta_page',
      state: 'unsupported',
      unsupportedReason: 'malformed',
      posthogUrl: NONE,
    })
    expect(list.unregistered).toEqual([{ key: 'mm_probe_flag', active: true, posthogUrl: NONE }])
  })

  it('carries the traits reference and the snapshot block', async () => {
    const { token } = await createTrackedStaff('viewer')

    const list = dataOf<FlagsList>(await staffGet(token, '/flags'))

    expect(list.traits.map((trait) => trait.name)).toEqual([
      'platform_role',
      'tenant_role',
      'app_env',
      'account_created_days',
      'tenant_created_days',
    ])
    expect(list.snapshot).toEqual({
      enabled: true,
      fetchedAt: expect.any(String) as unknown,
      stale: false,
    })
  })

  it('says enabled: false when flags are unconfigured', async () => {
    flags.isEnabled = false
    const { token } = await createTrackedStaff('viewer')

    const list = dataOf<FlagsList>(await staffGet(token, '/flags'))

    expect(list.snapshot.enabled).toBe(false)
  })

  it('runs the platform-search limiter', async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await staffGet(token, '/flags')

    expect(response.headers['ratelimit-limit']).toBe('60')
  })
})

describe('GET /platform/flags/evaluate', () => {
  it("answers a member's traits and every flag's value and reason in a tenant", async () => {
    const { userId, tenantId } = await memberWithTenant()
    const { token } = await createTrackedStaff('admin')

    const response = await staffGet(
      token,
      `/flags/evaluate?userId=${userId}&tenantId=${tenantId}&app=react`
    )

    expect(response.status).toBe(200)
    const result = dataOf<FlagsEvaluation>(response)
    expect(result.traits).toMatchObject({
      platform_role: 'none',
      tenant_role: 'owner',
      account_created_days: 0,
      tenant_created_days: 0,
    })
    expect(result.flags).toEqual([
      { key: 'example_beta_page', value: true, reason: 'condition_match', conditionIndex: 0 },
      {
        key: 'example_cta_experiment',
        value: 'bold',
        reason: 'condition_match',
        conditionIndex: 0,
      },
    ])
    expect(result.snapshot).toEqual({ fetchedAt: expect.any(String) as unknown, stale: false })
  })

  it('evaluates with no tenant: a tenant-scoped flag falls back for want of one', async () => {
    const { userId } = await memberWithTenant()
    const { token } = await createTrackedStaff('admin')

    const result = dataOf<FlagsEvaluation>(
      await staffGet(token, `/flags/evaluate?userId=${userId}&app=react`)
    )

    expect(result.traits).toMatchObject({ tenant_role: 'none' })
    expect(result.traits).not.toHaveProperty('tenant_created_days')
    expect(result.flags[0]).toEqual({
      key: 'example_beta_page',
      value: false,
      reason: 'fallback:no_tenant',
    })
  })

  it('shows a holdout user getting control, recorded as holdout-<id>', async () => {
    await loadFlagDefinitions([
      betaPageDefinition(true),
      ctaExperimentDefinition({ holdoutId: 77 }),
    ])
    const { userId } = await memberWithTenant()
    const { token } = await createTrackedStaff('admin')

    const result = dataOf<FlagsEvaluation>(
      await staffGet(token, `/flags/evaluate?userId=${userId}&app=react`)
    )

    expect(result.flags[1]).toEqual({
      key: 'example_cta_experiment',
      value: 'control',
      reason: 'holdout',
      holdoutVariant: 'holdout-77',
    })
  })

  it('audits the view once per staff member, user, tenant and app per throttle window', async () => {
    const { userId, tenantId } = await memberWithTenant()
    const { user: admin, token } = await createTrackedStaff('admin')
    const path = `/flags/evaluate?userId=${userId}&tenantId=${tenantId}&app=react`

    const first = await staffGet(token, path)
    const second = await staffGet(token, path)

    expect([first.status, second.status]).toEqual([200, 200])
    const platform = await platformTenant()
    expect(await evaluateAudits(admin.id)).toEqual([
      { tenantId: platform.id, targetId: userId, metadata: { tenantId, clientApp: 'react' } },
    ])
  })

  it('audits the same user again in another tenant, and with no tenant, inside the window', async () => {
    const { userId, tenantId } = await memberWithTenant()
    const second = await tenantRepository.create({
      name: 'Inspect Two',
      slug: `inspect-${randomUUID().slice(0, 8)}`,
      ownerId: userId,
    })
    tenantIds.push(second.id)
    const { user: admin, token } = await createTrackedStaff('admin')

    const statuses = []
    for (const query of [
      `tenantId=${tenantId}&app=react`,
      `tenantId=${second.id}&app=react`,
      'app=react',
      `tenantId=${second.id}&app=react`,
    ]) {
      const response = await staffGet(token, `/flags/evaluate?userId=${userId}&${query}`)
      statuses.push(response.status)
    }

    expect(statuses).toEqual([200, 200, 200, 200])
    const audited = await evaluateAudits(admin.id)
    expect(audited.map((entry) => entry.metadata)).toEqual(
      expect.arrayContaining([
        { tenantId, clientApp: 'react' },
        { tenantId: second.id, clientApp: 'react' },
        { tenantId: NONE, clientApp: 'react' },
      ])
    )
    expect(audited).toHaveLength(3)
  })

  it('audits the same user again for the other app inside the window', async () => {
    const { userId } = await memberWithTenant()
    const { user: admin, token } = await createTrackedStaff('admin')

    const statuses = []
    for (const app of ['react', 'apex', 'apex']) {
      const response = await staffGet(token, `/flags/evaluate?userId=${userId}&app=${app}`)
      statuses.push(response.status)
    }

    expect(statuses).toEqual([200, 200, 200])
    const audited = await evaluateAudits(admin.id)
    expect(audited.map((entry) => entry.metadata)).toEqual(
      expect.arrayContaining([
        { tenantId: NONE, clientApp: 'react' },
        { tenantId: NONE, clientApp: 'apex' },
      ])
    )
    expect(audited).toHaveLength(2)
  })

  it('answers 404 for an unknown user, and audits nothing', async () => {
    const { user: admin, token } = await createTrackedStaff('admin')

    const response = await staffGet(token, `/flags/evaluate?userId=${randomUUID()}&app=react`)

    expect(response.status).toBe(404)
    expect(await evaluateAudits(admin.id)).toEqual([])
  })

  it('refuses a tenant the user is not a member of with 400', async () => {
    const { userId } = await memberWithTenant()
    const { tenantId: otherTenantId } = await memberWithTenant()
    const { token } = await createTrackedStaff('admin')

    const response = await staffGet(
      token,
      `/flags/evaluate?userId=${userId}&tenantId=${otherTenantId}&app=react`
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { tenantId: [expect.any(String)] } })
  })

  it('refuses a tenant with app=apex with 400: staff are evaluated with no tenant', async () => {
    const { userId, tenantId } = await memberWithTenant()
    const { token } = await createTrackedStaff('admin')

    const response = await staffGet(
      token,
      `/flags/evaluate?userId=${userId}&tenantId=${tenantId}&app=apex`
    )

    expect(response.status).toBe(400)
  })

  it.each([
    ['a malformed user id', 'userId=not-a-uuid&app=react'],
    ['no app', `userId=${randomUUID()}`],
    ['an unknown app', `userId=${randomUUID()}&app=api`],
  ])('refuses %s with 400', async (_label, query) => {
    const { token } = await createTrackedStaff('admin')

    const response = await staffGet(token, `/flags/evaluate?${query}`)

    expect(response.status).toBe(400)
  })

  it('answers a staff viewer the plain 404', async () => {
    const { userId } = await memberWithTenant()
    const { token } = await createTrackedStaff('viewer')

    const response = await staffGet(token, `/flags/evaluate?userId=${userId}&app=react`)

    expect(response.status).toBe(404)
  })
})
