/**
 * @file Step-up by a fresh Google login. `POST /api/v1/auth/step-up/google/start`
 * stores the step-up intent in the OAuth session; the popup's
 * `GET /api/v1/auth/step-up/google` sends it to Google with `max_age=0`,
 * `prompt=select_account` and the `openid` scope; the shared callback then
 * checks the ID token (`iss`, `aud`, `sub`, a fresh `auth_time`) and the
 * linked Google identity, moves the session's `authenticated_at` and lands
 * the popup on Apex's confirm page. It never sets a refresh cookie or issues
 * a session, and every refusal lands on `?error=step_up_failed` with
 * `auth.step_up_refused` audited. Google is never called: the callback runs
 * a fake strategy (`tests/helpers/fake-google.ts`) with an ID token each test
 * builds, and a supertest agent carries the OAuth session cookie.
 */
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { configurePassport } from '@/configs/passport.config'
import { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { verifyAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  FakeGoogleSuccessStrategy,
  fakeIdToken,
  type FakeIdTokenClaims,
} from '../../helpers/fake-google'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff } from '../../helpers/platform-staff'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { agent, request } from '../../helpers/request'
import { clearRateLimiter, signInByLink } from '../../helpers/sign-in'

// Before any import reads the environment: getEnv() memoises its first parse, and the Google routes mount only with these set.
vi.hoisted(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret')
  vi.stubEnv('APEX_URL', 'http://localhost:5174')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

const APEX = 'http://localhost:5174'
const CLIENT_ID = 'test-google-client-id'
const STEP_UP_FAILED = `${APEX}/auth/confirm?error=step_up_failed`
const CONFIRMED = `${APEX}/auth/confirm?result=confirmed`

const app = createApp()
const refreshCookieName = testRefreshCookie().name

/**
 * Every address this file created, for `afterEach` to delete.
 */
const usedEmails: string[] = []

beforeEach(async () => {
  await clearRateLimiter('sign-in-link-verify')
})

afterEach(async () => {
  configurePassport()
  await truncateAuditLogs()
  if (usedEmails.length === 0) return
  await sql`delete from users where email = any(${usedEmails})`
  usedEmails.length = 0
})

/**
 * A signed-in staff member: the user, the Google `sub` linked to it (empty
 * when none is), the bearer token, its session id, the refresh cookie, and
 * a browser holding the OAuth session cookie.
 */
interface StaffSession {
  userId: string
  email: string
  googleSub: string
  token: string
  sid: string
  refreshCookie: string
  browser: ReturnType<typeof agent>
}

/**
 * A verified staff account, with a linked Google identity unless told
 * otherwise, signed in to Apex by a real link.
 * @param options - `withGoogle: false` leaves Google unlinked.
 * @param options.withGoogle - Whether to link a Google identity.
 * @returns The session.
 */
async function signedInStaff(options: { withGoogle?: boolean } = {}): Promise<StaffSession> {
  const email = `step-up-google-${randomUUID()}@example.test`
  usedEmails.push(email)
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, email_verified_at) values (${email}, now()) returning id
  `
  if (!user) throw new Error('signedInStaff: no row')
  await makeStaff(user.id, 'viewer')
  const googleSub = options.withGoogle === false ? '' : `google-${randomUUID()}`
  if (googleSub !== '') {
    await sql`
      insert into auth_providers (user_id, provider, provider_id)
      values (${user.id}, 'google', ${googleSub})
    `
  }
  const session = await signInByLink(email, 'apex')
  const verified = verifyAccessToken(session.accessToken)
  if (!verified.ok || verified.payload.sid === undefined) throw new Error('no sid')
  return {
    userId: user.id,
    email,
    googleSub,
    token: session.accessToken,
    sid: verified.payload.sid,
    refreshCookie: session.refreshCookie,
    browser: agent(app),
  }
}

/**
 * Start a Google step-up as `session`, in its browser.
 * @param session - The staff session.
 * @returns The start's response.
 */
function startStepUp(session: StaffSession): Promise<Response> {
  return session.browser
    .post('/api/v1/auth/step-up/google/start')
    .set('Authorization', `Bearer ${session.token}`)
    .send({})
}

/**
 * A Google profile shaped as passport-google-oauth20 returns it.
 * @param id - The Google `sub`.
 * @param email - The address it carries.
 * @returns The profile.
 */
function profileFor(id: string, email: string): GoogleProfile {
  const now = Math.floor(Date.now() / 1000)
  return {
    provider: 'google',
    id,
    displayName: 'Step Up',
    profileUrl: `https://plus.google.com/${id}`,
    emails: [{ value: email, verified: true }],
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: id,
      iat: now,
      exp: now + 3600,
      email,
      email_verified: true,
    },
  }
}

