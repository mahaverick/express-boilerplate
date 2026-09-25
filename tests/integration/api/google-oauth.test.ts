// tests/integration/api/google-oauth.test.ts
//
// Exercises the REAL `createOAuthSessionMiddleware()` against the real,
// per-worker Redis instance (REDIS_URL in .env.test) — not a mock. That is
// the whole point of this file existing under tests/integration/, not
// tests/unit/: the brief this task was built from flagged
// `new RedisStore({ client: getRedis() })` as something to "verify
// empirically" rather than assume, and the only way to actually verify it
// is to run a real request through a real connect-redis `RedisStore` backed
// by a real node-redis client and see whether the OAuth redirect (which
// needs `req.session` for the `state` CSRF parameter) actually works.
// passport.config.ts's own header comment explains why the naive version
// (handing `RedisStore` the un-awaited `Promise<RedisClientType>` the brief's
// own sketch used) does NOT work, and this file is what proves the lazy-latch
// replacement does.
//
// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are set in `beforeAll`, via a
// DYNAMIC `import('@/app')` — not a static `import` at the top of this
// file, and not merely "set before calling `createApp()`" the way a first
// draft of this file tried. Verified empirically, the hard way: a static
// `import { createApp } from '@/app'` at the top of the file, with
// `process.env.GOOGLE_CLIENT_ID` set inside `beforeAll` immediately before
// calling `createApp()`, still produced a 404 — because `@/app` transitively
// imports `database.service.ts`, which calls `const env = getEnv()` at ITS
// OWN module scope. A static import's entire dependency graph evaluates
// before ANY of THIS file's own top-level code runs (that is what "static"
// means for a module graph) — so `getEnv()` was already memoised, without
// `GOOGLE_CLIENT_ID`, before `beforeAll` (or anything else in this file)
// ever got a chance to run, regardless of where the `import` statement sat
// in the file or when `createApp()` was actually CALLED. A dynamic
// `import()` has no such hoisting: it evaluates exactly where it is
// awaited, so performing it inside `beforeAll`, after the `process.env`
// assignments, is what actually gets `GOOGLE_CLIENT_ID` into `getEnv()`'s
// first (and only) parse. They are never real Google credentials —
// passport's Google strategy builds the redirect URL locally from
// `clientID`/`scope`/`callbackURL`; nothing in this test ever calls Google.
//
// A SEPARATE file, google-oauth-disabled.test.ts, covers the opposite env
// state (no Google credentials at all — this repo's actual .env.test
// default). That cannot live in this file: `getEnv()` memoises the first
// environment it parses for the life of this worker process, so once
// `createApp()` below has run with GOOGLE_CLIENT_ID set, no later test in
// this same file could ever observe it unset without `vi.resetModules()` —
// which discards this whole worker's module cache, including
// database.service.ts's live postgres pool (tests/helpers/mutate.ts's own
// header comment on `withMutatedModule` explains the leak). Two small,
// cheap files avoid paying that cost for a distinction this simple.
//
// `vi.stubEnv`, not a raw `process.env.GOOGLE_CLIENT_ID = ...` assignment —
// `tests/helpers/worker-database.ts`'s own header comment establishes that
// `process.env` persists ACROSS test files within one forked worker
// process (only the module registry resets between files, per
// tests/helpers/setup-global.ts). A raw assignment here would leak
// `GOOGLE_CLIENT_ID` into whichever file vitest schedules next in this
// worker — including google-oauth-disabled.test.ts, whose entire premise is
// that variable being unset. `afterAll(() => vi.unstubAllEnvs())` restores
// the prior value (here, genuinely absent, since `.env.test` never sets it)
// rather than merely deleting the key, so this file leaves no trace on
// `process.env` for whatever runs after it in the same worker.
import { randomUUID } from 'node:crypto'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'
import { GOOGLE_STRATEGY_NAME, REFRESH_TOKEN_COOKIE_NAME } from '@/constants/auth.constants'
import type { findOrCreateByGoogle as FindOrCreateByGoogleType } from '@/controllers/auth.controller'
import type { AuthProviderRepository as AuthProviderRepositoryClass } from '@/repositories/auth-provider.repository'
import type { UserRepository as UserRepositoryClass } from '@/repositories/user.repository'
import type { sql as SqlType } from '@/services/database.service'
import type { issueRefreshToken as IssueRefreshTokenType } from '@/services/session.service'
import { request } from '../../helpers/request'

