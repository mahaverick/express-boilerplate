// tests/integration/api/security-headers.test.ts
//
// helmet is mounted first in createApp(), so every response — success, 404,
// a 415 rejection, a 401 from the SSE route, and CORS preflights — carries
// the same headers. The CORS/SSE sibling-origin behaviour is covered by
// cors.test.ts and notification-stream.test.ts, which must pass unchanged:
// that is the proof `Cross-Origin-Resource-Policy: same-site` doesn't break
// the second frontend.
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'

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
