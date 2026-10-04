/**
 * @file GET /api/v1/platform/users/:id/timeline and
 * GET /api/v1/platform/tenants/:id/timeline through the real app, against
 * the fake PostHog: the admin gate, the audit of every read (cursor pages
 * and cache hits included) throttled per staff member, target and view,
 * and never for an unconfigured environment or an unknown target, the
 * unconfigured answer, the 502 for every PostHog failure and for a spent
 * budget, the actor join, paging inside one millisecond, a cursor reused
 * under another view, signed rows against forged ones (demoted or dropped,
 * with the cursor still at raw row 100), the `tenant` group type at another
 * index or missing,
 * Redis down, and the per-staff limiter. The timeline is configured for this
 * file through a mocked `getEnv()`, with a toggle for the unconfigured case;
 * the PostHog timeout is shortened, and Redis can be made unreachable,
 * through two more mocks.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'phx_test_key_not_real'
const PROJECT_ID = 4321

const target = vi.hoisted(() => ({
  host: 'http://127.0.0.1:1',
  isConfigured: true,
  budget: 1200,
  isRedisDown: false,
}))

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

// Far below the real 15 s, so a hang outlasts it quickly; the claim under test is the 502.
vi.mock('@/constants/timeline.constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/constants/timeline.constants')>()),
  TIMELINE_POSTHOG_TIMEOUT_MS: 300,
}))

vi.mock('@/services/redis.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/redis.service')>()
  return {
    ...actual,
    getRedis: () =>
      target.isRedisDown ? Promise.reject(new Error('Redis unreachable')) : actual.getRedis(),
  }
})

const { createApp } = await import('@/app')
const { decodeTimelineCursor, encodeTimelineCursor } =
  await import('@/services/analytics/timeline-cursor.service')
const { REPLAY_SESSION_PLACEHOLDER } = await import('@/configs/analytics.config')
const { TenantRepository } = await import('@/repositories/tenant.repository')
const { resetTenantGroupTypeIndexCache } =
  await import('@/services/analytics/timeline-group-index.service')
const { sql } = await import('@/services/database.service')
const { logger } = await import('@/services/logger.service')
const audit = await import('@/services/audit.service')
const { getRedis, redisKey } = await import('@/services/redis.service')
const { truncateAuditLogs } = await import('../../helpers/audit-log')
const { startFakePosthog } = await import('../../helpers/fake-posthog')
const { platformTenant } = await import('../../helpers/platform-staff')
const { createTrackedStaff, createTrackedUser, deleteTrackedUsers } =
  await import('../../helpers/platform-users')
const { request } = await import('../../helpers/request')
const { queryAnswer, signedEvent } = await import('../../helpers/timeline-rows')

type FakePosthog = Awaited<ReturnType<typeof startFakePosthog>>
type SeededEvent = Parameters<typeof queryAnswer>[0][number]

interface Row {
  uuid: string
  event: string
  verified: boolean
  access: string | null
  tenant: string | null
  timestamp: string
  distinctId: string
  source: string
  path: string | null
  elementText: string | null
  props: Record<string, unknown>
  actor?: { id: string; displayName: string | null } | null
}

interface Page {
  configured: boolean
  rows?: Row[]
  nextCursor?: string | null
  links?: { person: string | null; group: string | null; replay: string }
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
 * A `$pageview` by `distinctId` at a fixed microsecond timestamp, with a fresh uuid.
 * @param distinctId - Who did it.
 * @param overrides - Any other columns.
 * @returns The seeded event.
 */
function seeded(distinctId: string, overrides: Partial<SeededEvent> = {}): SeededEvent {
  return {
    uuid: randomUUID(),
    event: '$pageview',
    timestamp: '2026-10-04T10:00:42.886001Z',
    distinct_id: distinctId,
    ...overrides,
  }
}

/**
 * 101 events, one microsecond apart and newest first, so a first page has a next one.
 * @param distinctId - Who did them.
 * @returns The events; the 100th is at 2026-10-04T10:00:42.899901Z.
 */
function fullPage(distinctId: string): SeededEvent[] {
  return Array.from({ length: 101 }, (_, index) =>
    seeded(distinctId, { timestamp: `2026-10-04T10:00:42.${String(900_000 - index)}Z` })
  )
}

