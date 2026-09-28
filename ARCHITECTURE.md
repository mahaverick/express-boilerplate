# Architecture

This document describes how the pieces of this boilerplate fit together, and
is explicit about what is deliberately **not** built yet — this repo ships
the platform, not a product.

## Boot sequence: `index.ts` -> `server.ts` -> `app.ts`

The app is split into three files instead of one, on purpose:

```
src/index.ts    entrypoint — validates the environment, then boots
src/server.ts   owns the listening socket and the shutdown sequence
src/app.ts      builds the Express app — no listen, no side effects
```

`createApp()` in `app.ts` returns a plain, unstarted `Express` instance.
That is what lets `supertest` import it directly in tests without ever
binding a port. The alternative — one large entrypoint file that both
builds the app and starts listening — is what this repo was rebuilt away
from.

**`index.ts`** calls `getEnv()` synchronously first, inside a `try/catch`.
If the environment is invalid, it prints the named list of what's wrong and
exits 1 — before anything else runs. Only once that succeeds does it
`import('@/server')` **dynamically**. This matters: a static import at the
top of the file would be hoisted and evaluated before `main()`'s
`try/catch` ever ran, because ES module imports are evaluated before the
importing module's own body. `@/server` transitively imports
`database.service.ts`, which calls `getEnv()` again at module scope — so a
static import would have reintroduced, one layer up, the exact failure mode
(an uncaught stack trace from inside a dependency instead of a clean
message) this repo exists to remove.

With `WORKER_ENABLED`, `index.ts` then starts the Workers through
`startWorkers()` (`worker-supervisor.service.ts`): email, notification and
maintenance. Each time the supervisor starts a worker generation (boot is
the first) it also registers the daily retention schedule
(`ensureRetentionSchedule`, `src/jobs/maintenance.job.ts`). A failed
registration logs a `warn` and is retried with the next generation. A new
generation starts only when a worker connection gives up before its first
ready, so a registration that fails while the Workers stay healthy waits
for the next restart. The scheduler is stored in Redis, so one registered
earlier keeps running meanwhile.

**`server.ts`** exports `startServer(port?)` and `gracefulShutdown(server, workers?)`.
`startServer` takes the port as a parameter rather than reading it from
`getEnv()` internally, specifically so tests can bind an ephemeral port
(`startServer(0)`) without the environment's memoised, already-parsed
`APP_PORT` getting in the way. `gracefulShutdown` closes the socket first
(so no new request can arrive), waits for it to drain, closes the Workers
`startWorkers()` is currently running, then closes the database, Redis and
queue clients — deliberately in that order.

