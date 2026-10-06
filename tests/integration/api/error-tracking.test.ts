/**
 * @file Server errors to a fake PostHog, through the real middleware chain
 * (request id, request context, route template, PostHog session, auth,
 * tenant resolution) and the real `errorHandler`, on a probe router of
 * failing routes: the 5xx body's `errorId` names the log line and the one
 * `$exception` sent, signed and with GeoIP disabled; the actor's identity and tenant group, or the server's
 * anonymous identity; what is never sent (a 404, a validation 400, a client
 * abort, a timeline 502, a 503 with no cause); a postgres.js unique
 * violation arriving without its row values; and the `/collect` proxy's own
 * failures never reaching the reporter. Error tracking is enabled for this
 * file through a mocked `getEnv()`. The payload assertions run against the
 * reporter built in the error-tracking services.
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const target = vi.hoisted((): { host: string; projectKey: string | undefined } => ({
  host: 'http://127.0.0.1:1',
  projectKey: 'phc_test_key_not_real',
}))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_PROJECT_KEY: target.projectKey,
      POSTHOG_HOST: target.host,
      POSTHOG_ASSETS_HOST: target.host,
      ERROR_TRACKING_ENABLED: true,
    }),
  }
})

const { createApp } = await import('@/app')
const { userModel } = await import('@/database/models/user.model')
const { HttpError } = await import('@/errors/http-error')
const { TimelineUnavailableError } = await import('@/errors/timeline-errors')
const { requireAuth } = await import('@/middlewares/auth.middleware')
const { errorHandler } = await import('@/middlewares/error.middleware')
const { posthogSession } = await import('@/middlewares/posthog-session.middleware')
const { requestContext } = await import('@/middlewares/request-context.middleware')
const { requestId } = await import('@/middlewares/request-id.middleware')
const { recordRouteTemplate } = await import('@/middlewares/route-template.middleware')
const { resolveTenant } = await import('@/middlewares/tenant.middleware')
const { TenantRepository } = await import('@/repositories/tenant.repository')
const { isAnalyticsSignatureValid, signedFieldsOf } =
  await import('@/services/analytics/analytics-signature.service')
const { db, sql } = await import('@/services/database.service')
const reporter = await import('@/services/errors/error-reporter.service')
const { logger } = await import('@/services/logger.service')
const { startFakePosthog } = await import('../../helpers/fake-posthog')
const { createTrackedUser, deleteTrackedUsers, tokenFor } =
  await import('../../helpers/platform-users')
const { request } = await import('../../helpers/request')

type FakePosthog = Awaited<ReturnType<typeof startFakePosthog>>

const FLUSH_DEADLINE_MS = 5000
const fake: { posthog?: FakePosthog } = {}
const tenantIds: string[] = []
const tenantRepository = new TenantRepository()

/**
 * The running fake.
 * @returns It.
 */
function posthog(): FakePosthog {
  if (!fake.posthog) throw new Error('the fake PostHog is not running')
  return fake.posthog
}

/**
 * The barrier the client-abort test waits on: resolved by the probe app's error handler.
 */
const handled: { resolve: ((status: number) => void) | undefined } = { resolve: undefined }

/**
 * A probe app with the real middleware chain, routes that fail on purpose
 * under a mounted router, and the real `errorHandler`.
 * @returns The app.
 */