/**
 * Answer every timeline query with these events.
 * @param events - The events, newest first.
 */
function answerWith(events: SeededEvent[]): void {
  posthog().respondToQuery(() => ({ status: 200, json: queryAnswer(events) }))
}

/**
 * A GET of one timeline.
 * @param token - The staff bearer token.
 * @param path - The path under /api/v1/platform.
 * @param query - The query string.
 * @returns The response.
 */
function getTimeline(
  token: string,
  path: string,
  query: Record<string, string> = {}
): Promise<Response> {
  return request(app)
    .get(`/api/v1/platform${path}`)
    .query(query)
    .set('Authorization', `Bearer ${token}`)
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
function pageOf(response: Response): Page {
  expect(response.status).toBe(200)
  return (response.body as { data: Page }).data
}

/**
 * How many timeline audit entries target an id.
 * @param targetId - The user or tenant id.
 * @returns The count.
 */
async function timelineAudits(targetId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from audit_logs
    where action in ('user.timeline_viewed', 'tenant.timeline_viewed') and target_id = ${targetId}`
  return row?.count ?? 0
}

/**
 * A customer tenant with no members, tracked for cleanup.
 * @returns Its id.
 */
async function createTenant(): Promise<string> {
  const tenant = await tenantRepository.createWithoutOwner({
    name: 'Timeline Co',
    slug: `timeline-${randomUUID()}`,
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
  target.isRedisDown = false
  const current = posthog()
  current.respondToQuery(() => ({ status: 200 }))
  current.hang(0)
  current.groupTypes = [{ group_type: 'tenant', group_type_index: 0 }]
  current.groupTypesStatus = 200
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

describe('the timeline gate', () => {
  it('admits an admin and refuses a viewer with 404 and anonymous with 401', async () => {
    const subject = await createTrackedUser()
    const { token: admin } = await createTrackedStaff('admin')
    const { token: viewer } = await createTrackedStaff('viewer')

    expect(await statusOf(getTimeline(admin, `/users/${subject.id}/timeline`))).toBe(200)
    expect(await statusOf(getTimeline(viewer, `/users/${subject.id}/timeline`))).toBe(404)
    const anonymous = await request(app).get(`/api/v1/platform/users/${subject.id}/timeline`)
    expect(anonymous.status).toBe(401)
    expect(await timelineAudits(subject.id)).toBe(1)
  })
})

describe('a user timeline', () => {
  it('asks PostHog with the Bearer key and the user id as a value, and maps the page', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    answerWith([
      seeded(subject.id, {
        event: '$autocapture',
        'properties.$current_url': 'https://app.example.test/settings?token=secret#x',
        'properties.$el_text': 'Save',
        'properties.$ip': '203.0.113.7',
      }),
    ])

    const page = pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))

    expect(posthog().authHeaders).toEqual([`Bearer ${KEY}`])
    const [query] = posthog().queries
    expect(query?.values).toEqual({ id: subject.id, hours: 168 })
    expect(query?.query).not.toContain(subject.id)
    const sent = posthog().requests.find((request) => request.path.endsWith('/query/'))
    // PostHog's own cache would otherwise serve a repeated query for hours.
    expect(JSON.parse(sent?.body.toString('utf8') ?? '{}')).toMatchObject({
      refresh: 'force_blocking',
    })
    expect(page.configured).toBe(true)
    expect(page.rows).toEqual([
      expect.objectContaining({
        event: '$autocapture',
        distinctId: subject.id,
        source: 'browser',
        path: '/settings',
        elementText: 'Save',
        props: {},
      }),
    ])
    expect(page.rows?.[0]).not.toHaveProperty('actor')
    expect(JSON.stringify(page)).not.toContain('203.0.113.7')
    expect(page.nextCursor).toBeNull()
    expect(page.links).toEqual({
      person: `${posthog().url}/project/${String(PROJECT_ID)}/person/${subject.id}`,
      group: NONE,
      replay: `${posthog().url}/project/${String(PROJECT_ID)}/replay/${REPLAY_SESSION_PLACEHOLDER}`,
    })
  })

  it('still has a timeline for a soft-deleted user', async () => {
    const subject = await createTrackedUser()
    await sql`update users set deleted_at = now() where id = ${subject.id}`
    const { token } = await createTrackedStaff('admin')

    expect(pageOf(await getTimeline(token, `/users/${subject.id}/timeline`)).configured).toBe(true)
  })

  it('answers 404 for an unknown or malformed id, without auditing or asking PostHog', async () => {
    const { token } = await createTrackedStaff('admin')
    const unknown = randomUUID()

    expect(await statusOf(getTimeline(token, `/users/${unknown}/timeline`))).toBe(404)
    expect(await statusOf(getTimeline(token, '/users/not-a-uuid/timeline'))).toBe(404)
    expect(await timelineAudits(unknown)).toBe(0)
    expect(posthog().queries).toEqual([])
  })

  it('answers 400 for a cursor this API did not issue', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')

    const response = await getTimeline(token, `/users/${subject.id}/timeline`, {
      before: 'bm90IGEgY3Vyc29y',
    })

    expect(response.status).toBe(400)
    expect((response.body as { errors?: unknown }).errors).toEqual({
      before: ['before is invalid.'],
    })
    expect(posthog().queries).toEqual([])
    expect(await timelineAudits(subject.id)).toBe(0)
  })

  it('keeps a page in the Redis cache for 30 s under the timeline:v1 key', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')

    await getTimeline(token, `/users/${subject.id}/timeline`, { range: '24h', view: 'key' })

    const redis = await getRedis()
    const ttl = await redis.ttl(
      redisKey('timeline', 'v1', 'user', subject.id, '24h', 'key', 'first')
    )
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(30)
  })

  it('refuses an unknown range or view with 400', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')

    for (const query of [{ range: '1y' }, { view: 'everything' }]) {
      expect(await statusOf(getTimeline(token, `/users/${subject.id}/timeline`, query))).toBe(400)
    }
  })
})

describe('the timeline audit', () => {
  it('writes user.timeline_viewed in the platform tenant, with the range and view', async () => {
    const subject = await createTrackedUser()
    const { user: staff, token } = await createTrackedStaff('admin')

    await getTimeline(token, `/users/${subject.id}/timeline`, { range: '30d', view: 'key' })

    const platform = await platformTenant()
    const rows = await sql<
      {
        action: string
        actor_user_id: string
        access: string
        tenant_id: string
        metadata: unknown
      }[]
    >`select action, actor_user_id, access, tenant_id, metadata from audit_logs
      where target_id = ${subject.id}`
    expect(rows).toEqual([
      {
        action: 'user.timeline_viewed',
        actor_user_id: staff.id,
        access: 'platform',
        tenant_id: platform.id,
        metadata: { range: '30d', view: 'key' },
      },
    ])
  })

  it('does not audit a second first page within the window, cached or not', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')

    await getTimeline(token, `/users/${subject.id}/timeline`)
    await getTimeline(token, `/users/${subject.id}/timeline`)
    await getTimeline(token, `/users/${subject.id}/timeline`, { range: '90d' })

    expect(posthog().queries).toHaveLength(2)
    expect(await timelineAudits(subject.id)).toBe(1)
  })

  it('audits a cursor page with no view before it, a forged far-future cursor included', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    answerWith(fullPage(subject.id))
    const forged = encodeTimelineCursor({ t: '2099-01-01T00:00:00.000000Z', u: randomUUID() })

    const page = pageOf(
      await getTimeline(token, `/users/${subject.id}/timeline`, { before: forged })
    )

    expect(page.rows).toHaveLength(100)
    expect(await timelineAudits(subject.id)).toBe(1)
  })

  it('does not audit a cursor page after a first page in the same view', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    answerWith(fullPage(subject.id))
    const first = pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))

    await getTimeline(token, `/users/${subject.id}/timeline`, { before: first.nextCursor ?? '' })

    expect(await timelineAudits(subject.id)).toBe(1)
  })

  it('audits again for another view, another target and another staff member', async () => {
    const subject = await createTrackedUser()
    const other = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const { token: secondStaff } = await createTrackedStaff('admin')

    await getTimeline(token, `/users/${subject.id}/timeline`)
    await getTimeline(token, `/users/${subject.id}/timeline`, { view: 'key' })
    await getTimeline(token, `/users/${other.id}/timeline`)
    await getTimeline(secondStaff, `/users/${subject.id}/timeline`)

    expect(await timelineAudits(subject.id)).toBe(3)
    expect(await timelineAudits(other.id)).toBe(1)
  })

  it('audits a cache hit for another staff member, without asking PostHog again', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const { token: secondStaff } = await createTrackedStaff('admin')

    await getTimeline(token, `/users/${subject.id}/timeline`)
    await getTimeline(secondStaff, `/users/${subject.id}/timeline`)

    expect(posthog().queries).toHaveLength(1)
    expect(await timelineAudits(subject.id)).toBe(2)
  })

  it('audits again once the ten-minute throttle key is gone', async () => {
    const subject = await createTrackedUser()
    const { user: staff, token } = await createTrackedStaff('admin')
    const key = redisKey('timeline', 'audit', staff.id, 'user', subject.id, 'all')

    await getTimeline(token, `/users/${subject.id}/timeline`)
    const redis = await getRedis()
    const ttl = await redis.ttl(key)
    await redis.del(key)
    await getTimeline(token, `/users/${subject.id}/timeline`)

    expect(ttl).toBeGreaterThan(590)
    expect(ttl).toBeLessThanOrEqual(600)
    expect(await timelineAudits(subject.id)).toBe(2)
  })

  it('audits every read, logged at warn, when the throttle cannot be claimed', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const redis = await getRedis()
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('connection reset'))

    await getTimeline(token, `/users/${subject.id}/timeline`)
    await getTimeline(token, `/users/${subject.id}/timeline`)

    expect(await timelineAudits(subject.id)).toBe(2)
    expect(warn).toHaveBeenCalledWith(
      'Timeline audit throttle unavailable; writing the audit entry anyway',
      expect.objectContaining({ error: expect.any(Error) as unknown })
    )
  })

  it('keeps the entry when PostHog then fails', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    posthog().respondToQuery(() => ({ status: 500 }))

    expect(await statusOf(getTimeline(token, `/users/${subject.id}/timeline`))).toBe(502)
    expect(await timelineAudits(subject.id)).toBe(1)
  })

  it('fails closed when the audit write fails: 500, no PostHog, key released, next read audited', async () => {
    const subject = await createTrackedUser()
    const { user: staff, token } = await createTrackedStaff('admin')
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    vi.spyOn(audit, 'recordTimelineView').mockRejectedValueOnce(new Error('insert failed'))

    const failed = await getTimeline(token, `/users/${subject.id}/timeline`)

    expect(failed.status).toBe(500)
    expect((failed.body as { data?: unknown }).data).toBeUndefined()
    expect(posthog().queries).toEqual([])
    const redis = await getRedis()
    expect(
      await redis.exists(redisKey('timeline', 'audit', staff.id, 'user', subject.id, 'all'))
    ).toBe(0)
    expect(await timelineAudits(subject.id)).toBe(0)

    expect(await statusOf(getTimeline(token, `/users/${subject.id}/timeline`))).toBe(200)
    expect(await timelineAudits(subject.id)).toBe(1)
  })

  it('logs at error, with the target, when the audit write and the key release both fail', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    vi.spyOn(audit, 'recordTimelineView').mockRejectedValueOnce(new Error('insert failed'))
    const redis = await getRedis()
    vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('connection reset'))

    expect(await statusOf(getTimeline(token, `/users/${subject.id}/timeline`))).toBe(500)

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('reads of this target may go unaudited'),
      {
        error: expect.any(Error) as unknown,
        kind: 'user',
        targetId: subject.id,
        unauditedSeconds: 600,
      }
    )
    expect(JSON.stringify(error.mock.calls)).not.toContain('timeline:audit')
  })

  it('writes tenant.timeline_viewed for a tenant read and user.timeline_viewed for a user read', async () => {
    const subject = await createTrackedUser()
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')

    await getTimeline(token, `/tenants/${tenantId}/timeline`)
    await getTimeline(token, `/users/${subject.id}/timeline`)

    const platform = await platformTenant()
    const rows = await sql<{ action: string; target_id: string; tenant_id: string }[]>`
      select action, target_id, tenant_id from audit_logs
      where target_id in (${tenantId}, ${subject.id}) order by action`
    expect(rows).toEqual([
      { action: 'tenant.timeline_viewed', target_id: tenantId, tenant_id: platform.id },
      { action: 'user.timeline_viewed', target_id: subject.id, tenant_id: platform.id },
    ])
  })
})

describe('an unconfigured environment', () => {
  it('answers configured: false, audits nothing and never calls PostHog', async () => {
    target.isConfigured = false
    const subject = await createTrackedUser()
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')

    expect(pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))).toEqual({
      configured: false,
    })
    expect(pageOf(await getTimeline(token, `/tenants/${tenantId}/timeline`))).toEqual({
      configured: false,
    })
    expect(await timelineAudits(subject.id)).toBe(0)
    expect(await timelineAudits(tenantId)).toBe(0)
    expect(posthog().requests).toEqual([])
  })

  it('still answers 404 for an unknown target', async () => {
    target.isConfigured = false
    const { token } = await createTrackedStaff('admin')
    const unknown = randomUUID()

    expect(await statusOf(getTimeline(token, `/users/${unknown}/timeline`))).toBe(404)
  })
})

describe('PostHog failures', () => {
  it.each([
    ['a 429', 429, 'warn'],
    ['a 500', 500, 'warn'],
    ['a 401', 401, 'error'],
  ] as const)(
    'answers %s (%i) with 502 TIMELINE_UNAVAILABLE, logged at %s',
    async (_name, status, level) => {
      const subject = await createTrackedUser()
      const { token } = await createTrackedStaff('admin')
      const spy = vi.spyOn(logger, level).mockImplementation(() => {})
      posthog().respondToQuery(() => ({ status }))

      const response = await getTimeline(token, `/users/${subject.id}/timeline`)

      expect(response.status).toBe(502)
      expect((response.body as { code?: string }).code).toBe('TIMELINE_UNAVAILABLE')
      expect(spy).toHaveBeenCalledWith(expect.any(String), {
        operation: 'timeline query',
        status,
      })
      expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY)
    }
  )

  it('answers a hang past the timeout with 502 TIMELINE_UNAVAILABLE', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    // Held far longer than the mocked 300 ms timeout; afterEach stops holding.
    posthog().hang(10_000)

    const response = await getTimeline(token, `/users/${subject.id}/timeline`)

    expect(response.status).toBe(502)
    expect((response.body as { code?: string }).code).toBe('TIMELINE_UNAVAILABLE')
    expect(warn).toHaveBeenCalledWith('PostHog did not answer a timeline call', {
      operation: 'timeline query',
      outcome: 'timeout',
    })
  })

  it('answers a result that is not a HogQL answer with 502', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    posthog().respondToQuery(() => ({ status: 200, json: { results: 'nope' } }))

    expect(await statusOf(getTimeline(token, `/users/${subject.id}/timeline`))).toBe(502)
  })

  it('answers 502 without asking PostHog once the hourly budget is spent, logged at warn', async () => {
    target.budget = 1
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await statusOf(getTimeline(token, `/users/${subject.id}/timeline`))).toBe(200)
    const spent = await getTimeline(token, `/users/${subject.id}/timeline`, { range: '24h' })

    expect(spent.status).toBe(502)
    expect((spent.body as { code?: string }).code).toBe('TIMELINE_UNAVAILABLE')
    expect(posthog().queries).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('Timeline query budget exhausted; not asking PostHog')
  })

  it('does not cache a failed page', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    posthog().respondToQuery(() => ({ status: 500 }))
    await getTimeline(token, `/users/${subject.id}/timeline`)

    posthog().respondToQuery(() => ({ status: 200 }))
    expect(await statusOf(getTimeline(token, `/users/${subject.id}/timeline`))).toBe(200)
    expect(posthog().queries).toHaveLength(2)
  })
})

describe('a tenant timeline', () => {
  it('names each actor: full name, else email, null for no user row, and no actor for system', async () => {
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')
    const named = await createTrackedUser({ firstName: 'Ada', lastName: 'Lovelace' })
    const unnamed = await createTrackedUser({ email: `unnamed-${randomUUID()}@example.test` })
    const purged = randomUUID()
    answerWith([
      seeded(named.id, { event: 'tenant_updated', 'properties.source': 'audit' }),
      seeded(unnamed.id),
      seeded(purged),
      seeded('system', { event: 'email_delivered', 'properties.source': 'email' }),
    ])

    const page = pageOf(await getTimeline(token, `/tenants/${tenantId}/timeline`))

    expect(page.rows?.map((row) => row.actor)).toEqual([
      { id: named.id, displayName: 'Ada Lovelace' },
      { id: unnamed.id, displayName: unnamed.email },
      { id: purged, displayName: NONE },
      NONE,
    ])
    expect(page.links).toEqual({
      person: NONE,
      group: `${posthog().url}/project/${String(PROJECT_ID)}/groups/0/${tenantId}`,
      replay: `${posthog().url}/project/${String(PROJECT_ID)}/replay/${REPLAY_SESSION_PLACEHOLDER}`,
    })
    expect(await timelineAudits(tenantId)).toBe(1)
  })

  it('filters on the group column PostHog gave the tenant type, and links that index', async () => {
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')
    posthog().groupTypes = [
      { group_type: 'organization', group_type_index: 0 },
      { group_type: 'tenant', group_type_index: 2 },
    ]

    const page = pageOf(await getTimeline(token, `/tenants/${tenantId}/timeline`))

    expect(posthog().queries[0]?.query).toContain('$group_2 = {id}')
    expect(posthog().queries[0]?.query).not.toContain('$group_0')
    expect(page.links?.group).toBe(
      `${posthog().url}/project/${String(PROJECT_ID)}/groups/2/${tenantId}`
    )
  })

  it('answers 502 with an error log when PostHog has no tenant group type, and caches nothing', async () => {
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    posthog().groupTypes = []

    const response = await getTimeline(token, `/tenants/${tenantId}/timeline`)

    expect(response.status).toBe(502)
    expect((response.body as { code?: string }).code).toBe('TIMELINE_UNAVAILABLE')
    expect(error).toHaveBeenCalledWith(
      'PostHog has no "tenant" group type, so tenant timelines are unavailable',
      { groupType: 'tenant' }
    )
    expect(posthog().queries).toEqual([])
    const redis = await getRedis()
    expect(
      await redis.exists(redisKey('timeline', 'v1', 'tenant', tenantId, '7d', 'all', 'first'))
    ).toBe(0)

    posthog().groupTypes = [{ group_type: 'tenant', group_type_index: 1 }]
    expect(await statusOf(getTimeline(token, `/tenants/${tenantId}/timeline`))).toBe(200)
    expect(posthog().queries[0]?.query).toContain('$group_1 = {id}')
  })

  it('still has a timeline for an archived tenant, and none for the platform tenant', async () => {
    const tenantId = await createTenant()
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenantId}`
    const { token } = await createTrackedStaff('admin')
    const platform = await platformTenant()
    const unknown = randomUUID()

    expect(await statusOf(getTimeline(token, `/tenants/${tenantId}/timeline`))).toBe(200)
    expect(await statusOf(getTimeline(token, `/tenants/${platform.id}/timeline`))).toBe(404)
    expect(await statusOf(getTimeline(token, `/tenants/${unknown}/timeline`))).toBe(404)
  })
})