**`app.ts`** wires, in order: `requestId` middleware, JSON/urlencoded body
parsing, `GET /health`, `GET /health/ready`, the versioned API router
(`createApiRouter()`, mounted at `/api/v1` — see "Request path: auth and
beyond" below), a 404 catch-all, then `errorHandler`. Order is load-bearing
— Express matches middleware and routes in registration order, and the
error handler must be registered last to see errors from everything before
it.

## Request path: auth and beyond

`createApiRouter()` (`src/routes/index.routes.ts`) mounts one router per
feature under `/api/v1` — `auth.routes.ts` at `/api/v1/auth`,
`profile.routes.ts` at `/api/v1/profile` — rather than `app.ts` growing an
`app.use(...)` call per feature. A new feature router is one more
`router.use(...)` line in `index.routes.ts`, never a change to `app.ts`
itself.

**Registration and login** (`POST /api/v1/auth/register`,
`POST /api/v1/auth/login`) are open routes — no token required to reach
them, by definition. `register` is the only route that **hashes** a
password; `login` and `verify-email` are the only routes that **compare**
one — both through `src/utilities/password.utilities.ts`, never bcrypt
directly. On success,
`login` mints an access token (`signAccessToken`) and a refresh token
(`issueRefreshToken`), the latter set as an httpOnly cookie. See
[SECURITY.md](SECURITY.md) for the full reasoning behind both token types,
password hashing, user-enumeration resistance, and rate limiting.

**Every other authenticated route** sits behind `requireAuth`
(`src/middlewares/auth.middleware.ts`), mounted with `router.use(requireAuth)`
ahead of a feature's routes (see `profile.routes.ts`) rather than repeated
per-route, so a route added later inherits the gate automatically.
`requireAuth` verifies the bearer access token (`verifyAccessToken`) and
then reloads the user by id — a stateless JWT alone would keep answering
"valid" for a disabled or deleted account until the token's own expiry, so
this trades one extra database read per authenticated request for that
account state actually being enforced in real time.

**`POST /api/v1/auth/refresh`** and **`POST /api/v1/auth/logout`** are the
odd ones out: neither requires a bearer access token (a user's access token
has often already expired by the time either is called), and both instead
read the refresh-token cookie directly off the raw `Cookie` header — there
is no `cookie-parser` dependency in this codebase; the cookie name is known
in advance (`refreshCookieSpec`, plus the legacy `refreshToken` — see
SECURITY.md, "Cookies"), so parsing the values this API cares about by hand
costs less than a dependency for the rest of RFC 6265 nothing here needs.

**The repository layer** (`src/repositories/`) is a thin layer over
`src/database/models/`: `BaseRepository` owns soft-delete filtering,
`updatedAt` maintenance, and unique-violation-to-409 translation once,
shared by `UserRepository`, `UserTokenRepository` and `TenantRepository`,
each of which supplies only the four concrete Drizzle queries
`BaseRepository` cannot express generically (see `base.repository.ts`'s own
header comment for why). Every public method it defines, including these
inherited ones, takes a final optional `executor: DbExecutor = db`
parameter, so any caller can run it inside its own transaction. See
[DATABASE.md](DATABASE.md) for these models. The repository layer's other
classes are deliberately NOT one of them — they do not extend
`BaseRepository` at all. `EmailLogRepository` is the clearest case: the
`email_logs` table it queries is append-only audit data, so it has no
`updatedAt`/`deletedAt` columns for `BaseRepository` to require, nothing
ever updates or soft-deletes a row once written, and there is no unique
constraint on the table for a 23505-to-409 translation to have anything to
translate. Sharing the base class here would mean inheriting `update()` and
`softDelete()` methods whose very existence contradicts what an audit log
is — see `email-log.model.ts` and `email-log.repository.ts`'s own header
comments for the full reasoning. `AuthProviderRepository`,
`NotificationRepository`, `NotificationPreferenceRepository`,
`TenantSettingsRepository`, `TenantInvitationRepository` and
`UserMembershipRepository` each give the same reasoning for their own
table in their own header comment: no soft-delete concept on it, so
nothing for `BaseRepository`'s policy to apply to.

## Layers

| Layer        | Directory           | Job                                                                                             | May import                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| routes       | `src/routes/`       | Wire middleware to controller methods.                                                          | controllers, middlewares, configs, constants                                                                                                                                                                                                                                                                                                                                                                                            |
| middlewares  | `src/middlewares/`  | Cross-cutting request handling (auth, tenant resolution, rate limits, errors).                  | services (`resolveTenant` reads the platform role through `platform.service` and writes its staff-access entry through `audit.service`; `requirePlatformRole` reads `platform.service`), repositories (read-only lookups in `resolveTenant`/`requireAuth`), policies, presenters (e.g. `auth.middleware.ts` builds `request.user` via `toAuthenticatedUser`, `src/presenters/user.presenter.ts`), errors, configs, utilities, constants |
| configs      | `src/configs/`      | Env and library configuration.                                                                  | services, utilities, constants                                                                                                                                                                                                                                                                                                                                                                                                          |
| presenters   | `src/presenters/`   | Pure mappers from a database row to its wire shape.                                             | types from `database/models` and `types/`, and constants (e.g. `AuthProvider`)                                                                                                                                                                                                                                                                                                                                                          |
| controllers  | `src/controllers/`  | Parse and validate input, call service methods, shape the response.                             | services, presenters, validators, errors, configs, utilities/response.utilities, constants, types, and `database/models` types via `import type` only                                                                                                                                                                                                                                                                                   |
| services     | `src/services/`     | Business rules, transactions, authorization, side effects.                                      | repositories, policies, other services, workers, jobs, templates, errors, utilities, configs, constants, types, `database/models`, `database.service`, validator types (`import type`, for a validated-input shape a service signature needs)                                                                                                                                                                                           |
| policies     | `src/policies/`     | Pure, boolean-returning authorization functions. Never throw.                                   | constants and types only                                                                                                                                                                                                                                                                                                                                                                                                                |
| repositories | `src/repositories/` | Queries only.                                                                                   | models, `database.service`, errors, constants                                                                                                                                                                                                                                                                                                                                                                                           |
| errors       | `src/errors/`       | Error classes and Postgres error handling (`HttpError`, `isUniqueViolation`, `redactedForLog`). | nothing under `src/`                                                                                                                                                                                                                                                                                                                                                                                                                    |

`eslint.config.mjs`'s `import-x/no-restricted-paths` turns six of this
table's boundaries into `error`-level lint gates: controllers may not
import a repository or `database.service` directly; controllers may not
import another controller, except `base.controller.ts` and
`helpers.controller.ts`; services, repositories, policies, errors and
presenters may not import controllers, routes or middlewares; repositories
may not import a service other than `database.service`; policies may not
import repositories, services or `database`; and configs may not import
controllers. A seventh boundary is enforced separately, by
`@typescript-eslint/no-restricted-imports`: controllers may import
`database/models` for TYPES only, never a value, so a controller reads a
model's shape (`User`, `Notification`) through `import type` and never its
runtime export. An eighth, core `no-restricted-imports` over `src/**`
with `src/services/platform-*.service.ts` ignored, keeps
`repositories/platform-tenant.repository.ts` (every customer tenant, for
staff search) out of every other module, so "your tenants" can never be
served from it. `tests/unit/lint-gates.test.ts` proves each of the eight
actually fires, against a committed violating fixture under
`tests/fixtures/lint-zones/`. `import-x/no-restricted-paths` is a
blocklist, not an allowlist, so a "may import" cell above with no zone
naming it — most of middlewares' own imports, services importing validator
types, presenters importing constants — is simply unrestricted by lint,
not separately enforced: the table states the intended shape, and only
the six zones, the controllers' type-only models rule and the
platform-tenant repository rule are lint-enforced. Controllers never
import a repository or `database.service` directly — every controller
method calls a service method and shapes the response.

Every route handler is a `BaseController` (`src/controllers/base.controller.ts`)
method. Nearly all are arrow-function class fields built through
`this.handle(handler)`, which forwards a thrown or rejected error to
`next()`. `handle()` never
sends a response itself. Once `response.headersSent`, it also logs a
`warn` — without the error object, so it can never bypass `redactedForLog`
— before calling `next(error)`; `errorHandler` (`error.middleware.ts`) then
logs the error redacted and destroys the socket itself, rather than
attempting a second write. The one exception is `handleGoogleCallback`
(`auth.controller.ts`) and `streamNotifications`
(`notification-stream.controller.ts`), which are plain, unwrapped arrow
fields — not routed through `handle()` — for reasons specific to a
redirect and an SSE stream; both still call a service, so this is an
exception to `handle()`, not to the layering above.

**Lock order**, binding for every transaction that locks more than one row
set:

1. the user row, for password writes, login, refresh rotation, logout,
   the refresh kills and the Google account claim (`lockById`,
   `user.repository.ts`); nothing takes tenant locks and then the user row;
2. the tenant's owner rows (`lockOwners`, ordered by `id`);
3. memberships, ordered by `user_id` (`lockMemberships`);
4. only when the actor has no membership in the tenant, the actor's
   platform-tenant membership, `FOR SHARE` (`lockTenantAccess`,
   `tenant-access.service.ts`, via `lockPlatformRole`,
   `user-membership.repository.ts`);
5. the row a tenant or settings update writes (`lockById`,
   `tenant.repository.ts`; `lockByTenantId`,
   `tenant-settings.repository.ts`).

**Lock modes.** A lock that only guards a read-then-write takes
`FOR NO KEY UPDATE`, not `FOR UPDATE`. `FOR UPDATE` also conflicts with the
`FOR KEY SHARE` lock that every foreign-key insert takes on the row it
references. Held on a tenant, it would block that tenant's audit inserts
and invitation accepts for the whole transaction. `FOR UPDATE` is used only
where the transaction deletes the locked row or changes a key column. A
repository method that serves both kinds takes a `mode: RowLockMode`
(`src/types/lock-mode.ts`), defaulting to `'no key update'`. The user row's
modes are listed in SECURITY.md, "Password change and reset against a
concurrent login". The two-connection tests detect blocking with
`pg_blocking_pids` (`tests/helpers/lock-probe.ts`), not with sleeps.

It's written into the JSDoc of `lockOwners`, `lockMemberships` and
`lockPlatformRole` (`user-membership.repository.ts`), of
`lockTenantAccess` (`tenant-access.service.ts`), and of `lockById` and
`lockByTenantId`, and enforced only by
convention plus a deadlock regression test
(`tests/integration/services/tenant-membership.service.test.ts`), since
Postgres itself has no way to enforce an application-level lock order.

**Platform access.** Four services carry it. Their callers stay in the
layers above.

| Service                      | Job                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant-access.service.ts`   | `lockTenantAccess(actor, tenantId, otherUserIds, tx)`: locks owners, memberships and, when the actor has no membership, the platform membership, in that order (step 4 above), returning the actor's access and the locked memberships. `resolveActorAccess(actor, tenantId, tx)` wraps it for a caller with no other memberships to lock. Membership wins; the platform tenant is members-only. |
| `platform.service.ts`        | `getPlatformMembership` (one indexed read, no cache), `autoJoin` (viewer only, verified addresses on `PLATFORM_EMAIL_DOMAINS`), `bootstrapGrant` (the `platform:grant` script only).                                                                                                                                                                                                             |
| `platform-tenant.service.ts` | `searchAll`: every customer tenant, for staff. The only importer of `platform-tenant.repository.ts`.                                                                                                                                                                                                                                                                                             |
| `audit.service.ts`           | `record(entry, tx)`, in the caller's transaction, with strict per-action metadata; `recordPlatformAccess` (hourly, deduplicated in Redis); `listForTenant` and `listPlatformWide` (keyset).                                                                                                                                                                                                      |

## The B3 seam: email verification is wired up; password recovery is not

`users.email_verified_at` (`src/database/models/user.model.ts`) is no
longer a reserved column nothing writes — it is written by a real flow, and
read by `login` as a gate. `profile.validators.ts` still deliberately
excludes `email` from the profile-update allow-list, and the reason is now
current rather than forward-looking: changing a verified address through
that endpoint would leave a stale verified flag attached to an address
nobody actually verified for the new value.

**Stated plainly, so this is not left for a reader to discover by
grepping, the way the previous version of this section had to be:**

- `POST /api/v1/auth/register` issues an `email_verification`-purpose token
  (`user_tokens`, via `issueToken`) and mails a verification link on the
  free-address branch. `user_tokens` was refresh-token-specific when the
  previous version of this section was written — B3 Task 1 generalised it
  with a `purpose` discriminator before Task 5 needed a home for this
  token, so the table this section once described no longer exists in that
  shape.
- `POST /api/v1/auth/verify-email` (`src/controllers/verification.controller.ts`)
  redeems that token and sets `email_verified_at`. It requires the
  account's password alongside the token, and a wrong password consumes the
  token exactly as a correct one would — see SECURITY.md's "Email
  verification" section for the full reasoning, including the squatting
  scenario the password requirement exists to defend against.
- `POST /api/v1/auth/resend-verification` reissues a token for an
  unverified address, revoking any still-live one first, with a response
  identical whether the address is unknown, unverified, or already
  verified.
- `POST /api/v1/auth/login` refuses any account whose `email_verified_at`
  is still null, through the same guard and the same misleading-but-
  deliberate `401` body a wrong password produces (SECURITY.md).
- Both new routes carry their own rate limiters — three limiters between
  them, since `resend-verification` carries two in series — on the same
  one-prefix-per-route convention `auth.routes.ts`'s header comment already
  states: `rl:verify-email:` (under `REDIS_KEY_PREFIX`, like every Redis key)
  and the two-layer
  `rl:resend-verification-ip:` / `rl:resend-verification-email:` pair.

**What is still not built, and is not confused with the above:**
forgot/reset password (B3 Task 6). A squatted, unverified address — see
SECURITY.md's squatting scenario — has no recovery route until that lands;
a successful reset is also where `email_verified_at` must be set, since
clicking a reset link proves the same mailbox control a verification click
does. Mailpit (`docker-compose.yml`) is the local SMTP sink both the
shipped flow and Task 6 use.

**A deployment upgrading with existing users must backfill
`email_verified_at` before deploying the `login` gate above**, or every
account created before this change is locked out simultaneously — see
SECURITY.md for the exact statement to run and why.

## Configuration

All configuration is read through `getEnv()` in
[`src/configs/env.config.ts`](src/configs/env.config.ts), which validates
`process.env` against a Zod schema once, on first call, and memoises the
result. `APP_ENV` (`local`/`dev`/`qa`/`prod`) is required and names the
deployment. Environment-dependent defaults such as `COOKIE_SECURE`,
`LOG_FORMAT` and SMTP's TLS requirement derive from it through helpers in
that file. Before anything starts, `index.ts` runs `assertEnvConsistent`
([`src/configs/env-consistency.config.ts`](src/configs/env-consistency.config.ts)),
which refuses stale names and unsafe combinations. No other application
module reads `process.env`; the exceptions are listed in CLAUDE.md.
`tracing.ts` is the notable one, since it loads before validation. Every
Redis key and channel is namespaced by `REDIS_KEY_PREFIX` through
`redisKey()`. See [DATABASE.md](DATABASE.md) for `getDatabaseUrl()`, the
narrower sibling function `drizzle.config.ts` uses.

### Environment variables

`.env.example` is **generated** from the Zod schema in
[`src/configs/env.config.ts`](src/configs/env.config.ts). Don't edit it by
hand; `pnpm env:example` regenerates it, and the pre-commit hook does so when
`env.config.ts` is staged. Required keys are blank, except `APP_ENV=local`
and `NODE_ENV=development`, which carry a working local value. Keys with a
default carry it. Optional keys with no default are commented out, including
`COOKIE_SECURE` and `LOG_FORMAT`, whose defaults come from `APP_ENV`.

The table is generated from the same schema: each row's text is that
variable's `.describe()`. To change a row, change the schema and regenerate
the table with `pnpm env:table` (see CONTRIBUTING.md).
`tests/unit/architecture-env-table.test.ts` fails when the table differs from
what it prints.

| Variable                              | Required | Default                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                             | **yes**  | —                      | Which deployment this is: local, dev, qa or prod. Required. COOKIE_SECURE and LOG_FORMAT default from it, and SMTP requires TLS everywhere but local.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `NODE_ENV`                            | **yes**  | —                      | Node runtime mode: development, test or production. Required. Express reads it directly, and only production hides stack traces in its built-in error handler, so every APP_ENV but local must run production. test is for the test suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `APP_PORT`                            | no       | `4040`                 | Port the HTTP server listens on. Defaults to 4040.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `APP_URL`                             | **yes**  | —                      | Public origin of this API. Used to build the Google OAuth callback URL (passport.config.ts) — must match a redirect URI registered in Google Cloud Console exactly, including scheme and trailing slash. http://localhost:4040 locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `WEB_URL`                             | **yes**  | —                      | Public origin of the frontend. Email verification links are built from it — the link points at your frontend, which POSTs the token to this API. http://localhost:5173 locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DATABASE_URL`                        | **yes**  | —                      | Postgres connection URL. The compose stack publishes Postgres on localhost:5433: postgres://boilerplate:boilerplate@localhost:5433/boilerplate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `REDIS_URL`                           | **yes**  | —                      | Redis connection URL. The compose stack publishes Redis on localhost:6380: redis://localhost:6380.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DB_POOL_MAX`                         | no       | `10`                   | Most open connections in the Postgres pool, per process. Defaults to 10. The test suite sets 2, so its parallel workers stay under Postgres's default 100 connections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DB_STATEMENT_TIMEOUT_MS`             | no       | `30000`                | Milliseconds a single SQL statement may run before Postgres cancels it (statement_timeout). Defaults to 30000 (30s). 0 sends no limit, leaving the server's own setting. A statement_timeout in DATABASE_URL's query string overrides it. PgBouncer, in every pool mode, refuses a startup parameter not listed in its ignore_startup_parameters, so behind it set 0 or list statement_timeout there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `JWT_ACCESS_SECRET`                   | **yes**  | —                      | Signs and verifies access tokens (session.service.ts). Any 32+ character string works; use `openssl rand -hex 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SESSION_SECRET`                      | **yes**  | —                      | Signs the express-session cookie used during the Google OAuth round-trip (passport.config.ts). Any 32+ character string works; use `openssl rand -hex 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GOOGLE_CLIENT_ID`                    | no       | —                      | Google OAuth 2.0 client ID. When absent, Google login is disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GOOGLE_CLIENT_SECRET`                | no       | —                      | Google OAuth 2.0 client secret. Required when GOOGLE_CLIENT_ID is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ACCESS_TOKEN_TTL`                    | no       | `15m`                  | Access token lifetime, as an ms()-parseable duration string (e.g. "15m"). Defaults to 15m.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `REFRESH_TOKEN_TTL`                   | no       | `30d`                  | Refresh token lifetime, as an ms()-parseable duration string (e.g. "30d"). Defaults to 30d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SESSION_ABSOLUTE_TTL`                | no       | `30d`                  | Hard ceiling on one login session, measured from the login itself and never reset by rotation, as an ms()-parseable duration string (e.g. "30d"). Past it, refreshing fails and the user signs in again. Defaults to 30d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `EMAIL_VERIFICATION_TTL`              | no       | `24h`                  | How long an email-verification link stays valid. Defaulted to 24h; a link the user finds the next morning should still work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PASSWORD_RESET_TTL`                  | no       | `1h`                   | How long a password-reset link stays valid. Defaulted to 1h — shorter than EMAIL_VERIFICATION_TTL, because redeeming it grants immediate account takeover rather than merely proving mailbox ownership.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `INVITATION_TTL`                      | no       | `7d`                   | How long a tenant invitation link stays valid, as an ms()-parseable duration string (e.g. "7d"). Resending an invitation issues a new link with a fresh lifetime. Defaults to 7d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `TRUST_PROXY`                         | no       | `false`                | How much of X-Forwarded-For to believe. "false" (default) trusts none: correct when clients reach this app directly, WRONG behind a proxy, where every IP-keyed rate limiter then shares one bucket for the whole deployment. Behind a proxy set the NUMBER of proxies in front of this app (e.g. "1"), or a comma-separated list of trusted proxy addresses/subnets or presets ("loopback", "linklocal", "uniquelocal"). Never "true" — it is refused, because it lets any client spoof its own IP and bypass the limiters.                                                                                                                                                                                                                                                                                                                                                                                        |
| `COOKIE_SECURE`                       | no       | —                      | Whether the refresh-token and OAuth session cookies carry the Secure attribute ("true" or "false"). Defaults from APP_ENV: false on local, true elsewhere. With Secure on behind a TLS-terminating proxy, TRUST_PROXY must be set, or the OAuth session cookie is never sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `COOKIE_DOMAIN`                       | no       | —                      | Domain attribute for the refresh-token and OAuth session cookies, e.g. "example.com" to share them with subdomains. Unset means host-only cookies, the narrowest scope. Boot refuses a value that APP_URL's host is not within, since browsers would reject the cookies. With COOKIE_SECURE on, the refresh cookie is __Secure-refreshToken when this is set and __Host-refreshToken (Path=/) when it is not, so setting or unsetting it on a live deployment signs users in again once. With COOKIE_SECURE on, a leftover unprefixed refreshToken cookie is still read, then cleared in its host-only form and under this domain. Within one name the API reads the most recently created cookie. Reverting to an earlier value is the exception: the browser keeps that cookie's original creation time, so the other scope's cookie reads as newer and refresh fails until the user logs in again or it expires. |
| `CORS_ALLOWED_ORIGINS`                | no       | —                      | Extra browser origins allowed to call this API, comma-separated (e.g. "https://admin.example.com,https://shop.example.com"). WEB_URL is ALWAYS allowed and does not need listing here, and same-origin requests send no Origin header at all. Leave empty for a single-frontend deployment. Never a wildcard: this API sends credentials, and the CORS spec forbids "*" with credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PLATFORM_EMAIL_DOMAINS`              | no       | —                      | Comma-separated email domains, e.g. "example.com,example.org". A user whose verified address is on one of them joins the platform tenant as viewer, when the address is verified and at every sign-in. Viewer can see every tenant and change nothing; a higher platform role needs an explicit grant (pnpm platform:grant, or an invitation to the platform tenant). Only the exact domain after the last "@" matches, never a subdomain. Empty means nobody joins automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | no       | —                      | Absent means tracing is disabled; the SDK is never started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `OTEL_SERVICE_NAME`                   | no       | `express-boilerplate`  | Service name reported in OTEL traces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `LOG_LEVEL`                           | no       | `info`                 | Console log level: error, warn, info or debug. silent disables logging entirely (the test suite uses it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LOG_FORMAT`                          | no       | —                      | Console log format: json or pretty. Defaults from APP_ENV: pretty on local, json elsewhere. pretty needs the pino-pretty devDependency; without it the logger writes json.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SLACK_WEBHOOK_URL`                   | no       | —                      | Slack Incoming Webhook URL for log alerting. When unset, no Slack transport is registered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SLACK_LOG_LEVEL`                     | no       | `error`                | Minimum log level that triggers a Slack notification. Defaults to error; set to warn if you want Slack alerts for warnings too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `WORKER_ENABLED`                      | no       | `true`                 | Whether the BullMQ workers (email, notification and maintenance) start in-process alongside the HTTP server. Set to false for API-only pods behind a load balancer; a separate worker deployment sets this to true. The daily retention purge runs only where this is true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `WORKER_CONCURRENCY`                  | no       | `5`                    | Jobs the email and notification workers each process at once, per process. Defaults to 5. The maintenance worker always runs one job at a time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RETENTION_TOKENS_DAYS`               | no       | `7`                    | Days to keep a user_tokens row once it has expired, or once it was revoked without ever being used (logout, reuse, password change). A token rotated away is kept until it expires, because reuse detection needs it. 0 never purges; at most 36500. Defaults to 7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RETENTION_INVITATIONS_DAYS`          | no       | `30`                   | Days to keep a tenant invitation after the latest of its expiry, acceptance and revocation. 0 never purges; at most 36500. Defaults to 30.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RETENTION_EMAIL_LOGS_DAYS`           | no       | `90`                   | Days to keep an email_logs row (one per email sent or failed). 0 never purges; at most 36500. Defaults to 90.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `RETENTION_NOTIFICATIONS_READ_DAYS`   | no       | `90`                   | Days to keep a notification after it was read. 0 never purges; at most 36500. Defaults to 90.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `RETENTION_NOTIFICATIONS_UNREAD_DAYS` | no       | `365`                  | Days to keep a notification nobody read, counted from when it was created. 0 never purges; at most 36500. Defaults to 365.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RETENTION_AUDIT_LOGS_DAYS`           | no       | `0`                    | Days to keep an audit_logs row. Defaults to 0, which keeps the audit log forever. Set a number of days, at most 36500, only where your compliance rules allow deleting audit history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `REDIS_KEY_PREFIX`                    | no       | `express-boilerplate`  | Namespace for every Redis key and channel this app uses: BullMQ queues (`<prefix>:bull`), rate-limit counters (`<prefix>:rl`), the session denylist (`<prefix>:denylist`), OAuth sessions (`<prefix>:sess`) and the notification channel (`<prefix>:notifications`). Lowercase letters, digits, ":", "_" and "-", with no trailing colon. Give each app or environment sharing one Redis its own value; changing it abandons every existing key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SSE_HEARTBEAT_INTERVAL_MS`           | no       | `30000`                | Milliseconds between `:ping` heartbeat comments on an open notification SSE stream (notification-stream.controller.ts). Defaults to 30000 (30s).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SSE_MAX_STREAMS_PER_USER`            | no       | `5`                    | Most notification SSE streams one user may hold open at once, per process. A request over the cap gets 429 too_many_streams. Defaults to 5 (several tabs and devices).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SMTP_HOST`                           | no       | `127.0.0.1`            | SMTP server host. Defaults to 127.0.0.1, where the compose Mailpit service listens; an IP literal skips a DNS lookup on every send.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SMTP_PORT`                           | no       | `1025`                 | SMTP server port. Defaults to 1025 — Mailpit's SMTP port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SMTP_USERNAME`                       | no       | —                      | SMTP username. Absent means no authentication is attempted, which is correct for Mailpit and wrong for most real providers. Set it together with SMTP_PASSWORD: boot refuses one without the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SMTP_PASSWORD`                       | no       | —                      | SMTP password. Set it together with SMTP_USERNAME: boot refuses one without the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MAIL_FROM`                           | no       | `no-reply@example.com` | The From address on every outbound email. Mailpit accepts any value; a real provider may require this to be a verified sender.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `APP_NAME`                            | no       | `Express Boilerplate`  | Product name in outbound email copy and notification text: verification, password reset, password changed and invitation messages (auth.service.ts, verification.service.ts, tenant-invitation.service.ts). Defaults to "Express Boilerplate".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SMTP_CONNECTION_TIMEOUT_MS`          | no       | `3000`                 | Milliseconds to wait for each SMTP connection attempt to establish before failing. Also the timeout for the first try of each DNS query; the resolver doubles it on each retry, and the OS-lookup fallback has no timeout. A host that resolves to several addresses can take it once per address. Boot checks that it plus SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS and the 5s HTTP drain stays at least 5s under SHUTDOWN_TIMEOUT_MS; that assumes one address and is a sanity check, not a per-send deadline. nodemailer's own defaults are 2 minutes to connect and 30 seconds per DNS query.                                                                                                                                                                                                                                                                                                           |
| `SMTP_GREETING_TIMEOUT_MS`            | no       | `5000`                 | Milliseconds to wait for the SMTP server's greeting after connecting. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 30 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SMTP_SOCKET_TIMEOUT_MS`              | no       | `7000`                 | Milliseconds of inactivity before an open SMTP connection is closed. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 10 minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SHUTDOWN_TIMEOUT_MS`                 | no       | `25000`                | Milliseconds graceful shutdown may take before the process exits with code 1 anyway. Defaults to 25000, under Kubernetes' default 30s termination grace period.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### `APP_ENV` and `NODE_ENV`

`APP_ENV` names the deployment: `local`, `dev`, `qa` or `prod`. It has no
default, and boot fails without it. A `.env` copied from an older
`.env.example` needs `APP_ENV=local` added. The Docker image sets
`NODE_ENV=production` but not `APP_ENV`, so the deployment must supply it.

`NODE_ENV` is what Express itself reads; it must be `production` in every
environment except `local`.

|                                                                                           | `local`  | `dev`, `qa`, `prod` |
| ----------------------------------------------------------------------------------------- | -------- | ------------------- |
| `COOKIE_SECURE` when unset                                                                | `false`  | `true`              |
| `LOG_FORMAT` when unset                                                                   | `pretty` | `json`              |
| SMTP must upgrade to TLS                                                                  | no       | yes                 |
| `NODE_ENV` other than `production`                                                        | allowed  | refused at boot     |
| `SMTP_HOST` `localhost`/`127.0.0.1`, `SMTP_PORT` 1025, `MAIL_FROM` `no-reply@example.com` | allowed  | refused at boot     |
| SMTP timeouts summing to more than `SHUTDOWN_TIMEOUT_MS` − 10000                          | warning  | refused at boot     |
| Trace attribute `deployment.environment.name`                                             | `local`  | the `APP_ENV` value |

The 10000 is the 5-second HTTP drain that runs before the in-flight send is
awaited, plus 5 seconds of headroom for closing the database, Redis and queues and
flushing traces. The timeouts bound each connection attempt, the greeting
and socket inactivity, and the first try of each DNS query. They are not a
per-send deadline: the resolver doubles the DNS timeout on each retry, the
OS-lookup fallback has no timeout, and a host that resolves to several
addresses can take the connection timeout once per address. The check
assumes one address and no DNS delay, so it is a sanity check.

Everywhere:

- setting only one of `SMTP_USERNAME` and `SMTP_PASSWORD` is refused;
- a `COOKIE_DOMAIN` that `APP_URL`'s host is neither equal to nor a
  subdomain of is refused, because browsers reject every auth cookie it
  would set;
- a renamed variable's old name is refused, with a message naming the new
  one (see MIGRATIONS.md);
- `COOKIE_SECURE` resolving to `true` while `GOOGLE_CLIENT_ID` is set and
  `TRUST_PROXY=false` logs a warning (see SECURITY.md).

### Secrets

`JWT_ACCESS_SECRET` signs access tokens. `SESSION_SECRET` signs the session
cookie of the Google OAuth round-trip. Both are read. Generate each with
`openssl rand -hex 32`, even in development.

There is no `JWT_REFRESH_SECRET`: refresh tokens are opaque random strings,
not JWTs, so nothing ever signs one with a secret — see
[SECURITY.md](SECURITY.md).

### Invalid configuration fails before anything starts

Unsetting or malforming any variable fails fast with a named list, not a
stack trace. Dropping `JWT_ACCESS_SECRET` prints

```
Invalid environment:
✖ Invalid input: expected string, received undefined
  → at JWT_ACCESS_SECRET
```

and exits 1 before any socket opens. After the schema parses, `index.ts`
runs `assertEnvConsistent`
([`src/configs/env-consistency.config.ts`](src/configs/env-consistency.config.ts)),
which refuses the combinations above. It lists every problem in one
message, each naming the variable and the fix, and exits 1.

### Why the compose stack uses ports 5433 and 6380

`docker-compose.yml` publishes Postgres on host port **5433** and Redis on
**6380**, not their defaults. This is deliberate, not a typo: the two most
commonly installed local services are a native Postgres and a native Redis,
and both default to 5432/6379. On a machine running either, connecting to
`localhost:5432`/`localhost:6379` can silently hit your own Homebrew (or
system) instance instead of the compose stack. Postgres fails loudly in that
case (`role "boilerplate" does not exist`), but **Redis fails silently** —
any Redis instance answers `PING`, so the app would appear to work while
writing into an unrelated database. Container-internal ports stay
5432/6379, so a container-to-container URL like `postgres://…@postgres:5432/…`
is unaffected. Every port is published on `127.0.0.1` only, so no other
machine on your network can reach the stack's services (Postgres, Redis,
Grafana, Mailpit). See the header comment in
[`docker-compose.yml`](docker-compose.yml) and
[ARCHITECTURE.md](ARCHITECTURE.md) for the full reasoning.