function probeApp(): express.Express {
  const app = express()
  app.use(requestId)
  app.use(recordRouteTemplate)
  app.use(requestContext)
  app.use(posthogSession)
  app.use(express.json())
  const router = Router()
  router.get('/items/:itemId/boom', () => {
    throw new Error('plain failure for user-leak@example.test')
  })
  router.get('/me/boom', requireAuth, () => {
    throw new Error('authenticated failure')
  })
  router.get('/tenants/:slug/boom', requireAuth, resolveTenant(), () => {
    throw new Error('tenant failure')
  })
  router.get('/missing', () => {
    throw new HttpError('Not found', 404)
  })
  router.post('/echo', (request_: Request, response: Response) => {
    response.json(request_.body)
  })
  router.get('/timeline', () => {
    throw Object.assign(new TimelineUnavailableError(), { cause: new Error('refused') })
  })
  router.get('/shutting-down', () => {
    throw new HttpError('Server is shutting down', 503)
  })
  router.get('/wrapped', () => {
    throw new HttpError('Upstream failed', 503, undefined, undefined, {
      cause: new Error('connect ECONNREFUSED'),
    })
  })
  // Async, so a falsy throw (`null`) rejects the handler's promise: Express treats a synchronous `throw null` as `next(null)`, a 404.
  router.get('/throw/:kind', async (request_: Request) => {
    await Promise.resolve()
    const kind = String(request_.params.kind)
    // The non-Error throws below are the case under test.
    /* eslint-disable @typescript-eslint/only-throw-error, unicorn/no-null -- a falsy throw is the case under test */
    if (kind === 'string') throw 'boom'
    if (kind === 'null') throw null
    if (kind === 'object') throw { message: 'x', email: 'a@b.example' }
    throw Object.create(null)
    /* eslint-enable @typescript-eslint/only-throw-error, unicorn/no-null */
  })
  router.get('/duplicate/:email', async (request_: Request) => {
    await db.insert(userModel).values({ email: String(request_.params.email) })
  })
  app.use('/api/probe', router)
  app.use((error: unknown, request_: Request, response: Response, next: NextFunction) => {
    errorHandler(error, request_, response, next)
    handled.resolve?.(response.statusCode)
  })
  return app
}

/**
 * Flush the reporter and return every `$exception` the fake received.
 * @returns The events.
 */
async function sentExceptions(): Promise<Record<string, unknown>[]> {
  await reporter.flushErrorReports(FLUSH_DEADLINE_MS)
  return posthog()
    .batches.flat()
    .filter((event) => event.event === '$exception') as unknown as Record<string, unknown>[]
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
  target.host = fake.posthog.url
})

afterEach(async () => {
  vi.restoreAllMocks()
  target.projectKey = 'phc_test_key_not_real'
  target.host = posthog().url
  await reporter.flushErrorReports(FLUSH_DEADLINE_MS)
  posthog().batches.length = 0
  posthog().requests.length = 0
  if (tenantIds.length > 0) {
    await sql`delete from user_memberships where tenant_id = any(${tenantIds})`
    await sql`delete from tenants where id = any(${tenantIds})`
    tenantIds.length = 0
  }
  await deleteTrackedUsers()
})

afterAll(async () => {
  await fake.posthog?.close()
})

