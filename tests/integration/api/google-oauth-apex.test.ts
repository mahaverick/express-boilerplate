/**
 * @file A Google sign-in started with `?app=apex` comes back to APEX_URL; one
 * started without it comes back to WEB_URL. On Apex, Google signs in only an
 * existing, active staff account and never creates one: every other profile
 * lands on the Apex login page with `google_auth_failed` and no session.
 * Google itself is never called: the callback runs a fake strategy, and a
 * supertest agent carries the OAuth session cookie.
 */
import { randomUUID } from 'node:crypto'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'
import { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'
import type { sql as SqlType } from '@/services/database.service'
import { FakeGoogleSuccessStrategy } from '../../helpers/fake-google'
import { withMutatedMethod } from '../../helpers/mutate'
import type { testRefreshCookie as TestRefreshCookieType } from '../../helpers/refresh-cookie'
import { agent } from '../../helpers/request'

const APEX = 'http://localhost:5174'
const WEB = 'http://localhost:5173'

/**
 * A verified Google profile for `email`, shaped as passport-google-oauth20 returns it.
 * @param email - The profile's address.
 */
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

/**
 * Switch this replica to `full`, as a staff change would.
 */
async function enterFull(): Promise<void> {
  const { storeMaintenanceMode } = await import('../../helpers/maintenance-mode')
  const { reloadMaintenanceMode } =
    await import('@/services/maintenance-mode/maintenance-mode-store.service')
  await storeMaintenanceMode('full')
  await reloadMaintenanceMode()
}

describe('Google sign-in return target', () => {
  let app: ReturnType<typeof CreateApp>
  let sql: typeof SqlType
  let refreshCookieName: ReturnType<typeof TestRefreshCookieType>['name']
  const emails: string[] = []

  /**
   * Every runtime import that reaches `getEnv()` happens here, after the
   * `vi.stubEnv` calls, so the Google routes mount (google-oauth.test.ts
   * explains the memoisation).
   */
  beforeAll(async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret')
    vi.stubEnv('APEX_URL', APEX)
    const { createApp } = await import('@/app')
    app = createApp()
    const database = await import('@/services/database.service')
    sql = database.sql
    const { testRefreshCookie } = await import('../../helpers/refresh-cookie')
    refreshCookieName = testRefreshCookie().name
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
   * A fresh address, recorded for cleanup.
   * @returns The address, lowercase.
   */
  function freshEmail(): string {
    const email = `apex-google-${randomUUID()}@example.test`
    emails.push(email)
    return email
  }

  /**
   * A verified, active account for a fresh address, optionally staff.
   * @param platformRole - The platform role to grant, or undefined for a customer.
   * @returns The account's id and address.
   */
  async function seedAccount(
    platformRole?: 'viewer' | 'admin'
  ): Promise<{ id: string; email: string }> {
    const email = freshEmail()
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, email_verified_at) values (${email}, now()) returning id
    `
    if (!user) throw new Error('seedAccount: no row')
    if (platformRole !== undefined) {
      await sql`
        insert into user_memberships (user_id, tenant_id, role)
        select ${user.id}, id, ${platformRole} from tenants where is_platform
      `
    }
    return { id: user.id, email }
  }

  /**
   * Start at /auth/google with `query`, then complete the callback in the same cookie jar.
   * @param query - The query string to start with, including any leading `?`.
   * @param email - The address the fake Google profile carries.
   * @returns The callback's response.
   */
  async function signInFrom(query: string, email: string): Promise<Response> {
    const browser = agent(app)
    await browser.get(`/api/v1/auth/google${query}`)
    passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(profileFor(email)))
    return browser.get('/api/v1/auth/google/callback')
  }

  /**
   * Whether a response set the refresh cookie.
   * @param response - The callback's response.
   * @returns True when a `Set-Cookie` line names it.
   */
  function hasRefreshCookie(response: Response): boolean {
    const lines = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? []
    return lines.some((line) => line.startsWith(`${refreshCookieName}=`))
  }

  /**
   * How many refresh rows a user holds.
   * @param userId - The user.
   * @returns The count.
   */
  async function refreshCount(userId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from user_tokens
      where user_id = ${userId} and purpose = 'refresh'
    `
    return row?.count ?? 0
  }

  it('returns an app=apex sign-in to APEX_URL', async () => {
    const staff = await seedAccount('viewer')
    const response = await signInFrom('?app=apex', staff.email)
    expect(response.headers.location).toBe(`${APEX}/auth/callback`)
  })

  it('returns a sign-in with no app to WEB_URL', async () => {
    const customer = await seedAccount()
    const response = await signInFrom('', customer.email)
    expect(response.headers.location).toBe(`${WEB}/auth/callback`)
  })

  it.each(['?app=https://evil.example', '?app=APEX', '?app=apex&app=web'])(
    'returns %s to WEB_URL',
    async (query) => {
      const customer = await seedAccount()
      const response = await signInFrom(query, customer.email)
      expect(response.headers.location).toBe(`${WEB}/auth/callback`)
    }
  )

  it('sends a denied consent back to the app that started it', async () => {
    const browser = agent(app)
    await browser.get('/api/v1/auth/google?app=apex')
    const response = await browser.get('/api/v1/auth/google/callback?error=access_denied')
    expect(response.headers.location).toMatch(new RegExp(String.raw`^${APEX}/login\?error=`))
  })

  it('never creates an account from apex Google', async () => {
    const email = freshEmail()

    const response = await signInFrom('?app=apex', email)

    expect(response.headers.location).toBe(`${APEX}/login?error=google_auth_failed`)
    expect(hasRefreshCookie(response)).toBe(false)
    const users = await sql`select id from users where lower(email) = ${email}`
    expect(users).toHaveLength(0)
  })

  it('refuses a non-staff Google user on apex', async () => {
    const customer = await seedAccount()

    const response = await signInFrom('?app=apex', customer.email)

    expect(response.headers.location).toBe(`${APEX}/login?error=google_auth_failed`)
    expect(hasRefreshCookie(response)).toBe(false)
    expect(await refreshCount(customer.id)).toBe(0)
    const links = await sql`
      select id from auth_providers where user_id = ${customer.id} and provider = 'google'
    `
    expect(links).toHaveLength(0)
  })

  it('refuses an inactive staff Google user on apex', async () => {
    const staff = await seedAccount('admin')
    await sql`update users set active = false where id = ${staff.id}`

    const response = await signInFrom('?app=apex', staff.email)

    expect(response.headers.location).toBe(`${APEX}/login?error=google_auth_failed`)
    expect(hasRefreshCookie(response)).toBe(false)
    expect(await refreshCount(staff.id)).toBe(0)
  })

  it('signs a staff Google user in to apex', async () => {
    const staff = await seedAccount('admin')

    const response = await signInFrom('?app=apex', staff.email)

    expect(response.headers.location).toBe(`${APEX}/auth/callback`)
    expect(hasRefreshCookie(response)).toBe(true)
    expect(await refreshCount(staff.id)).toBe(1)
    const links = await sql`
      select id from auth_providers where user_id = ${staff.id} and provider = 'google'
    `
    expect(links).toHaveLength(1)
  })
  it('refuses an apex Google user demoted between the staff check and the session', async () => {
    const staff = await seedAccount('admin')
    const { AuthProviderRepository } = await import('@/repositories/auth-provider.repository')
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realCreate = AuthProviderRepository.prototype.create
    const demoted = { done: false }
    /**
     * Stands in for `AuthProviderRepository.create`: just before the Google
     * link is written, the staff member's platform role is removed.
     */
    const demotingCreate: typeof realCreate = async function (
      this: InstanceType<typeof AuthProviderRepository>,
      ...arguments_
    ) {
      if (!demoted.done) {
        demoted.done = true
        await sql`
          delete from user_memberships
          where user_id = ${staff.id} and tenant_id = (select id from tenants where is_platform)
        `
      }
      return realCreate.apply(this, arguments_)
    }

    let response: Response | undefined
    await withMutatedMethod(
      AuthProviderRepository.prototype,
      'create',
      demotingCreate,
      async () => {
        response = await signInFrom('?app=apex', staff.email)
      }
    )

    expect(demoted.done).toBe(true)
    expect(response?.headers.location).toBe(`${APEX}/login?error=google_auth_failed`)
    if (!response) throw new Error('the callback answered nothing')
    expect(hasRefreshCookie(response)).toBe(false)
    expect(await refreshCount(staff.id)).toBe(0)
  })

  describe('in full maintenance', () => {
    afterEach(async () => {
      const { resetMaintenanceMode } = await import('../../helpers/maintenance-mode')
      const { reloadMaintenanceMode } =
        await import('@/services/maintenance-mode/maintenance-mode-store.service')
      await resetMaintenanceMode()
      await reloadMaintenanceMode()
    })

    it('signs a staff Google user in to apex', async () => {
      const staff = await seedAccount('viewer')
      await enterFull()

      const response = await signInFrom('?app=apex', staff.email)

      expect(response.headers.location).toBe(`${APEX}/auth/callback`)
      expect(hasRefreshCookie(response)).toBe(true)
      expect(await refreshCount(staff.id)).toBe(1)
    })

    it('refuses a non-staff Google user on apex with google_auth_failed and no session', async () => {
      const customer = await seedAccount()
      await enterFull()

      const response = await signInFrom('?app=apex', customer.email)

      expect(response.headers.location).toBe(`${APEX}/login?error=google_auth_failed`)
      expect(hasRefreshCookie(response)).toBe(false)
      expect(await refreshCount(customer.id)).toBe(0)
    })
  })
})
