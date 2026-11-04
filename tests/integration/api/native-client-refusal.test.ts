/**
 * @file The refusals `resolveClientKind` makes on the auth router: a native
 * request with browser headers and a web request with a refresh token in its
 * body both answer 400 before any limiter or session is touched, and CORS
 * never allows `x-client` from a page.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { request } from '../../helpers/request'
import { clearRateLimiter, signInByLink } from '../../helpers/sign-in'

const app = createApp()

/**
 * The `signInLinkVerify` budget left after one plain probe, which spends 1.
 * @returns The `RateLimit-Remaining` value the probe answered.
 */
async function remainingAfterProbe(): Promise<number> {
  const response = await request(app).post('/api/v1/auth/link/verify').send({})
  return Number(response.headers['ratelimit-remaining'])
}

describe('native client refusal', () => {
  beforeEach(async () => {
    await clearRateLimiter(RATE_LIMITS.signInLinkVerify.name)
  })

  afterEach(async () => {
    await clearRateLimiter(RATE_LIMITS.signInLinkVerify.name)
  })

  it('refuses a native request with an Origin and spends no limiter budget', async () => {
    const before = await remainingAfterProbe()

    const refused = await request(app)
      .post('/api/v1/auth/link/verify')
      .set('X-Client', 'native')
      .set('Origin', 'https://example.com')
      .send({})
    const after = await remainingAfterProbe()

    expect(refused.status).toBe(400)
    expect((refused.body as { code: string }).code).toBe('NATIVE_CLIENT_REFUSED')
    expect(refused.headers['ratelimit-remaining']).toBeUndefined()
    // Each plain probe spends 1, so a refused request that spent anything would make this 2.
    expect(before - after).toBe(1)
  })

  it('refuses a web refresh with a refresh token in the body and keeps the session', async () => {
    const { refreshCookie } = await signInByLink(`native-refusal-${randomUUID()}@example.test`)

    const refused = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie)
      .send({ refreshToken: 'a'.repeat(64) })
    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', refreshCookie)

    expect(refused.status).toBe(400)
    expect((refused.body as { code: string }).code).toBe('REFRESH_TOKEN_IN_BODY')
    expect(refreshed.status).toBe(200)
  })

  it('does not let a page ask for x-client in a preflight', async () => {
    const response = await request(app)
      .options('/api/v1/auth/refresh')
      .set('Origin', process.env.WEB_URL ?? 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-client,content-type')

    const allowed = response.headers['access-control-allow-headers']?.toLowerCase() ?? ''
    expect(allowed.split(',').map((name) => name.trim())).not.toContain('x-client')
  })
})
