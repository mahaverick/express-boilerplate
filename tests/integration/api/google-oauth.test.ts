/**
 * @file Exercises the real `createOAuthSessionMiddleware()` against the test
 * Redis (REDIS_URL in .env.test, under the worker's key prefix), not a mock,
 * proving the `RedisStore`-backed session middleware that passport.config.ts
 * builds on the first request works. `google-oauth-disabled.test.ts` covers
 * the opposite env state (no Google credentials); the describe block below
 * says why that cannot live here too.
 */

import { randomUUID } from 'node:crypto'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'
import { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import type { AuthProviderRepository as AuthProviderRepositoryClass } from '@/repositories/auth-provider.repository'
import type { UserRepository as UserRepositoryClass } from '@/repositories/user.repository'
import type { sql as SqlType } from '@/services/database.service'
import type { subscribeDomainEvent as SubscribeDomainEventType } from '@/services/domain-events.service'
import type { completeGoogleSignIn as CompleteGoogleSignInType } from '@/services/google-auth.service'
import type { issueRefreshToken as IssueRefreshTokenType } from '@/services/session.service'
import { FakeGoogleSuccessStrategy } from '../../helpers/fake-google'
import { withMutatedMethod } from '../../helpers/mutate'
import { fakeQueryError, LEAKED_PARAM, loggedText } from '../../helpers/query-error'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { agent, request } from '../../helpers/request'

/**
 * The `state` query parameter off a Google OAuth redirect URL, if present.
 */
function stateOf(location: string | undefined): string | undefined {
  return location ? (new URL(location).searchParams.get('state') ?? undefined) : undefined
}

/**
 * A disposable email unique to this call, so it cannot collide with rows other tests in this
 * worker's database hold.
 */
function uniqueEmail(): string {
  return `google-oauth-${randomUUID()}@example.test`
}

/**
 * A fixture Google profile shaped like the profile `passthroughGoogleProfile` (passport.config.ts)
 * hands `done()`, which is what `completeGoogleSignIn` (google-auth.service.ts) receives. The fields the
 * account-linking code reads (`id`, `emails[0].value`, `emails[0].verified`,
 * `_json.email_verified`) can be overridden; every other field is a plausible constant.
 * @param overrides - Fields to replace. `jsonEmailVerified` defaults to `emailVerified`, so a test sets it only to make the two disagree; `includeEmails: false` omits `emails`, the "Google shared no email" case.
 */
function googleProfile(
  overrides: {
    id?: string
    email?: string
    emailVerified?: boolean
    jsonEmailVerified?: boolean
    includeEmails?: boolean
  } = {}
): GoogleProfile {
  const id = overrides.id ?? randomUUID()
  const email = overrides.email ?? uniqueEmail()
  const isEmailVerified = overrides.emailVerified ?? true
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    provider: 'google',
    id,
    displayName: 'Test User',
    profileUrl: `https://plus.google.com/${id}`,
    // Omitted entirely, not set to undefined, for the "no email" fixture: exactOptionalPropertyTypes: true (tsconfig.json) rejects an explicit undefined for an optional property.
    ...(overrides.includeEmails !== false && {
      emails: [{ value: email, verified: isEmailVerified }],
    }),
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: id,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      email,
      email_verified: overrides.jsonEmailVerified ?? isEmailVerified,
    },
  }
}

/**
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are stubbed with `vi.stubEnv` for this block and
 * restored in `afterAll`. The values are fake: passport's Google strategy builds the redirect URL
 * locally, so nothing here calls Google. `getEnv()` memoises the first environment it parses for
 * the life of the worker process, so once `beforeAll` has run with the variable set, no later test
 * in this file could see it unset without `vi.resetModules()`, which re-evaluates
 * database.service.ts and opens a second postgres pool that nothing closes. That is why the "disabled" state lives in its own file.
 */
