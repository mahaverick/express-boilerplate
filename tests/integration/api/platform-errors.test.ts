/**
 * @file GET /api/v1/platform/users/:id/errors and
 * GET /api/v1/platform/tenants/:id/errors through the real app, against the
 * fake PostHog: the admin gate, the audit (`user.errors_viewed` /
 * `tenant.errors_viewed`, empty metadata, in the platform tenant) throttled
 * per staff member and target and written again once the key is gone, never
 * for an unconfigured environment or an unknown target, the query's values
 * bound and never written into its text, the list envelope, a forged
 * `app: 'api'` row left unverified, the value re-scrubbed, the tenant group
 * index, and the 502 for a PostHog failure or a spent budget. The views are
 * configured through a mocked `getEnv()`, with a toggle for the
 * unconfigured case.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const PROJECT_ID = 4321

const target = vi.hoisted(() => ({ host: 'http://127.0.0.1:1', isConfigured: true, budget: 1200 }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_APP_HOST: target.host,
      POSTHOG_PERSONAL_API_KEY: target.isConfigured ? 'phx_test_key_not_real' : undefined,
      POSTHOG_PROJECT_ID: target.isConfigured ? 4321 : undefined,
      TIMELINE_QUERY_BUDGET_PER_HOUR: target.budget,
    }),
  }
})

const { createApp } = await import('@/app')
const { TenantRepository } = await import('@/repositories/tenant.repository')
const { resetTenantGroupTypeIndexCache } =
  await import('@/services/analytics/timeline-group-index.service')
const { sql } = await import('@/services/database.service')
const { logger } = await import('@/services/logger.service')
const { getRedis, redisKey } = await import('@/services/redis.service')
const { truncateAuditLogs } = await import('../../helpers/audit-log')
const { issuesAnswer, signedIssue } = await import('../../helpers/error-issue-rows')
const { startFakePosthog } = await import('../../helpers/fake-posthog')
const { platformTenant } = await import('../../helpers/platform-staff')
const { createTrackedStaff, createTrackedUser, deleteTrackedUsers } =
  await import('../../helpers/platform-users')
const { request } = await import('../../helpers/request')

type FakePosthog = Awaited<ReturnType<typeof startFakePosthog>>
type SeededIssue = Parameters<typeof issuesAnswer>[0][number]

interface Issue {
  issueId: string
  type: string
  value: string
  count: number
  source: string
  app: string | null
  verified: boolean
  link: string
}

interface ErrorsPage {
  configured: boolean
  items?: Issue[]
  nextCursor?: string | null
}

// eslint-disable-next-line unicorn/no-null -- JSON null, as the page carries it
const NONE = null

const app = createApp()
const tenantRepository = new TenantRepository()
const fake: { posthog?: FakePosthog } = {}
const tenantIds: string[] = []

/**
 * The running fake.
 * @returns It.
 */
function posthog(): FakePosthog {
  if (!fake.posthog) throw new Error('the fake PostHog is not running')
  return fake.posthog
}

/**
 * An issue whose most recent event was sent under `distinctId`.
 * @param distinctId - Whose event.
 * @param overrides - Any other columns.
 * @returns The seeded issue.
 */
function seeded(distinctId: string, overrides: Partial<SeededIssue> = {}): SeededIssue {
  return {
    issueId: randomUUID(),
    count: 2,
    firstSeen: '2026-10-01T09:00:00.000000Z',
    lastSeen: '2026-10-04T10:00:42.886001Z',
    uuid: randomUUID(),
    distinctId,
    exceptionList: [{ type: 'TypeError', value: 'x is undefined' }],
    app: 'api',
    source: 'error',
    ...overrides,
  }
}

/**
 * Answer every query with these issues.
 * @param issues - The issues.
 */
function answerWith(issues: SeededIssue[]): void {
  posthog().respondToQuery(() => ({ status: 200, json: issuesAnswer(issues) }))
}

/**
 * A GET of one Errors view.
 * @param token - The staff bearer token.
 * @param path - The path under /api/v1/platform.
 * @returns The response.
 */
function getErrors(token: string, path: string): Promise<Response> {
  return request(app).get(`/api/v1/platform${path}`).set('Authorization', `Bearer ${token}`)
}

/**
 * The status of a response.
 * @param pending - The request.
 * @returns Its status.
 */
async function statusOf(pending: PromiseLike<Response>): Promise<number> {
  const response = await pending
  return response.status
}

/**
 * The page in a 200 response.
 * @param response - The response.
 * @returns Its data.
 */
function pageOf(response: Response): ErrorsPage {
  expect(response.status).toBe(200)
  return (response.body as { data: ErrorsPage }).data
}