describe('paging', () => {
  it('starts the next page exactly after row 100, with rows sharing one millisecond', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    // 150 events inside 2026-10-04T10:00:42.886Z, one microsecond apart, newest first.
    const events = Array.from({ length: 150 }, (_, index) =>
      seeded(subject.id, {
        uuid: `0199a1b2-0000-7000-8000-${String(index).padStart(12, '0')}`,
        timestamp: `2026-10-04T10:00:42.886${String(999 - index).padStart(3, '0')}Z`,
      })
    )
    posthog().respondToQuery(({ values }) => {
      const t = typeof values.t === 'string' ? values.t : undefined
      const u = typeof values.u === 'string' ? values.u : undefined
      const older = events.filter(
        (event) =>
          t === undefined ||
          event.timestamp < t ||
          (event.timestamp === t && u !== undefined && event.uuid < u)
      )
      return { status: 200, json: queryAnswer(older.slice(0, 101)) }
    })

    const first = pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))
    const second = pageOf(
      await getTimeline(token, `/users/${subject.id}/timeline`, { before: first.nextCursor ?? '' })
    )

    expect(first.rows).toHaveLength(100)
    expect(posthog().queries[1]?.values.t).toBe(events[99]?.timestamp)
    expect(posthog().queries[1]?.values.u).toBe(events[99]?.uuid)
    expect(second.rows).toHaveLength(50)
    expect(second.nextCursor).toBeNull()
    const seen = [...(first.rows ?? []), ...(second.rows ?? [])].map((row) => row.uuid)
    expect(seen).toEqual(events.map((event) => event.uuid))
  })

  it('takes a cursor under another view and range as a keyset, audited as that view', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    answerWith(fullPage(subject.id))
    const first = pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))

    const switched = await getTimeline(token, `/users/${subject.id}/timeline`, {
      before: first.nextCursor ?? '',
      view: 'key',
      range: '24h',
    })

    expect(switched.status).toBe(200)
    const [, query] = posthog().queries
    expect(query?.query).toContain("not startsWith(event, '$')")
    expect(query?.values).toMatchObject({ hours: 24, t: '2026-10-04T10:00:42.899901Z' })
    expect(await timelineAudits(subject.id)).toBe(2)
  })
})