/**
 * ID token claims Google would send for a login that just happened.
 * @param sub - The Google `sub`.
 * @returns The claims.
 */
function freshClaims(sub: string): FakeIdTokenClaims {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub,
    iat: now,
    exp: now + 3600,
    auth_time: now,
  }
}

/**
 * Make Google answer the next callback with `profile` and an ID token
 * carrying `claims`, or no ID token when `claims` is undefined.
 * @param profile - The profile.
 * @param claims - The ID token's claims.
 */
function googleAnswers(profile: GoogleProfile, claims: FakeIdTokenClaims | undefined): void {
  const idToken = claims === undefined ? undefined : fakeIdToken(claims)
  passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(profile, idToken))
}

/**
 * Make Google answer the next callback as the session's own linked account,
 * logged in just now.
 * @param session - The staff session.
 */
function googleAnswersAsLinked(session: StaffSession): void {
  googleAnswers(profileFor(session.googleSub, session.email), freshClaims(session.googleSub))
}

/**
 * Start the step-up, open the popup route, then complete the callback with
 * the fake strategy in the same browser.
 * @param session - The staff session.
 * @param profile - The profile Google answers with.
 * @param claims - The ID token's claims; undefined for no ID token.
 * @returns The callback's response.
 */
async function completeStepUp(
  session: StaffSession,
  profile: GoogleProfile,
  claims: FakeIdTokenClaims | undefined
): Promise<Response> {
  const start = await startStepUp(session)
  expect(start.status).toBe(204)
  const popup = await session.browser.get('/api/v1/auth/step-up/google')
  expect(popup.status).toBe(302)
  googleAnswers(profile, claims)
  return session.browser.get('/api/v1/auth/google/callback')
}

/**
 * Move every refresh row of a session an hour into the past.
 * @param sid - The session.
 */
async function ageSession(sid: string): Promise<void> {
  await sql`
    update user_tokens set authenticated_at = authenticated_at - interval '1 hour'
    where session_id = ${sid} and purpose = 'refresh'
  `
}

/**
 * The `authenticated_at` of a session's refresh rows, as epoch milliseconds.
 * @param sid - The session.
 * @returns One value per row.
 */
async function refreshAuthenticatedTimes(sid: string): Promise<number[]> {
  const rows = await sql<{ at: Date }[]>`
    select authenticated_at as at from user_tokens
    where session_id = ${sid} and purpose = 'refresh'
  `
  return rows.map((row) => new Date(row.at).getTime())
}

/**
 * How many refresh rows a user holds.
 * @param userId - The user.
 * @returns The count.
 */
