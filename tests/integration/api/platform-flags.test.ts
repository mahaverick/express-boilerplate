/**
 * @file GET /api/v1/platform/flags, /flags/unregistered, /flags/meta and /flags/evaluate through
 * the real app and snapshot store. The registry list joins the registry with the snapshot (each
 * state, the condition summary, PostHog links, the kind and state filters under a search), the
 * unregistered list pages the flags PostHog has that the registry lacks, and meta carries the
 * traits and the snapshot block (its age and staleness); none calls PostHog. Evaluate answers one
 * user's traits and every flag's value and reason, a holdout's
 * recorded variant included, after its gates: 404 for an unknown user, 400 for a tenant the user
 * isn't in or a tenant with `app=apex`. It is audited once per staff member, user, tenant and app
 * per throttle window. Flags are switched on with a mock; the project id and app host come from a
 * mocked `getEnv()`.
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
const { FLAG_SNAPSHOT_STALE_MS, LISTED_FLAG_KEY_MAX } = await import('@/constants/flags.constants')
const { logger } = await import('@/services/logger.service')
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

/**
 * What the flags list `data` holds.
 */
type FlagsList = import('@/utilities/list-page.utilities').ListPage<import('@/types/flags').FlagRow>
/**
 * What the unregistered flags list `data` holds.
 */
type UnregisteredList = import('@/utilities/list-page.utilities').ListPage<
  import('@/types/flags').UnregisteredRow
>
/**
 * What the flags meta `data` holds.
 */
type FlagsMeta = import('@/types/flags').FlagsMetaResponse
/**
 * What the flags evaluate `data` holds.
 */
type FlagsEvaluation = import('@/types/flags').FlagsEvaluateResponse

// eslint-disable-next-line unicorn/no-null -- JSON null, as the list carries it
const NONE = null

/**
 * Past the snapshot's staleness window, well inside an access token's life.
 */
const PAST_STALE_MS = FLAG_SNAPSHOT_STALE_MS + 60_000

const app = createApp()
const tenantRepository = new TenantRepository()
const tenantIds: string[] = []

/**
 * GET a platform path as a staff member.
 */
function staffGet(token: string, path: string): Promise<Response> {
  return request(app).get(`/api/v1/platform${path}`).set('Authorization', `Bearer ${token}`)
}

/**
 * The data of a 200 response.
 */
function dataOf<T>(response: Response): T {
  return (response.body as { data: T }).data
}

/**
 * The keys of a flags list response's items, in order.
 */
function keysOf(response: Response): string[] {
  return dataOf<FlagsList>(response).items.map((item) => item.key)
}