/**
 * The `state` query parameter off a Google OAuth redirect URL, if present.
 * Module-scoped rather than declared inside a test — a closure with no
 * reference to anything in its enclosing test's scope has no reason to be
 * redeclared on every run.
 * @param location - The `Location` header from a `GET /auth/google` response.
 * @returns The `state` value, or undefined when absent.
 */
function stateOf(location: string | undefined): string | undefined {
  return location ? (new URL(location).searchParams.get('state') ?? undefined) : undefined
}

/**
 * A disposable email, unique to one test run — avoids colliding with rows
 * any other test in this worker's shared database may be holding onto. Same
 * convention as every other integration file's own `uniqueEmail` helper
 * (e.g. forgot-password.test.ts).
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `google-oauth-${randomUUID()}@example.test`
}

/**
 * Build a fixture Google profile shaped exactly like what
 * `passthroughGoogleProfile` (passport.config.ts) hands `done()` — the raw
 * value `findOrCreateByGoogle` (auth.controller.ts) receives, with none of
 * this repo's own account-linking logic run yet. Every field
 * `findOrCreateByGoogle` actually reads (`id`, `emails[0].value`,
 * `emails[0].verified`, `_json.email_verified`) is controllable via
 * `overrides`; every other field is a plausible constant, since nothing
 * under test reads it.
 * @param overrides - Which fields to vary for one test.
 * @param overrides.id - Google's stable profile id. Defaults to a fresh UUID.
 * @param overrides.email - The email Google reports. Defaults to a fresh unique address.
 * @param overrides.emailVerified - `emails[0].verified`. Defaults to true.
 * @param overrides.jsonEmailVerified - `_json.email_verified`. Defaults to the same value as `emailVerified`, so a test only needs to override it to exercise the two disagreeing.
 * @param overrides.includeEmails - Set false to omit `emails` entirely — the "Google shared no email" case.
 * @returns A fixture satisfying `passport-google-oauth20`'s `Profile` type.
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
    // Omitted entirely, not set to `undefined`, for the "no email" fixture
    // — `exactOptionalPropertyTypes: true` (tsconfig.json) rejects an
    // explicit `undefined` for an optional property, the same distinction
    // this codebase's own controllers draw elsewhere (e.g. the JSON-`null`
    // vs `undefined` comments in auth.controller.ts).
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
 * A Passport `Strategy` that skips the OAuth2 dance entirely and calls
 * `this.success(profile)` the instant it authenticates a request — the
 * brief's own "option 1" for testing a callback that can never reach the
 * real Google. `configurePassport()` (passport.config.ts) registers the
 * REAL `GoogleStrategy` under `GOOGLE_STRATEGY_NAME`; `passport.use(name,
 * strategy)` (passport's own API) simply overwrites whatever was previously
 * registered under that name, so swapping this in for one test and calling
 * `configurePassport()` again afterwards (real `afterEach`, below) is
 * enough to restore it for every other test in this file — no
 * `vi.resetModules()`, no mocking `passport-google-oauth20` itself.
 *
 * Exists specifically to drive `handleGoogleCallback`'s SUCCESS path over
 * real HTTP, which neither the `findOrCreateByGoogle` suite (calls the
 * function directly, never touches the route, the cookie, or
 * `passport.authenticate`'s own plumbing) nor the "no live OAuth attempt"
 * tests above (deliberately drive the FAILURE path) can reach — and two of
 * this task's brief's own CRITICAL rules only show up on that path:
 * `sameSite: 'lax'` on the response cookie, and `lastLoggedInAt` actually
 * being written.
 */
class FakeGoogleSuccessStrategy implements passport.Strategy {
  name = GOOGLE_STRATEGY_NAME

