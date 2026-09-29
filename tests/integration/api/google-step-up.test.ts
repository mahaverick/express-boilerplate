/**
 * @file Google step-up: `?reauth=1` binds the round-trip to the
 * browser's own live staff session, asks Google to re-authenticate, and on
 * the way back accepts only that user with a fresh ID-token auth_time. It
 * marks that session and starts none. Google is never called: the start is
 * checked by its redirect URL, and the callback runs a fake strategy.
 * Everything under src/ is imported after the env stubs, as in
 * google-oauth-apex.test.ts: the database module reads the env on import.
 */
import { randomUUID } from 'node:crypto'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'
import { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { sql as SqlType } from '@/services/database.service'
import { agent } from '../../helpers/request'

const APEX = 'http://localhost:5174'
const PASSWORD = 'correct horse battery staple'
const FAILED = `${APEX}/auth/callback?reauth=1&error=reauth_failed`

/**
 * Now, in seconds since the epoch, as an ID token's `auth_time` counts.
 * @returns The current time in whole seconds.
 */
const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/**
 * A Google profile, as the real verify function would hand it on, with the ID token's auth time.
 */
type SignIn = GoogleProfile & { stepUpAuthTime?: number }

class FakeGoogleStrategy implements passport.Strategy {
  name = GOOGLE_STRATEGY_NAME

  constructor(readonly signIn: SignIn) {}

  authenticate(this: passport.StrategyCreated<FakeGoogleStrategy>): void {
    // eslint-disable-next-line unicorn/no-undeclared-class-members -- passport injects `success` onto the per-request instance (see google-oauth.test.ts).
    this.success(this.signIn as unknown as Express.User)
  }
}

/**
 * The profile Google would return for an account.
 * @param googleId - The Google account's id (`sub`).
 * @param stepUpAuthTime - The ID token's auth_time in seconds, or undefined for a token without one.
 * @returns The sign-in the fake strategy hands to the callback.
 */
function signInFor(googleId: string, stepUpAuthTime: number | undefined): SignIn {
  const now = Math.floor(Date.now() / 1000)
  const profile: GoogleProfile = {
    provider: 'google',
    id: googleId,
    displayName: 'Step Up',
    profileUrl: `https://plus.google.com/${googleId}`,
    emails: [{ value: `${googleId}@example.test`, verified: true }],
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: googleId,
      iat: now,
      exp: now + 3600,
    },
  }
  return stepUpAuthTime === undefined ? profile : { ...profile, stepUpAuthTime }
}