describe('signed and forged rows', () => {
  it('trusts a signed server event, demotes a forged one and drops a forged target match', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const forger = randomUUID()
    const signed = signedEvent(
      seeded(subject.id, {
        event: 'user_signed_in',
        'properties.source': 'product',
        'properties.access': 'member',
        'properties.method': 'google',
      })
    )
    const staffAction = signedEvent(
      seeded(randomUUID(), {
        event: 'user_deactivated',
        'properties.source': 'audit',
        'properties.access': 'platform',
        'properties.target_type': 'user',
        'properties.target_id': subject.id,
      })
    )
    const forgedAudit = seeded(subject.id, {
      event: 'user_deleted',
      'properties.source': 'audit',
      'properties.access': 'platform',
      'properties.server_sig': 'f'.repeat(32),
    })
    const forgedTarget = seeded(forger, {
      event: 'user_purged',
      'properties.source': 'audit',
      'properties.access': 'platform',
      'properties.target_type': 'user',
      'properties.target_id': subject.id,
      'properties.server_sig': 'f'.repeat(32),
    })
    answerWith([signed, staffAction, forgedAudit, forgedTarget])

    const page = pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))

    expect(
      page.rows?.map((row) => [row.event, row.verified, row.source, row.access, row.props])
    ).toEqual([
      ['user_signed_in', true, 'product', 'member', { method: 'google' }],
      [
        'user_deactivated',
        true,
        'audit',
        'platform',
        { target_type: 'user', target_id: subject.id },
      ],
      ['user_deleted', false, 'browser', NONE, {}],
    ])
    expect(JSON.stringify(page)).not.toContain(forger)
  })

  it('drops a forged tenant target match from outside the group, and keeps a signed one', async () => {
    const tenantId = await createTenant()
    const { token } = await createTrackedStaff('admin')
    const staff = await createTrackedUser()
    const signed = signedEvent(
      seeded(staff.id, {
        event: 'tenant_suspended',
        'properties.source': 'audit',
        'properties.access': 'platform',
        'properties.target_type': 'tenant',
        'properties.target_id': tenantId,
        'properties.$groups.tenant': tenantId,
      })
    )
    const forged = seeded(randomUUID(), {
      event: 'tenant_purged',
      'properties.source': 'audit',
      'properties.target_type': 'tenant',
      'properties.target_id': tenantId,
    })
    answerWith([signed, forged])

    const page = pageOf(await getTimeline(token, `/tenants/${tenantId}/timeline`))

    expect(page.rows?.map((row) => [row.event, row.verified, row.tenant])).toEqual([
      ['tenant_suspended', true, tenantId],
    ])
  })

  it('returns the signed row, verified, when a forged row reuses its uuid', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const signed = signedEvent(
      seeded(subject.id, {
        event: 'password_changed',
        'properties.source': 'product',
        'properties.access': 'member',
      })
    )
    const forged = {
      ...signed,
      event: 'password_changed',
      'properties.source': 'audit',
      'properties.access': 'platform',
    }
    answerWith([forged, signed])

    const page = pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))

    expect(page.rows?.map((row) => [row.uuid, row.verified, row.source, row.access])).toEqual([
      [signed.uuid, true, 'product', 'member'],
    ])
  })

  it('lists two identical rows straddling rows 100 and 101 once across both pages', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const events = fullPage(subject.id)
    const hundredth = events[99]
    if (!hundredth) throw new Error('fullPage has 101 events')
    events[100] = { ...hundredth }
    events.push(seeded(subject.id, { timestamp: '2026-10-04T10:00:42.800000Z' }))
    posthog().respondToQuery(({ values }) => {
      const t = typeof values.t === 'string' ? values.t : undefined
      const u = typeof values.u === 'string' ? values.u : ''
      const older = events.filter(
        (event) =>
          t === undefined || event.timestamp < t || (event.timestamp === t && event.uuid < u)
      )
      return { status: 200, json: queryAnswer(older.slice(0, 101)) }
    })

    const first = pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))
    const second = pageOf(
      await getTimeline(token, `/users/${subject.id}/timeline`, { before: first.nextCursor ?? '' })
    )

    const seen = [...(first.rows ?? []), ...(second.rows ?? [])].map((row) => row.uuid)
    expect(seen.filter((uuid) => uuid === hundredth.uuid)).toHaveLength(1)
    expect(seen).toHaveLength(101)
    expect(new Set(seen).size).toBe(101)
  })

  it('builds the cursor from raw row 100 even when the mapper dropped it', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const events = fullPage(subject.id)
    const forgedHundredth = {
      ...events[99],
      uuid: events[99]?.uuid ?? randomUUID(),
      event: 'user_purged',
      timestamp: events[99]?.timestamp ?? '',
      distinct_id: randomUUID(),
      'properties.target_type': 'user',
      'properties.target_id': subject.id,
    }
    events[99] = forgedHundredth
    answerWith(events)

    const first = pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))
    await getTimeline(token, `/users/${subject.id}/timeline`, { before: first.nextCursor ?? '' })

    expect(first.rows).toHaveLength(99)
    expect(posthog().queries[1]?.values).toMatchObject({
      t: forgedHundredth.timestamp,
      u: forgedHundredth.uuid,
    })
  })

  it('answers no rows and a cursor at raw row 100 when all 101 rows are forged target matches', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const events = fullPage(subject.id).map((event) => ({
      ...event,
      distinct_id: randomUUID(),
      event: 'user_purged',
      'properties.source': 'audit',
      'properties.target_type': 'user',
      'properties.target_id': subject.id,
      'properties.server_sig': 'f'.repeat(32),
    }))
    answerWith(events)

    const page = pageOf(await getTimeline(token, `/users/${subject.id}/timeline`))

    expect(page.rows).toEqual([])
    expect(page.nextCursor).not.toBeNull()
    expect(decodeTimelineCursor(page.nextCursor ?? '')).toEqual({
      t: events[99]?.timestamp,
      u: events[99]?.uuid,
    })
  })
})

