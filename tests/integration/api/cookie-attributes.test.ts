/**
 * @file COOKIE_SECURE and COOKIE_DOMAIN at every site that writes an auth
 * cookie: the refresh cookie on login, refresh, logout (clear) and the
 * Google callback, and express-session's `oauth.sid`.
 *
 * The refresh cookie's name follows the deployment: refreshToken without
 * COOKIE_SECURE, __Host-refreshToken (Path=/) when secure with no
 * COOKIE_DOMAIN, __Secure-refreshToken when secure with one. A request
 * that still carries the legacy refreshToken gets it cleared. A refresh
 * answered 401 clears the cookie it read, and nothing else.
 *
 * getEnv() is a vi.fn over the real one, so each test hands the app its
 * own env without vi.resetModules(). Every test builds a fresh app:
 * createApp() reads TRUST_PROXY and the Google credentials once, and the
 * OAuth session middleware reads its cookie options once per app, on
 * first use.
 *
 * express-session gets no `proxy` option, so it sends a Secure cookie
 * only when req.secure is true (express-session index.js, issecure). The
 * Secure cases therefore run with TRUST_PROXY=1 and
 * X-Forwarded-Proto: https, and one test pins the drop when that header
 * is missing.
 */

import { randomUUID } from 'node:crypto'
import express from 'express'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { getEnv, type Env } from '@/configs/env.config'
import { GOOGLE_STRATEGY_NAME, REFRESH_REUSE_GRACE_MS } from '@/constants/auth.constants'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { resetPassword } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { getRedis, redisKey } from '@/services/redis.service'
import {
  hashToken,
  issueRefreshToken,
  issueToken,
  rotateRefreshToken,
} from '@/services/session.service'
import { parseDurationMs } from '@/utilities/duration.utilities'
import { hashPassword } from '@/utilities/password.utilities'
import { withMutatedMethod } from '../../helpers/mutate'
import { request } from '../../helpers/request'

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: vi.fn(actual.getEnv) }
})

const realEnv = getEnv()
const userRepository = new UserRepository()
const PASSWORD = 'correct horse battery staple'
const OAUTH_SESSION_COOKIE = 'oauth.sid'

const GOOGLE: Partial<Env> = {
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
}
const SECURE_SCOPED: Partial<Env> = {
  ...GOOGLE,
  COOKIE_SECURE: true,
  COOKIE_DOMAIN: 'api.example.test',
  TRUST_PROXY: '1',
}
// COOKIE_DOMAIN is unset in .env.test, so this is host-only.
const PLAIN_HOST_ONLY: Partial<Env> = { ...GOOGLE, COOKIE_SECURE: false, TRUST_PROXY: '1' }
const SECURE_HOST_ONLY: Partial<Env> = { ...GOOGLE, COOKIE_SECURE: true, TRUST_PROXY: '1' }
const PLAIN_SCOPED: Partial<Env> = {
  ...GOOGLE,
  COOKIE_SECURE: false,
  COOKIE_DOMAIN: 'api.example.test',
  TRUST_PROXY: '1',
}

const PLAIN_COOKIE = 'refreshToken'
const HOST_COOKIE = '__Host-refreshToken'
const SECURE_COOKIE = '__Secure-refreshToken'

const PATH_ROOT = /;\s*Path=\/(?:;|$)/i
const PATH_AUTH = /;\s*Path=\/api\/v1\/auth(?:;|$)/i
const HTTP_ONLY = /;\s*HttpOnly(?:;|$)/i
const SAME_SITE_STRICT = /;\s*SameSite=Strict(?:;|$)/i

const SECURE = /;\s*Secure(?:;|$)/i
const SCOPED_DOMAIN = /;\s*Domain=api\.example\.test(?:;|$)/i
const ANY_DOMAIN = /;\s*Domain=/i
const EPOCH_EXPIRY = /;\s*Expires=Thu, 01 Jan 1970/i

const createdIds: string[] = []

afterEach(async () => {
  vi.mocked(getEnv).mockReturnValue(realEnv)
  passport.unuse(GOOGLE_STRATEGY_NAME)
  if (createdIds.length === 0) return
  await sql`delete from users where id = any(${createdIds})`
  createdIds.length = 0
})

function appWith(overrides: Partial<Env>): ReturnType<typeof createApp> {
  vi.mocked(getEnv).mockReturnValue({ ...realEnv, ...overrides })
  return createApp()
}

function cookieLines(response: Response, name: string): string[] {
  const lines = response.headers['set-cookie'] as string[] | undefined
  return lines?.filter((line) => line.startsWith(`${name}=`)) ?? []
}

