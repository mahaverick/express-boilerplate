/**
 * @file A Google sign-in started with `?app=apex` comes back to APEX_URL; one
 * started without it comes back to WEB_URL. Google itself is never called: the
 * callback runs a fake strategy, and a supertest agent carries the OAuth session cookie.
 */
import { randomUUID } from 'node:crypto'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'
import { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'
import type { sql as SqlType } from '@/services/database.service'
import { agent } from '../../helpers/request'

const APEX = 'http://localhost:5174'
const WEB = 'http://localhost:5173'

class FakeGoogleSuccessStrategy implements passport.Strategy {
  name = GOOGLE_STRATEGY_NAME

  constructor(readonly profile: GoogleProfile) {}

  authenticate(this: passport.StrategyCreated<FakeGoogleSuccessStrategy>): void {
    // eslint-disable-next-line unicorn/no-undeclared-class-members -- passport injects `success` onto the per-request instance (see google-oauth.test.ts).
    this.success(this.profile as unknown as Express.User)
  }
}

function profileFor(email: string): GoogleProfile {
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  return {
    provider: 'google',
    id,
    displayName: 'Apex User',
    profileUrl: `https://plus.google.com/${id}`,
    emails: [{ value: email, verified: true }],
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: id,
      iat: now,
      exp: now + 3600,
      email,
      email_verified: true,
    },
  }
}

describe('Google sign-in return target', () => {
  let app: ReturnType<typeof CreateApp>
  let sql: typeof SqlType
  const emails: string[] = []

  beforeAll(async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret')
    vi.stubEnv('APEX_URL', APEX)
    const { createApp } = await import('@/app')
    app = createApp()
    const database = await import('@/services/database.service')
    sql = database.sql
  })

  afterEach(async () => {
    const { configurePassport } = await import('@/configs/passport.config')
    configurePassport()
    if (emails.length === 0) {
      return
    }

    await sql`delete from users where email = any(${emails})`
    emails.length = 0
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  /**
   * Start at /auth/google with `query`, then complete the callback in the same cookie jar.
   * @param query - The query string to start with, including any leading `?`.
   * @returns The callback's redirect target.
   */
  async function signInFrom(query: string): Promise<string | undefined> {
    const browser = agent(app)
    await browser.get(`/api/v1/auth/google${query}`)
    const email = `apex-google-${randomUUID()}@example.test`
    emails.push(email)
    passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(profileFor(email)))
    const response = await browser.get('/api/v1/auth/google/callback')
    return response.headers.location
  }

  it('returns an app=apex sign-in to APEX_URL', async () => {
    expect(await signInFrom('?app=apex')).toBe(`${APEX}/auth/callback`)
  })

  it('returns a sign-in with no app to WEB_URL', async () => {
    expect(await signInFrom('')).toBe(`${WEB}/auth/callback`)
  })

  it.each(['?app=https://evil.example', '?app=APEX', '?app=apex&app=web'])(
    'returns %s to WEB_URL',
    async (query) => {
      expect(await signInFrom(query)).toBe(`${WEB}/auth/callback`)
    }
  )

  it('sends a denied consent back to the app that started it', async () => {
    const browser = agent(app)
    await browser.get('/api/v1/auth/google?app=apex')
    const response = await browser.get('/api/v1/auth/google/callback?error=access_denied')
    expect(response.headers.location).toMatch(new RegExp(String.raw`^${APEX}/login\?error=`))
  })
})
