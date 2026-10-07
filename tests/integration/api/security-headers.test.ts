/**
 * @file helmet is mounted first in createApp(), so every response —
 * success, 404, a 415 rejection, a 401 from the SSE route, and CORS
 * preflights — carries the same headers. The CORS/SSE sibling-origin
 * behaviour is covered by cors.test.ts and notification-stream.test.ts,
 * which must pass unchanged: that is the proof
 * `Cross-Origin-Resource-Policy: same-site` doesn't break the second
 * frontend.
 */

import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { closeNotificationSubscriber } from '@/services/notification-emitter.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  TEST_PASSWORD,
  tokenFor,
} from '../../helpers/platform-users'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'

const app = createApp()

/**
 * Assert the helmet header set configured in helmet.config.ts.
 * @param headers - The supertest response headers.
 */
function expectSecurityHeaders(headers: Record<string, string | undefined>): void {
  expect(headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'")
  expect(headers['cross-origin-resource-policy']).toBe('same-site')
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['x-content-type-options']).toBe('nosniff')
  // HSTS belongs to the TLS-terminating edge, never this API.
  expect(headers['strict-transport-security']).toBeUndefined()
  expect(headers['x-powered-by']).toBeUndefined()
}

/**
 * One parameterized test, not five near-identical ones
 * (sonarjs/parameterized-tests) — each case still pins its own request
 * shape and expected status, the same convention
 * generate-env-example.test.ts uses. Every case sends a different
 * request (a plain success, a 404 that never reaches a router, a
 * CSRF-gate 415, an unauthenticated SSE 401, and a CORS preflight) so
 * that helmet's mount position — before every other middleware in
 * app.ts — is what each one actually proves.
 */
describe('security headers', () => {
  it.each([
    {
      description: 'are set on GET /health',
      makeRequest: () => request(app).get('/health'),
      expectedStatus: 200,
    },
    {
      description: 'are set on a 404',
      makeRequest: () => request(app).get('/api/v1/does-not-exist'),
      expectedStatus: 404,
    },
    {
      description: 'are set on a 415 rejection from the auth routes',
      makeRequest: () =>
        request(app).post('/api/v1/auth/login').type('form').send('email=a@example.com&password=x'),
      expectedStatus: 415,
    },
    {
      description: 'are set on the SSE route even when it rejects an unauthenticated request',
      makeRequest: () => request(app).get('/api/v1/notifications/stream'),
      expectedStatus: 401,
    },
    {
      description: 'are set on a CORS preflight',
      makeRequest: () =>
        request(app)
          .options('/api/v1/auth/login')
          .set('Origin', process.env.WEB_URL ?? 'http://localhost:5173')
          .set('Access-Control-Request-Method', 'POST'),
      expectedStatus: 204,
    },
  ])('$description', async ({ makeRequest, expectedStatus }) => {
    const response = await makeRequest()
    expect(response.status).toBe(expectedStatus)
    expectSecurityHeaders(response.headers)
  })
})

/**
 * The it.each block above only ever reaches the SSE route's 401
 * rejection, which never calls `response.writeHead` at all (see
 * notification-stream.controller.ts's own header comment) — so it
 * cannot prove helmet's headers, set via `setHeader` on the same
 * response object before this controller runs, actually survive the
 * controller's own `response.writeHead(200, {...})` call on a real
 * 200. `writeHead` can overwrite headers already set on the response
 * if the handler passes them again, so this needs its own case against
 * a live, successfully-opened stream.
 */