/**
 * The first `name` Set-Cookie line that carries Domain, else the first: a
 * response can also carry a host-only clearing line for the same name.
 * @param response - The response.
 * @param name - The cookie name.
 * @returns The matching line, or undefined.
 */
function cookieLine(response: Response, name: string): string | undefined {
  const lines = cookieLines(response, name)
  return lines.find((line) => ANY_DOMAIN.test(line)) ?? lines[0]
}

function cookiePair(line: string | undefined): string {
  const pair = line?.split(';', 1)[0]
  if (!pair) throw new Error('expected a Set-Cookie line to replay')
  return pair
}

/**
 * Assert one refresh Set-Cookie line's attributes.
 * @param line - The line.
 * @param expected - The attributes the line must carry.
 * @param expected.path - The Path pattern.
 * @param expected.isSecure - Whether the line carries Secure.
 * @param expected.domain - The Domain pattern, or undefined for none.
 */
function expectRefreshAttributes(
  line: string | undefined,
  expected: { path: RegExp; isSecure: boolean; domain: RegExp | undefined }
): void {
  expect(line).toMatch(expected.path)
  expect(line).toMatch(HTTP_ONLY)
  expect(line).toMatch(SAME_SITE_STRICT)
  if (expected.isSecure) {
    expect(line).toMatch(SECURE)
  } else {
    expect(line).not.toMatch(SECURE)
  }
  if (expected.domain) {
    expect(line).toMatch(expected.domain)
  } else {
    expect(line).not.toMatch(ANY_DOMAIN)
  }
}

/**
 * A live refresh token for the user with `email`, issued directly.
 * @param email - The user's address.
 * @returns The raw token.
 */
async function sessionFor(email: string): Promise<string> {
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error('setup: the user exists')
  const issued = await issueRefreshToken(user.id, randomUUID())
  return issued.raw
}

/**
 * Whether a token row has been consumed and whether it has been revoked.
 * @param raw - The raw token.
 * @returns The two flags, or undefined when no row has that token.
 */
async function tokenState(
  raw: string
): Promise<{ isConsumed: boolean; isRevoked: boolean } | undefined> {
  const [row] = await sql<{ isConsumed: boolean; isRevoked: boolean }[]>`
    select consumed_at is not null as "isConsumed", revoked_at is not null as "isRevoked"
    from user_tokens where token_hash = ${hashToken(raw)}
  `
  return row
}

async function createVerifiedUser(): Promise<string> {
  const email = `cookie-attributes-${randomUUID()}@example.test`
  const user = await userRepository.create({ email, passwordHash: await hashPassword(PASSWORD) })
  createdIds.push(user.id)
  await sql`update users set email_verified_at = now() where id = ${user.id}`
  return email
}

function googleProfile(email: string): GoogleProfile {
  const id = randomUUID()
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    provider: 'google',
    id,
    displayName: 'Cookie Test',
    profileUrl: `https://plus.google.com/${id}`,
    emails: [{ value: email, verified: true }],
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: id,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      email,
      email_verified: true,
    },
  }
}

/**
 * Skips the OAuth2 dance and succeeds with a fixed profile, so the
 * callback's own cookie-setting path runs over real HTTP. Same technique
 * as google-oauth.test.ts's FakeGoogleSuccessStrategy.
 */
class FakeGoogleSuccessStrategy implements passport.Strategy {
  name = GOOGLE_STRATEGY_NAME

  constructor(readonly profile: GoogleProfile) {}

  authenticate(this: passport.StrategyCreated<FakeGoogleSuccessStrategy>): void {
    // eslint-disable-next-line unicorn/no-undeclared-class-members -- passport injects `success` onto the per-request instance (StrategyCreatedStatic).
    this.success(this.profile as unknown as Express.User)
  }
}

