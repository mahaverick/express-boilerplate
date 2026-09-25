// tests/integration/api/auth-refresh.test.ts
//
// Task 7's four security properties, against the real per-worker Postgres
// database and the real compose Redis — every email used here is unique to
// this run and every row created is deleted in afterEach, the same
// convention tests/integration/api/auth.test.ts already follows. This file
// lives under tests/integration/, never tests/unit/ — see CLAUDE.md's note
// on why a DB/Redis-dependent test under tests/unit/ breaks
// .husky/pre-commit whenever Docker is down.
//
// Kept as its own file rather than folded into auth.test.ts: refresh/logout
// exercise a materially different concern (cookie round-tripping, rotation,
// rate limiting) from register/login, and this file's helpers (raw cookie
// extraction, replay) have no use for that file's registration-specific
// assertions.
import { randomUUID } from 'node:crypto'
import type { Response, Test } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REFRESH_REUSE_GRACE_MS, REFRESH_TOKEN_COOKIE_NAME } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { hashToken } from '@/services/session.service'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()

const VALID_PASSWORD = 'correct horse battery staple'

/**
 * A disposable email, unique to one test run — avoids colliding with rows
 * any other test in this worker's shared database (or, for the rate-limit
 * test below, the shared Redis instance) may be holding onto.
 * @returns An email guaranteed unique to this call.
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
 * The exact `name=value` pair for the refresh-token cookie out of a
 * response's raw `Set-Cookie` header — suitable for replaying verbatim via
 * `.set('Cookie', ...)` on a LATER, unrelated request, which is what proves
 * a specific raw token was (or was not) accepted, independent of whatever
 * cookie a test's own supertest call would otherwise be carrying.
 * @param response - The supertest response.
 * @returns The `refreshToken=...` pair, or undefined if the cookie was not set.
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
 * Looked up by address rather than read out of the register response body.
 * register's response does not carry the user any more (it would be an
 * enumeration oracle), and a helper that reads `registerBody.data.id`
 * does not FAIL when that becomes null — it silently stops tracking the
 * row and leaks it into the shared worker database.
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
 * Own copy of auth.test.ts's helper of the same name, not a shared import:
 * this file's helpers take `createdIds` as a parameter (see
 * `registerAndLogin` above) rather than closing over a describe-scoped
 * array, so the signature follows this file's own convention instead of
 * the other file's.
 *
 * Marked verified even though nothing checks it yet — a later task adds
 * the email-verification gate to login, and a helper that marks from the
 * start means a test built on it keeps testing what it claims to test
 * instead of quietly starting to pass for the wrong reason (login itself
 * getting rejected pre-gate would make a before/after comparison of two
 * `null`s look like proof rotation doesn't write, when it would really be
 * proof login never happened).
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
 * Push every consumed token of a user 11s into the past, beyond REFRESH_REUSE_GRACE_MS, without sleeping.
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
 * The raw token inside a `refreshToken=<value>` pair.
 * @param pair - A pair from `refreshCookiePair`.
 * @returns The decoded raw token.
 */
function rawTokenOf(pair: string): string {
  return decodeURIComponent(pair.slice(`${REFRESH_TOKEN_COOKIE_NAME}=`.length))
}

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

      // The access token is NOT asserted to differ from login's: signing is
      // deterministic (jsonwebtoken, same secret/payload/second-granularity
      // `iat`), so two tokens issued for the same user within the same
      // second are legitimately byte-identical — that would make this
      // assertion flaky, not meaningful. What "a new pair" actually means
      // here, and what's worth proving, is the REFRESH token: a freshly
      // rotated, different raw value (asserted below via `secondCookie`).
      expect(firstRefresh.status).toBe(200)
      expect(firstRefreshBody.data?.accessToken).toEqual(expect.any(String))
      expect(loginBody.data?.accessToken).toEqual(expect.any(String))

      const secondCookie = refreshCookiePair(firstRefresh)
      expect(secondCookie).toBeDefined()
      expect(secondCookie).not.toBe(firstCookie)

      // The NEW refresh token must itself be live — rotation produces a
      // working credential, not a dead end.
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

    // After a COOKIE_DOMAIN change the browser holds two refreshToken cookies
    // (one per domain scope) and sends the older one first (RFC 6265 §5.4).
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
      // Without this, a before/after comparison of two `null`s (e.g. login
      // itself failing) would look identical to proof that refresh doesn't
      // write — pin that login actually recorded a sign-in first.
      expect(before?.lastLoggedInAt).toBeInstanceOf(Date)

      await request(app)
        .post('/api/v1/auth/refresh')
        // The raw Set-Cookie line, replayable verbatim — this file's own
        // helper, not a hand-built cookie.
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

      // Logging out again with the SAME (already-revoked) token, and with a
      // token that never existed, must both simply succeed — a caller
      // cannot use logout's response to test whether a given raw token was
      // ever live.
      const secondLogout = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)
      const forgedLogout = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${'a'.repeat(64)}`)

      expect(secondLogout.status).toBe(200)
      expect(forgedLogout.status).toBe(200)
    })
  })

  // The production limiters on /register and /logout are proven WIRED here,
  // not proven to 429 here: exhausting either would take 100 registrations
  // (or 300 logouts) from this suite's single client address, spending a
  // budget every other integration file running in parallel shares — the
  // exact cross-test coupling tests/helpers/global-setup.ts's Redis flush
  // exists to keep out of this suite. The 429 behaviour itself is proven
  // against the same factories, with small `limit` overrides, in
  // tests/unit/middlewares/rate-limit.middleware.test.ts.
  //
  // `RateLimit-*` headers are set by express-rate-limit on EVERY response it
  // lets through, not only on a 429 (standardHeaders: true, verified
  // empirically), so their presence on an ordinary response is exactly the
  // evidence that a limiter ran. Red proof: delete `createRegisterRateLimiter()`
  // from auth.routes.ts and this goes from green to red.
  describe('every auth route is behind a limiter (wiring, not thresholds)', () => {
    it('runs a limiter on /register — proven by the RateLimit-* headers on an ordinary response', async () => {
      // A body that fails validation: this reaches the limiter (which runs
      // first) but never reaches bcrypt or the database, so the wiring
      // proof costs nothing and creates no row to clean up.
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
    it('returns 429 after the configured number of attempts, with RateLimit-* headers', async () => {
      const email = uniqueEmail()
      const attempt = (): Test =>
        request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password' })

      // The production limiter allows 5 attempts per 15 minutes
      // (rate-limit.middleware.ts) — the first 5 fail normally (401,
      // unknown email), the 6th is rate-limited.
      for (let index = 0; index < 5; index += 1) {
        // Sequential on purpose: attempts against one shared counter must
        // happen one after another, not concurrently, for the count to be
        // deterministic.
        const response = await attempt()
        expect(response.status).toBe(401)
      }
      const limited = await attempt()

      expect(limited.status).toBe(429)
      expect(limited.headers).toHaveProperty('ratelimit-limit')
    })
  })
})