describe('security headers on a live SSE stream', () => {
  // supertest only resolves once a response has fully ended, and an SSE response never ends on its own, so this drives its own real, ephemeral http.Server with a plain node:http client instead of request(app).
  let server: http.Server
  let baseUrl: string
  const userRepository = new UserRepository()
  const createdUserIds: string[] = []

  beforeAll(async () => {
    server = createApp().listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // The stream it opened started this process's subscriber.
    await closeNotificationSubscriber()
    if (createdUserIds.length > 0) {
      await sql`delete from users where id = any(${createdUserIds})`
    }
  })

  it('survive response.writeHead(200, ...) on a real, successfully-opened stream', async () => {
    const user = await userRepository.create({
      email: `security-headers-sse-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    const token = signAccessToken(user, randomUUID())

    await new Promise<void>((resolve, reject) => {
      const streamRequest = http.get(
        `${baseUrl}/api/v1/notifications/stream`,
        { headers: { Authorization: `Bearer ${token}` } },
        (response) => {
          try {
            expect(response.statusCode).toBe(200)
            expect(response.headers['content-type']).toMatch(/^text\/event-stream/)
            expectSecurityHeaders(response.headers as Record<string, string | undefined>)
            // The stream's own header wins over the no-store requireAuth set before it.
            expect(response.headers['cache-control']).toBe('no-cache')
            resolve()
          } catch (error: unknown) {
            reject(error instanceof Error ? error : new Error(String(error)))
          } finally {
            // Close the still-open connection cleanly rather than letting it hang for the life of the test process.
            streamRequest.destroy()
          }
        }
      )
      streamRequest.on('error', () => {
        // Expected once destroy() above fires on an open connection.
      })
    })
  })
})

/**
 * Every authenticated response, and the two that carry an access token in
 * their body, are `no-store`: a revalidating policy (`no-cache`, `private`)
 * still keeps the body in the browser's disk cache, readable after sign-out.
 * Routes with their own policy keep it.
 */
describe('Cache-Control', () => {
  afterEach(async () => {
    await truncateAuditLogs()
    await deleteTrackedUsers()
  })

  it.each([
    { description: 'GET /profile', path: '/api/v1/profile' },
    { description: 'GET /tenants', path: '/api/v1/tenants' },
    { description: 'GET /notifications', path: '/api/v1/notifications' },
  ])('is no-store on an authenticated $description', async ({ path }) => {
    const user = await createTrackedUser()

    const response = await request(app)
      .get(path)
      .set('Authorization', `Bearer ${tokenFor(user)}`)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('is no-store on the staff user directory', async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await request(app)
      .get('/api/v1/platform/users')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('is no-store on a refused authenticated request', async () => {
    const response = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', 'Bearer not-a-token')

    expect(response.status).toBe(401)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('is no-store on the login and refresh responses that carry an access token', async () => {
    const user = await createTrackedUser({ hasPassword: true })

    const loggedIn = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
    expect(loggedIn.status).toBe(200)
    expect(loggedIn.headers['cache-control']).toBe('no-store')

    const cookieName = testRefreshCookie().name
    const cookie = (loggedIn.headers['set-cookie'] as string[] | undefined)
      ?.find((line) => line.startsWith(`${cookieName}=`))
      ?.split(';', 1)[0]
    expect(cookie).toBeDefined()
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie as string)
    expect(refreshed.status).toBe(200)
    expect(refreshed.headers['cache-control']).toBe('no-store')
  })

  it('keeps an authenticated GET conditional: a matching If-None-Match still answers 304', async () => {
    const user = await createTrackedUser()
    const token = tokenFor(user)
    const first = await request(app).get('/api/v1/profile').set('Authorization', `Bearer ${token}`)
    const etag = first.headers.etag
    expect(etag).toBeDefined()

    const second = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', etag as string)

    expect(second.status).toBe(304)
    expect(second.headers['cache-control']).toBe('no-store')
  })

  it('leaves the public maintenance status at public, max-age=5', async () => {
    // Other files in this worker poll the route under the same IP; start its per-IP budget afresh.
    const client = await getRedis()
    const keys: string[] = []
    const batches = client.scanIterator({ MATCH: `${redisKey('rl', 'maintenance-status')}:*` })
    for await (const batch of batches) keys.push(...batch)
    if (keys.length > 0) await client.del(keys)

    const response = await request(app).get('/api/v1/status/maintenance')

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('public, max-age=5')
  })

  it('leaves the flag read at no-store', async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await request(app)
      .get('/api/v1/platform/me/flags')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
  })
})