async function refreshCount(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens where user_id = ${userId} and purpose = 'refresh'
  `
  return row?.count ?? 0
}

/**
 * The step-up audit entries about one user, oldest first.
 * @param userId - The user.
 * @returns Each entry's action and metadata.
 */
async function stepUpAudits(userId: string): Promise<{ action: string; metadata: unknown }[]> {
  return sql`
    select action, metadata from audit_logs
    where target_id = ${userId} and action like 'auth.step_up_%'
    order by occurred_at, id
  `
}

/**
 * Whether a response set the refresh cookie.
 * @param response - The response.
 * @returns True when a `Set-Cookie` line names it.
 */
function didSetRefreshCookie(response: Response): boolean {
  const lines = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? []
  return lines.some((line) => line.startsWith(`${refreshCookieName}=`))
}

/**
 * The Redis key of the OAuth session a response's `oauth.sid` cookie names.
 * @param response - A response that set the cookie.
 * @returns The key.
 * @throws {Error} When the response set no OAuth session cookie.
 */
function oauthSessionKey(response: Response): string {
  const lines = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? []
  const line = lines.find((candidate) => candidate.startsWith('oauth.sid='))
  if (line === undefined) throw new Error('no OAuth session cookie was set')
  const value = decodeURIComponent(line.slice('oauth.sid='.length).split(';', 1)[0] ?? '')
  // express-session signs the id: `s:<id>.<signature>`.
  const id = value.slice(2, value.lastIndexOf('.'))
  return `${redisKey('sess')}:${id}`
}

/**
 * The OAuth session's stored intent.
 * @param key - The session's Redis key.
 * @returns The stored `oauthIntent`, or undefined when there is none.
 */
async function storedIntent(key: string): Promise<unknown> {
  const redis = await getRedis()
  const text = await redis.get(key)
  if (text === null) return undefined
  const stored = JSON.parse(text) as { oauthIntent?: unknown }
  return stored.oauthIntent
}

describe('POST /api/v1/auth/step-up/google/start', () => {
  it('stores the step-up intent and answers 204', async () => {
    const session = await signedInStaff()
    const before = Date.now()

    const response = await startStepUp(session)

    expect(response.status).toBe(204)
    const intent = (await storedIntent(oauthSessionKey(response))) as Record<string, unknown>
    expect(intent).toEqual({
      kind: 'step_up',
      userId: session.userId,
      sessionId: session.sid,
      startedAt: expect.any(Number) as number,
    })
    expect(intent.startedAt).toBeGreaterThanOrEqual(before)
    expect(intent.startedAt).toBeLessThanOrEqual(Date.now())
  })

  it('asks a token without sid to refresh (401 ACCESS_TOKEN_EXPIRED)', async () => {
    const session = await signedInStaff()
    const sidLess = jwt.sign({ sub: session.userId }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    const response = await session.browser
      .post('/api/v1/auth/step-up/google/start')
      .set('Authorization', `Bearer ${sidLess}`)
      .send({})

    expect(response.status).toBe(401)
    expect((response.body as { code?: string }).code).toBe('ACCESS_TOKEN_EXPIRED')
  })

  it('refuses start with 409 google_not_linked for an account without Google', async () => {
    const session = await signedInStaff({ withGoogle: false })

    const response = await startStepUp(session)

    expect(response.status).toBe(409)
    expect((response.body as { code?: string }).code).toBe('google_not_linked')
  })
})

describe('GET /api/v1/auth/step-up/google', () => {
  it('redirects to Google with max_age=0, prompt=select_account and openid', async () => {
    const session = await signedInStaff()
    await startStepUp(session)

    const response = await session.browser.get('/api/v1/auth/step-up/google')

    expect(response.status).toBe(302)
    const location = new URL(response.headers.location as string)
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('max_age')).toBe('0')
    expect(location.searchParams.get('prompt')).toBe('select_account')
    expect(location.searchParams.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining(['openid', 'email', 'profile'])
    )
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(location.searchParams.get('state')).toBeTruthy()
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4040/api/v1/auth/google/callback'
    )
  })

  it('redirects GET /auth/step-up/google with no intent to the apex confirm page with error=step_up_failed', async () => {
    const response = await agent(app).get('/api/v1/auth/step-up/google')

    expect(response.status).toBe(302)
    expect(response.headers.location).toBe(STEP_UP_FAILED)
  })

  it('refuses a sign-in intent: only a started step-up opens Google from here', async () => {
    const browser = agent(app)
    await browser.get('/api/v1/auth/google?app=apex')

    const response = await browser.get('/api/v1/auth/step-up/google')

    expect(response.headers.location).toBe(STEP_UP_FAILED)
  })

  it('refuses a step-up intent older than the OAuth session lasts', async () => {
    const session = await signedInStaff()
    const start = await startStepUp(session)
    const key = oauthSessionKey(start)
    const redis = await getRedis()
    const text = (await redis.get(key)) ?? '{}'
    const stored = JSON.parse(text) as { oauthIntent: Record<string, unknown> }
    stored.oauthIntent.startedAt = Date.now() - 6 * 60 * 1000
    await redis.set(key, JSON.stringify(stored), { KEEPTTL: true })

    const response = await session.browser.get('/api/v1/auth/step-up/google')

    expect(response.headers.location).toBe(STEP_UP_FAILED)
  })

  it('leaves the sign-in Google start without max_age or a forced account choice', async () => {
    const response = await agent(app).get('/api/v1/auth/google')

    const location = new URL(response.headers.location as string)
    expect(location.searchParams.has('max_age')).toBe(false)
    expect(location.searchParams.has('prompt')).toBe(false)
  })
})

describe('GET /api/v1/auth/google/callback after a step-up start', () => {
  it('confirms on a matching sub and a fresh auth_time, minting no session', async () => {
    const session = await signedInStaff()
    await ageSession(session.sid)
    const refreshRowsBefore = await refreshCount(session.userId)
    const before = Date.now()
    const start = await startStepUp(session)
    expect(start.status).toBe(204)
    const key = oauthSessionKey(start)
    await session.browser.get('/api/v1/auth/step-up/google')
    googleAnswersAsLinked(session)

    const response = await session.browser.get('/api/v1/auth/google/callback')

    expect(response.status).toBe(302)
    expect(response.headers.location).toBe(CONFIRMED)
    expect(didSetRefreshCookie(response)).toBe(false)
    expect(await refreshCount(session.userId)).toBe(refreshRowsBefore)
    const times = await refreshAuthenticatedTimes(session.sid)
    expect(times.length).toBeGreaterThan(0)
    for (const time of times) expect(time).toBeGreaterThanOrEqual(before - 1000)
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_confirmed', metadata: { method: 'google' } },
    ])
    expect(await storedIntent(key)).toBeUndefined()

    // The real strategy on a replay: the state was spent with the intent, so nothing confirms or signs in.
    configurePassport()
    const replay = await session.browser.get(
      '/api/v1/auth/google/callback?code=replayed&state=spent'
    )
    expect(replay.status).toBe(302)
    expect(replay.headers.location).not.toBe(CONFIRMED)
    expect(didSetRefreshCookie(replay)).toBe(false)
    expect(await refreshCount(session.userId)).toBe(refreshRowsBefore)
    expect(await stepUpAudits(session.userId)).toHaveLength(1)
  })

  it('leaves the asking session signed in when the popup carries its refresh cookie', async () => {
    const session = await signedInStaff()
    const start = await startStepUp(session)
    const oauthCookie = ((start.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .map((line) => line.split(';', 1)[0] ?? '')
      .find((pair) => pair.startsWith('oauth.sid='))
    if (oauthCookie === undefined) throw new Error('no OAuth session cookie was set')
    await request(app).get('/api/v1/auth/step-up/google').set('Cookie', oauthCookie)
    googleAnswersAsLinked(session)

    const response = await request(app)
      .get('/api/v1/auth/google/callback')
      .set('Cookie', `${oauthCookie}; ${session.refreshCookie}`)

    expect(response.headers.location).toBe(CONFIRMED)
    expect(didSetRefreshCookie(response)).toBe(false)
    const [live] = await sql<{ count: number }[]>`
      select count(*)::int as count from user_tokens
      where session_id = ${session.sid} and purpose = 'refresh' and revoked_at is null
    `
    expect(live?.count).toBe(1)
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .send({})
    expect(refreshed.status).toBe(200)
  })

  it('refuses a Google account whose sub is not the linked one, even with the same email', async () => {
    const session = await signedInStaff()
    await ageSession(session.sid)
    const timesBefore = await refreshAuthenticatedTimes(session.sid)
    const otherSub = `google-${randomUUID()}`

    const response = await completeStepUp(
      session,
      profileFor(otherSub, session.email),
      freshClaims(otherSub)
    )

    expect(response.headers.location).toBe(STEP_UP_FAILED)
    expect(didSetRefreshCookie(response)).toBe(false)
    expect(await refreshAuthenticatedTimes(session.sid)).toEqual(timesBefore)
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_refused', metadata: { method: 'google' } },
    ])
  })

  it('refuses a Google account linked to another user', async () => {
    const session = await signedInStaff()
    const other = await signedInStaff()

    const response = await completeStepUp(
      session,
      profileFor(other.googleSub, other.email),
      freshClaims(other.googleSub)
    )

    expect(response.headers.location).toBe(STEP_UP_FAILED)
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_refused', metadata: { method: 'google' } },
    ])
    expect(await stepUpAudits(other.userId)).toEqual([])
  })

  it.each<[string, (sub: string) => FakeIdTokenClaims]>([
    [
      'an auth_time older than the start',
      (sub) => ({ ...freshClaims(sub), auth_time: Math.floor(Date.now() / 1000) - 3600 }),
    ],
    ['an ID token with no auth_time', (sub) => ({ ...freshClaims(sub), auth_time: undefined })],
    ['another audience', (sub) => ({ ...freshClaims(sub), aud: 'another-client-id' })],
    ['an audience list', (sub) => ({ ...freshClaims(sub), aud: [CLIENT_ID] })],
    ['another issuer', (sub) => ({ ...freshClaims(sub), iss: 'https://evil.example' })],
    [
      'an expired ID token',
      (sub) => ({ ...freshClaims(sub), exp: Math.floor(Date.now() / 1000) - 10 }),
    ],
    [
      'a token sub that is not the profile id',
      (sub) => ({ ...freshClaims(sub), sub: `${sub}-other` }),
    ],
  ])('refuses %s', async (_label, claimsFor) => {
    const session = await signedInStaff()
    await ageSession(session.sid)
    const timesBefore = await refreshAuthenticatedTimes(session.sid)

    const response = await completeStepUp(
      session,
      profileFor(session.googleSub, session.email),
      claimsFor(session.googleSub)
    )

    expect(response.headers.location).toBe(STEP_UP_FAILED)
    expect(didSetRefreshCookie(response)).toBe(false)
    expect(await refreshAuthenticatedTimes(session.sid)).toEqual(timesBefore)
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_refused', metadata: { method: 'google' } },
    ])
  })

  it.each<[string, (sub: string) => FakeIdTokenClaims]>([
    ['audience', (sub) => ({ ...freshClaims(sub), aud: [CLIENT_ID] })],
    [
      'id_token_expired',
      (sub) => ({ ...freshClaims(sub), exp: Math.floor(Date.now() / 1000) - 10 }),
    ],
    ['auth_time_missing', (sub) => ({ ...freshClaims(sub), auth_time: undefined })],
  ])('logs the refusal reason %s for the operator', async (reason, claimsFor) => {
    const warn = vi.spyOn(logger, 'warn')
    const session = await signedInStaff()

    await completeStepUp(
      session,
      profileFor(session.googleSub, session.email),
      claimsFor(session.googleSub)
    )

    expect(warn).toHaveBeenCalledWith('Google step-up refused (step_up_refused)', {
      reason,
      userId: session.userId,
    })
    warn.mockRestore()
  })

  it('accepts an auth_time within the clock skew before the start', async () => {
    const session = await signedInStaff()
    const claims = {
      ...freshClaims(session.googleSub),
      auth_time: Math.floor(Date.now() / 1000) - 30,
    }

    const response = await completeStepUp(
      session,
      profileFor(session.googleSub, session.email),
      claims
    )

    expect(response.headers.location).toBe(CONFIRMED)
  })

  it('accepts an issuer without the scheme, which Google also uses', async () => {
    const session = await signedInStaff()

    const response = await completeStepUp(session, profileFor(session.googleSub, session.email), {
      ...freshClaims(session.googleSub),
      iss: 'accounts.google.com',
    })

    expect(response.headers.location).toBe(CONFIRMED)
  })

  it('lands a denied Google consent on the confirm page with error=step_up_failed', async () => {
    const session = await signedInStaff()
    await startStepUp(session)
    await session.browser.get('/api/v1/auth/step-up/google')

    // The real strategy: Google sent the user back with an error, before any token exchange.
    const response = await session.browser.get('/api/v1/auth/google/callback?error=access_denied')

    expect(response.headers.location).toBe(STEP_UP_FAILED)
    expect(didSetRefreshCookie(response)).toBe(false)
    expect(await stepUpAudits(session.userId)).toEqual([])
  })

  it('refuses a callback with no ID token', async () => {
    const session = await signedInStaff()

    const response = await completeStepUp(
      session,
      profileFor(session.googleSub, session.email),
      undefined
    )

    expect(response.headers.location).toBe(STEP_UP_FAILED)
    expect(didSetRefreshCookie(response)).toBe(false)
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_refused', metadata: { method: 'google' } },
    ])
  })

  it('refuses an ID token that is not a JWT', async () => {
    const session = await signedInStaff()
    await startStepUp(session)
    await session.browser.get('/api/v1/auth/step-up/google')
    passport.use(
      GOOGLE_STRATEGY_NAME,
      new FakeGoogleSuccessStrategy(profileFor(session.googleSub, session.email), 'not-a-jwt')
    )

    const response = await session.browser.get('/api/v1/auth/google/callback')

    expect(response.headers.location).toBe(STEP_UP_FAILED)
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_refused', metadata: { method: 'google' } },
    ])
  })

  it('refuses when the session ended between start and callback', async () => {
    const session = await signedInStaff()
    const start = await startStepUp(session)
    expect(start.status).toBe(204)
    await session.browser.get('/api/v1/auth/step-up/google')
    const logout = await agent(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', session.refreshCookie)
      .send({})
    expect(logout.status).toBe(200)
    googleAnswersAsLinked(session)

    const response = await session.browser.get('/api/v1/auth/google/callback')

    expect(response.headers.location).toBe(STEP_UP_FAILED)
    expect(didSetRefreshCookie(response)).toBe(false)
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_refused', metadata: { method: 'google' } },
    ])
  })

  it('refuses a caller who lost the platform role between start and callback', async () => {
    const session = await signedInStaff()
    const start = await startStepUp(session)
    expect(start.status).toBe(204)
    await sql`delete from user_memberships where user_id = ${session.userId}`
    await ageSession(session.sid)
    const timesBefore = await refreshAuthenticatedTimes(session.sid)
    googleAnswersAsLinked(session)

    const response = await session.browser.get('/api/v1/auth/google/callback')

    expect(response.headers.location).toBe(STEP_UP_FAILED)
    expect(didSetRefreshCookie(response)).toBe(false)
    expect(await refreshAuthenticatedTimes(session.sid)).toEqual(timesBefore)
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_refused', metadata: { method: 'google' } },
    ])
  })

  it('refuses a caller demoted while the confirm waits for the user-row lock', async () => {
    const session = await signedInStaff()
    const start = await startStepUp(session)
    expect(start.status).toBe(204)
    await ageSession(session.sid)
    const timesBefore = await refreshAuthenticatedTimes(session.sid)
    googleAnswersAsLinked(session)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realLock = UserRepository.prototype.lockById
    const demoted = { done: false }
    /**
     * Stands in for `UserRepository.lockById`: the demotion commits on another connection just before the confirm's lock.
     */
    const demotingLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
      const [id, mode] = arguments_
      if (mode === 'no key update' && id === session.userId && !demoted.done) {
        demoted.done = true
        await sql`delete from user_memberships where user_id = ${session.userId}`
      }
      return realLock.apply(this, arguments_)
    }

    let location: string | undefined
    await withMutatedMethod(UserRepository.prototype, 'lockById', demotingLock, async () => {
      const response = await session.browser.get('/api/v1/auth/google/callback')
      location = response.headers.location
    })

    expect(demoted.done).toBe(true)
    expect(location).toBe(STEP_UP_FAILED)
    expect(await refreshAuthenticatedTimes(session.sid)).toEqual(timesBefore)
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_refused', metadata: { method: 'google' } },
    ])
  })

  it('never reads a tampered step-up intent as a sign-in', async () => {
    const session = await signedInStaff()
    const start = await startStepUp(session)
    const key = oauthSessionKey(start)
    const redis = await getRedis()
    const text = (await redis.get(key)) ?? '{}'
    const stored = JSON.parse(text) as Record<string, unknown>
    stored.oauthIntent = { kind: 'step_up', userId: 7 }
    await redis.set(key, JSON.stringify(stored), { KEEPTTL: true })
    googleAnswersAsLinked(session)
    const refreshRowsBefore = await refreshCount(session.userId)

    const response = await session.browser.get('/api/v1/auth/google/callback')

    expect(response.headers.location).toBe(STEP_UP_FAILED)
    expect(didSetRefreshCookie(response)).toBe(false)
    expect(await refreshCount(session.userId)).toBe(refreshRowsBefore)
  })

  it('leaves a normal Google sign-in untouched after an abandoned step-up start', async () => {
    const session = await signedInStaff()
    const start = await startStepUp(session)
    expect(start.status).toBe(204)
    await session.browser.get('/api/v1/auth/google?app=apex')
    googleAnswersAsLinked(session)

    const response = await session.browser.get('/api/v1/auth/google/callback')

    expect(response.headers.location).toBe(`${APEX}/auth/callback`)
    expect(didSetRefreshCookie(response)).toBe(true)
    expect(await stepUpAudits(session.userId)).toEqual([])
  })
})
