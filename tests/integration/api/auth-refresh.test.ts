/**
 * @file Refresh, rotation, reuse detection, logout and cookie handling,
 * against the real per-worker Postgres database and the real compose Redis.
 * Every email is unique to the run and every row is deleted in afterEach. The
 * file lives under tests/integration/, never tests/unit/: a test that reaches
 * the database or Redis would break the pre-commit hook whenever Docker is
 * down (CLAUDE.md).
 */

import { randomUUID } from 'node:crypto'
import type { Response, Test } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REFRESH_REUSE_GRACE_MS } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken } from '@/services/session.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()
const REFRESH_TOKEN_COOKIE_NAME = testRefreshCookie().name

const VALID_PASSWORD = 'correct horse battery staple'

/**
 * A disposable email, unique to this call, so it cannot collide with rows
 * another test in this worker's database holds or, for the rate-limit tests
 * below, with keys in the shared Redis.
 * @returns The email.
 */
function uniqueEmail(): string {
  return `auth-refresh-${randomUUID()}@example.test`
}

/**
 * The envelope every controller response is wrapped in
 * (response.utilities.ts), narrowed to the fields these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
  code?: string
}

/**
 * Cast a supertest response's body to a known envelope shape.
 * @param response - The supertest response.
 * @returns The response body, typed.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * The refresh cookie's `name=value` pair from a response's `Set-Cookie`
 * header, for replaying verbatim with `.set('Cookie', ...)` on a later
 * request: replaying one specific raw token is what proves it was or was not
 * accepted.
 * @param response - The supertest response.
 * @returns The pair, or undefined if the cookie was not set.
 */
function refreshCookiePair(response: Response): string | undefined {
  const cookieLines = response.headers['set-cookie'] as string[] | undefined
  const line = cookieLines?.find((cookie) => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
  return line?.split(';', 1)[0]
}

/**
 * Register a fresh user, mark them verified, and log in through the real
 * HTTP endpoints.
 *
 * The user is looked up by address, not read from the register response,
 * which does not carry it (that would be an enumeration oracle). A helper
 * reading `registerBody.data.id` would not fail on a null there: it would
 * silently stop tracking the row and leak it into the worker's database.
 * @param createdIds - Array to push the created user's id onto, for `afterEach` cleanup.
 * @returns The login response, the email used, and the verified user row.
 */
async function registerAndLogin(
  createdIds: string[]
): Promise<{ response: Response; email: string; user: User }> {
  const email = uniqueEmail()
  await request(app).post('/api/v1/auth/register').send({ email, password: VALID_PASSWORD })
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error(`registerAndLogin: no user for ${email}`)
  createdIds.push(user.id)
  await sql`update users set email_verified_at = now() where id = ${user.id}`

  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: VALID_PASSWORD })
  return { response, email, user }
}

/**
 * Register a user through the real HTTP endpoint, look it up, track it for
 * cleanup, and mark it verified.
 *
 * Marked verified because login requires `emailVerifiedAt`: with an
 * unverified seed login would be rejected, and a before/after comparison of
 * two `null`s would look like proof that rotation does not write when it
 * only proves login never happened.
 * @param createdIds - Array to push the created user's id onto, for `afterEach` cleanup.
 * @returns The seeded (verified) user row and the email it was registered with.
 */
async function seedLoginableUser(createdIds: string[]): Promise<{ user: User; email: string }> {
  const email = uniqueEmail()
  await request(app).post('/api/v1/auth/register').send({ email, password: VALID_PASSWORD })
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error(`seedLoginableUser: no user for ${email}`)
  createdIds.push(user.id)
  await sql`update users set email_verified_at = now() where id = ${user.id}`
  const verified = await userRepository.findById(user.id)
  if (!verified) throw new Error(`seedLoginableUser: user vanished for ${email}`)
  return { user: verified, email }
}

/**
 * Push every consumed token of a user 11 s into the past, beyond `REFRESH_REUSE_GRACE_MS` (10 s), without sleeping.
 * @param userId - The user whose consumed tokens are aged.
 */
async function ageConsumedTokensPastGrace(userId: string): Promise<void> {
  expect(REFRESH_REUSE_GRACE_MS).toBeLessThan(11_000)
  await sql`
    update user_tokens set consumed_at = consumed_at - interval '11 seconds'
    where user_id = ${userId} and consumed_at is not null
  `
}

/**
 * The raw token inside a `<cookie name>=<value>` pair.
 * @param pair - A pair from `refreshCookiePair`.
 * @returns The decoded raw token.
 */
function rawTokenOf(pair: string): string {
  return decodeURIComponent(pair.slice(`${REFRESH_TOKEN_COOKIE_NAME}=`.length))
}

