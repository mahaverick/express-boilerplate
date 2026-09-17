# Google OAuth — Design Spec

Status: approved in brainstorming
Session: https://claude.ai/code/session_018W6fi5MwVob2Vr1AexY5Mu
Date: 2026-09-17
Stream: 5 of 7 (see `2026-09-16-boilerplate-roadmap.md`)

## Problem

The boilerplate supports only email/password authentication. There is no
federated identity flow, no way to sign in with Google, and no mechanism to
track which authentication providers a user has. The `passwordHash` column
on `users` is already nullable (anticipating federated users), `SESSION_SECRET`
is declared in `env.config.ts` as a placeholder, and `APP_URL` exists but is
unused — all waiting for this stream.

Both Ofluence/core and Consequential/core use Passport.js with Google OAuth.
Ofluence's pattern (separate `auth_providers` table, refresh cookie on callback,
frontend calls `/auth/refresh`) is the reference for this design.

## Solution

Google OAuth via Passport.js with:

- An `auth_providers` table tracking all auth methods (email + Google, extensible)
- Passport.js with `passport-google-oauth20` strategy
- `express-session` + `connect-redis` scoped to OAuth routes only (not global)
- Callback issues refresh token cookie and redirects to frontend
- Frontend calls existing `POST /auth/refresh` to get an access token
- No tokens in URLs

## 1. Auth Providers Model

**File:** `src/database/models/auth-provider.model.ts`

### `auth_providers` table

| Column          | Type                | Constraints                       | Notes                                        |
| --------------- | ------------------- | --------------------------------- | -------------------------------------------- |
| `id`            | `varchar(36)`       | PK, default `uuidv7()`            |                                              |
| `user_id`       | `varchar(36)`       | NOT NULL, FK → `users.id` CASCADE |                                              |
| `provider`      | `varchar(20)`       | NOT NULL                          | `'email'` or `'google'`                      |
| `provider_id`   | `varchar(255)`      | NOT NULL                          | Google: profile ID. Email: the email address |
| `access_token`  | `text`              | nullable                          | Google's OAuth access token                  |
| `refresh_token` | `text`              | nullable                          | Google's OAuth refresh token                 |
| `created_at`    | `timestamp with tz` | NOT NULL, default `now()`         |                                              |
| `updated_at`    | `timestamp with tz` | NOT NULL, default `now()`         |                                              |

Unique constraint on `(provider, provider_id)` — one Google account links to
exactly one user.

Index on `(user_id)` for listing a user's providers.

### Data Migration

Existing email/password users get an `auth_providers` row seeded in the same
migration:

```sql
INSERT INTO auth_providers (id, user_id, provider, provider_id, created_at, updated_at)
SELECT uuidv7(), id, 'email', email, now(), now()
FROM users
WHERE password_hash IS NOT NULL;
```

This makes the providers table the single source of truth for "how can this
user authenticate" from the moment the migration runs.

### Provider Types

```typescript
export const AUTH_PROVIDERS = ['email', 'google'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]
```

## 2. Auth Provider Repository

**File:** `src/repositories/auth-provider.repository.ts`

- `findByProviderAndId(provider, providerId)` — lookup for OAuth callback
- `findByUser(userId)` — list all providers for a user
- `create(data)` — add a new provider link
- `updateTokens(id, { accessToken, refreshToken })` — update OAuth tokens on returning login

## 3. Google OAuth Flow

### Endpoints

| Method | Path                    | Auth | Purpose                             |
| ------ | ----------------------- | ---- | ----------------------------------- |
| `GET`  | `/auth/google`          | None | Redirect to Google's consent screen |
| `GET`  | `/auth/google/callback` | None | Handle Google's redirect back       |

Both routes carry `express-session` middleware (scoped, not global).

### Flow

```
Browser → GET /auth/google
  → Passport sets OAuth state in session
  → Redirect to accounts.google.com/o/oauth2/v2/auth

Google → GET /auth/google/callback?code=...&state=...
  → Passport validates state (CSRF)
  → Passport exchanges code for tokens
  → Passport fetches Google profile
  → handleGoogleCallback:
    1. Look up auth_providers by (google, profile.id)
    2. If found → load user, update Google tokens
    3. If not found → look up user by email
       a. User exists → create Google provider link
       b. No user → create user (passwordHash: null) + email provider + Google provider
    4. Set emailVerifiedAt if Google says verified and not already set
    5. Set lastLoggedInAt
    6. Issue refresh token via issueRefreshToken()
    7. Set refresh cookie (same as regular login)
    8. Redirect to ${WEB_URL}/auth/callback

Frontend → POST /auth/refresh (existing endpoint)
  → Returns access token from refresh cookie
```

### Session Middleware (OAuth-scoped)

`express-session` is mounted ONLY on the two OAuth routes, not globally. The
rest of the API stays stateless (JWT-only).