  // Public, not private: `authenticate`'s `this: passport.StrategyCreated<...>`
  // parameter type is a MAPPED type passport's own `.d.ts` builds from
  // `keyof (FakeGoogleSuccessStrategy & StrategyCreatedStatic)`, computed
  // outside this class's lexical scope — a `private` field is not visible
  // through that reconstructed type, even from inside this method, so
  // `this.profile` would not type-check. A public field carries no risk
  // here: this class exists only inside this test file, for one test's
  // duration.
  constructor(readonly profile: GoogleProfile) {}

  authenticate(this: passport.StrategyCreated<FakeGoogleSuccessStrategy>): void {
    // The cast mirrors `passthroughGoogleProfile`'s own (passport.config.ts):
    // `Express.User` is this codebase's JWT principal type; a raw Google
    // profile is what a real `done(null, profile)` call resolves to for
    // the SAME strategy in production, so `handleGoogleCallback`'s custom
    // callback receives an identically-shaped value either way.
    // eslint-disable-next-line unicorn/no-undeclared-class-members -- `success` is never a member of THIS class; passport injects it at runtime onto the per-request instance `this` refers to (`StrategyCreatedStatic`, passport's own `.d.ts`), which is exactly what `authenticate`'s `this: passport.StrategyCreated<...>` parameter type documents.
    this.success(this.profile as unknown as Express.User)
  }
}

