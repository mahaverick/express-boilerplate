// tests/integration/api/security-headers.test.ts
//
// helmet is mounted first in createApp(), so every response — success, 404,
// a 415 rejection, a 401 from the SSE route, and CORS preflights — carries
// the same headers. The CORS/SSE sibling-origin behaviour is covered by
// cors.test.ts and notification-stream.test.ts, which must pass unchanged:
// that is the proof `Cross-Origin-Resource-Policy: same-site` doesn't break
// the second frontend.
//
// The it.each block below only ever reaches the SSE route's 401 rejection,
// which never calls `response.writeHead` at all (see
// notification-stream.controller.ts's own header comment) — so it cannot
// prove helmet's headers, set via `setHeader` on the same response object
// before this controller runs, actually survive the controller's own
// `response.writeHead(200, {...})` call on a real 200. `writeHead` can
// overwrite headers already set on the response if the handler passes them
// again, so this needs its own case against a live, successfully-opened
// stream.
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { closeNotificationSubscriber } from '@/services/notification-emitter.service'
import { signAccessToken } from '@/services/session.service'
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
  expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
  expect(headers['x-powered-by']).toBeUndefined()
}

// One parameterized test, not five near-identical ones
// (sonarjs/parameterized-tests) — each case still pins its own request shape
// and expected status, the same convention generate-env-example.test.ts
// uses. Every case sends a different request (a plain success, a 404 that
// never reaches a router, a CSRF-gate 415, an unauthenticated SSE 401, and a
// CORS preflight) so that helmet's mount position — before every other
// middleware in app.ts — is what each one actually proves.
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

describe('security headers on a live SSE stream', () => {
  // supertest only resolves a request once its response has fully ENDED,
  // and an SSE response never ends on its own — same reason
  // notification-stream.test.ts drives its own real, ephemeral
  // `http.Server` with a plain `node:http` client instead of `request(app)`.
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
            resolve()
          } catch (error: unknown) {
            reject(error instanceof Error ? error : new Error(String(error)))
          } finally {
            // Close the still-open connection cleanly rather than letting
            // it hang for the life of the test process.
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
