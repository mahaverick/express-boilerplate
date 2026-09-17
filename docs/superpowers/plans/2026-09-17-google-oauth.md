# Google OAuth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google OAuth login via Passport.js with an `auth_providers` table tracking all auth methods, express-session scoped to OAuth routes, and the existing JWT refresh flow for ongoing auth.

**Architecture:** Passport.js redirects to Google, the callback finds or creates a user in `auth_providers`, issues a refresh token cookie, and redirects to the frontend. The frontend calls the existing `POST /auth/refresh` to get an access token. Sessions are only used during the OAuth round-trip (5-minute TTL in Redis). Email is tracked as a provider via a seed migration and `register()` insertion.

**Tech Stack:** Passport.js 0.7, passport-google-oauth20 2.x, express-session 1.19, connect-redis 10.x, Drizzle ORM.

**Spec:** `docs/superpowers/specs/2026-09-17-google-oauth-design.md`

## Global Constraints

- TypeScript pinned `~6.0.3`
- Zod 4.6.5
- No barrel files — import directly
- `getEnv()` is lazy and memoised
- File naming: `src/repositories/*.repository.ts`, `src/configs/*.config.ts`, `src/database/models/*.model.ts`
- `pnpm db:migration:generate` generates migrations — commit SQL + `meta/`
- Pre-commit runs `eslint` + `vitest --changed HEAD` (excluding `tests/integration/**`)
- Tests that hit Docker MUST live under `tests/integration/`
- FKs use `.references(() => userModel.id, { onDelete: 'cascade' })`
- `setRefreshTokenCookie` (auth.controller.ts:124) uses `sameSite: 'strict'` — the OAuth callback MUST use `'lax'` instead (cross-site redirect from Google breaks `strict` in Safari)
- `db` from `@/services/database.service` (NOT `getDatabase()`)
- `exactOptionalPropertyTypes: true` — conditional object construction
- `connect-redis` v10 uses `import { RedisStore } from 'connect-redis'` (class import, not factory)
- `getRedis()` is async — node-redis v4+ queues commands before connect, so passing the client before `await` may work, but verify empirically

## Spec Corrections (rulings against the spec)

