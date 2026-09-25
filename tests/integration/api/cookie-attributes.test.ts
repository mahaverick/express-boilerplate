// tests/integration/api/cookie-attributes.test.ts
//
// COOKIE_SECURE and COOKIE_DOMAIN at every site that writes an auth cookie:
// the refresh cookie on login, refresh, logout (clear) and the Google
// callback, and express-session's `oauth.sid`.
//
// getEnv() is a vi.fn over the real one, so each test hands the app its own
// env without vi.resetModules(). Every test builds a fresh app: createApp()
// reads TRUST_PROXY and the Google credentials once, and the OAuth session
// middleware reads its cookie options once per app, on first use.
//
// express-session gets no `proxy` option, so it sends a Secure cookie only
// when req.secure is true (express-session index.js, issecure). The Secure
// cases therefore run with TRUST_PROXY=1 and X-Forwarded-Proto: https, and
// one test pins the drop when that header is missing.
import { randomUUID } from 'node:crypto'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { getEnv, type Env } from '@/configs/env.config'
import { GOOGLE_STRATEGY_NAME, REFRESH_TOKEN_COOKIE_NAME } from '@/constants/auth.constants'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { hashPassword } from '@/utilities/password.utilities'
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

function cookieLine(response: Response, name: string): string | undefined {
  const lines = response.headers['set-cookie'] as string[] | undefined
  return lines?.find((line) => line.startsWith(`${name}=`))
}

function cookiePair(line: string | undefined): string {
  const pair = line?.split(';', 1)[0]
  if (!pair) throw new Error('expected a Set-Cookie line to replay')
  return pair
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

// Skips the OAuth2 dance and succeeds with a fixed profile, so the callback's
// own cookie-setting path runs over real HTTP. Same technique as
// google-oauth.test.ts's FakeGoogleSuccessStrategy.
class FakeGoogleSuccessStrategy implements passport.Strategy {
  name = GOOGLE_STRATEGY_NAME

  constructor(readonly profile: GoogleProfile) {}

  authenticate(this: passport.StrategyCreated<FakeGoogleSuccessStrategy>): void {
    // eslint-disable-next-line unicorn/no-undeclared-class-members -- passport injects `success` onto the per-request instance (StrategyCreatedStatic).
    this.success(this.profile as unknown as Express.User)
  }
}

describe('refresh cookie: login, refresh and logout', () => {
  it('carries Secure and COOKIE_DOMAIN on set, rotate and clear when COOKIE_SECURE=true', async () => {
    const app = appWith(SECURE_SCOPED)
    const email = await createVerifiedUser()

    const login = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ email, password: PASSWORD })
    expect(login.status).toBe(200)
    const loginCookie = cookieLine(login, REFRESH_TOKEN_COOKIE_NAME)
    expect(loginCookie).toMatch(SECURE)
    expect(loginCookie).toMatch(SCOPED_DOMAIN)

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', cookiePair(loginCookie))
    expect(refreshed.status).toBe(200)
    const rotatedCookie = cookieLine(refreshed, REFRESH_TOKEN_COOKIE_NAME)
    expect(rotatedCookie).toMatch(SECURE)
    expect(rotatedCookie).toMatch(SCOPED_DOMAIN)

    const loggedOut = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', cookiePair(rotatedCookie))
    expect(loggedOut.status).toBe(200)
    const cleared = cookieLine(loggedOut, REFRESH_TOKEN_COOKIE_NAME)
    expect(cleared).toMatch(EPOCH_EXPIRY)
    // The clear must repeat Domain, or the browser keeps the scoped cookie.
    expect(cleared).toMatch(SECURE)
    expect(cleared).toMatch(SCOPED_DOMAIN)
  })

  it('has neither Secure nor Domain when COOKIE_SECURE=false and COOKIE_DOMAIN is unset, even over forwarded https', async () => {
    const app = appWith(PLAIN_HOST_ONLY)
    const email = await createVerifiedUser()

    const login = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ email, password: PASSWORD })
    expect(login.status).toBe(200)
    const loginCookie = cookieLine(login, REFRESH_TOKEN_COOKIE_NAME)
    expect(loginCookie).toBeDefined()
    expect(loginCookie).not.toMatch(SECURE)
    expect(loginCookie).not.toMatch(ANY_DOMAIN)

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', cookiePair(loginCookie))
    expect(refreshed.status).toBe(200)
    const rotatedCookie = cookieLine(refreshed, REFRESH_TOKEN_COOKIE_NAME)
    expect(rotatedCookie).toBeDefined()
    expect(rotatedCookie).not.toMatch(SECURE)
    expect(rotatedCookie).not.toMatch(ANY_DOMAIN)

    const loggedOut = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', cookiePair(rotatedCookie))
    expect(loggedOut.status).toBe(200)
    const cleared = cookieLine(loggedOut, REFRESH_TOKEN_COOKIE_NAME)
    expect(cleared).toMatch(EPOCH_EXPIRY)
    expect(cleared).not.toMatch(SECURE)
    expect(cleared).not.toMatch(ANY_DOMAIN)
  })
})

describe('refresh cookie: Google callback', () => {
  it.each([
    { label: 'COOKIE_SECURE=true with COOKIE_DOMAIN', env: SECURE_SCOPED, isSecure: true },
    { label: 'COOKIE_SECURE=false, host-only', env: PLAIN_HOST_ONLY, isSecure: false },
  ])('follows $label', async ({ env, isSecure }) => {
    const app = appWith(env)
    const email = `cookie-attributes-google-${randomUUID()}@example.test`
    passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(googleProfile(email)))

    const response = await request(app)
      .get('/api/v1/auth/google/callback')
      .set('X-Forwarded-Proto', 'https')

    const user = await userRepository.findByEmail(email)
    if (user) createdIds.push(user.id)
    expect(response.status).toBe(302)
    const refreshCookie = cookieLine(response, REFRESH_TOKEN_COOKIE_NAME)
    expect(refreshCookie).toMatch(/SameSite=Lax/i)
    if (isSecure) {
      expect(refreshCookie).toMatch(SECURE)
      expect(refreshCookie).toMatch(SCOPED_DOMAIN)
    } else {
      expect(refreshCookie).not.toMatch(SECURE)
      expect(refreshCookie).not.toMatch(ANY_DOMAIN)
    }
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