describe('Google step-up', () => {
  let app: ReturnType<typeof CreateApp>
  let sql: typeof SqlType
  let signedInStaff: (role: MembershipRole | null) => Promise<{
    userId: string
    googleId: string
    sid: string
    browser: ReturnType<typeof agent>
  }>
  let authTimeAfterRefresh: (browser: ReturnType<typeof agent>) => Promise<number | undefined>
  let truncateAuditLogs: () => Promise<void>
  const createdIds: string[] = []

  beforeAll(async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret')
    vi.stubEnv('APEX_URL', APEX)
    const { createApp } = await import('@/app')
    app = createApp()
    ;({ sql } = await import('@/services/database.service'))
    const { verifyAccessToken } = await import('@/services/session.service')
    const { hashPassword } = await import('@/utilities/password.utilities')
    const { UserRepository } = await import('@/repositories/user.repository')
    const { AuthProviderRepository } = await import('@/repositories/auth-provider.repository')
    const { makeStaff } = await import('../../helpers/platform-staff')
    ;({ truncateAuditLogs } = await import('../../helpers/audit-log'))
    const users = new UserRepository()
    const providers = new AuthProviderRepository()

    const tokenClaims = (
      response: Response
    ): { sid: string | undefined; authTime: number | undefined } => {
      const token = (response.body as { data: { accessToken: string } }).data.accessToken
      const verified = verifyAccessToken(token)
      if (!verified.ok) throw new Error('unverifiable token')
      return { sid: verified.payload.sid, authTime: verified.payload.auth_time }
    }

    signedInStaff = async (role) => {
      const email = `google-step-up-${randomUUID()}@example.test`
      const user = await users.create({ email, passwordHash: await hashPassword(PASSWORD) })
      createdIds.push(user.id)
      await sql`update users set email_verified_at = now() where id = ${user.id}`
      if (role !== null) await makeStaff(user.id, role)
      const googleId = randomUUID()
      await providers.create({ userId: user.id, provider: 'google', providerId: googleId })
      const browser = agent(app)
      const login = await browser.post('/api/v1/auth/login').send({ email, password: PASSWORD })
      expect(login.status).toBe(200)
      const { sid } = tokenClaims(login)
      if (!sid) throw new Error('login issued no sid')
      // Signed in an hour ago, so a successful step-up visibly moves the time.
      await sql`
        update user_tokens set authenticated_at = authenticated_at - interval '1 hour'
        where session_id = ${sid}
      `
      return { userId: user.id, googleId, sid, browser }
    }

    authTimeAfterRefresh = async (browser) => {
      const refreshed = await browser.post('/api/v1/auth/refresh').send({})
      expect(refreshed.status).toBe(200)
      return tokenClaims(refreshed).authTime
    }
  })

  afterEach(async () => {
    const { configurePassport } = await import('@/configs/passport.config')
    configurePassport()
    await truncateAuditLogs()
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  /**
   * The step-up audit outcomes recorded for a user, oldest first.
   * @param userId - The staff member.
   * @returns The outcomes.
   */
  async function outcomes(userId: string): Promise<string[]> {
    const rows = await sql<{ metadata: { outcome: string } }[]>`
      select metadata from audit_logs where action = 'auth.reauthenticated' and target_id = ${userId}
      order by occurred_at, id
    `
    return rows.map((row) => row.metadata.outcome)
  }

  /**
   * How many sessions a user has.
   * @param userId - The user.
   * @returns The count of distinct session ids.
   */
  async function sessionCount(userId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      select count(distinct session_id)::int as count from user_tokens
      where user_id = ${userId} and purpose = 'refresh'
    `
    return row?.count ?? 0
  }

  it('refuses to start without a session: straight back to Apex with reauth_failed, never to Google', async () => {
    const response = await agent(app).get('/api/v1/auth/google?app=apex&reauth=1')
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe(FAILED)
  })

  it('refuses to start for a signed-in user who is not staff', async () => {
    // eslint-disable-next-line unicorn/no-null -- a non-staff caller has no platform role
    const { browser } = await signedInStaff(null)
    const response = await browser.get('/api/v1/auth/google?app=apex&reauth=1')
    expect(response.headers.location).toBe(FAILED)
  })

  it('refuses to start for a staff session past its absolute lifetime', async () => {
    const { requireDurationMs } = await import('@/utilities/duration.utilities')
    const { getEnv } = await import('@/configs/env.config')
    const staff = await signedInStaff('admin')
    const lifetimeSeconds = requireDurationMs(getEnv().SESSION_ABSOLUTE_TTL) / 1000
    await sql`
      update user_tokens
      set session_started_at = now() - make_interval(secs => ${lifetimeSeconds + 60})
      where session_id = ${staff.sid}
    `
    const response = await staff.browser.get('/api/v1/auth/google?app=apex&reauth=1')
    expect(response.headers.location).toBe(FAILED)
  })

  it('starts a bound round-trip that asks Google to re-authenticate and choose the account', async () => {
    const { browser } = await signedInStaff('admin')
    const response = await browser.get('/api/v1/auth/google?app=apex&reauth=1')

    const location = new URL(String(response.headers.location))
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('max_age')).toBe('0')
    expect(location.searchParams.get('prompt')).toBe('select_account')
    expect(location.searchParams.get('scope')?.split(' ')).toContain('openid')
  })

  it('sends neither max_age nor prompt on a plain sign-in', async () => {
    const response = await agent(app).get('/api/v1/auth/google?app=apex')
    const location = new URL(String(response.headers.location))
    expect(location.searchParams.has('max_age')).toBe(false)
    expect(location.searchParams.has('prompt')).toBe(false)
  })

  it('marks the same session re-authenticated for the same user with a fresh auth_time, and starts no session', async () => {
    const staff = await signedInStaff('admin')
    const before = Math.floor(Date.now() / 1000)
    await staff.browser.get('/api/v1/auth/google?app=apex&reauth=1')
    passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleStrategy(signInFor(staff.googleId, before)))

    const callback = await staff.browser.get('/api/v1/auth/google/callback')

    expect(callback.headers.location).toBe(`${APEX}/auth/callback?reauth=1`)
    const cookies = [callback.headers['set-cookie'] ?? []].flat()
    expect(cookies.some((cookie) => /refreshToken=/i.test(cookie))).toBe(false)
    expect(await sessionCount(staff.userId)).toBe(1)
    expect(await authTimeAfterRefresh(staff.browser)).toBeGreaterThanOrEqual(before - 1)
    expect(await outcomes(staff.userId)).toEqual(['success'])
  })

  it.each([
    ['a Google account linked to nobody', (): string => randomUUID(), nowSeconds],
    ['an auth_time six minutes old', undefined, (): number => nowSeconds() - 6 * 60],
    ['no auth_time at all', undefined, (): undefined => undefined],
  ] as const)(
    'refuses %s: reauth_failed, the session keeps its old time',
    async (_label, otherGoogleId, authTime) => {
      const staff = await signedInStaff('admin')
      const oldTime = await authTimeAfterRefresh(staff.browser)
      await staff.browser.get('/api/v1/auth/google?app=apex&reauth=1')
      const googleId = otherGoogleId === undefined ? staff.googleId : otherGoogleId()
      const signIn = signInFor(googleId, authTime())
      passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleStrategy(signIn))

      const callback = await staff.browser.get('/api/v1/auth/google/callback')

      expect(callback.headers.location).toBe(FAILED)
      expect(await authTimeAfterRefresh(staff.browser)).toBe(oldTime)
      expect(await sessionCount(staff.userId)).toBe(1)
      expect(await outcomes(staff.userId)).toEqual(['failure'])
    }
  )

  it('refuses another staff member’s Google account', async () => {
    const staff = await signedInStaff('admin')
    const other = await signedInStaff('owner')
    await staff.browser.get('/api/v1/auth/google?app=apex&reauth=1')
    const otherSignIn = signInFor(other.googleId, nowSeconds())
    passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleStrategy(otherSignIn))

    const callback = await staff.browser.get('/api/v1/auth/google/callback')

    expect(callback.headers.location).toBe(FAILED)
    expect(await sessionCount(other.userId)).toBe(1)
  })
})