describe('refresh cookie: name, path and domain per deployment', () => {
  it.each([
    {
      label: 'COOKIE_SECURE=false, no COOKIE_DOMAIN',
      env: PLAIN_HOST_ONLY,
      name: PLAIN_COOKIE,
      path: PATH_AUTH,
      isSecure: false,
      domain: undefined,
    },
    {
      label: 'COOKIE_SECURE=true, no COOKIE_DOMAIN',
      env: SECURE_HOST_ONLY,
      name: HOST_COOKIE,
      path: PATH_ROOT,
      isSecure: true,
      domain: undefined,
    },
    {
      label: 'COOKIE_SECURE=true with COOKIE_DOMAIN',
      env: SECURE_SCOPED,
      name: SECURE_COOKIE,
      path: PATH_AUTH,
      isSecure: true,
      domain: SCOPED_DOMAIN,
    },
  ])(
    'sets, rotates and clears $name when $label',
    async ({ env, name, path, isSecure, domain }) => {
      const app = appWith(env)
      const email = await createVerifiedUser()

      const login = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-Proto', 'https')
        .send({ email, password: PASSWORD })
      expect(login.status).toBe(200)
      const loginLines = cookieLines(login, name)
      expect(loginLines).toHaveLength(1)
      expectRefreshAttributes(loginLines[0], { path, isSecure, domain })
      expect(loginLines[0]).not.toMatch(EPOCH_EXPIRY)
      if (name !== PLAIN_COOKIE) expect(cookieLines(login, PLAIN_COOKIE)).toHaveLength(0)

      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-Proto', 'https')
        .set('Cookie', cookiePair(loginLines[0]))
      expect(refreshed.status).toBe(200)
      const rotatedLines = cookieLines(refreshed, name)
      expect(rotatedLines).toHaveLength(1)
      expectRefreshAttributes(rotatedLines[0], { path, isSecure, domain })

      const loggedOut = await request(app)
        .post('/api/v1/auth/logout')
        .set('X-Forwarded-Proto', 'https')
        .set('Cookie', cookiePair(rotatedLines[0]))
      expect(loggedOut.status).toBe(200)
      const clearedLines = cookieLines(loggedOut, name)
      expect(clearedLines).toHaveLength(1)
      // The clear must repeat Path and Domain, or the browser keeps the cookie.
      expect(clearedLines[0]).toMatch(EPOCH_EXPIRY)
      expectRefreshAttributes(clearedLines[0], { path, isSecure, domain })
    }
  )

  it('keeps Domain on the plain cookie, and clears a host-only one the request presents', async () => {
    const app = appWith(PLAIN_SCOPED)
    const email = await createVerifiedUser()

    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })
    expect(login.status).toBe(200)
    const loginLines = cookieLines(login, PLAIN_COOKIE)
    expect(loginLines).toHaveLength(1)
    expectRefreshAttributes(loginLines[0], {
      path: PATH_AUTH,
      isSecure: false,
      domain: SCOPED_DOMAIN,
    })

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookiePair(loginLines[0]))
    expect(refreshed.status).toBe(200)
    const refreshLines = cookieLines(refreshed, PLAIN_COOKIE)
    expect(refreshLines).toHaveLength(2)
    // The host-only clear comes first, so a browser that treats the two scopes as one cookie ends up with the new one.
    expect(refreshLines[0]).toMatch(EPOCH_EXPIRY)
    expect(refreshLines[0]).not.toMatch(ANY_DOMAIN)
    expect(refreshLines[1]).toMatch(SCOPED_DOMAIN)
    expect(refreshLines[1]).not.toMatch(EPOCH_EXPIRY)

    const loggedOut = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookiePair(refreshLines[1]))
    expect(loggedOut.status).toBe(200)
    const logoutLines = cookieLines(loggedOut, PLAIN_COOKIE)
    expect(logoutLines).toHaveLength(2)
    expect(logoutLines.every((line) => EPOCH_EXPIRY.test(line))).toBe(true)
    const scopedClears = logoutLines.filter((line) => SCOPED_DOMAIN.test(line))
    expect(scopedClears).toHaveLength(1)
    expectRefreshAttributes(scopedClears[0], {
      path: PATH_AUTH,
      isSecure: false,
      domain: SCOPED_DOMAIN,
    })
    const hostOnlyClears = logoutLines.filter((line) => !ANY_DOMAIN.test(line))
    expect(hostOnlyClears).toHaveLength(1)
    expectRefreshAttributes(hostOnlyClears[0], {
      path: PATH_AUTH,
      isSecure: false,
      domain: undefined,
    })
  })

  it('sends exactly one refreshToken Set-Cookie per response when COOKIE_DOMAIN is unset', async () => {
    const app = appWith(PLAIN_HOST_ONLY)
    const email = await createVerifiedUser()

    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })
    expect(cookieLines(login, PLAIN_COOKIE)).toHaveLength(1)
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookiePair(cookieLine(login, PLAIN_COOKIE)))
    expect(cookieLines(refreshed, PLAIN_COOKIE)).toHaveLength(1)
    const loggedOut = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookiePair(cookieLine(refreshed, PLAIN_COOKIE)))
    expect(cookieLines(loggedOut, PLAIN_COOKIE)).toHaveLength(1)
  })
})