/**
 * How many errors-view audit entries target an id.
 * @param targetId - The user or tenant id.
 * @returns The count.
 */
async function errorsAudits(targetId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from audit_logs
    where action in ('user.errors_viewed', 'tenant.errors_viewed') and target_id = ${targetId}`
  return row?.count ?? 0
}

/**
 * A customer tenant with no members, tracked for cleanup.
 * @returns Its id.
 */
async function createTenant(): Promise<string> {
  const tenant = await tenantRepository.createWithoutOwner({
    name: 'Errors Co',
    slug: `errors-${randomUUID()}`,
  })
  tenantIds.push(tenant.id)
  return tenant.id
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
  target.host = fake.posthog.url
})

beforeEach(async () => {
  resetTenantGroupTypeIndexCache()
  const redis = await getRedis()
  await redis.del(redisKey('timeline', 'budget'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  target.isConfigured = true
  target.budget = 1200
  const current = posthog()
  current.respondToQuery(() => ({ status: 200 }))
  current.groupTypes = [{ group_type: 'tenant', group_type_index: 0 }]
  current.requests.length = 0
  current.queries.length = 0
  current.authHeaders.length = 0
  await truncateAuditLogs()
  await deleteTrackedUsers()
  if (tenantIds.length === 0) return
  await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
})

afterAll(async () => {
  await fake.posthog?.close()
})

describe('the Errors gate', () => {
  it('admits an admin and refuses a viewer with 404 and anonymous with 401', async () => {
    const subject = await createTrackedUser()
    const { token: admin } = await createTrackedStaff('admin')
    const { token: viewer } = await createTrackedStaff('viewer')

    expect(await statusOf(getErrors(admin, `/users/${subject.id}/errors`))).toBe(200)
    expect(await statusOf(getErrors(viewer, `/users/${subject.id}/errors`))).toBe(404)
    expect(await statusOf(request(app).get(`/api/v1/platform/users/${subject.id}/errors`))).toBe(
      401
    )
    expect(await errorsAudits(subject.id)).toBe(1)
  })
})

describe("a user's errors", () => {
  it('asks PostHog with the id as a value and answers the list envelope', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const issue = signedIssue(seeded(subject.id))
    answerWith([issue])

    const page = pageOf(await getErrors(token, `/users/${subject.id}/errors`))

    const [query] = posthog().queries
    expect(query?.values).toEqual({ id: subject.id, days: 30 })
    expect(query?.query).not.toContain(subject.id)
    expect(query?.query).toContain('distinct_id = {id}')
    const sent = posthog().requests.find((received) => received.path.endsWith('/query/'))
    expect(JSON.parse(sent?.body.toString('utf8') ?? '{}')).toMatchObject({
      refresh: 'force_blocking',
    })
    expect(page).toEqual({
      configured: true,
      items: [
        {
          issueId: issue.issueId,
          type: 'TypeError',
          value: 'x is undefined',
          count: 2,
          firstSeen: issue.firstSeen,
          lastSeen: issue.lastSeen,
          source: 'server',
          app: 'api',
          verified: true,
          link: `${posthog().url}/project/${String(PROJECT_ID)}/error_tracking/${issue.issueId}`,
        },
      ],
      nextCursor: NONE,
    })
  })

  it("marks a forged app: 'api' issue unverified and re-scrubs its value", async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    answerWith([
      seeded(subject.id, {
        signature: '0'.repeat(32),
        exceptionList: [{ type: 'Error', value: 'leaked victim@example.test' }],
      }),
    ])

    const [issue] = pageOf(await getErrors(token, `/users/${subject.id}/errors`)).items ?? []

    expect(issue).toMatchObject({ source: 'server', verified: false })
    expect(issue?.value).not.toContain('victim@example.test')
  })

  it('answers 404 for an unknown or malformed id, without auditing or asking PostHog', async () => {
    const { token } = await createTrackedStaff('admin')
    const unknown = randomUUID()

    expect(await statusOf(getErrors(token, `/users/${unknown}/errors`))).toBe(404)
    expect(await statusOf(getErrors(token, '/users/not-a-uuid/errors'))).toBe(404)
    expect(await errorsAudits(unknown)).toBe(0)
    expect(posthog().queries).toEqual([])
  })
})

describe("a tenant's errors", () => {
  it("matches the tenant group's column at its index", async () => {
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')
    posthog().groupTypes = [{ group_type: 'tenant', group_type_index: 2 }]

    pageOf(await getErrors(token, `/tenants/${tenantId}/errors`))

    const [query] = posthog().queries
    expect(query?.query).toContain('$group_2 = {id}')
    expect(query?.values).toEqual({ id: tenantId, days: 30 })
  })

  it('answers 502 when the project has no tenant group type', async () => {
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    posthog().groupTypes = []

    const response = await getErrors(token, `/tenants/${tenantId}/errors`)

    expect(response.status).toBe(502)
    expect((response.body as { code?: string }).code).toBe('TIMELINE_UNAVAILABLE')
  })

  it('answers 404 for the platform tenant', async () => {
    const platform = await platformTenant()
    const { token } = await createTrackedStaff('admin')

    expect(await statusOf(getErrors(token, `/tenants/${platform.id}/errors`))).toBe(404)
  })
})

describe('the Errors audit', () => {
  it('writes user.errors_viewed in the platform tenant with empty metadata, once per window', async () => {
    const subject = await createTrackedUser()
    const { user: staff, token } = await createTrackedStaff('admin')

    await getErrors(token, `/users/${subject.id}/errors`)
    await getErrors(token, `/users/${subject.id}/errors`)

    const platform = await platformTenant()
    const rows = await sql<
      { action: string; actor_user_id: string; tenant_id: string; metadata: unknown }[]
    >`select action, actor_user_id, tenant_id, metadata from audit_logs
      where target_id = ${subject.id}`
    expect(rows).toEqual([
      {
        action: 'user.errors_viewed',
        actor_user_id: staff.id,
        tenant_id: platform.id,
        metadata: {},
      },
    ])
    expect(posthog().queries).toHaveLength(2)
  })

  it('audits again once the ten-minute throttle key is gone', async () => {
    const subject = await createTrackedUser()
    const { user: staff, token } = await createTrackedStaff('admin')
    const key = redisKey('errors', 'audit', staff.id, 'user', subject.id)

    await getErrors(token, `/users/${subject.id}/errors`)
    const redis = await getRedis()
    const ttl = await redis.ttl(key)
    await redis.del(key)
    await getErrors(token, `/users/${subject.id}/errors`)

    expect(ttl).toBeGreaterThan(590)
    expect(ttl).toBeLessThanOrEqual(600)
    expect(await errorsAudits(subject.id)).toBe(2)
  })

  it('writes tenant.errors_viewed for a tenant, apart from its timeline audit', async () => {
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')

    await getErrors(token, `/tenants/${tenantId}/errors`)
    await getErrors(token, `/tenants/${tenantId}/timeline`)

    const rows = await sql<{ action: string }[]>`
      select action from audit_logs where target_id = ${tenantId} order by action`
    expect(rows).toEqual([{ action: 'tenant.errors_viewed' }, { action: 'tenant.timeline_viewed' }])
  })
})

describe('an unconfigured environment', () => {
  it('answers configured: false, audits nothing and never calls PostHog', async () => {
    target.isConfigured = false
    const subject = await createTrackedUser()
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')

    expect(pageOf(await getErrors(token, `/users/${subject.id}/errors`))).toEqual({
      configured: false,
    })
    expect(pageOf(await getErrors(token, `/tenants/${tenantId}/errors`))).toEqual({
      configured: false,
    })
    expect(await errorsAudits(subject.id)).toBe(0)
    expect(await errorsAudits(tenantId)).toBe(0)
    expect(posthog().requests).toEqual([])
  })

  it('still answers 404 for an unknown target', async () => {
    target.isConfigured = false
    const { token } = await createTrackedStaff('admin')
    const unknown = randomUUID()

    expect(await statusOf(getErrors(token, `/users/${unknown}/errors`))).toBe(404)
  })
})

describe('PostHog failures', () => {
  it.each([
    ['a 500', 500, 'warn'],
    ['a 401', 401, 'error'],
  ] as const)(
    'answers %s with 502 TIMELINE_UNAVAILABLE, keeping the audit',
    async (_n, status, level) => {
      const subject = await createTrackedUser()
      const { token } = await createTrackedStaff('admin')
      const spy = vi.spyOn(logger, level).mockImplementation(() => {})
      posthog().respondToQuery(() => ({ status }))

      const response = await getErrors(token, `/users/${subject.id}/errors`)

      expect(response.status).toBe(502)
      expect((response.body as { code?: string }).code).toBe('TIMELINE_UNAVAILABLE')
      expect(spy).toHaveBeenCalledWith(expect.any(String), { operation: 'errors query', status })
      expect(await errorsAudits(subject.id)).toBe(1)
    }
  )

  it('answers 502 for an answer without results', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    posthog().respondToQuery(() => ({ status: 200, json: { results: 'nope' } }))

    expect(await statusOf(getErrors(token, `/users/${subject.id}/errors`))).toBe(502)
  })

  it('answers 502 without asking PostHog when the hourly budget is spent', async () => {
    target.budget = 0
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await statusOf(getErrors(token, `/users/${subject.id}/errors`))).toBe(502)
    expect(posthog().queries).toEqual([])
  })
})
