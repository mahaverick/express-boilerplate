/**
 * @file The flag read and exposure routes and the reference beta route,
 * through the real app, the real snapshot store and the outbox. Reads serve
 * only the app's client flags, uncached, with fallbacks when flags are
 * unconfigured. Exposure reports are validated against the app's experiment
 * flags with one fixed message, re-evaluated on the server, recorded once per
 * session and value (a holdout as `holdout-<id>`), and recorded only for a
 * matched condition or a holdout: never for a user out of the rollout or a
 * fallback. The beta route answers the unknown-route 404 whenever its flag is
 * not on. Flags and analytics are switched on with a mock.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ isEnabled: true }))

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true, isFlagsEnabled: () => flags.isEnabled }
})

const { createApp } = await import('@/app')
const { TenantRepository } = await import('@/repositories/tenant.repository')
const { sql } = await import('@/services/database.service')
const { getRedis, redisKey } = await import('@/services/redis.service')
const { startFlagSnapshot, stopFlagSnapshot } =
  await import('@/services/flags/flag-snapshot.service')
const { EXPOSURE_KEY_MESSAGE } = await import('@/validators/flags.validators')
const { clearOutbox, outboxRowsOf } = await import('../../helpers/analytics-outbox')
const { truncateAuditLogs } = await import('../../helpers/audit-log')
const { betaPageDefinition, ctaExperimentDefinition, loadFlagDefinitions } =
  await import('../../helpers/flag-definitions')
const { createTrackedStaff, createTrackedUser, deleteTrackedUsers, tokenFor } =
  await import('../../helpers/platform-users')
const { request } = await import('../../helpers/request')

interface Envelope<T> {
  data: T
  message: string
  errors?: Record<string, string[]>
}

interface FlagsPayload {
  flags: Record<string, boolean | string>
  evaluatedAt: string
}

const app = createApp()
const tenantRepository = new TenantRepository()
const tenantIds: string[] = []

/**
 * A verified user who owns a fresh tenant, with a bearer token on its own session.
 * @returns The token and the tenant's slug.
 */
async function tenantOwner(): Promise<{ token: string; slug: string }> {
  const user = await createTrackedUser()
  const slug = `flags-${randomUUID().slice(0, 8)}`
  const tenant = await tenantRepository.create({ name: 'Flags Co', slug, ownerId: user.id })
  tenantIds.push(tenant.id)
  return { token: tokenFor(user), slug }
}

/**
 * The data of a 200 response.
 * @param response - The response.
 * @returns Its envelope's data.
 */
function dataOf<T>(response: Response): T {
  return (response.body as Envelope<T>).data
}

/**
 * POST an exposure report.
 * @param path - The route under /api/v1.
 * @param token - The bearer token.
 * @param body - The JSON body.
 * @returns The response.
 */
function report(path: string, token: string, body: unknown): Promise<Response> {
  return request(app)
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send(body as object)
}

/**
 * The recorded `$feature_flag_called` rows' flag, response and origin.
 * @returns One entry per row, oldest first.
 */
async function recordedExposures(): Promise<Record<string, unknown>[]> {
  const rows = await outboxRowsOf('$feature_flag_called')
  return rows.map((row) => ({
    flag: row.properties.$feature_flag,
    response: row.properties.$feature_flag_response,
    origin: row.properties.exposure_origin,
    source: row.properties.source,
  }))
}

beforeAll(async () => {
  await startFlagSnapshot()
})

beforeEach(async () => {
  flags.isEnabled = true
  await loadFlagDefinitions([betaPageDefinition(true), ctaExperimentDefinition()])
})

afterEach(async () => {
  vi.restoreAllMocks()
  await clearOutbox()
})

afterAll(async () => {
  await stopFlagSnapshot()
  await truncateAuditLogs()
  await sql`delete from tenants where id = any(${tenantIds})`
  await deleteTrackedUsers()
})