describe('Redis down', () => {
  it('answers from PostHog: the budget fails open and the cache falls through, each logged at warn', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    target.isRedisDown = true

    const first = await getTimeline(token, `/users/${subject.id}/timeline`)
    const second = await getTimeline(token, `/users/${subject.id}/timeline`)

    expect([first.status, second.status]).toEqual([200, 200])
    expect(posthog().queries).toHaveLength(2)
    const messages = warn.mock.calls.map(([message]) => message)
    expect(messages).toContain('Timeline query budget unavailable; allowing the query')
    expect(messages).toContain('Timeline cache read failed; asking PostHog')
    expect(messages).toContain('Timeline cache write failed')
  })
})

describe('the timeline limiter', () => {
  it('answers 429 RATE_LIMITED past 20 requests a minute for one staff member', async () => {
    const subject = await createTrackedUser()
    const { token } = await createTrackedStaff('admin')

    const statuses: number[] = []
    for (let index = 0; index < 20; index += 1) {
      statuses.push(await statusOf(getTimeline(token, `/users/${subject.id}/timeline`)))
    }
    const refused = await getTimeline(token, `/users/${subject.id}/timeline`)

    expect(statuses.every((status) => status === 200)).toBe(true)
    expect(refused.status).toBe(429)
    expect((refused.body as { code?: string }).code).toBe('RATE_LIMITED')
    expect(posthog().queries).toHaveLength(1)
  })
})