describe('GET /api/v1/auth/google (Google OAuth configured)', () => {
  let app: ReturnType<typeof CreateApp>
  let findOrCreateByGoogle: typeof FindOrCreateByGoogleType
  let userRepository: InstanceType<typeof UserRepositoryClass>
  let authProviderRepository: InstanceType<typeof AuthProviderRepositoryClass>
  let sql: typeof SqlType
  let issueRefreshToken: typeof IssueRefreshTokenType

  // Every runtime value this describe block needs is imported DYNAMICALLY,
  // inside `beforeAll`, AFTER the `vi.stubEnv` calls — not just `@/app`.
  // This file's own header comment explains why for `@/app` specifically
  // (a static import's whole dependency graph, including
  // database.service.ts's own module-scope `getEnv()`, evaluates before
  // `beforeAll` ever runs); the identical reasoning applies to EVERY one of
  // these imports, since `@/controllers/auth.controller`,
  // `@/repositories/user.repository`, `@/repositories/auth-provider.repository`,
  // and `@/services/database.service` all transitively reach that same
  // module-scope `getEnv()` call. By the time this `await import('@/app')`
  // resolves, every one of those modules is already loaded (createApp's own
  // dependency graph reaches all of them via auth.routes.ts), so the
  // dynamic imports below just return the already-cached module — this is
  // not a second, independent load.
  beforeAll(async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret')
    const { createApp } = await import('@/app')
    app = createApp()

    const authController = await import('@/controllers/auth.controller')
    findOrCreateByGoogle = authController.findOrCreateByGoogle

    const { UserRepository } = await import('@/repositories/user.repository')
    userRepository = new UserRepository()

    const { AuthProviderRepository } = await import('@/repositories/auth-provider.repository')
    authProviderRepository = new AuthProviderRepository()

    const database = await import('@/services/database.service')
    sql = database.sql

    const sessionService = await import('@/services/session.service')
    issueRefreshToken = sessionService.issueRefreshToken
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  // Every user `findOrCreateByGoogle` creates or seeds below is torn down
  // here — same convention as forgot-password.test.ts/auth-refresh.test.ts.
  // Deleting the user cascades to its `auth_providers` rows
  // (`onDelete: 'cascade'`, auth-provider.model.ts), so nothing separately
  // deletes those.
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

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
    // `resave: false, saveUninitialized: false` (createOAuthSessionMiddleware)
    // still issues a cookie here: the Google strategy's `state: true` writes
    // to `req.session` on this very request (to store the CSRF state value),
    // which is exactly the kind of write saveUninitialized's own semantics
    // do not suppress — only a session left completely untouched is skipped.
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

  describe('GET /api/v1/auth/google/callback', () => {
    // Google itself can never be hit from a test — see this file's own
    // header comment and the brief this task was built from. Two shapes
    // ARE reachable over real HTTP with no Google credentials needed:
    //
    // - No query parameters at all: `passport-oauth2`'s strategy cannot
    //   tell that apart from a FRESH `/google` request (both routes run the
    //   identical `passport.authenticate(GOOGLE_STRATEGY_NAME, ...)`; the
    //   only signal it has is the query string), so it redirects to
    //   Google's consent screen — verified empirically, not assumed: an
    //   earlier draft of this test asserted a `/login?error=` redirect here
    //   and failed with the actual `Location` pointing at
    //   accounts.google.com instead.
    // - `?error=access_denied` — what Google itself sends when a user
    //   cancels its consent screen. `passport-oauth2` checks `req.query.error`
    //   before anything else, so this fails immediately, with no network
    //   call and no session/state needed, calling `handleGoogleCallback`'s
    //   custom callback with `profile: false` — exactly the branch that
    //   redirects to `${WEB_URL}/login?error=...` instead of throwing. This
    //   is what proves the ROUTE ITSELF (rate limiter, session middleware,
    //   `passport.initialize()`, `handleGoogleCallback`) is wired correctly
    //   end to end; the account-linking POLICY behind a successful callback
    //   is exercised directly, against the real database, by the
    //   `findOrCreateByGoogle` suite below.
    it('redirects to Google when hit with no query parameters at all (indistinguishable from a fresh /google request)', async () => {
      const response = await request(app).get('/api/v1/auth/google/callback')

      expect(response.status).toBe(302)
      expect(response.headers.location).toContain('https://accounts.google.com')
    })

    it('redirects to the frontend login with an error when Google reports the user denied consent', async () => {
      const response = await request(app).get('/api/v1/auth/google/callback?error=access_denied')

      expect(response.status).toBe(302)
      expect(response.headers.location).toBeDefined()
      // WEB_URL from .env.test — this file never overrides it, only
      // GOOGLE_CLIENT_ID/SECRET (`beforeAll` above).
      expect(response.headers.location).toContain('http://localhost:5173/login?error=')
    })

    it('never sets a refresh-token cookie for a failed callback', async () => {
      const response = await request(app).get('/api/v1/auth/google/callback?error=access_denied')

      const cookies = response.headers['set-cookie'] as string[] | undefined
      expect(cookies?.some((cookie) => cookie.startsWith('refreshToken='))).not.toBe(true)
    })

    // `FakeGoogleSuccessStrategy` (module scope, above) drives
    // `handleGoogleCallback`'s SUCCESS path over real HTTP — see its own
    // header comment. `configurePassport()` restores the REAL Google
    // strategy after every test here, so nothing above or below this
    // `describe` block observes the swap.
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
        // WEB_URL from .env.test — see the earlier redirect test's own note.
        expect(response.headers.location).toBe('http://localhost:5173/auth/callback')

        const cookies = response.headers['set-cookie'] as string[] | undefined
        const refreshCookie = cookies?.find((cookie) => cookie.startsWith('refreshToken='))
        expect(refreshCookie).toBeDefined()
        // The one property this task's brief calls CRITICAL: `'strict'`
        // (every other cookie this API sets — `setRefreshTokenCookie`'s
        // own default) would be withheld on the very redirect chain this
        // response just started (auth.controller.ts's own header comment
        // on `setOAuthRefreshTokenCookie`), so asserting the literal
        // attribute — not just "a cookie exists" — is the point of this
        // test.
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

      it('redirects to the frontend login with an error and sets no cookie when the resolved user is inactive', async () => {
        const profile = googleProfile({ emailVerified: true })
        const email = profile.emails?.[0]?.value
        if (!email) throw new Error('test fixture has no email')
        const existing = await userRepository.create({ email, passwordHash: 'not-a-real-hash' })
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
    })
  })

  describe('findOrCreateByGoogle (auth.controller.ts)', () => {
    it('creates a new user, an email provider, and a google provider, with emailVerifiedAt set, when Google verified the email', async () => {
      const email = uniqueEmail()
      const profile = googleProfile({ email, emailVerified: true })

      const user = await findOrCreateByGoogle(profile)
      createdIds.push(user.id)

      expect(user.email.toLowerCase()).toBe(email.toLowerCase())
      expect(user.passwordHash).toBeNull()
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
        const user = await findOrCreateByGoogle(profile)
        createdIds.push(user.id)
        outcome = user
      } catch (error) {
        outcome = error
      }

      expect(outcome).toMatchObject({ statusCode: 403, code: 'email_not_verified' })
      expect(await userRepository.findByEmail(email)).toBeUndefined()
    })

    it('treats the email as verified when only _json.email_verified says so (the two fields disagreeing)', async () => {
      const profile = googleProfile({ emailVerified: false, jsonEmailVerified: true })

      const user = await findOrCreateByGoogle(profile)
      createdIds.push(user.id)

      expect(user.emailVerifiedAt).not.toBeNull()
    })

    it('links a google provider to an existing user when Google has verified the matching email', async () => {
      const email = uniqueEmail()
      const existing = await userRepository.create({ email, passwordHash: 'not-a-real-hash' })
      createdIds.push(existing.id)

      const profile = googleProfile({ email, emailVerified: true })
      const user = await findOrCreateByGoogle(profile)

      expect(user.id).toBe(existing.id)
      const link = await authProviderRepository.findByProviderAndId('google', profile.id)
      expect(link?.userId).toBe(existing.id)
      // No second `'email'` row is created. `existing` is seeded directly
      // through `userRepository.create` above, bypassing `register()` —
      // the only place an `'email'` row is written (Task 4,
      // auth.controller.ts) — so this user genuinely has none, and linking
      // must not fabricate one; it only adds the `'google'` row.
      const providers = await authProviderRepository.findByUser(existing.id)
      expect(providers.map((provider) => provider.provider)).toEqual(['google'])
    })

    it('takes over an unverified account on a verified link: clears the password, verifies the email, revokes its sessions', async () => {
      const email = uniqueEmail()
      const existing = await userRepository.create({ email, passwordHash: 'not-a-real-hash' })
      createdIds.push(existing.id)
      expect(existing.emailVerifiedAt).toBeNull()
      const squatterSession = await issueRefreshToken(existing.id, randomUUID())

      const profile = googleProfile({ email, emailVerified: true })
      const user = await findOrCreateByGoogle(profile)

      expect(user.id).toBe(existing.id)
      expect(user.passwordHash).toBeNull()
      expect(user.emailVerifiedAt).toBeInstanceOf(Date)
      const reread = await userRepository.findById(existing.id)
      expect(reread?.passwordHash).toBeNull()
      expect(reread?.emailVerifiedAt).toBeInstanceOf(Date)
      const link = await authProviderRepository.findByProviderAndId('google', profile.id)
      expect(link?.userId).toBe(existing.id)

      const refreshResponse = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${squatterSession.raw}`)
      expect(refreshResponse.status).toBe(401)
    })

    it("drops a squatter's own pre-existing Google link when a different, verified identity claims the account", async () => {
      // Seeded directly, because no API path creates it: a squatter's Google
      // row on a never-verified account the real owner now claims. Pins that
      // the claim removes it, so findOrCreateByGoogle's step 1 cannot honour it.
      const email = uniqueEmail()
      const existing = await userRepository.create({ email, passwordHash: 'not-a-real-hash' })
      createdIds.push(existing.id)
      const squatterGoogleId = randomUUID()
      await authProviderRepository.create({
        userId: existing.id,
        provider: 'google',
        providerId: squatterGoogleId,
      })

      const profile = googleProfile({ email, emailVerified: true })
      const user = await findOrCreateByGoogle(profile)

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
      const existing = await userRepository.create({ email, passwordHash: 'not-a-real-hash' })
      createdIds.push(existing.id)
      await sql`
        update users set email_verified_at = now() - interval '30 days'
        where id = ${existing.id}
      `
      // Re-read through the repository, not the raw `sql` result above —
      // postgres.js's own driver returns a raw query's timestamp column as
      // a string, not a `Date`; every other integration file in this repo
      // re-reads through `findById` for the same reason (see e.g.
      // forgot-password.test.ts's `seedUser`).
      const alreadyVerified = await userRepository.findById(existing.id)
      expect(alreadyVerified?.emailVerifiedAt).toBeInstanceOf(Date)

      const profile = googleProfile({ email, emailVerified: true })
      const user = await findOrCreateByGoogle(profile)

      expect(user.emailVerifiedAt?.getTime()).toBe(alreadyVerified?.emailVerifiedAt?.getTime())
    })

    it('rejects linking an unverified Google email to an existing user (account-takeover guard)', async () => {
      const email = uniqueEmail()
      const existing = await userRepository.create({ email, passwordHash: 'not-a-real-hash' })
      createdIds.push(existing.id)

      const profile = googleProfile({ email, emailVerified: false })

      await expect(findOrCreateByGoogle(profile)).rejects.toMatchObject({
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
      const first = await findOrCreateByGoogle(profile)
      createdIds.push(first.id)

      const second = await findOrCreateByGoogle(profile)

      expect(second.id).toBe(first.id)
      const providers = await authProviderRepository.findByUser(first.id)
      expect(providers).toHaveLength(2)
    })

    it('rejects (with a 4xx, not a 500) a returning Google sign-in whose linked user was soft-deleted', async () => {
      // REACHABLE, not theoretical — see findOrCreateByGoogle's own comment
      // on this branch: `auth_providers` rows survive a soft delete (only a
      // hard delete cascades), so this is exactly the row `findByProviderAndId`
      // still finds after `softDelete` runs.
      const profile = googleProfile({ emailVerified: true })
      const user = await findOrCreateByGoogle(profile)
      createdIds.push(user.id)
      await userRepository.softDelete(user.id)

      await expect(findOrCreateByGoogle(profile)).rejects.toMatchObject({
        statusCode: 401,
        code: 'google_auth_failed',
      })
    })

    it("creates a fresh account for a soft-deleted user's email under a different Google identity", async () => {
      const email = uniqueEmail()
      const deleted = await findOrCreateByGoogle(googleProfile({ email, emailVerified: true }))
      createdIds.push(deleted.id)
      await userRepository.softDelete(deleted.id)

      const fresh = await findOrCreateByGoogle(googleProfile({ email, emailVerified: true }))
      createdIds.push(fresh.id)

      expect(fresh.id).not.toBe(deleted.id)
      const providers = await authProviderRepository.findByUser(fresh.id)
      expect(
        providers.map((provider) => provider.provider).toSorted((a, b) => a.localeCompare(b))
      ).toEqual(['email', 'google'])
    })

    it("keeps a deleted user's Google identity off the account that re-registers the address", async () => {
      const email = uniqueEmail()
      const profile = googleProfile({ email, emailVerified: true })
      const deleted = await findOrCreateByGoogle(profile)
      createdIds.push(deleted.id)
      await userRepository.softDelete(deleted.id)

      const registration = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct horse battery staple' })
      const fresh = await userRepository.findByEmail(email)
      if (fresh) createdIds.push(fresh.id)

      expect(registration.status).toBe(202)
      expect(fresh?.id).toBeDefined()
      expect(fresh?.id).not.toBe(deleted.id)
      await expect(findOrCreateByGoogle(profile)).rejects.toMatchObject({
        statusCode: 401,
        code: 'google_auth_failed',
      })
      const freshProviders = await authProviderRepository.findByUser(fresh?.id ?? '')
      expect(freshProviders.map((provider) => provider.provider)).toEqual(['email'])
    })

    it('rejects a Google profile that carries no email at all', async () => {
      const profile = googleProfile({ includeEmails: false })

      await expect(findOrCreateByGoogle(profile)).rejects.toMatchObject({
        statusCode: 400,
        code: 'google_email_missing',
      })
    })

    it('lowercases the Google email before matching it against an existing user', async () => {
      const email = uniqueEmail()
      const existing = await userRepository.create({ email, passwordHash: 'not-a-real-hash' })
      createdIds.push(existing.id)

      const profile = googleProfile({ email: email.toUpperCase(), emailVerified: true })
      const user = await findOrCreateByGoogle(profile)

      expect(user.id).toBe(existing.id)
    })
  })
})