describe('GET /api/v1/tenants/:slug/flags', () => {
  it("serves react's client flags for a member, uncached, with no trait or reason", async () => {
    const { token, slug } = await tenantOwner()

    const response = await request(app)
      .get(`/api/v1/tenants/${slug}/flags`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const data = dataOf<FlagsPayload>(response)
    expect(Object.keys(data).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'evaluatedAt',
      'flags',
    ])
    expect(data.flags).toEqual({ example_beta_page: true, example_cta_experiment: 'bold' })
    expect(Number.isNaN(Date.parse(data.evaluatedAt))).toBe(false)
  })

  it('answers a non-member 404', async () => {
    const { slug } = await tenantOwner()
    const stranger = await createTrackedUser()

    const response = await request(app)
      .get(`/api/v1/tenants/${slug}/flags`)
      .set('Authorization', `Bearer ${tokenFor(stranger)}`)

    expect(response.status).toBe(404)
  })

  it('serves the fallbacks with 200 when flags are unconfigured', async () => {
    flags.isEnabled = false
    const { token, slug } = await tenantOwner()

    const response = await request(app)
      .get(`/api/v1/tenants/${slug}/flags`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(dataOf<FlagsPayload>(response).flags).toEqual({
      example_beta_page: false,
      example_cta_experiment: 'control',
    })
  })
})

describe('GET /api/v1/flags', () => {
  it('serves react flags with no tenant, so a tenant-scoped flag falls back', async () => {
    const user = await createTrackedUser()

    const response = await request(app)
      .get('/api/v1/flags')
      .set('Authorization', `Bearer ${tokenFor(user)}`)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(dataOf<FlagsPayload>(response).flags).toEqual({
      example_beta_page: false,
      example_cta_experiment: 'bold',
    })
  })

  it('answers an anonymous caller 401', async () => {
    const response = await request(app).get('/api/v1/flags')

    expect(response.status).toBe(401)
  })
})

describe('GET /api/v1/platform/me/flags', () => {
  it("serves apex's client flags to a staff viewer: none are registered yet", async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await request(app)
      .get('/api/v1/platform/me/flags')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(dataOf<FlagsPayload>(response).flags).toEqual({})
  })

  it('answers a non-staff caller 404', async () => {
    const user = await createTrackedUser()

    const response = await request(app)
      .get('/api/v1/platform/me/flags')
      .set('Authorization', `Bearer ${tokenFor(user)}`)

    expect(response.status).toBe(404)
  })
})

describe('POST …/flags/exposures', () => {
  it('records the server-evaluated variant once per session, then dedupes', async () => {
    const { token, slug } = await tenantOwner()

    const first = await report(`/tenants/${slug}/flags/exposures`, token, {
      keys: ['example_cta_experiment'],
    })
    const second = await report(`/tenants/${slug}/flags/exposures`, token, {
      keys: ['example_cta_experiment'],
    })

    expect([first.status, second.status]).toEqual([204, 204])
    expect(await recordedExposures()).toEqual([
      { flag: 'example_cta_experiment', response: 'bold', origin: 'react', source: 'flag' },
    ])
  })

  it('records a holdout user as holdout-<id>, never as control', async () => {
    await loadFlagDefinitions([
      betaPageDefinition(true),
      ctaExperimentDefinition({ holdoutId: 77 }),
    ])
    const user = await createTrackedUser()

    const response = await report('/flags/exposures', tokenFor(user), {
      keys: ['example_cta_experiment'],
    })

    expect(response.status).toBe(204)
    expect(await recordedExposures()).toEqual([
      { flag: 'example_cta_experiment', response: 'holdout-77', origin: 'react', source: 'flag' },
    ])
  })

  it('records nothing for a user out of the rollout, and still answers 204', async () => {
    await loadFlagDefinitions([
      betaPageDefinition(true),
      ctaExperimentDefinition({ rolloutPercentage: 0 }),
    ])
    const user = await createTrackedUser()

    const response = await report('/flags/exposures', tokenFor(user), {
      keys: ['example_cta_experiment'],
    })

    expect(response.status).toBe(204)
    expect(await recordedExposures()).toEqual([])
  })

  it('records nothing for a fallback, and still answers 204', async () => {
    await loadFlagDefinitions([betaPageDefinition(true)])
    const user = await createTrackedUser()

    const response = await report('/flags/exposures', tokenFor(user), {
      keys: ['example_cta_experiment'],
    })

    expect(response.status).toBe(204)
    expect(await recordedExposures()).toEqual([])
  })

  it('records nothing when flags are unconfigured, and still answers 204', async () => {
    flags.isEnabled = false
    const user = await createTrackedUser()

    const response = await report('/flags/exposures', tokenFor(user), {
      keys: ['example_cta_experiment'],
    })

    expect(response.status).toBe(204)
    expect(await recordedExposures()).toEqual([])
  })

  it('refuses a value sent by the client: the body is strict', async () => {
    const user = await createTrackedUser()

    const response = await report('/flags/exposures', tokenFor(user), {
      keys: ['example_cta_experiment'],
      value: 'control',
    })

    expect(response.status).toBe(400)
    expect(await recordedExposures()).toEqual([])
  })

  it.each([
    ['no keys', { keys: [] }],
    ['eleven keys', { keys: Array.from({ length: 11 }, (_, index) => `k${String(index)}`) }],
    ['a repeated key', { keys: ['example_cta_experiment', 'example_cta_experiment'] }],
    ['no body', {}],
  ])('refuses %s with 400', async (_label, body) => {
    const user = await createTrackedUser()

    const response = await report('/flags/exposures', tokenFor(user), body)

    expect(response.status).toBe(400)
  })

  it('answers an unregistered key and a non-experiment key identically, naming neither', async () => {
    const user = await createTrackedUser()
    const token = tokenFor(user)

    const unknown = await report('/flags/exposures', token, { keys: ['no_such_flag'] })
    const notExperiment = await report('/flags/exposures', token, { keys: ['example_beta_page'] })

    expect([unknown.status, notExperiment.status]).toEqual([400, 400])
    expect(unknown.body).toMatchObject({ errors: { keys: [EXPOSURE_KEY_MESSAGE] } })
    expect((notExperiment.body as Envelope<null>).errors).toEqual(
      (unknown.body as Envelope<null>).errors
    )
    expect(JSON.stringify(unknown.body)).not.toContain('no_such_flag')
  })

  it("refuses a react experiment on apex's route: each route serves its own app", async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await report('/platform/me/flags/exposures', token, {
      keys: ['example_cta_experiment'],
    })

    expect(response.status).toBe(400)
    expect(await recordedExposures()).toEqual([])
  })

  it('runs the flag-exposure limiter, 60 a minute', async () => {
    const user = await createTrackedUser()

    const response = await report('/flags/exposures', tokenFor(user), {
      keys: ['example_cta_experiment'],
    })

    expect(response.headers['ratelimit-limit']).toBe('60')
  })

  it('shares one Redis budget of 60 a minute per session across the tenant and tenantless routes', async () => {
    const { token, slug } = await tenantOwner()
    const body = { keys: ['example_cta_experiment'] }
    const statuses: number[] = []

    for (let index = 0; index < 30; index += 1) {
      const tenantless = await report('/flags/exposures', token, body)
      const tenantScoped = await report(`/tenants/${slug}/flags/exposures`, token, body)
      statuses.push(tenantless.status, tenantScoped.status)
    }
    const tenantless = await report('/flags/exposures', token, body)
    const tenant = await report(`/tenants/${slug}/flags/exposures`, token, body)

    expect(statuses).toEqual(Array.from({ length: 60 }, () => 204))
    expect([tenantless.status, tenant.status]).toEqual([429, 429])
    expect(tenant.headers['ratelimit-remaining']).toBe('0')
    // The counter is in Redis under the session, not in this process's memory fallback.
    const { sid } = JSON.parse(
      Buffer.from(token.split('.', 2)[1] ?? '', 'base64url').toString()
    ) as {
      sid: string
    }
    const redis = await getRedis()
    expect(await redis.exists(`${redisKey('rl', 'flag-exposure')}:session:${sid}`)).toBe(1)
  })

  it('refuses a non-JSON body with 415', async () => {
    const user = await createTrackedUser()

    const response = await request(app)
      .post('/api/v1/flags/exposures')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .set('Content-Type', 'text/plain')
      .send('keys=example_cta_experiment')

    expect(response.status).toBe(415)
  })

  it('answers a non-member on the tenant route 404', async () => {
    const { slug } = await tenantOwner()
    const stranger = await createTrackedUser()

    const response = await report(`/tenants/${slug}/flags/exposures`, tokenFor(stranger), {
      keys: ['example_cta_experiment'],
    })

    expect(response.status).toBe(404)
  })
})