/**
 * A user who owns a fresh tenant.
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
  vi.useRealTimers()
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

  it('links no PostHog page for a malformed flag, which has no numeric id', async () => {
    await loadFlagDefinitions([
      { ...flagDefinition('example_beta_page', { groupIndex: 0 }), id: undefined },
      { ...flagDefinition('mm_probe_flag'), id: undefined },
    ])
    const { token } = await createTrackedStaff('viewer')

    const list = dataOf<FlagsList>(await staffGet(token, '/flags'))
    const unregistered = dataOf<UnregisteredList>(await staffGet(token, '/flags/unregistered'))

    expect(list.items[0]).toMatchObject({
      key: 'example_beta_page',
      state: 'unsupported',
      unsupportedReason: 'malformed',
      posthogUrl: NONE,
    })
    expect(unregistered.items).toEqual([{ key: 'mm_probe_flag', active: true, posthogUrl: NONE }])
  })

  it('filters by kind and state, combined with a search over the key and the description', async () => {
    await loadFlagDefinitions([betaPageDefinition(true)])
    const { token } = await createTrackedStaff('viewer')

    const boolean = await staffGet(token, '/flags?kind=boolean')
    const missing = await staffGet(token, '/flags?state=missing')
    const active = await staffGet(token, '/flags?state=active')
    const both = await staffGet(token, '/flags?kind=multivariate&state=missing&search=EXPERIMENT')
    const byDescription = await staffGet(token, '/flags?search=call-to-action')
    const mismatch = await staffGet(token, '/flags?kind=boolean&state=missing&search=beta')
    const searchMismatch = await staffGet(token, '/flags?kind=boolean&state=active&search=cta')

    expect(keysOf(boolean)).toEqual(['example_beta_page'])
    expect(keysOf(missing)).toEqual(['example_cta_experiment'])
    expect(keysOf(active)).toEqual(['example_beta_page'])
    expect(keysOf(both)).toEqual(['example_cta_experiment'])
    expect(keysOf(byDescription)).toEqual(['example_cta_experiment'])
    expect(keysOf(mismatch)).toEqual([])
    expect(keysOf(searchMismatch)).toEqual([])
  })

  it('refuses an unknown kind or state with 400', async () => {
    const { token } = await createTrackedStaff('viewer')

    const kind = await staffGet(token, '/flags?kind=numeric')
    const state = await staffGet(token, '/flags?state=broken')

    expect([kind.status, state.status]).toEqual([400, 400])
  })

  it('runs the platform-search limiter', async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await staffGet(token, '/flags')

    expect(response.headers['ratelimit-limit']).toBe('60')
  })
})

describe('GET /platform/flags/unregistered', () => {
  it('lists the flags PostHog has that the registry lacks, sorted by key', async () => {
    const zed = flagDefinition('zz_probe_flag', { active: false })
    const ant = flagDefinition('aa_probe_flag')
    await loadFlagDefinitions([zed, betaPageDefinition(true), ant])
    const { token } = await createTrackedStaff('viewer')

    const { items } = dataOf<UnregisteredList>(await staffGet(token, '/flags/unregistered'))

    expect(items).toEqual([
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

  it('answers an empty page when the registry lacks nothing', async () => {
    const { token } = await createTrackedStaff('viewer')

    const { items, page } = dataOf<UnregisteredList>(await staffGet(token, '/flags/unregistered'))

    expect(items).toEqual([])
    expect(page).toMatchObject({ hasNext: false, hasPrev: false })
  })

  it('pages a key of the longest listed length across a page boundary', async () => {
    const longKey = 'a'.repeat(LISTED_FLAG_KEY_MAX)
    await loadFlagDefinitions([flagDefinition(longKey), flagDefinition('b_probe_flag')])
    const { token } = await createTrackedStaff('viewer')

    const first = dataOf<UnregisteredList>(await staffGet(token, '/flags/unregistered?limit=1'))
    const second = await staffGet(
      token,
      `/flags/unregistered?limit=1&cursor=${String(first.page.nextCursor)}`
    )
    const back = await staffGet(
      token,
      `/flags/unregistered?limit=1&direction=prev&cursor=${String(dataOf<UnregisteredList>(second).page.prevCursor)}`
    )

    expect(first.items.map((item) => item.key)).toEqual([longKey])
    expect(dataOf<UnregisteredList>(second).items.map((item) => item.key)).toEqual(['b_probe_flag'])
    expect(dataOf<UnregisteredList>(back).items.map((item) => item.key)).toEqual([longKey])
  })

  it('leaves a key too long for a cursor out of the list, logs it, and loads the rest', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const tooLong = 'a'.repeat(LISTED_FLAG_KEY_MAX + 1)
    await loadFlagDefinitions([
      flagDefinition(tooLong),
      flagDefinition('b_probe_flag'),
      flagDefinition('c_probe_flag'),
      betaPageDefinition(true),
    ])
    const { token } = await createTrackedStaff('viewer')

    const unregistered = dataOf<UnregisteredList>(await staffGet(token, '/flags/unregistered'))
    const again = dataOf<UnregisteredList>(await staffGet(token, '/flags/unregistered'))
    const registry = dataOf<FlagsList>(await staffGet(token, '/flags'))

    expect(again.items).toEqual(unregistered.items)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(unregistered.items.map((item) => item.key)).toEqual(['b_probe_flag', 'c_probe_flag'])
    expect(registry.items[0]).toMatchObject({ key: 'example_beta_page', state: 'active' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('too long'), {
      keyLength: LISTED_FLAG_KEY_MAX + 1,
      keyPrefix: 'a'.repeat(40),
    })
  })

  it('refuses a cursor from the registry list, and the registry list one from this list', async () => {
    await loadFlagDefinitions([flagDefinition('a_probe_flag'), flagDefinition('b_probe_flag')])
    const { token } = await createTrackedStaff('viewer')
    const registry = dataOf<FlagsList>(await staffGet(token, '/flags?limit=1'))
    const unregistered = dataOf<UnregisteredList>(
      await staffGet(token, '/flags/unregistered?limit=1')
    )

    const onUnregistered = await staffGet(
      token,
      `/flags/unregistered?limit=1&cursor=${String(registry.page.nextCursor)}`
    )
    const onRegistry = await staffGet(
      token,
      `/flags?limit=1&cursor=${String(unregistered.page.nextCursor)}`
    )

    for (const response of [onUnregistered, onRegistry]) {
      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        message: 'This list link is out of date. Reload the list from its first page.',
        code: 'CURSOR_INVALID',
        errors: { cursor: ['This list link is out of date. Reload the list from its first page.'] },
      })
    }
  })

  it('runs the platform-search limiter', async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await staffGet(token, '/flags/unregistered')

    expect(response.headers['ratelimit-limit']).toBe('60')
  })
})

describe('GET /platform/flags/meta', () => {
  it('carries the traits reference and the snapshot block', async () => {
    const { token } = await createTrackedStaff('viewer')

    const meta = dataOf<FlagsMeta>(await staffGet(token, '/flags/meta'))

    expect(meta.traits.map((trait) => trait.name)).toEqual([
      'platform_role',
      'tenant_role',
      'app_env',
      'account_created_days',
      'tenant_created_days',
    ])
    expect(meta.snapshot).toEqual({
      enabled: true,
      fetchedAt: expect.any(String) as unknown,
      stale: false,
    })
  })

  it('reports a snapshot not re-confirmed for ten minutes as stale, its fetchedAt unchanged', async () => {
    const { token } = await createTrackedStaff('viewer')
    const fresh = dataOf<FlagsMeta>(await staffGet(token, '/flags/meta'))
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(Date.now() + PAST_STALE_MS) })

    const stale = dataOf<FlagsMeta>(await staffGet(token, '/flags/meta'))

    expect(stale.snapshot).toEqual({
      enabled: true,
      fetchedAt: fresh.snapshot.fetchedAt,
      stale: true,
    })
  })

  it('says enabled: false when flags are unconfigured', async () => {
    flags.isEnabled = false
    const { token } = await createTrackedStaff('viewer')

    const meta = dataOf<FlagsMeta>(await staffGet(token, '/flags/meta'))

    expect(meta.snapshot.enabled).toBe(false)
  })

  it('runs the platform-search limiter', async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await staffGet(token, '/flags/meta')

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

  it('writes one entry when a repeat sends the tenant id in upper case', async () => {
    // Ids are stored lower case and compared exactly, so the membership check refuses the variant before the audit.
    const { userId, tenantId } = await memberWithTenant()
    const { user: admin, token } = await createTrackedStaff('admin')

    const first = await staffGet(
      token,
      `/flags/evaluate?userId=${userId}&tenantId=${tenantId}&app=react`
    )
    const repeat = await staffGet(
      token,
      `/flags/evaluate?userId=${userId}&tenantId=${tenantId.toUpperCase()}&app=react`
    )

    expect([first.status, repeat.status]).toEqual([200, 400])
    expect(await evaluateAudits(admin.id)).toHaveLength(1)
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

describe('the flag-evaluate limiter', () => {
  it('answers 429 RATE_LIMITED past 20 evaluations a minute for one staff member', async () => {
    const { userId } = await memberWithTenant()
    const { token } = await createTrackedStaff('admin')

    const statuses: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const response = await staffGet(token, `/flags/evaluate?userId=${userId}&app=react`)
      statuses.push(response.status)
    }
    const refused = await staffGet(token, `/flags/evaluate?userId=${userId}&app=react`)

    expect(statuses.every((status) => status === 200)).toBe(true)
    expect(refused.status).toBe(429)
    expect((refused.body as { code?: string }).code).toBe('RATE_LIMITED')
  })
})

describe('GET /platform/flags/evaluate refusals', () => {
  it('names errors.tenantId on the apex+tenant 400, and audits nothing', async () => {
    const { userId, tenantId } = await memberWithTenant()
    const { user: admin, token } = await createTrackedStaff('admin')
    const response = await staffGet(
      token,
      `/flags/evaluate?userId=${userId}&tenantId=${tenantId}&app=apex`
    )
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { tenantId: [expect.any(String)] } })
    expect(await evaluateAudits(admin.id)).toEqual([])
  })

  it('audits nothing for a non-member tenant 400 or a malformed query 400', async () => {
    const { userId } = await memberWithTenant()
    const { tenantId: otherTenantId } = await memberWithTenant()
    const { user: admin, token } = await createTrackedStaff('admin')
    const nonMember = await staffGet(
      token,
      `/flags/evaluate?userId=${userId}&tenantId=${otherTenantId}&app=react`
    )
    const malformed = await staffGet(token, `/flags/evaluate?userId=${userId}&app=api`)
    expect([nonMember.status, malformed.status]).toEqual([400, 400])
    expect(await evaluateAudits(admin.id)).toEqual([])
  })

  it('answers a soft-deleted user 404, as an unknown one, and audits nothing', async () => {
    const { userId } = await memberWithTenant()
    await sql`update users set deleted_at = now() where id = ${userId}`
    const { user: admin, token } = await createTrackedStaff('admin')
    const response = await staffGet(token, `/flags/evaluate?userId=${userId}&app=react`)
    expect(response.status).toBe(404)
    expect(await evaluateAudits(admin.id)).toEqual([])
  })
})