describe('refresh cookie: the legacy refreshToken name', () => {
  it.each([
    { label: 'no COOKIE_DOMAIN', env: SECURE_HOST_ONLY, name: HOST_COOKIE, legacyClears: 1 },
    { label: 'COOKIE_DOMAIN', env: SECURE_SCOPED, name: SECURE_COOKIE, legacyClears: 2 },
  ])(
    'refreshes a client holding only the legacy cookie, sets $name and clears the legacy one ($label)',
    async ({ env, name, legacyClears }) => {
      const app = appWith(env)
      const email = await createVerifiedUser()
      const legacy = await sessionFor(email)

      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-Proto', 'https')
        .set('Cookie', `${PLAIN_COOKIE}=${legacy}`)

      expect(refreshed.status).toBe(200)
      const current = cookieLines(refreshed, name)
      expect(current).toHaveLength(1)
      expect(current[0]).not.toMatch(EPOCH_EXPIRY)
      const clears = cookieLines(refreshed, PLAIN_COOKIE)
      expect(clears).toHaveLength(legacyClears)
      expect(clears.every((line) => EPOCH_EXPIRY.test(line) && PATH_AUTH.test(line))).toBe(true)
      expect(clears.filter((line) => !ANY_DOMAIN.test(line))).toHaveLength(1)
      if (legacyClears === 2) {
        expect(clears.filter((line) => SCOPED_DOMAIN.test(line))).toHaveLength(1)
      }
      const legacyState = await tokenState(legacy)
      expect(legacyState?.isConsumed).toBe(true)
    }
  )

  it('uses the current cookie when a client holds both, and leaves the legacy session alone', async () => {
    const app = appWith(SECURE_HOST_ONLY)
    const email = await createVerifiedUser()
    const legacy = await sessionFor(email)
    const current = await sessionFor(email)

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `${PLAIN_COOKIE}=${legacy}; ${HOST_COOKIE}=${current}`)

    expect(refreshed.status).toBe(200)
    const currentState = await tokenState(current)
    expect(currentState?.isConsumed).toBe(true)
    expect(await tokenState(legacy)).toEqual({ isConsumed: false, isRevoked: false })
    const hostLines = cookieLines(refreshed, HOST_COOKIE)
    expect(hostLines).toHaveLength(1)
    expect(hostLines[0]).not.toMatch(EPOCH_EXPIRY)
    expect(cookieLines(refreshed, PLAIN_COOKIE)).toHaveLength(1)
  })

  it('clears both cookies on logout and revokes both sessions', async () => {
    const app = appWith(SECURE_HOST_ONLY)
    const email = await createVerifiedUser()
    const legacy = await sessionFor(email)
    const current = await sessionFor(email)

    const loggedOut = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `${PLAIN_COOKIE}=${legacy}; ${HOST_COOKIE}=${current}`)

    expect(loggedOut.status).toBe(200)
    const hostLines = cookieLines(loggedOut, HOST_COOKIE)
    expect(hostLines).toHaveLength(1)
    expect(hostLines[0]).toMatch(EPOCH_EXPIRY)
    expectRefreshAttributes(hostLines[0], { path: PATH_ROOT, isSecure: true, domain: undefined })
    const legacyLines = cookieLines(loggedOut, PLAIN_COOKIE)
    expect(legacyLines).toHaveLength(1)
    expect(legacyLines[0]).toMatch(EPOCH_EXPIRY)
    expect(legacyLines[0]).toMatch(PATH_AUTH)
    const legacyState = await tokenState(legacy)
    expect(legacyState?.isRevoked).toBe(true)
    const currentState = await tokenState(current)
    expect(currentState?.isRevoked).toBe(true)
  })

  it('two tabs presenting the same legacy cookie at once both refresh, and both get the new cookie', async () => {
    const app = appWith(SECURE_HOST_ONLY)
    const email = await createVerifiedUser()
    const legacy = await sessionFor(email)

    const send = () =>
      request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-Proto', 'https')
        .set('Cookie', `${PLAIN_COOKIE}=${legacy}`)
    const [first, second] = await Promise.all([send(), send()])

    expect([first.status, second.status]).toEqual([200, 200])
    for (const response of [first, second]) {
      const current = cookieLines(response, HOST_COOKIE)
      expect(current).toHaveLength(1)
      expect(current[0]).not.toMatch(EPOCH_EXPIRY)
    }
  })
})