/**
 * The unknown-route 404 body's message, for comparison.
 * @param token - A bearer token.
 * @returns The message.
 */
async function unknownRouteMessage(token: string): Promise<string | undefined> {
  const response = await request(app)
    .get('/api/v1/definitely-not-a-route')
    .set('Authorization', `Bearer ${token}`)
  return (response.body as { message?: string }).message
}

describe('GET /api/v1/tenants/:slug/beta', () => {
  it('answers a member while the flag is on', async () => {
    const { token, slug } = await tenantOwner()

    const response = await request(app)
      .get(`/api/v1/tenants/${slug}/beta`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    const data = dataOf<{ slug: string; enabledAt: string }>(response)
    expect(data.slug).toBe(slug)
    expect(Number.isNaN(Date.parse(data.enabledAt))).toBe(false)
  })

  it.each([
    ['rolled out to no one', () => loadFlagDefinitions([betaPageDefinition(false)])],
    ['missing from PostHog', () => loadFlagDefinitions([ctaExperimentDefinition()])],
    [
      'unconfigured',
      () => {
        flags.isEnabled = false
        return Promise.resolve()
      },
    ],
  ])('answers the unknown-route 404 when the flag is %s', async (_label, arrange) => {
    await arrange()
    const { token, slug } = await tenantOwner()

    const response = await request(app)
      .get(`/api/v1/tenants/${slug}/beta`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(404)
    expect((response.body as { message?: string }).message).toBe(await unknownRouteMessage(token))
  })

  it('answers a non-member 404 before the flag is read', async () => {
    const { slug } = await tenantOwner()
    const stranger = await createTrackedUser()

    const response = await request(app)
      .get(`/api/v1/tenants/${slug}/beta`)
      .set('Authorization', `Bearer ${tokenFor(stranger)}`)

    expect(response.status).toBe(404)
  })
})