1. **Spec §1 `access_token`/`refresh_token` columns:** Drop both. Nothing in the spec reads them — no revocation endpoint, no Google API calls. Storing unencrypted third-party credentials with no consumer violates the "field nobody reads" anti-pattern (user.model.ts header). Add when a revocation flow lands.
2. **Spec §3 email-match linking without verified check:** Gate linking by email on Google's `email_verified`. An unverified Google email matching an existing user = account takeover. Unverified + no existing user → create with `emailVerifiedAt: null`.
3. **Spec §3 `sameSite` on callback cookie:** The callback sets a refresh cookie after a cross-site redirect from Google. `sameSite: 'strict'` (the existing login flow's default) may not send the cookie on the frontend's immediate next request in Safari. Use `'lax'` for the OAuth-set cookie. The existing `setRefreshTokenCookie` keeps `'strict'` for the regular login flow — create a separate function or parameterize it.
4. **Spec §3 `passport.authenticate` session:** Use `session: false` on the callback's `passport.authenticate()`. The session is only for the OAuth state parameter during the redirect. After the callback, the user gets a JWT — no Passport serialization needed.
5. **Spec §3 profile.emails guard:** `profile.emails` can be undefined or empty. Guard with `profile.emails?.[0]?.value`, reject if missing.
6. **Spec §4 GOOGLE_CLIENT_ID/SECRET pairing:** Both `.optional()` in Zod (can't use `.refine()` on the schema — breaks `EnvSchema.pick()`). `passport.config.ts` checks pairing at strategy-registration time and throws if only one is set.
7. **Spec §3 step 3b (new user creation):** A brand-new OAuth user gets BOTH an email provider row and a google provider row. The email provider uses the Google email as `providerId`.

---

### Task 1: Auth Providers Model + Migration + Repository

**Files:**

- Create: `src/database/models/auth-provider.model.ts`
- Create: `src/repositories/auth-provider.repository.ts`
- Create: `src/constants/auth-provider.constants.ts`
- Create: `src/database/migrations/XXXX_*.sql` (generated)
- Create: `tests/integration/repositories/auth-provider.repository.test.ts`

**Interfaces:**

- Consumes: `userModel` from `@/database/models/user.model` (FK)
- Consumes: `db` from `@/services/database.service`
- Produces: `authProviderModel` — Drizzle table definition
- Produces: `AuthProviderRecord`, `NewAuthProvider` — inferred types
- Produces: `AUTH_PROVIDERS`, `AuthProvider` — type constants
- Produces: `AuthProviderRepository`:
  - `findByProviderAndId(provider, providerId): Promise<AuthProviderRecord | undefined>`
  - `findByUser(userId): Promise<AuthProviderRecord[]>`
  - `create(data): Promise<AuthProviderRecord>`

- [ ] **Step 1: Create `src/constants/auth-provider.constants.ts`**

```typescript
export const AUTH_PROVIDERS = ['email', 'google'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]
```

- [ ] **Step 2: Create `src/database/models/auth-provider.model.ts`**

Table: `auth_providers` with `id`, `userId` (FK cascade), `provider` (varchar 20), `providerId` (varchar 255), `createdAt`, `updatedAt`. NO `access_token`/`refresh_token` columns (spec correction #1).

Unique constraint on `(provider, provider_id)`. Index on `(user_id)`.

- [ ] **Step 3: Generate migration**

```bash
pnpm db:migration:generate
```

The generated SQL creates the table. After the CREATE TABLE, add a raw SQL data migration to seed existing email/password users:

```sql
INSERT INTO auth_providers (id, user_id, provider, provider_id, created_at, updated_at)
SELECT uuidv7(), id, 'email', email, now(), now()
FROM users
WHERE password_hash IS NOT NULL;
```

If drizzle-kit doesn't include the seed (it only generates schema diffs), add the INSERT manually to the generated SQL file. Verify with `pnpm db:migrate`.

- [ ] **Step 4: Create `src/repositories/auth-provider.repository.ts`**

Standalone class (no BaseRepository — `auth_providers` has `updatedAt` but no `deletedAt`, and BaseRepository's soft-delete policy isn't needed).

Methods: `findByProviderAndId`, `findByUser`, `create`.

- [ ] **Step 5: Write integration tests**

Create `tests/integration/repositories/auth-provider.repository.test.ts`:

- Create email provider for a user, find by provider+id
- Create google provider, find by provider+id
- findByUser returns all providers
- Unique constraint prevents duplicate provider+id
- Cascade delete: deleting user removes providers
- findByProviderAndId returns undefined for non-existent

- [ ] **Step 6: Run tests, commit**

```bash
pnpm test && pnpm lint
git commit -m "feat: add auth_providers model, migration with email seed, and repository"
```

---

### Task 2: Passport Config + Session Middleware + Google Redirect

**Files:**

- Create: `src/configs/passport.config.ts`
- Modify: `src/configs/env.config.ts` (add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
- Modify: `src/routes/auth.routes.ts` (add `GET /auth/google` with session + passport middleware)
- Modify: `package.json` (add passport, passport-google-oauth20, express-session, connect-redis, @types/*)
- Create: `tests/integration/api/google-oauth.test.ts` (redirect test)

**Interfaces:**

- Consumes: `getEnv()` — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `APP_URL`
- Consumes: `getRedis()` from `@/services/redis.service` (for connect-redis store)
- Produces: `configurePassport()` — registers Google strategy when credentials present
- Produces: `oauthSessionMiddleware` — express-session scoped to OAuth routes
- Produces: `isGoogleOAuthEnabled()` — check if credentials are configured

- [ ] **Step 1: Install dependencies**

```bash
pnpm add passport passport-google-oauth20 express-session connect-redis @types/passport @types/passport-google-oauth20 @types/express-session
```

- [ ] **Step 2: Add env vars**

In `env.config.ts`, add after the existing fields:

```typescript
GOOGLE_CLIENT_ID: z.string().optional().describe('Google OAuth 2.0 client ID. When absent, Google login is disabled.'),
GOOGLE_CLIENT_SECRET: z.string().optional().describe('Google OAuth 2.0 client secret. Required when GOOGLE_CLIENT_ID is set.'),
```

Both `.optional()` — Zod can't express "required together" without `.refine()` on the schema (breaks `EnvSchema.pick()`). The pairing check happens in `passport.config.ts`.

Update `SESSION_SECRET`'s `.describe()` to remove "PLACEHOLDER — nothing reads this" since it's now used.

- [ ] **Step 3: Create `src/configs/passport.config.ts`**

```typescript
import { RedisStore } from 'connect-redis'
import session from 'express-session'
import passport from 'passport'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20'
import { getEnv } from '@/configs/env.config'
import { isSecureCookieEnvironment } from '@/controllers/auth.controller'
import { logger } from '@/services/logger.service'
import { getRedis } from '@/services/redis.service'

export function isGoogleOAuthEnabled(): boolean {
  const env = getEnv()
  return env.GOOGLE_CLIENT_ID !== undefined
}

export function configurePassport(handleGoogleVerify: Function): void {
  const env = getEnv()
  if (!env.GOOGLE_CLIENT_ID) return

  if (!env.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set')
  }

  passport.use(
    'google',
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${env.APP_URL}/api/v1/auth/google/callback`,
        scope: ['profile', 'email'],
        state: true,
      },
      handleGoogleVerify
    )
  )

  logger.info('Google OAuth strategy registered')
}

export function createOAuthSessionMiddleware() {
  const env = getEnv()
  return session({
    store: new RedisStore({ client: getRedis() }),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'oauth.sid',
    cookie: {
      maxAge: 5 * 60 * 1000,
      httpOnly: true,
      secure: isSecureCookieEnvironment(),
      sameSite: 'lax',
    },
  })
}
```

**Key:** `createOAuthSessionMiddleware` calls `getRedis()` which is async/lazy. `connect-redis` v10 with node-redis v4+ should accept the client — node-redis queues commands until connected. Verify empirically. If it doesn't work, use a wrapper middleware that awaits the client on first request.

**Key:** `session: false` will be on the callback's `passport.authenticate()` (Task 3), not here. The strategy needs `state: true` which reads `req.session` on the initiate step and writes/reads it on the callback.

- [ ] **Step 4: Wire `GET /auth/google` in routes**

In `auth.routes.ts`, add:

```typescript
import passport from 'passport'
import { createOAuthSessionMiddleware, isGoogleOAuthEnabled } from '@/configs/passport.config'

// Only mount OAuth routes when Google credentials are configured
if (isGoogleOAuthEnabled()) {
  const oauthSession = createOAuthSessionMiddleware()
  router.get(
    '/google',
    oauthSession,
    passport.initialize(),
    passport.authenticate('google', { scope: ['profile', 'email'] })
  )
  // callback route added in Task 3
}
```

- [ ] **Step 5: Write redirect test**

In `tests/integration/api/google-oauth.test.ts`:

- `GET /auth/google` responds with 302 redirect
- Location header contains `accounts.google.com`, `client_id=`, `redirect_uri=`, `scope=`, `state=`
- If `GOOGLE_CLIENT_ID` is unset in test env, the route returns 404 (not mounted)

**For testing:** Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to test values in the test file (they don't need to be real — the redirect URL is constructed locally, it's never exchanged with Google). Use `process.env` override before importing the app, or `vi.stubEnv`.

- [ ] **Step 6: Run tests, commit**

```bash
pnpm test && pnpm lint
git commit -m "feat: add Passport.js config, session middleware, and Google OAuth redirect"
```

---

### Task 3: Google Callback Controller + User Linking

**Files:**

- Modify: `src/controllers/auth.controller.ts` (add `handleGoogleCallback`, `findOrCreateByGoogle`)
- Modify: `src/routes/auth.routes.ts` (add `GET /auth/google/callback`)
- Modify: `tests/integration/api/google-oauth.test.ts` (callback tests)

**Interfaces:**

- Consumes: `AuthProviderRepository` from `@/repositories/auth-provider.repository`
- Consumes: `UserRepository` from `@/repositories/user.repository`
- Consumes: `issueRefreshToken` from `@/utilities/token.utilities`
- Consumes: `db.transaction()` from Drizzle for atomic user+provider creation
- Produces: `handleGoogleCallback` — Express handler for the callback route

- [ ] **Step 1: Add `findOrCreateByGoogle` to auth.controller.ts**

The core linking logic:

1. Look up `auth_providers` by `(google, profile.id)`
2. If found → load user, return
3. If not found → check `profile.emails[0].verified` (or `_json.email_verified`)
4. Look up user by email
5. If user exists AND Google email is verified → link Google provider
6. If user exists AND Google email NOT verified → reject (account takeover risk)
7. If no user → create new user (`passwordHash: null`) + email provider + Google provider in a transaction
8. Set `emailVerifiedAt` if Google says verified and not already set
9. Return user

**CRITICAL:** Step 6 — do NOT link an unverified Google email to an existing user. Redirect to `${WEB_URL}/login?error=email_not_verified`.

**Transaction:** Step 7 uses `db.transaction(async (tx) => { ... })` for the user + providers creation. If any insert fails, everything rolls back.

- [ ] **Step 2: Add `handleGoogleCallback` to auth.controller.ts**

The callback handler:

```typescript
export function handleGoogleCallback(request, response, next) {
  const env = getEnv()
  passport.authenticate('google', { session: false }, async (error, profile, info) => {
    if (error || !profile) {
      return response.redirect(`${env.WEB_URL}/login?error=google_auth_failed`)
    }
    try {
      const user = await findOrCreateByGoogle(profile)
      await userRepository.update(user.id, { lastLoggedInAt: new Date() })
      const sessionId = randomUUID()
      const refreshToken = await issueRefreshToken(user.id, sessionId)
      // Use 'lax' for OAuth callback — 'strict' breaks cross-site redirect
      setOAuthRefreshTokenCookie(response, refreshToken.raw, refreshToken.expiresAt)
      response.redirect(`${env.WEB_URL}/auth/callback`)
    } catch (error) {
      logger.error('Google OAuth callback failed', { error })
      response.redirect(`${env.WEB_URL}/login?error=processing_failed`)
    }
  })(request, response, next)
}
```

**Key:** `session: false` on the callback's authenticate — don't serialize user to session.

**Key:** `setOAuthRefreshTokenCookie` is a new function (or parameterized `setRefreshTokenCookie`) that uses `sameSite: 'lax'` instead of `'strict'`.

- [ ] **Step 3: Wire the callback route**

In `auth.routes.ts`, inside the `isGoogleOAuthEnabled()` block:

```typescript
router.get('/google/callback', oauthSession, passport.initialize(), handleGoogleCallback)
```

- [ ] **Step 4: Write callback tests**

Since you can't hit Google in tests, use one of these approaches:

- Register a mock Passport strategy under the `'google'` name when `NODE_ENV === 'test'` that calls `verify` directly with a fixture profile
- OR test `findOrCreateByGoogle` as a unit against the real DB, plus assert the redirect route structure

Test scenarios:

- New Google user (no existing account) → creates user + both providers + refresh cookie + redirect
- Existing email user + verified Google email → links provider + login
- Existing email user + unverified Google email → redirect to error
- Returning Google user → updates tokens + login
- Missing email in profile → redirect to error
- Verify `emailVerifiedAt` is set when Google says verified
- Verify `lastLoggedInAt` is updated
- Verify refresh cookie is set with `sameSite: 'lax'` (not `strict`)

- [ ] **Step 5: Run tests, commit**

```bash
pnpm test && pnpm lint
git commit -m "feat: add Google OAuth callback with user linking and verified-email gate"
```

---

### Task 4: Register + Seed Wiring + Docs

**Files:**

- Modify: `src/controllers/auth.controller.ts` — `register()` creates email provider row
- Modify: `CLAUDE.md` — document OAuth conventions
- Modify: `.env.example` — regenerated
- Modify: `src/configs/env.config.ts` — update SESSION_SECRET and APP_URL descriptions

- [ ] **Step 1: Update `register()` to create email provider**

After `userRepository.create()` succeeds (inside the existing try/catch), create the provider row:

```typescript
const created = await userRepository.create({ ... })
await authProviderRepository.create({
  userId: created.id,
  provider: 'email',
  providerId: input.email,
})
```

Both inserts should be in a transaction (`db.transaction()`) so they're atomic. If the provider insert fails, the user creation rolls back.

- [ ] **Step 2: Update env.config.ts descriptions**

- `SESSION_SECRET`: remove "PLACEHOLDER — nothing reads this" from `.describe()`, replace with "Signs express-session cookies for the OAuth round-trip. Any 32+ character string works; use `openssl rand -hex 32`."
- `APP_URL`: remove "PLACEHOLDER — nothing reads it yet", replace with "Public origin of this API. Used for OAuth callback URLs — must match a redirect URI registered in Google Cloud Console exactly."

- [ ] **Step 3: Regenerate .env.example**

```bash
pnpm env:example
```

- [ ] **Step 4: Update CLAUDE.md**

Add after "## Notifications":

```markdown
## OAuth

- **Google OAuth is optional.** When `GOOGLE_CLIENT_ID` is unset, the OAuth
  routes are not mounted. When set, `GOOGLE_CLIENT_SECRET` must also be set
  — `passport.config.ts` throws at boot if only one is present.
- **`auth_providers` tracks all auth methods.** Email users get a row with
  `provider: 'email'` at registration. Google users get both an `'email'`
  and a `'google'` row. A user with `passwordHash: null` is federated-only
  (they use forgot-password to set a password if they want one).
- **Email-match linking requires Google's `email_verified`.** An unverified
  Google email matching an existing account is rejected — linking without
  verification would be an account takeover.
- **The OAuth callback's refresh cookie uses `sameSite: 'lax'`**, not the
  regular login's `'strict'`. The callback is a cross-site redirect from
  Google; `strict` can fail in Safari on the immediate next same-site request.
- **`APP_URL` must match Google Cloud Console's redirect URI exactly** —
  including scheme and trailing slash. `http://localhost:4040` works for
  development.
- **Sessions are OAuth-scoped only.** `express-session` middleware runs on
  `/auth/google` and `/auth/google/callback` only (5-minute TTL). The rest
  of the API is stateless (JWT).
```

- [ ] **Step 5: Update existing test fixtures**

Any test that constructs a full `Env` object (mailer.config.test.ts, auth.controller.test.ts) needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` added (both can be `undefined` since they're optional).

- [ ] **Step 6: Run all tests, commit**

```bash
pnpm test && pnpm lint
git commit -m "feat: wire email provider creation in register and document OAuth conventions"
```