describe('refresh cookie: Google callback', () => {
  it.each([
    {
      label: 'COOKIE_SECURE=true with COOKIE_DOMAIN',
      env: SECURE_SCOPED,
      name: SECURE_COOKIE,
      path: PATH_AUTH,
      isSecure: true,
      domain: SCOPED_DOMAIN,
    },
    {
      label: 'COOKIE_SECURE=true, no COOKIE_DOMAIN',
      env: SECURE_HOST_ONLY,
      name: HOST_COOKIE,
      path: PATH_ROOT,
      isSecure: true,
      domain: undefined,
    },
    {
      label: 'COOKIE_SECURE=false, host-only',
      env: PLAIN_HOST_ONLY,
      name: PLAIN_COOKIE,
      path: PATH_AUTH,
      isSecure: false,
      domain: undefined,
    },
  ])('sets $name with SameSite=Lax when $label', async ({ env, name, path, isSecure, domain }) => {
    const app = appWith(env)
    const email = `cookie-attributes-google-${randomUUID()}@example.test`
    passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(googleProfile(email)))

    const response = await request(app)
      .get('/api/v1/auth/google/callback')
      .set('X-Forwarded-Proto', 'https')

    const user = await userRepository.findByEmail(email)
    if (user) createdIds.push(user.id)
    expect(response.status).toBe(302)
    const lines = cookieLines(response, name)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/SameSite=Lax/i)
    expect(lines[0]).toMatch(path)
    expect(lines[0]).toMatch(HTTP_ONLY)
    if (isSecure) {
      expect(lines[0]).toMatch(SECURE)
    } else {
      expect(lines[0]).not.toMatch(SECURE)
    }
    if (domain) {
      expect(lines[0]).toMatch(domain)
    } else {
      expect(lines[0]).not.toMatch(ANY_DOMAIN)
    }
  })
})

describe('refresh cookie: Google callback with a legacy cookie', () => {
  it('clears a legacy refreshToken the callback request carries and sets __Host-refreshToken', async () => {
    const app = appWith(SECURE_HOST_ONLY)
    const email = `cookie-attributes-google-${randomUUID()}@example.test`
    passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(googleProfile(email)))

    const response = await request(app)
      .get('/api/v1/auth/google/callback')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `${PLAIN_COOKIE}=${'a'.repeat(64)}`)

    const user = await userRepository.findByEmail(email)
    if (user) createdIds.push(user.id)
    expect(response.status).toBe(302)
    const current = cookieLines(response, HOST_COOKIE)
    expect(current).toHaveLength(1)
    expect(current[0]).not.toMatch(EPOCH_EXPIRY)
    expect(current[0]).toMatch(/SameSite=Lax/i)
    expect(current[0]).toMatch(PATH_ROOT)
    const legacyClears = cookieLines(response, PLAIN_COOKIE)
    expect(legacyClears).toHaveLength(1)
    expect(legacyClears[0]).toMatch(EPOCH_EXPIRY)
    expect(legacyClears[0]).toMatch(PATH_AUTH)
    expect(legacyClears[0]).not.toMatch(ANY_DOMAIN)
  })
})

describe('oauth.sid (express-session)', () => {
  it('carries Secure and COOKIE_DOMAIN when COOKIE_SECURE=true and the request is https via the proxy', async () => {
    const app = appWith(SECURE_SCOPED)

    const response = await request(app).get('/api/v1/auth/google').set('X-Forwarded-Proto', 'https')

    expect(response.status).toBe(302)
    const sessionCookie = cookieLine(response, OAUTH_SESSION_COOKIE)
    expect(sessionCookie).toMatch(SECURE)
    expect(sessionCookie).toMatch(SCOPED_DOMAIN)
  })

  it('is withheld when COOKIE_SECURE=true but the request is not seen as https', async () => {
    const app = appWith(SECURE_SCOPED)

    const response = await request(app).get('/api/v1/auth/google')

    expect(response.status).toBe(302)
    expect(cookieLine(response, OAUTH_SESSION_COOKIE)).toBeUndefined()
  })

  it('has neither Secure nor Domain when COOKIE_SECURE=false and COOKIE_DOMAIN is unset', async () => {
    const app = appWith(PLAIN_HOST_ONLY)

    const response = await request(app).get('/api/v1/auth/google').set('X-Forwarded-Proto', 'https')

    expect(response.status).toBe(302)
    const sessionCookie = cookieLine(response, OAUTH_SESSION_COOKIE)
    expect(sessionCookie).toBeDefined()
    expect(sessionCookie).not.toMatch(SECURE)
    expect(sessionCookie).not.toMatch(ANY_DOMAIN)
  })
})