/**
 * Refresh and logout exercise cookie round-tripping, rotation and rate
 * limiting, which auth.test.ts's register and login tests do not.
 */
describe('POST /api/v1/auth/refresh and /logout', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  describe('refresh', () => {
    it('rotates: returns a new access/refresh pair, and the new refresh token is itself usable', async () => {
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const loginBody = envelopeOf<{ accessToken: string }>(loginResponse)
      const firstCookie = refreshCookiePair(loginResponse)
      expect(firstCookie).toBeDefined()

      const firstRefresh = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', firstCookie as string)
      const firstRefreshBody = envelopeOf<{ accessToken: string }>(firstRefresh)

      // Rotation is proven by the refresh token (secondCookie below); the access tokens are only checked to be present.
      expect(firstRefresh.status).toBe(200)
      expect(firstRefreshBody.data?.accessToken).toEqual(expect.any(String))
      expect(loginBody.data?.accessToken).toEqual(expect.any(String))

      const secondCookie = refreshCookiePair(firstRefresh)
      expect(secondCookie).toBeDefined()
      expect(secondCookie).not.toBe(firstCookie)

      // The new refresh token must itself be live — rotation produces a working credential, not a dead end.
      const secondRefresh = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', secondCookie as string)
      expect(secondRefresh.status).toBe(200)
    })

    it('invalidates the old refresh token: presenting it again after the grace window fails', async () => {
      const { response: loginResponse, user } = await registerAndLogin(createdIds)
      const originalCookie = refreshCookiePair(loginResponse) as string

      const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', originalCookie)
      expect(rotated.status).toBe(200)
      await ageConsumedTokensPastGrace(user.id)

      const replayed = await request(app).post('/api/v1/auth/refresh').set('Cookie', originalCookie)
      expect(replayed.status).toBe(401)
    })

    it('answers two concurrent refreshes with the same cookie with 200 each, and both new tokens refresh once', async () => {
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const cookie = refreshCookiePair(loginResponse) as string

      const [first, second] = await Promise.all([
        request(app).post('/api/v1/auth/refresh').set('Cookie', cookie),
        request(app).post('/api/v1/auth/refresh').set('Cookie', cookie),
      ])
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)

      const firstNext = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', refreshCookiePair(first) as string)
      const secondNext = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', refreshCookiePair(second) as string)
      expect(firstNext.status).toBe(200)
      expect(secondNext.status).toBe(200)
    })

    it('answers a rotated cookie replayed within the grace window with a working sibling token', async () => {
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const original = refreshCookiePair(loginResponse) as string

      const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', original)
      expect(rotated.status).toBe(200)
      const replayed = await request(app).post('/api/v1/auth/refresh').set('Cookie', original)
      expect(replayed.status).toBe(200)

      const sibling = refreshCookiePair(replayed) as string
      expect(sibling).not.toBe(refreshCookiePair(rotated))
      const siblingNext = await request(app).post('/api/v1/auth/refresh').set('Cookie', sibling)
      const rotatedNext = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', refreshCookiePair(rotated) as string)
      expect(siblingNext.status).toBe(200)
      expect(rotatedNext.status).toBe(200)
    })

    it('revokes every token in the session when a rotated cookie is replayed after the grace window', async () => {
      const { response: loginResponse, user } = await registerAndLogin(createdIds)
      const original = refreshCookiePair(loginResponse) as string
      const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', original)
      expect(rotated.status).toBe(200)
      await ageConsumedTokensPastGrace(user.id)

      const replayed = await request(app).post('/api/v1/auth/refresh').set('Cookie', original)
      expect(replayed.status).toBe(401)
      const legitimate = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', refreshCookiePair(rotated) as string)
      expect(legitimate.status).toBe(401)
    })

    it('refuses a rotated cookie replayed within the grace window once the session is logged out', async () => {
      // The only case where isSessionKilled decides: consumed seconds ago, but the session was logged out.
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const original = refreshCookiePair(loginResponse) as string
      const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', original)
      expect(rotated.status).toBe(200)
      const loggedOut = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', refreshCookiePair(rotated) as string)
      expect(loggedOut.status).toBe(200)

      const replayed = await request(app).post('/api/v1/auth/refresh').set('Cookie', original)
      expect(replayed.status).toBe(401)
    })

    // After a COOKIE_DOMAIN change the browser holds two refresh cookies (one per domain scope) and sends the older one first (RFC 6265 §5.4).
    it('reads the last of two refreshToken cookies: a stale one first does not revoke the live session', async () => {
      const { response: loginResponse, user } = await registerAndLogin(createdIds)
      const stale = refreshCookiePair(loginResponse) as string
      const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', stale)
      expect(rotated.status).toBe(200)
      const live = refreshCookiePair(rotated) as string
      await ageConsumedTokensPastGrace(user.id)

      const both = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${stale}; ${live}`)
      expect(both.status).toBe(200)
      const next = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', refreshCookiePair(both) as string)
      expect(next.status).toBe(200)
    })

    it('rejects a refresh request with no cookie at all', async () => {
      const response = await request(app).post('/api/v1/auth/refresh')
      expect(response.status).toBe(401)
    })

    it('does not record lastLoggedInAt on refresh — a rotation is not a sign-in', async () => {
      const { user, email } = await seedLoginableUser(createdIds)
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: VALID_PASSWORD })
      expect(login.status).toBe(200)
      const before = await userRepository.findById(user.id)
      // Without this, a before/after comparison of two nulls (e.g. login itself failing) would look identical to proof that refresh doesn't write.
      expect(before?.lastLoggedInAt).toBeInstanceOf(Date)

      await request(app)
        .post('/api/v1/auth/refresh')
        // The `name=value` pair taken from login's Set-Cookie, not a hand-built cookie.
        .set('Cookie', refreshCookiePair(login) as string)

      const after = await userRepository.findById(user.id)
      expect(after?.lastLoggedInAt?.getTime()).toBe(before?.lastLoggedInAt?.getTime())
    })
  })

  describe('logout', () => {
    it('revokes the session: a subsequent refresh with that token fails', async () => {
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const cookie = refreshCookiePair(loginResponse) as string

      const logoutResponse = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)
      expect(logoutResponse.status).toBe(200)

      const refreshAfterLogout = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
      expect(refreshAfterLogout.status).toBe(401)
    })

    it('clears the refresh-token cookie in its own response', async () => {
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const cookie = refreshCookiePair(loginResponse) as string

      const logoutResponse = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)

      expect(refreshCookiePair(logoutResponse)).toBe(`${REFRESH_TOKEN_COOKIE_NAME}=`)
    })

    it('revokes the session of the last of two refreshToken cookies', async () => {
      const { response: firstLogin, email } = await registerAndLogin(createdIds)
      const stale = refreshCookiePair(firstLogin) as string
      await request(app).post('/api/v1/auth/logout').set('Cookie', stale)
      const secondLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: VALID_PASSWORD })
      const live = refreshCookiePair(secondLogin) as string

      const loggedOut = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', `${stale}; ${live}`)
      expect(loggedOut.status).toBe(200)

      const [row] = await sql<{ isRevoked: boolean }[]>`
        select revoked_at is not null as "isRevoked" from user_tokens
        where token_hash = ${hashToken(rawTokenOf(live))}
      `
      expect(row?.isRevoked).toBe(true)
    })

    it('succeeds even with no refresh cookie at all — logout never leaks whether a token was live', async () => {
      const response = await request(app).post('/api/v1/auth/logout')
      expect(response.status).toBe(200)
    })

    it('answers the no-content envelope, with data: null', async () => {
      const response = await request(app).post('/api/v1/auth/logout')

      expect(response.body).toEqual({
        success: true,
        message: 'Logged out.',
        statusCode: 200,
        // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
        data: null,
      })
    })

    it('answers identically for an already-revoked token as for one that never existed', async () => {
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const cookie = refreshCookiePair(loginResponse) as string
      await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)

      // Both the same already-revoked token and one that never existed must simply succeed — a caller cannot use logout's response to test whether a raw token was ever live.
      const secondLogout = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)
      const forgedLogout = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${'a'.repeat(64)}`)

      expect(secondLogout.status).toBe(200)
      expect(forgedLogout.status).toBe(200)
    })
  })

  /**
   * SameSite=Strict does not stop a sibling subdomain (same site, other
   * origin) from making the browser POST here with the cookie attached.
   */
  describe('the Origin check on refresh and logout', () => {
    const SIBLING = 'https://blog.example.test'

    it('refuses a refresh from a disallowed Origin 403, and the session still refreshes', async () => {
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const cookie = refreshCookiePair(loginResponse) as string

      const refused = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', SIBLING)
        .set('Sec-Fetch-Site', 'same-site')
        .set('Cookie', cookie)
      expect(refused.status).toBe(403)
      expect(envelopeOf(refused).code).toBe('ORIGIN_NOT_ALLOWED')
      expect(refreshCookiePair(refused)).toBeUndefined()

      const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)
      expect(refreshed.status).toBe(200)
    })

    it('refuses a logout from a disallowed Origin 403, and the session survives', async () => {
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const cookie = refreshCookiePair(loginResponse) as string

      const refused = await request(app)
        .post('/api/v1/auth/logout')
        .set('Origin', SIBLING)
        .set('Sec-Fetch-Site', 'same-site')
        .set('Cookie', cookie)
      expect(refused.status).toBe(403)
      expect(envelopeOf(refused).code).toBe('ORIGIN_NOT_ALLOWED')

      const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)
      expect(refreshed.status).toBe(200)
    })

    it('answers WEB_URL, a same-origin browser request and a request with no Origin as before', async () => {
      const { response: loginResponse } = await registerAndLogin(createdIds)
      const first = refreshCookiePair(loginResponse) as string

      const fromWebUrl = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', first)
      expect(fromWebUrl.status).toBe(200)
      const second = refreshCookiePair(fromWebUrl) as string

      const sameOrigin = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', 'http://localhost:8088')
        .set('Sec-Fetch-Site', 'same-origin')
        .set('Cookie', second)
      expect(sameOrigin.status).toBe(200)
      const third = refreshCookiePair(sameOrigin) as string

      const loggedOut = await request(app).post('/api/v1/auth/logout').set('Cookie', third)
      expect(loggedOut.status).toBe(200)
      const afterLogout = await request(app).post('/api/v1/auth/refresh').set('Cookie', third)
      expect(afterLogout.status).toBe(401)
    })

    it('refuses before the limiter, so a refused request spends no refresh budget', async () => {
      const refused = await request(app).post('/api/v1/auth/refresh').set('Origin', SIBLING)
      expect(refused.status).toBe(403)
      expect(refused.headers['ratelimit-policy']).toBeUndefined()
    })
  })

  /**
   * The limiters on /register and /logout are proven wired, not proven to
   * 429: exhausting either would take 100 registrations (or 300 logouts) from
   * this suite's single client address, spending a budget that every
   * integration file running in parallel shares. The 429 behaviour is proven
   * with small `limit` overrides in
   * tests/unit/middlewares/rate-limit.middleware.test.ts.
   *
   * `RateLimit-*` headers are set on every response a limiter lets through,
   * not only on a 429, so their presence on an ordinary response is evidence
   * that a limiter ran.
   */
  describe('every auth route is behind a limiter (wiring, not thresholds)', () => {
    it('runs a limiter on /register — proven by the RateLimit-* headers on an ordinary response', async () => {
      // A body that fails validation reaches the limiter (which runs first) but never reaches bcrypt or the database, so the wiring proof costs nothing and creates no row to clean up.
      const response = await request(app).post('/api/v1/auth/register').send({ email: 'nope' })

      expect(response.status).toBe(400)
      expect(response.headers).toHaveProperty('ratelimit-limit')
      expect(response.headers).not.toHaveProperty('x-ratelimit-limit')
    })

    it('runs a limiter on /logout', async () => {
      const response = await request(app).post('/api/v1/auth/logout')

      expect(response.status).toBe(200)
      expect(response.headers).toHaveProperty('ratelimit-limit')
    })

    it('runs a limiter on /login and /refresh', async () => {
      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail(), password: VALID_PASSWORD })
      const refreshResponse = await request(app).post('/api/v1/auth/refresh')

      expect(loginResponse.headers).toHaveProperty('ratelimit-limit')
      expect(refreshResponse.headers).toHaveProperty('ratelimit-limit')
    })
  })

  describe('login rate limiting (end to end, against the real production limiter and real Redis)', () => {
    it('never writes the submitted address into a rate-limit key name', async () => {
      const email = uniqueEmail()

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'not-the-password' })
      expect(response.status).toBe(401)

      const client = await getRedis()
      const keys: string[] = []
      const batches = client.scanIterator({ MATCH: `${redisKey('rl')}:*`, COUNT: 500 })
      for await (const batch of batches) {
        keys.push(...batch)
      }
      expect(keys).toContain(`${redisKey('rl', 'login-account')}:${hashRateLimitIdentity(email)}`)
      expect(keys.filter((key) => key.includes(email))).toEqual([])
    })

    it('returns 429 after the configured number of attempts, with RateLimit-* headers', async () => {
      const email = uniqueEmail()
      /**
       * One login with a wrong password for this test's address.
       * @returns The pending request.
       */
      const attempt = (): Test =>
        request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password' })

      // The production limiter allows 5 attempts per 15 minutes — the first 5 fail normally (401, unknown email), the 6th is rate-limited.
      for (let index = 0; index < 5; index += 1) {
        // Sequential on purpose: attempts against one shared counter must happen one after another for the count to be deterministic.
        const response = await attempt()
        expect(response.status).toBe(401)
      }
      const limited = await attempt()

      expect(limited.status).toBe(429)
      expect(limited.headers).toHaveProperty('ratelimit-limit')
    })
  })
})