## Health checks

Two endpoints, deliberately different depths:

- **`GET /health`** is shallow — it never touches the database or Redis. If
  it depended on either, a transient blip in a dependency would make an
  orchestrator restart an otherwise-healthy process, turning a slow query
  into an outage.
- **`GET /health/ready`** is deep — it checks both `isDatabaseReachable()`
  and `isRedisReachable()` in parallel and returns 503 if either is down.
  It is safe to fail: a failing readiness probe only removes the instance
  from load-balancer rotation, it doesn't restart anything.

## Data layer

- **Postgres**: [`src/services/database.service.ts`](src/services/database.service.ts)
  creates exactly one `postgres` client (and one Drizzle instance wrapping
  it) per process, at module scope. A second client would mean a second
  connection pool and double the configured connection budget — a class of
  bug that only shows up under load. Pool size is 10 outside tests, 2 in
  tests (kept small deliberately — see the "test isolation" note in
  MIGRATIONS.md's Vitest row).
- **Redis**: [`src/services/redis.service.ts`](src/services/redis.service.ts)
  connects lazily, on first use — an eager connection at import time would
  make every unit test that transitively imports a repository open a real
  socket, and fail outright on a machine with no Redis running. It also
  tracks a `closed` flag explicitly: unlike the Postgres client (where
  `sql.end()` makes every later query reject on its own), node-redis's
  client has no built-in "permanently dead" state, so without the flag a
  readiness probe issued after shutdown would silently reopen a socket the
  shutdown had just closed. The client is also given a bounded
  `reconnectStrategy` (a 5s connect timeout, giving up after a few
  attempts): node-redis's default strategy retries forever and never
  rejects `connect()`, which would make `isRedisReachable()` — and
  therefore `GET /health/ready` — hang indefinitely instead of reporting
  unreachable the moment Redis goes down.

Both expose `is*Reachable()` (not `ping*`) and `close*()`, and both
`close*()` functions are safe to call twice.

## Errors and the response envelope

Every JSON response — success or error — uses the same envelope, defined
once in [`src/utilities/response.utilities.ts`](src/utilities/response.utilities.ts):

```json
{ "success": true, "message": "Success", "statusCode": 200, "data": {} }
{ "success": false, "message": "Not found", "statusCode": 404, "requestId": "…" }
{ "success": false, "message": "Access token expired", "statusCode": 401, "code": "ACCESS_TOKEN_EXPIRED", "requestId": "…" }
```

An error response optionally carries `code`: a single, stable,
machine-readable token a client branches on (e.g. `ACCESS_TOKEN_EXPIRED`
from `requireAuth`, `RATE_LIMITED` from the login/refresh limiters — see
[SECURITY.md](SECURITY.md)), independent of `errors` (field-level
validation detail, shaped by whatever validator produced it). The two are
deliberately separate fields rather than one overloaded one — see
`error.middleware.ts`'s own header comment for why collapsing them would
make a client parsing `errors` for field errors get something structurally
different the one time `code` is also present.

`HttpError` (in
[`src/errors/http-error.ts`](src/errors/http-error.ts))
is the exception type any handler can throw or forward to `next()` to
produce a specific status code. `errorHandler` is the terminal middleware:
it masks the message on a 5xx (returning `"Internal server error"`) but
**logs the original error**, redacted (`redactedForLog`,
[`src/errors/postgres-errors.ts`](src/errors/postgres-errors.ts)), through
the pino `logger` facade first — masking the message from the client
without logging it anywhere would leave an operator with nothing to search
and a bug report with nothing to point at. A 4xx is never logged; it isn't
a server failure.

`errorHandler` takes four parameters and is registered last, because
Express identifies error-handling middleware by arity — a handler with
fewer than four parameters is silently treated as ordinary middleware that
never sees an error. The unused fourth parameter is prefixed `_next`
accordingly.

Every response that carries no payload — a 200/202 success with no payload — uses
`messageResponse(response, message, status?)`
([`src/utilities/response.utilities.ts`](src/utilities/response.utilities.ts)),
which always sends `data: null`. It is the one shape used by every
no-content endpoint, across `auth.controller.ts`, `notification.controller.ts`,
`tenant.controller.ts` and `verification.controller.ts` — never a bare `{}`
and never `data` omitted.

This envelope shape (`{ success, message, statusCode, code?, errors? }`) is not RFC
9457 `problem+json`, which is the more modern standard and the better
choice for a greenfield API. It is kept here because this boilerplate is
derived from an existing codebase by stripping project-specific code, and
switching the envelope would mean rewriting every consumer that expects it.
See [SECURITY.md](SECURITY.md) for the same trade applied to other
inherited decisions.

## Request correlation

[`src/middlewares/request-id.middleware.ts`](src/middlewares/request-id.middleware.ts)
runs first in the chain. It honours a caller-supplied `X-Request-Id` header
(validated against a UUID pattern before being echoed back — reflecting an
arbitrary header into a response is how log injection starts) or generates
one. `errorResponse()` reads the id back off the response object rather
than accepting it as a parameter, since every caller already has the
response.

## Local infrastructure

`docker-compose.yml` provides Postgres, Redis, an OpenTelemetry Collector,
Tempo (trace storage), Loki (log storage, no host port — query it through
Grafana), Grafana (`:3100`, Tempo and Loki both pre-provisioned as data
sources), and Mailpit (a local SMTP sink with a web UI at `:8025`) —
everything the app needs to boot locally, none of it currently required to
be exercised by the app itself outside the database/Redis clients. The
collector forwards traces to Tempo and pino log records (via
`PinoInstrumentation`) to Loki; the app can also be pointed at the
collector directly via `OTEL_EXPORTER_OTLP_ENDPOINT` — see CLAUDE.md's
"Observability" section for what `src/observability/tracing.ts` does and
does not instrument, and how a Loki log line links back to its trace.

Every published port binds `127.0.0.1` only, so no other machine on the
network can reach the stack's services: Postgres with its fixed development
password, Redis with no password at all, Grafana with anonymous admin, and
Mailpit.

**Postgres is pinned to major version 18** because generated migrations may
use `uuidv7()` as a column default, which is built into Postgres from 18
onward; on 17 or older, a migration referencing it fails with `function
uuidv7() does not exist`.

**Host ports are non-default: 5433 for Postgres, 6380 for Redis.** The two
most commonly installed local dev services are a native Postgres and a
native Redis, both defaulting to 5432/6379 — and on a machine running
either, connections to `localhost:5432`/`localhost:6379` can silently hit
that native instance instead of the compose stack. Postgres fails loudly in
that case (wrong role/database); Redis does not — any Redis instance
answers `PING`, so a test suite or a dev server would appear to work while
talking to a personal, unrelated Redis. Container-internal ports remain
5432/6379, so nothing about container-to-container URLs
(`postgres://…@postgres:5432/…`) changes. A committed test
(`tests/unit/connection-target.test.ts`) reads `docker-compose.yml` and
`.env.test` off disk and asserts they agree on the non-default ports,
specifically so a well-meaning "tidy this up" edit fails loudly instead of
silently passing against a developer's own instance. It deliberately checks
the committed **files**, not `getEnv()` at runtime: CI's `services:`
publish the container-default ports, so CI runs against 5432/6379, and the
earlier runtime version of this assertion was guaranteed to fail on the
first pull request.

The OTel Collector's health-check extension is reachable on `:13133` for
manual verification, but the image has no shell/`curl`/`wget`, so it
carries no Docker-level `HEALTHCHECK` — verified by direct `exec` into the
container.

## Deployment

`Dockerfile` is a four-stage build (`base` -> `deps` -> `build` -> `runner`):

- `deps` installs with `--frozen-lockfile` against a layer cached
  independently of application code.
- `build` runs `pnpm build`, then `pnpm prune --prod --ignore-scripts`.
  `pnpm install --prod` alone is not enough here: it unlinks dev
  dependencies from `node_modules` but leaves their content in the pnpm
  virtual store, so the TypeScript compiler and `drizzle-kit` would still
  ship inside the image while appearing pruned. `prune` is the command that
  actually removes them — verified empirically against the built image.
- `runner` copies over only `node_modules`, `dist/`, and `package.json`,
  starts
  `node --enable-source-maps --import ./dist/observability/tracing.js dist/index.js`
  (so a logged stack trace names the original `.ts` line; `tsconfig.json`
  emits the maps), runs as a non-root user (uid 10001), and
  declares `HEALTHCHECK NONE` —
  the orchestrator already owns liveness/readiness via `/health` and
  `/health/ready`; a second, Docker-level health signal would just be a
  second opinion that can disagree with the first under load.

## What is deliberately not here yet

An earlier plan built the platform: environment validation, the
database/Redis clients, the app/server split, health checks, the error
contract, the test harness and its coverage gate, git hooks, and CI. This
plan (B2) added registration, login, JWT access + opaque refresh tokens,
refresh rotation with reuse detection bounded by an absolute session
lifetime, an authenticated profile endpoint, a rate limiter on every auth
route (each with its own store prefix), a content-type gate on the auth
router that closes forced-login CSRF, and `TRUST_PROXY` as an explicit
deployment decision — see [SECURITY.md](SECURITY.md) for the
security-relevant detail on all of it. It does **not** build:

- **MFA.** `auth.middleware.ts` and `auth.controller.ts` both note it as a
  later step-up plan; no such flow exists yet.
- OpenAPI documentation, or a bootstrap/seed script (`pnpm bootstrap` does
  not exist — do not run it).

Everything else this list used to name as not-yet-built has since shipped,
by later plans not otherwise documented in this file: forgot/reset password
(`auth.routes.ts`'s `/forgot-password`/`/reset-password`), sessions and
Google OAuth (`passport.config.ts`'s `express-session` usage — see
CLAUDE.md's "OAuth" section), tenancy/RBAC (`tenant.controller.ts`,
`tenant.routes.ts` — see CLAUDE.md's "Multi-tenancy and RBAC" section), the
BullMQ job queue (`src/jobs/`, `src/workers/` — see CLAUDE.md's "Job queue"
and "Notifications" sections), and OpenTelemetry SDK wiring in the app
itself (`src/observability/tracing.ts` starts a `NodeSDK` and exports
traces and logs — see CLAUDE.md's "Observability" section), and a daily
data-retention purge (`src/services/retention.service.ts`, run by the
maintenance worker — see [DATABASE.md](DATABASE.md#user_tokens-retention)
and MIGRATIONS.md, "Upgrading to 3.2.0"). The rate
limiters also cover the tenant, invitation and staff-search routes
(`createRateLimiter(RATE_LIMITS.createTenant)` and
`createRateLimiter(RATE_LIMITS.inviteTenantMember)` on `tenant.routes.ts`,
`createRateLimiter(RATE_LIMITS.invitationPreview)` and
`createRateLimiter(RATE_LIMITS.invitationAccept)` on `invitation.routes.ts`,
and `createRateLimiter(RATE_LIMITS.platformSearch)` on
`platform.routes.ts`). Every other authenticated write is limited by
`createRateLimiter(RATE_LIMITS.authenticatedWrite)`, one instance per
router (tenant, notification and profile), all counting under one Redis
prefix per user.