const NEW_PASSWORD = 'a different correct horse battery staple'

/**
 * The Cookie header a browser sends after `response`: each sent pair, minus
 * any the response cleared, with any it set in its place.
 * @param sent - The `name=value` pairs the request carried.
 * @param response - The response whose Set-Cookie lines apply.
 * @returns The next Cookie header, or undefined when no cookie is left.
 */
function cookieHeaderAfter(sent: string[], response: Response): string | undefined {
  const next = sent.flatMap((pair) => {
    const line = cookieLines(response, pair.slice(0, pair.indexOf('='))).at(-1)
    if (line === undefined) return [pair]
    return EPOCH_EXPIRY.test(line) ? [] : [cookiePair(line)]
  })
  return next.length > 0 ? next.join('; ') : undefined
}

/**
 * Every Redis key matching a pattern, via SCAN.
 * @param pattern - The glob pattern.
 * @returns The matching keys.
 */
async function redisKeysMatching(pattern: string): Promise<string[]> {
  const client = await getRedis()
  const found: string[] = []
  const batches = client.scanIterator({ MATCH: pattern, COUNT: 100 })
  for await (const keys of batches) {
    found.push(...keys)
  }
  return found
}

/**
 * The id of the user with `email`.
 * @param email - The address.
 * @returns The user's id.
 */
async function userIdFor(email: string): Promise<string> {
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error('setup: the user exists')
  return user.id
}

/**
 * The three deployments of the name, path and domain table above.
 */
const DEPLOYMENTS = [
  {
    label: 'COOKIE_SECURE=false, no COOKIE_DOMAIN',
    env: PLAIN_HOST_ONLY,
    name: PLAIN_COOKIE,
    path: PATH_AUTH,
    isSecure: false,
    domain: undefined,
  },
  {
    label: 'COOKIE_SECURE=true, no COOKIE_DOMAIN',
    env: SECURE_HOST_ONLY,
    name: HOST_COOKIE,
    path: PATH_ROOT,
    isSecure: true,
    domain: undefined,
  },
  {
    label: 'COOKIE_SECURE=true with COOKIE_DOMAIN',
    env: SECURE_SCOPED,
    name: SECURE_COOKIE,
    path: PATH_AUTH,
    isSecure: true,
    domain: SCOPED_DOMAIN,
  },
] as const

/**
 * One cookie deployment from `DEPLOYMENTS`.
 */
type Deployment = (typeof DEPLOYMENTS)[number]

/**
 * Log in, end every session with a password reset, then refresh with the
 * login's cookie.
 * @param deployment - The cookie environment.
 * @returns The app, the cookie pair the refresh presented, and its response.
 */
async function refreshAfterReset(deployment: Deployment): Promise<{
  app: ReturnType<typeof createApp>
  presented: string
  refreshed: Response
}> {
  const app = appWith(deployment.env)
  const email = await createVerifiedUser()
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('X-Forwarded-Proto', 'https')
    .send({ email, password: PASSWORD })
  expect(login.status).toBe(200)
  const presented = cookiePair(cookieLines(login, deployment.name)[0])
  const reset = await issueToken(await userIdFor(email), 'password_reset', 60_000)
  await resetPassword({ token: reset.raw, password: NEW_PASSWORD })

  const refreshed = await request(app)
    .post('/api/v1/auth/refresh')
    .set('X-Forwarded-Proto', 'https')
    .set('Cookie', presented)
  return { app, presented, refreshed }
}

/**
 * Assert that a refresh after a reset answers 401 with one clear of the
 * current cookie, carrying the path and domain it was set with.
 * @param deployment - The cookie environment.
 */
async function expectResetCookieCleared(deployment: Deployment): Promise<void> {
  const { refreshed } = await refreshAfterReset(deployment)

  expect(refreshed.status).toBe(401)
  const clears = cookieLines(refreshed, deployment.name)
  expect(clears).toHaveLength(1)
  expect(clears[0]).toMatch(EPOCH_EXPIRY)
  expectRefreshAttributes(clears[0], deployment)
  if (deployment.name !== PLAIN_COOKIE) {
    expect(cookieLines(refreshed, PLAIN_COOKIE)).toHaveLength(0)
  }
}