describe('an unexpected 5xx', () => {
  it('answers 500 with an errorId that names the log line and the one $exception sent', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})

    const response = await request(probeApp()).get(`/api/probe/items/${randomUUID()}/boom`)

    expect(response.status).toBe(500)
    const { errorId } = response.body as { errorId: string }
    expect(errorId).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    expect(error).toHaveBeenCalledWith(
      'Unhandled server error',
      expect.objectContaining({ errorId })
    )
    const events = await sentExceptions()
    expect(events).toHaveLength(1)
    const [event] = events
    expect(event).toMatchObject({ uuid: errorId, distinct_id: 'server:express-boilerplate' })
    const properties = event?.properties as Record<string, unknown>
    expect(properties).toMatchObject({
      app: 'api',
      source: 'error',
      capture_point: 'http',
      http_method: 'GET',
      http_route: '/api/probe/items/:itemId/boom',
      http_status: 500,
      $process_person_profile: false,
      $geoip_disable: true,
    })
    expect(
      isAnalyticsSignatureValid(
        signedFieldsOf(
          { uuid: errorId, event: '$exception', distinctId: 'server:express-boilerplate' },
          properties
        ),
        properties.server_sig
      )
    ).toBe(true)
    expect(JSON.stringify(event)).not.toContain('user-leak@example.test')
  })

  it("attributes an authenticated request's error to the user, without a person-profile opt-out", async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const user = await createTrackedUser()

    const response = await request(probeApp())
      .get('/api/probe/me/boom')
      .set('Authorization', `Bearer ${tokenFor(user)}`)

    expect(response.status).toBe(500)
    const [event] = await sentExceptions()
    expect(event?.distinct_id).toBe(user.id)
    expect(event?.properties).not.toHaveProperty('$process_person_profile')
  })

  it("attaches the resolved tenant as the event's tenant group", async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const user = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Errors Co',
      slug: `errors-${randomUUID()}`,
      ownerId: user.id,
    })
    tenantIds.push(tenant.id)

    await request(probeApp())
      .get(`/api/probe/tenants/${tenant.slug}/boom`)
      .set('Authorization', `Bearer ${tokenFor(user)}`)

    const [event] = await sentExceptions()
    expect(event?.distinct_id).toBe(user.id)
    expect(event?.properties).toMatchObject({
      $groups: { tenant: tenant.id },
      http_route: '/api/probe/tenants/:slug/boom',
    })
  })

  it('sends a postgres.js unique violation without its row values, detail or parameters', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const existing = await createTrackedUser()

    const response = await request(probeApp()).get(
      `/api/probe/duplicate/${encodeURIComponent(existing.email)}`
    )

    expect(response.status).toBe(500)
    const [event] = await sentExceptions()
    const payload = JSON.stringify(event)
    expect(payload).not.toContain(existing.email)
    expect(payload).not.toMatch(/"(?:detail|parameters|params|query|where)"/)
  })

  it.each(['string', 'null', 'object', 'nullproto'])(
    'handles a route that throws a non-Error value (%s): 500 with an errorId, one clean $exception',
    async (kind) => {
      vi.spyOn(logger, 'error').mockImplementation(() => {})

      const response = await request(probeApp()).get(`/api/probe/throw/${kind}`)

      expect(response.status).toBe(500)
      expect((response.body as { errorId?: unknown }).errorId).toEqual(expect.any(String))
      const events = await sentExceptions()
      expect(events).toHaveLength(1)
      expect(JSON.stringify(events[0])).not.toContain('a@b.example')
    }
  )

  it('sends a deliberate 503 that wraps a cause', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    const response = await request(probeApp()).get('/api/probe/wrapped')

    expect(response.status).toBe(503)
    expect(await sentExceptions()).toHaveLength(1)
  })
})

describe('what is never sent', () => {
  it.each([
    ['an HttpError 404', 'get', '/api/probe/missing', 404],
    ['a malformed-JSON 400', 'post', '/api/probe/echo', 400],
    ['a TimelineUnavailableError with a cause', 'get', '/api/probe/timeline', 502],
    ['an HttpError 503 without a cause', 'get', '/api/probe/shutting-down', 503],
  ] as const)('%s', async (_name, method, path, status) => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const report = vi.spyOn(reporter, 'reportError')

    const pending = request(probeApp())[method](path)
    const response = await (method === 'post'
      ? pending.set('Content-Type', 'application/json').send('{"broken":')
      : pending)

    expect(response.status).toBe(status)
    expect(report).not.toHaveBeenCalled()
    expect(await sentExceptions()).toEqual([])
  })

  it('a client that aborts its request body: a 400, never reported', async () => {
    const report = vi.spyOn(reporter, 'reportError')
    const server = http.createServer(probeApp())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const status = new Promise<number>((resolve) => {
      handled.resolve = resolve
    })
    try {
      const socket = net.connect(port, '127.0.0.1')
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      socket.write(
        'POST /api/probe/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"partial":'
      )
      socket.destroy()

      expect(await status).toBe(400)
      expect(report).not.toHaveBeenCalled()
    } finally {
      handled.resolve = undefined
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('the /collect proxy', () => {
  it('answers ANALYTICS_UNCONFIGURED 503 itself, never through the reporter', async () => {
    target.projectKey = undefined
    const report = vi.spyOn(reporter, 'reportError')

    const response = await request(createApp()).post('/api/v1/collect/batch/').send('x')

    expect(response.status).toBe(503)
    expect(report).not.toHaveBeenCalled()
  })

  it('answers an unreachable upstream itself, never through the reporter', async () => {
    const unreachable = await startFakePosthog()
    await unreachable.close()
    target.host = unreachable.url
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const report = vi.spyOn(reporter, 'reportError')

    const response = await request(createApp()).post('/api/v1/collect/batch/').send('x')

    expect(response.status).toBe(504)
    expect(report).not.toHaveBeenCalled()
  })
})