describe('GET /api/v1/auth/google (Google OAuth configured)', () => {
  let app: ReturnType<typeof CreateApp>
  let completeGoogleSignIn: typeof CompleteGoogleSignInType
  let userRepository: InstanceType<typeof UserRepositoryClass>
  let authProviderRepository: InstanceType<typeof AuthProviderRepositoryClass>
  let sql: typeof SqlType
  let issueRefreshToken: typeof IssueRefreshTokenType
  let subscribeDomainEvent: typeof SubscribeDomainEventType

  /**
   * Every runtime import happens here, after the `vi.stubEnv` calls. `@/app` reaches
   * `database.service.ts`, which calls `getEnv()` at module scope, and a static import would
   * evaluate that before any hook runs and memoise `getEnv()` without `GOOGLE_CLIENT_ID`. A dynamic
   * `import()` evaluates where it is awaited. The imports after `@/app` return modules it already
   * loaded.
   */
  beforeAll(async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret')
    const { createApp } = await import('@/app')
    app = createApp()

    const googleAuthService = await import('@/services/google-auth.service')
    completeGoogleSignIn = googleAuthService.completeGoogleSignIn

    const { UserRepository } = await import('@/repositories/user.repository')
    userRepository = new UserRepository()

    const { AuthProviderRepository } = await import('@/repositories/auth-provider.repository')
    authProviderRepository = new AuthProviderRepository()

    const database = await import('@/services/database.service')
    sql = database.sql

    const sessionService = await import('@/services/session.service')
    issueRefreshToken = sessionService.issueRefreshToken

    const domainEvents = await import('@/services/domain-events.service')
    subscribeDomainEvent = domainEvents.subscribeDomainEvent
  })

  /**
   * Restores the variables' prior state; both were unset, so vitest deletes them.
   */
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  /**
   * Users that `completeGoogleSignIn` creates or the tests seed, deleted in `afterEach`. Deleting a
   * user cascades to its `auth_providers` rows (`onDelete: 'cascade'`, auth-provider.model.ts).
   */
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Signs in through `completeGoogleSignIn`, the callback's own entry point, and reads back the
   * user it resolved, as committed. The user is tracked for cleanup.
   */
  async function signInWithGoogle(profile: GoogleProfile): Promise<User> {
    const { refreshToken } = await completeGoogleSignIn(profile, 'web')
    createdIds.push(refreshToken.userId)
    const user = await userRepository.findById(refreshToken.userId)
    if (!user) throw new Error('completeGoogleSignIn issued a session for no live user')
    return user
  }

  /**
   * A verified, active account whose address a fake profile then carries,
   * so its sign-in is not a new account's.
   * @returns The account's address.
   */
  async function existingVerifiedEmail(): Promise<string> {
    const email = uniqueEmail()
    const existing = await userRepository.create({ email })
    createdIds.push(existing.id)
    await sql`update users set email_verified_at = now() where id = ${existing.id}`
    return email
  }

  it('responds with a 302 redirect', async () => {
    const response = await request(app).get('/api/v1/auth/google')
    expect(response.status).toBe(302)
  })

  it('redirects to Google, carrying client_id, redirect_uri, scope, and state', async () => {
    const response = await request(app).get('/api/v1/auth/google')
    const location = response.headers.location
    expect(location).toBeDefined()
    expect(location).toContain('https://accounts.google.com')
    expect(location).toContain('client_id=test-google-client-id')
    expect(location).toContain(
      `redirect_uri=${encodeURIComponent('http://localhost:4040/api/v1/auth/google/callback')}`
    )
    expect(location).toContain('scope=')
    expect(location).toContain('state=')
  })

  it('sets the OAuth session cookie needed to verify `state` on the callback', async () => {
    // resave/saveUninitialized: false still issues a cookie here: the Google strategy's state: true writes to req.session on this very request, and only a session left completely untouched is skipped.
    const response = await request(app).get('/api/v1/auth/google')
    const cookies = response.headers['set-cookie'] as string[] | undefined
    expect(cookies).toBeDefined()
    expect(cookies?.some((cookie) => cookie.startsWith('oauth.sid='))).toBe(true)
  })

  it('issues a fresh state value on every request (not a fixed or replayed one)', async () => {
    const first = await request(app).get('/api/v1/auth/google')
    const second = await request(app).get('/api/v1/auth/google')

    const firstState = stateOf(first.headers.location)
    const secondState = stateOf(second.headers.location)
    expect(firstState).toBeTruthy()
    expect(secondState).toBeTruthy()
    expect(firstState).not.toBe(secondState)
  })

  /**
   * Two shapes reach the callback route over real HTTP without Google credentials:
   *
   * - No query parameters: `passport-oauth2` cannot tell this from a fresh `/google` request (it
   *   only inspects the query string), so it redirects to Google's consent screen.
   * - `?error=access_denied`, what Google sends when a user cancels its consent screen:
   *   `passport-oauth2` checks `req.query.error` before anything else, so it fails at once, with no
   *   network call and no session or state, and `handleGoogleCallback`'s custom callback gets
   *   `profile: false`, the branch that redirects to `${WEB_URL}/login?error=...` instead of
   *   throwing.
   *
   * Together they run the route's whole middleware chain (rate limiter, session middleware,
   * `passport.initialize()`, `handleGoogleCallback`); the account-linking policy behind a successful
   * callback is exercised by the suite below.
   */
  describe('GET /api/v1/auth/google/callback', () => {
    it('redirects to Google when hit with no query parameters at all (indistinguishable from a fresh /google request)', async () => {
      const response = await request(app).get('/api/v1/auth/google/callback')

      expect(response.status).toBe(302)
      expect(response.headers.location).toContain('https://accounts.google.com')
    })

    it('redirects to the frontend login with an error when Google reports the user denied consent', async () => {
      const response = await request(app).get('/api/v1/auth/google/callback?error=access_denied')

      expect(response.status).toBe(302)
      expect(response.headers.location).toBeDefined()
      // WEB_URL from .env.test — this file never overrides it, only GOOGLE_CLIENT_ID/SECRET (beforeAll above).
      expect(response.headers.location).toContain('http://localhost:5173/login?error=')
    })

    it('never sets a refresh-token cookie for a failed callback', async () => {
      const response = await request(app).get('/api/v1/auth/google/callback?error=access_denied')

      const cookies = response.headers['set-cookie'] as string[] | undefined
      expect(cookies?.some((cookie) => cookie.startsWith('refreshToken='))).not.toBe(true)
    })

    // FakeGoogleSuccessStrategy (tests/helpers/fake-google.ts) drives handleGoogleCallback's success path over real HTTP; configurePassport() restores the real Google strategy after every test here, so nothing above or below this describe block observes the swap.
    describe('a successful sign-in (fake strategy — Google itself can never be hit)', () => {
      afterEach(async () => {
        const passportConfig = await import('@/configs/passport.config')
        passportConfig.configurePassport()
      })

      it('sets a SameSite=Lax refresh cookie, updates lastLoggedInAt, and redirects to the frontend callback route', async () => {
        const profile = googleProfile({ emailVerified: true })
        passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(profile))
        const beforeSignIn = Date.now()

        const response = await request(app).get('/api/v1/auth/google/callback')

        expect(response.status).toBe(302)
        // WEB_URL from .env.test — see the earlier redirect test's own note. The profile is new, so the callback says so.
        expect(response.headers.location).toBe('http://localhost:5173/auth/callback?new=1')

        const cookies = response.headers['set-cookie'] as string[] | undefined
        const refreshCookie = cookies?.find((cookie) => cookie.startsWith('refreshToken='))
        expect(refreshCookie).toBeDefined()
        // The callback sets the cookie Lax by decision, unlike the Strict it carries everywhere else (SECURITY.md#the-refresh-cookie), so the test asserts the literal attribute, not just that a cookie exists.
        expect(refreshCookie?.toLowerCase()).toContain('samesite=lax')
        expect(refreshCookie?.toLowerCase()).not.toContain('samesite=strict')

        const email = profile.emails?.[0]?.value
        if (!email) throw new Error('test fixture has no email')
        const user = await userRepository.findByEmail(email)
        if (!user) throw new Error('handleGoogleCallback did not create a user')
        createdIds.push(user.id)
        expect(user.lastLoggedInAt).not.toBeNull()
        expect(user.lastLoggedInAt?.getTime()).toBeGreaterThanOrEqual(beforeSignIn - 1000)
      })

      it('revokes the session of a refresh cookie the callback request presents', async () => {
        const earlier = await userRepository.create({ email: uniqueEmail() })
        createdIds.push(earlier.id)
        const presented = await issueRefreshToken(earlier.id, randomUUID())
        const profile = googleProfile({ emailVerified: true })
        passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(profile))

        const response = await request(app)
          .get('/api/v1/auth/google/callback')
          .set('Cookie', `${testRefreshCookie().name}=${presented.raw}`)

        expect(response.status).toBe(302)
        expect(response.headers.location).toBe('http://localhost:5173/auth/callback?new=1')
        const email = profile.emails?.[0]?.value
        if (!email) throw new Error('test fixture has no email')
        const user = await userRepository.findByEmail(email)
        if (user) createdIds.push(user.id)
        const [row] = await sql<{ live: number }[]>`
          select count(*)::int as live from user_tokens
          where session_id = ${presented.sessionId} and revoked_at is null
        `
        expect(row?.live).toBe(0)
      })

      it('redirects to the frontend login with an error and sets no cookie when the resolved user is inactive', async () => {
        const profile = googleProfile({ emailVerified: true })
        const email = profile.emails?.[0]?.value
        if (!email) throw new Error('test fixture has no email')
        const existing = await userRepository.create({ email })
        createdIds.push(existing.id)
        await userRepository.update(existing.id, { active: false })
        passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(profile))

        const response = await request(app).get('/api/v1/auth/google/callback')

        expect(response.status).toBe(302)
        expect(response.headers.location).toBe(
          'http://localhost:5173/login?error=google_auth_failed'
        )
        const cookies = response.headers['set-cookie'] as string[] | undefined
        expect(cookies?.some((cookie) => cookie.startsWith('refreshToken='))).not.toBe(true)
        const untouched = await userRepository.findById(existing.id)
        expect(untouched?.lastLoggedInAt).toBeNull()
      })

      it('logs a failed sign-in query without its bound parameters', async () => {
        const profile = googleProfile({ emailVerified: true })
        const email = profile.emails?.[0]?.value
        if (!email) throw new Error('test fixture has no email')
        passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(profile))
        const { logger } = await import('@/services/logger.service')
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

        await withMutatedMethod(
          Object.getPrototypeOf(userRepository) as InstanceType<typeof UserRepositoryClass>,
          'update',
          () => Promise.reject(fakeQueryError()),
          async () => {
            const response = await request(app).get('/api/v1/auth/google/callback')
            expect(response.status).toBe(302)
            expect(response.headers.location).toBe(
              'http://localhost:5173/login?error=processing_failed'
            )
          }
        )

        const user = await userRepository.findByEmail(email)
        if (user) createdIds.push(user.id)
        expect(errorSpy).toHaveBeenCalledWith('Google OAuth callback failed', expect.anything())
        expect(loggedText(errorSpy)).not.toContain(LEAKED_PARAM)
      })

      it('redirects with email_not_verified and creates no user when Google has not verified a new email', async () => {
        const profile = googleProfile({ emailVerified: false })
        const email = profile.emails?.[0]?.value
        if (!email) throw new Error('test fixture has no email')
        passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(profile))

        const response = await request(app).get('/api/v1/auth/google/callback')

        expect(response.status).toBe(302)
        expect(response.headers.location).toBe(
          'http://localhost:5173/login?error=email_not_verified'
        )
        const user = await userRepository.findByEmail(email)
        // Tracked before asserting, so the red run's stray row is still cleaned up.
        if (user) createdIds.push(user.id)
        expect(user).toBeUndefined()
      })

      it('carries a valid redirect through to the callback', async () => {
        const email = await existingVerifiedEmail()
        const browser = agent(app)
        const start = await browser.get(
          '/api/v1/auth/google?redirect=%2Ftenants%2Facme%3Ftenant%3Dacme'
        )
        expect(start.status).toBe(302)
        passport.use(
          GOOGLE_STRATEGY_NAME,
          new FakeGoogleSuccessStrategy(googleProfile({ email, emailVerified: true }))
        )

        const response = await browser.get('/api/v1/auth/google/callback')

        expect(response.headers.location).toBe(
          'http://localhost:5173/auth/callback?redirect=%2Ftenants%2Facme%3Ftenant%3Dacme'
        )
      })

      it('drops an off-origin redirect', async () => {
        const email = await existingVerifiedEmail()
        const browser = agent(app)
        // The start is a navigation, so a bad redirect is dropped, never answered with a 400.
        const start = await browser.get('/api/v1/auth/google?redirect=%2F%2Fevil.test')
        expect(start.status).toBe(302)
        expect(start.headers.location).toContain('https://accounts.google.com')
        passport.use(
          GOOGLE_STRATEGY_NAME,
          new FakeGoogleSuccessStrategy(googleProfile({ email, emailVerified: true }))
        )

        const response = await browser.get('/api/v1/auth/google/callback')

        expect(response.headers.location).toBe('http://localhost:5173/auth/callback')
      })

      it('marks a new web Google user with new=1', async () => {
        const profile = googleProfile({ emailVerified: true })
        const browser = agent(app)
        await browser.get('/api/v1/auth/google?redirect=%2Fwelcome')
        passport.use(GOOGLE_STRATEGY_NAME, new FakeGoogleSuccessStrategy(profile))

        const response = await browser.get('/api/v1/auth/google/callback')

        const email = profile.emails?.[0]?.value
        if (!email) throw new Error('test fixture has no email')
        const user = await userRepository.findByEmail(email)
        if (user) createdIds.push(user.id)
        expect(user).toBeDefined()
        expect(response.headers.location).toBe(
          'http://localhost:5173/auth/callback?redirect=%2Fwelcome&new=1'
        )
      })
    })
  })

  describe('Google account linking (completeGoogleSignIn, google-auth.service.ts)', () => {
    it('answers isNewUser true only for the sign-in that created the account', async () => {
      const profile = googleProfile({ emailVerified: true })
      const first = await completeGoogleSignIn(profile, 'web')
      createdIds.push(first.refreshToken.userId)
      const second = await completeGoogleSignIn(profile, 'web')

      expect(first.isNewUser).toBe(true)
      expect(second.isNewUser).toBe(false)
      expect(second.refreshToken.userId).toBe(first.refreshToken.userId)
    })

    it.each(['deleted', 'deactivated'] as const)(
      'answers google_auth_failed with no session when the never-verified account is %s during the claim',
      async (change) => {
        const { UserRepository: Users } = await import('@/repositories/user.repository')
        const email = uniqueEmail()
        const existing = await userRepository.create({ email })
        createdIds.push(existing.id)
        // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
        const realLock = Users.prototype.lockById
        const changed = { done: false }
        /**
         * Stands in for `UserRepository.lockById`: just before the claim's
         * first lock, a delete or a deactivation commits on another connection.
         */
        const changingLock: typeof realLock = async function (
          this: InstanceType<typeof Users>,
          ...arguments_
        ) {
          const [id, mode] = arguments_
          if (mode === 'no key update' && id === existing.id && !changed.done) {
            changed.done = true
            await (change === 'deleted'
              ? sql`update users set deleted_at = now() where id = ${existing.id}`
              : sql`update users set active = false where id = ${existing.id}`)
          }
          return realLock.apply(this, arguments_)
        }

        await withMutatedMethod(Users.prototype, 'lockById', changingLock, async () => {
          await expect(
            completeGoogleSignIn(googleProfile({ email, emailVerified: true }), 'web')
          ).rejects.toMatchObject({ statusCode: 401, code: 'google_auth_failed' })
        })

        expect(changed.done).toBe(true)
        const [row] = await sql<{ count: number }[]>`
          select count(*)::int as count from user_tokens
          where user_id = ${existing.id} and purpose = 'refresh'
        `
        expect(row?.count).toBe(0)
      }
    )

    it('creates a new user, an email provider, and a google provider, with emailVerifiedAt set, when Google verified the email', async () => {
      const email = uniqueEmail()
      const profile = googleProfile({ email, emailVerified: true })

      const user = await signInWithGoogle(profile)

      expect(user.email.toLowerCase()).toBe(email.toLowerCase())
      expect(user.emailVerifiedAt).not.toBeNull()

      const providers = await authProviderRepository.findByUser(user.id)
      expect(
        providers.map((provider) => provider.provider).toSorted((a, b) => a.localeCompare(b))
      ).toEqual(['email', 'google'])
      const googleRow = providers.find((provider) => provider.provider === 'google')
      const emailRow = providers.find((provider) => provider.provider === 'email')
      expect(googleRow?.providerId).toBe(profile.id)
      expect(emailRow?.providerId).toBe(user.email)
    })

    it('refuses to create an account for an email Google has not verified, writing no row', async () => {
      const profile = googleProfile({ emailVerified: false })
      const email = profile.emails?.[0]?.value
      if (!email) throw new Error('test fixture has no email')

      let outcome: unknown
      try {
        outcome = await signInWithGoogle(profile)
      } catch (error) {
        outcome = error
      }

      expect(outcome).toMatchObject({ statusCode: 403, code: 'email_not_verified' })
      expect(await userRepository.findByEmail(email)).toBeUndefined()
    })

    it('treats the email as verified when only _json.email_verified says so (the two fields disagreeing)', async () => {
      const profile = googleProfile({ emailVerified: false, jsonEmailVerified: true })

      const user = await signInWithGoogle(profile)

      expect(user.emailVerifiedAt).not.toBeNull()
    })

    it('links a google provider to an existing user when Google has verified the matching email', async () => {
      const email = uniqueEmail()
      const existing = await userRepository.create({ email })
      createdIds.push(existing.id)

      const profile = googleProfile({ email, emailVerified: true })
      const user = await signInWithGoogle(profile)

      expect(user.id).toBe(existing.id)
      const link = await authProviderRepository.findByProviderAndId('google', profile.id)
      expect(link?.userId).toBe(existing.id)
      // No second 'email' row is created: existing is seeded directly, so this user has none, and linking must not fabricate one.
      const providers = await authProviderRepository.findByUser(existing.id)
      expect(providers.map((provider) => provider.provider)).toEqual(['google'])
    })

    it('takes over an unverified account on a verified link: verifies the email, revokes its sessions', async () => {
      const email = uniqueEmail()
      const existing = await userRepository.create({ email })
      createdIds.push(existing.id)
      expect(existing.emailVerifiedAt).toBeNull()
      const squatterSession = await issueRefreshToken(existing.id, randomUUID())
      const verifiedEvents: string[] = []
      subscribeDomainEvent('email_verified', (event) => {
        verifiedEvents.push(event.userId)
      })

      const profile = googleProfile({ email, emailVerified: true })
      const user = await signInWithGoogle(profile)

      expect(user.id).toBe(existing.id)
      // The claim's own write verified the row, so it emits email_verified once.
      expect(verifiedEvents.filter((userId) => userId === existing.id)).toHaveLength(1)
      expect(user.emailVerifiedAt).toBeInstanceOf(Date)
      const reread = await userRepository.findById(existing.id)
      expect(reread?.emailVerifiedAt).toBeInstanceOf(Date)
      const link = await authProviderRepository.findByProviderAndId('google', profile.id)
      expect(link?.userId).toBe(existing.id)

      const refreshResponse = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${testRefreshCookie().name}=${squatterSession.raw}`)
      expect(refreshResponse.status).toBe(401)
    })

    it("drops a squatter's own pre-existing Google link when a different, verified identity claims the account", async () => {
      // Seeded directly, because no API path creates it: a squatter's Google row on a never-verified account the real owner now claims.
      const email = uniqueEmail()
      const existing = await userRepository.create({ email })
      createdIds.push(existing.id)
      const squatterGoogleId = randomUUID()
      await authProviderRepository.create({
        userId: existing.id,
        provider: 'google',
        providerId: squatterGoogleId,
      })

      const profile = googleProfile({ email, emailVerified: true })
      const user = await signInWithGoogle(profile)

      expect(user.id).toBe(existing.id)
      // The squatter's identity no longer resolves to this account at all.
      expect(
        await authProviderRepository.findByProviderAndId('google', squatterGoogleId)
      ).toBeUndefined()
      // The claimer's identity does.
      const claimerLink = await authProviderRepository.findByProviderAndId('google', profile.id)
      expect(claimerLink?.userId).toBe(existing.id)
    })

    it('never moves an existing, earlier emailVerifiedAt timestamp when linking', async () => {
      const email = uniqueEmail()
      const existing = await userRepository.create({ email })
      createdIds.push(existing.id)
      await sql`
        update users set email_verified_at = now() - interval '30 days'
        where id = ${existing.id}
      `
      // Re-read through the repository, not the raw sql result above: the shared postgres.js client returns a raw query's timestamp column as a string (drizzle-orm's driver installs a passthrough parser), not a Date.
      const alreadyVerified = await userRepository.findById(existing.id)
      expect(alreadyVerified?.emailVerifiedAt).toBeInstanceOf(Date)

      const profile = googleProfile({ email, emailVerified: true })
      const user = await signInWithGoogle(profile)

      expect(user.emailVerifiedAt?.getTime()).toBe(alreadyVerified?.emailVerifiedAt?.getTime())
    })

    it('answers an unverified Google email the same, at the same cost, whether or not the address is registered', async () => {
      const { getMaintenanceMode } =
        await import('@/services/maintenance-mode/maintenance-mode-store.service')
      expect(getMaintenanceMode().mode).toBe('off')
      const { UserRepository: Users } = await import('@/repositories/user.repository')
      const registered = await userRepository.create({ email: uniqueEmail() })
      createdIds.push(registered.id)
      const profiles = {
        registered: googleProfile({ email: registered.email, emailVerified: false }),
        unknown: googleProfile({ email: uniqueEmail(), emailVerified: false }),
      }

      const answers: Record<string, unknown> = {}
      const emailReads: Record<string, number> = {}
      for (const [name, profile] of Object.entries(profiles)) {
        const findByEmail = vi.fn(Users.prototype.findByEmail.bind(userRepository))
        await withMutatedMethod(Users.prototype, 'findByEmail', findByEmail, async () => {
          try {
            await signInWithGoogle(profile)
            answers[name] = 'signed in'
          } catch (error) {
            answers[name] =
              error instanceof Error
                ? { type: error.constructor.name, ...error, message: error.message }
                : error
          }
        })
        emailReads[name] = findByEmail.mock.calls.length
      }

      expect(answers.registered).toEqual(answers.unknown)
      expect(answers.unknown).toMatchObject({ statusCode: 403, code: 'email_not_verified' })
      expect(emailReads.registered).toBe(emailReads.unknown)
      // Refused before the lookup, so neither address is ever read.
      expect(emailReads.unknown).toBe(0)
    })

    it('looks the account up once outside full maintenance, where the sign-in check reads nothing', async () => {
      const { getMaintenanceMode } =
        await import('@/services/maintenance-mode/maintenance-mode-store.service')
      expect(getMaintenanceMode().mode).toBe('off')
      const { AuthProviderRepository: Providers } =
        await import('@/repositories/auth-provider.repository')
      const { UserRepository: Users } = await import('@/repositories/user.repository')
      const findByProviderAndId = vi.fn(
        Providers.prototype.findByProviderAndId.bind(authProviderRepository)
      )
      const findByEmail = vi.fn(Users.prototype.findByEmail.bind(userRepository))

      await withMutatedMethod(Providers.prototype, 'findByProviderAndId', findByProviderAndId, () =>
        withMutatedMethod(Users.prototype, 'findByEmail', findByEmail, async () => {
          await signInWithGoogle(googleProfile({ email: uniqueEmail(), emailVerified: true }))
        })
      )

      // Only `resolveGoogleUser`'s own lookups: the link, then the address.
      expect(findByProviderAndId).toHaveBeenCalledTimes(1)
      expect(findByEmail).toHaveBeenCalledTimes(1)
    })

    it('rejects linking an unverified Google email to an existing user (account-takeover guard)', async () => {
      const email = uniqueEmail()
      const existing = await userRepository.create({ email })
      createdIds.push(existing.id)

      const profile = googleProfile({ email, emailVerified: false })

      await expect(completeGoogleSignIn(profile, 'web')).rejects.toMatchObject({
        statusCode: 403,
        code: 'email_not_verified',
      })

      const link = await authProviderRepository.findByProviderAndId('google', profile.id)
      expect(link).toBeUndefined()
      const untouched = await userRepository.findById(existing.id)
      expect(untouched?.emailVerifiedAt).toBeNull()
    })

    it('returns the linked user directly on a returning Google sign-in, creating nothing new', async () => {
      const profile = googleProfile({ emailVerified: true })
      const first = await signInWithGoogle(profile)

      const second = await signInWithGoogle(profile)

      expect(second.id).toBe(first.id)
      const providers = await authProviderRepository.findByUser(first.id)
      expect(providers).toHaveLength(2)
    })

    it('rejects (with a 4xx, not a 500) a returning Google sign-in whose linked user was soft-deleted', async () => {
      // Reachable, not theoretical: auth_providers rows survive a soft delete (only a hard delete cascades), so this is exactly the row findByProviderAndId still finds after softDelete runs.
      const profile = googleProfile({ emailVerified: true })
      const user = await signInWithGoogle(profile)
      await userRepository.softDelete(user.id)

      await expect(completeGoogleSignIn(profile, 'web')).rejects.toMatchObject({
        statusCode: 401,
        code: 'google_auth_failed',
      })
    })

    it("creates a fresh account for a soft-deleted user's email under a different Google identity", async () => {
      const email = uniqueEmail()
      const deleted = await signInWithGoogle(googleProfile({ email, emailVerified: true }))
      await userRepository.softDelete(deleted.id)

      const fresh = await signInWithGoogle(googleProfile({ email, emailVerified: true }))

      expect(fresh.id).not.toBe(deleted.id)
      const providers = await authProviderRepository.findByUser(fresh.id)
      expect(
        providers.map((provider) => provider.provider).toSorted((a, b) => a.localeCompare(b))
      ).toEqual(['email', 'google'])
    })

    it("keeps a deleted user's Google identity off the account a sign-in link creates for the address", async () => {
      const email = uniqueEmail()
      const profile = googleProfile({ email, emailVerified: true })
      const deleted = await signInWithGoogle(profile)
      await userRepository.softDelete(deleted.id)

      // Imported here, not at the top: the helper loads the app, which must load after the Google env stubs.
      const { signInByLink } = await import('../../helpers/sign-in')
      const { userId } = await signInByLink(email)
      createdIds.push(userId)
      const fresh = await userRepository.findByEmail(email)

      expect(fresh?.id).toBe(userId)
      expect(fresh?.id).not.toBe(deleted.id)
      await expect(completeGoogleSignIn(profile, 'web')).rejects.toMatchObject({
        statusCode: 401,
        code: 'google_auth_failed',
      })
      const freshProviders = await authProviderRepository.findByUser(fresh?.id ?? '')
      expect(freshProviders.map((provider) => provider.provider)).toEqual(['email'])
    })

    it('rejects a Google profile that carries no email at all, and writes no row', async () => {
      const profile = googleProfile({ includeEmails: false })
      try {
        await expect(completeGoogleSignIn(profile, 'web')).rejects.toMatchObject({
          statusCode: 400,
          code: 'google_email_missing',
        })
      } finally {
        const links = await sql<{ user_id: string }[]>`
          select user_id from auth_providers where provider = 'google' and provider_id = ${profile.id}`
        createdIds.push(...links.map((link) => link.user_id))
        expect(links).toHaveLength(0)
      }
    })

    it('lowercases the Google email before matching it against an existing user', async () => {
      const email = uniqueEmail()
      const existing = await userRepository.create({ email })
      createdIds.push(existing.id)

      const profile = googleProfile({ email: email.toUpperCase(), emailVerified: true })
      const user = await signInWithGoogle(profile)

      expect(user.id).toBe(existing.id)
    })
  })

  it('issues no session when the account is deactivated between lookup and issue', async () => {
    // completeGoogleSignIn re-reads the user under its row lock before issuing.
    const { UserRepository: Users } = await import('@/repositories/user.repository')
    // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
    const realUpdate = Users.prototype.update
    const email = `google-race-${randomUUID()}@example.test`
    const profile = googleProfile({ email, emailVerified: true })
    const { refreshToken: created } = await completeGoogleSignIn(profile, 'web')
    createdIds.push(created.userId)
    await sql`delete from user_tokens where user_id = ${created.userId}`
    /**
     * An `update` that deactivates the user right after the real write, opening a gap between
     * lookup and issue.
     */
    const deactivating: typeof realUpdate = async function (
      this: InstanceType<typeof Users>,
      ...arguments_
    ) {
      const result = await realUpdate.apply(this, arguments_)
      await sql`update users set active = false where id = ${created.userId}`
      return result
    }
    await withMutatedMethod(Users.prototype, 'update', deactivating, async () => {
      await expect(completeGoogleSignIn(profile, 'web')).rejects.toMatchObject({ statusCode: 401 })
    })
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from user_tokens where user_id = ${created.userId}
    `
    expect(row?.count).toBe(0)
  })
})