describe('refresh cookie: a refresh answered 401 clears the cookie it read', () => {
  it.each(DEPLOYMENTS)(
    'clears $name, as it was set, once a password reset has ended the session ($label)',
    async (deployment) => {
      await expectResetCookieCleared(deployment)
    }
  )

  // DELIBERATELY red under MUTATION_PROOF=1: with every cookie clear a no-op, the 401 carries no clearing line; unset, this test is skipped and the file is green.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the reset-clear test with the response cookie clear disabled',
    async () => {
      const skipClear = function (this: express.Response) {
        return this
      } as express.Response['clearCookie']
      await withMutatedMethod(express.response, 'clearCookie', skipClear, async () => {
        await expectResetCookieCleared(DEPLOYMENTS[0])
      })
    }
  )

  it('leaves the next request without the cookie, and that one looks up no token', async () => {
    const { app, presented, refreshed } = await refreshAfterReset(DEPLOYMENTS[0])
    expect(refreshed.status).toBe(401)
    const nextCookie = cookieHeaderAfter([presented], refreshed)
    const findByHash = vi.spyOn(UserTokenRepository.prototype, 'findByHash')
    try {
      const followUp = request(app).post('/api/v1/auth/refresh')
      const response = await (nextCookie === undefined
        ? followUp
        : followUp.set('Cookie', nextCookie))

      expect(response.status).toBe(401)
      expect((response.body as { message?: string }).message).toBe('Missing refresh token')
      expect(cookieLines(response, PLAIN_COOKIE)).toHaveLength(0)
      expect(findByHash).not.toHaveBeenCalled()
    } finally {
      findByHash.mockRestore()
    }
  })

  it.each([
    {
      label: 'an unknown token',
      message: 'Invalid refresh token',
      present: (): Promise<string> => Promise.resolve('a'.repeat(64)),
    },
    {
      label: 'an expired token',
      message: 'Refresh token expired',
      present: async (email: string): Promise<string> => {
        const raw = await sessionFor(email)
        await sql`
          update user_tokens set expires_at = now() - interval '1 minute'
          where token_hash = ${hashToken(raw)}
        `
        return raw
      },
    },
    {
      label: 'a rotated token replayed after the grace window',
      message: 'Invalid refresh token',
      present: async (email: string): Promise<string> => {
        expect(REFRESH_REUSE_GRACE_MS).toBeLessThan(11_000)
        const raw = await sessionFor(email)
        await rotateRefreshToken(raw)
        await sql`
          update user_tokens set consumed_at = consumed_at - interval '11 seconds'
          where token_hash = ${hashToken(raw)}
        `
        return raw
      },
    },
    {
      label: 'a session past its absolute lifetime',
      message: 'Refresh token expired',
      present: async (email: string): Promise<string> => {
        const absoluteTtlMs = parseDurationMs(realEnv.SESSION_ABSOLUTE_TTL)
        if (absoluteTtlMs === undefined) throw new Error('SESSION_ABSOLUTE_TTL is unparseable')
        const raw = await sessionFor(email)
        const startedAt = new Date(Date.now() - absoluteTtlMs - 60_000).toISOString()
        await sql`
          update user_tokens set session_started_at = ${startedAt}::timestamptz
          where token_hash = ${hashToken(raw)}
        `
        return raw
      },
    },
    {
      label: 'an inactive account',
      message: 'Account no longer exists or is inactive',
      present: async (email: string): Promise<string> => {
        const raw = await sessionFor(email)
        await sql`update users set active = false where lower(email) = lower(${email})`
        return raw
      },
    },
  ])('clears the cookie for $label', async ({ message, present }) => {
    const app = appWith(PLAIN_HOST_ONLY)
    const raw = await present(await createVerifiedUser())

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${PLAIN_COOKIE}=${raw}`)

    expect(refreshed.status).toBe(401)
    expect((refreshed.body as { message?: string }).message).toBe(message)
    const clears = cookieLines(refreshed, PLAIN_COOKIE)
    expect(clears).toHaveLength(1)
    expect(clears[0]).toMatch(EPOCH_EXPIRY)
    expectRefreshAttributes(clears[0], { path: PATH_AUTH, isSecure: false, domain: undefined })
  })

  it.each([
    { label: 'no COOKIE_DOMAIN', env: SECURE_HOST_ONLY, name: HOST_COOKIE, legacyClears: 1 },
    { label: 'COOKIE_DOMAIN', env: SECURE_SCOPED, name: SECURE_COOKIE, legacyClears: 2 },
  ])(
    'clears the legacy cookie in each of its forms when it was the one read ($label)',
    async ({ env, name, legacyClears }) => {
      const app = appWith(env)

      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-Proto', 'https')
        .set('Cookie', `${PLAIN_COOKIE}=${'a'.repeat(64)}`)

      expect(refreshed.status).toBe(401)
      expect(cookieLines(refreshed, name)).toHaveLength(0)
      const clears = cookieLines(refreshed, PLAIN_COOKIE)
      expect(clears).toHaveLength(legacyClears)
      expect(clears.every((line) => EPOCH_EXPIRY.test(line) && PATH_AUTH.test(line))).toBe(true)
      expect(clears.filter((line) => !ANY_DOMAIN.test(line))).toHaveLength(1)
      if (legacyClears === 2) {
        expect(clears.filter((line) => SCOPED_DOMAIN.test(line))).toHaveLength(1)
      }
    }
  )

  it('clears both scopes of the plain name when COOKIE_DOMAIN is set, since either may be the one read', async () => {
    const app = appWith(PLAIN_SCOPED)

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${PLAIN_COOKIE}=${'a'.repeat(64)}`)

    expect(refreshed.status).toBe(401)
    const clears = cookieLines(refreshed, PLAIN_COOKIE)
    expect(clears).toHaveLength(2)
    expect(clears.every((line) => EPOCH_EXPIRY.test(line) && PATH_AUTH.test(line))).toBe(true)
    expect(clears.filter((line) => SCOPED_DOMAIN.test(line))).toHaveLength(1)
    expect(clears.filter((line) => !ANY_DOMAIN.test(line))).toHaveLength(1)
  })

  it('clears only the current cookie when both came and the current one fails', async () => {
    const app = appWith(SECURE_HOST_ONLY)
    const legacy = await sessionFor(await createVerifiedUser())

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `${PLAIN_COOKIE}=${legacy}; ${HOST_COOKIE}=${'b'.repeat(64)}`)

    expect(refreshed.status).toBe(401)
    const hostLines = cookieLines(refreshed, HOST_COOKIE)
    expect(hostLines).toHaveLength(1)
    expect(hostLines[0]).toMatch(EPOCH_EXPIRY)
    expectRefreshAttributes(hostLines[0], { path: PATH_ROOT, isSecure: true, domain: undefined })
    expect(cookieLines(refreshed, PLAIN_COOKIE)).toHaveLength(0)
    expect(await tokenState(legacy)).toEqual({ isConsumed: false, isRevoked: false })
  })

  it('sets a fresh cookie and clears nothing for a replay inside the grace window', async () => {
    const app = appWith(PLAIN_HOST_ONLY)
    const raw = await sessionFor(await createVerifiedUser())
    await rotateRefreshToken(raw)

    const replayed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${PLAIN_COOKIE}=${raw}`)

    expect(replayed.status).toBe(200)
    const lines = cookieLines(replayed, PLAIN_COOKIE)
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toMatch(EPOCH_EXPIRY)
  })

  it('clears nothing when the refresh limiter answers 429', async () => {
    const app = appWith(PLAIN_HOST_ONLY)
    const live = await sessionFor(await createVerifiedUser())
    // An ordinary request first, so the limiter has a counter to fill.
    const first = await request(app).post('/api/v1/auth/refresh')
    expect(first.status).toBe(401)
    const client = await getRedis()
    const keys = await redisKeysMatching(`${redisKey('rl', RATE_LIMITS.refresh.name)}:*`)
    expect(keys.length).toBeGreaterThan(0)
    try {
      for (const key of keys) await client.incrBy(key, RATE_LIMITS.refresh.limit)

      const limited = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${PLAIN_COOKIE}=${live}`)

      expect(limited.status).toBe(429)
      expect(cookieLines(limited, PLAIN_COOKIE)).toHaveLength(0)
      expect(await tokenState(live)).toEqual({ isConsumed: false, isRevoked: false })
    } finally {
      // The worker's other refresh tests share this counter.
      await client.del(keys)
    }
  })

  it('clears nothing when the refresh fails with a server error', async () => {
    const app = appWith(PLAIN_HOST_ONLY)
    const live = await sessionFor(await createVerifiedUser())
    const unavailable = (() =>
      Promise.reject(new Error('database unavailable'))) as UserTokenRepository['findByHash']

    await withMutatedMethod(UserTokenRepository.prototype, 'findByHash', unavailable, async () => {
      const failed = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${PLAIN_COOKIE}=${live}`)

      expect(failed.status).toBe(500)
      expect(cookieLines(failed, PLAIN_COOKIE)).toHaveLength(0)
    })
    expect(await tokenState(live)).toEqual({ isConsumed: false, isRevoked: false })
  })
})