```typescript
const oauthSession = session({
  store: new RedisStore({ client: redisClient }),
  secret: getEnv().SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 5 * 60 * 1000, // 5 minutes — only for the OAuth round-trip
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'lax',
  },
})
```

`connect-redis` uses the same Redis as the rest of the app. The session TTL
is 5 minutes — long enough for Google's redirect, short enough that stale
sessions don't accumulate.

### Passport Strategy

**File:** `src/configs/passport.config.ts`

```typescript
passport.use(
  new GoogleStrategy(
    {
      clientID: getEnv().GOOGLE_CLIENT_ID,
      clientSecret: getEnv().GOOGLE_CLIENT_SECRET,
      callbackURL: `${getEnv().APP_URL}/api/v1/auth/google/callback`,
      scope: ['profile', 'email'],
      state: true, // CSRF protection via session
    },
    handleGoogleVerify
  )
)
```

The strategy is registered conditionally — only when `GOOGLE_CLIENT_ID` is set.
When absent, the OAuth routes return 404 (or are simply not mounted).

### User Creation / Linking

```typescript
async function findOrCreateByGoogle(
  googleId: string,
  email: string,
  firstName: string | null,
  lastName: string | null,
  googleAccessToken: string,
  googleRefreshToken: string
): Promise<User> {
  // 1. Check auth_providers for (google, googleId)
  const existing = await authProviderRepo.findByProviderAndId('google', googleId)
  if (existing) {
    await authProviderRepo.updateTokens(existing.id, { accessToken, refreshToken })
    return userRepo.findById(existing.userId)
  }

  // 2. Check users by email
  const user = await userRepo.findByEmail(email)
  if (user) {
    // Link Google to existing account
    await authProviderRepo.create({
      userId: user.id,
      provider: 'google',
      providerId: googleId,
      accessToken,
      refreshToken,
    })
    return user
  }

  // 3. Create new user (no password — federated only)
  const newUser = await userRepo.create({
    email,
    firstName,
    lastName,
    passwordHash: null,
    emailVerifiedAt: new Date(), // Google verified the email
  })
  // Create both providers
  await authProviderRepo.create({
    userId: newUser.id,
    provider: 'email',
    providerId: email,
  })
  await authProviderRepo.create({
    userId: newUser.id,
    provider: 'google',
    providerId: googleId,
    accessToken,
    refreshToken,
  })
  return newUser
}
```

### Email Verification

Google's profile includes `emails[0].verified` (or `_json.email_verified`).
When `true` and the user's `emailVerifiedAt` is null, set it. This auto-
verifies users who sign in with Google, matching Ofluence's pattern.

## 4. Env Vars

Add to `env.config.ts`:

- `GOOGLE_CLIENT_ID` — `z.string().optional()`. When absent, Google OAuth is
  disabled.
- `GOOGLE_CLIENT_SECRET` — `z.string().optional()`. Required alongside
  `GOOGLE_CLIENT_ID`.

`SESSION_SECRET` already exists (placeholder, required). `APP_URL` already
exists (placeholder, required — now used for the callback URL).

## 5. Registration Change

`register()` in `auth.controller.ts` must also create an `auth_providers` row
with `provider: 'email'` and `providerId: input.email` when creating a new
user. This ensures every user has at least one provider row from the moment
they register.

## 6. File Structure

**New files:**

| File                                           | Purpose                         |
| ---------------------------------------------- | ------------------------------- |
| `src/database/models/auth-provider.model.ts`   | Table definition                |
| `src/repositories/auth-provider.repository.ts` | Provider CRUD                   |
| `src/configs/passport.config.ts`               | Google strategy + session setup |
| `src/database/migrations/XXXX_*.sql`           | Table + seed                    |

**Modified files:**

| File                                 | Change                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `src/configs/env.config.ts`          | Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                               |
| `src/controllers/auth.controller.ts` | Add `initiateGoogleAuth`, `handleGoogleCallback`; update `register` to create email provider |
| `src/routes/auth.routes.ts`          | Add `GET /auth/google`, `GET /auth/google/callback` with session middleware                  |
| `CLAUDE.md`                          | Document OAuth conventions                                                                   |

**New dependencies:**

- `passport`, `@types/passport`
- `passport-google-oauth20`, `@types/passport-google-oauth20`
- `express-session`, `@types/express-session`
- `connect-redis`

## 7. What This Does NOT Include

- Frontend changes (uses existing `/auth/refresh`)
- Account unlinking (remove a provider)
- Other OAuth providers (Apple, GitHub) — extensible pattern, not built
- Password-setting for OAuth-only users (use forgot-password)
- Global session middleware — scoped to OAuth routes only
- Rate limiting on OAuth routes (Google's own rate limits apply; the callback
  is not user-callable directly)
