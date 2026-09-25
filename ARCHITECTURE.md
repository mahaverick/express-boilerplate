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
in advance (`REFRESH_TOKEN_COOKIE_NAME`), so parsing the one value this API
cares about by hand costs less than a dependency for the rest of RFC 6265
nothing here needs.

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

| Layer        | Directory           | Job                                                                                             | May import                                                                                                                                                                                                                                               |
| ------------ | ------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| routes       | `src/routes/`       | Wire middleware to controller methods.                                                          | controllers, middlewares, configs, constants                                                                                                                                                                                                             |
| middlewares  | `src/middlewares/`  | Cross-cutting request handling (auth, tenant resolution, rate limits, errors).                  | services, repositories (read-only lookups in `resolveTenant`/`requireAuth`), policies, presenters (e.g. `auth.middleware.ts` builds `request.user` via `toAuthenticatedUser`, `src/presenters/user.presenter.ts`), errors, configs, utilities, constants |
| configs      | `src/configs/`      | Env and library configuration.                                                                  | services, utilities, constants                                                                                                                                                                                                                           |
| presenters   | `src/presenters/`   | Pure mappers from a database row to its wire shape.                                             | types from `database/models`, and constants (e.g. `AuthProvider`)                                                                                                                                                                                        |
| controllers  | `src/controllers/`  | Parse and validate input, call service methods, shape the response.                             | services, presenters, validators, errors, configs, utilities/response.utilities, constants, types, and `database/models` types via `import type` only                                                                                                    |
| services     | `src/services/`     | Business rules, transactions, authorization, side effects.                                      | repositories, policies, other services, workers, jobs, templates, errors, utilities, configs, constants, types, `database/models`, `database.service`, validator types (`import type`, for a validated-input shape a service signature needs)            |
| policies     | `src/policies/`     | Pure, boolean-returning authorization functions. Never throw.                                   | constants and types only                                                                                                                                                                                                                                 |
| repositories | `src/repositories/` | Queries only.                                                                                   | models, `database.service`, errors, constants                                                                                                                                                                                                            |
| errors       | `src/errors/`       | Error classes and Postgres error handling (`HttpError`, `isUniqueViolation`, `redactedForLog`). | nothing under `src/`                                                                                                                                                                                                                                     |

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
runtime export. `tests/unit/lint-gates.test.ts` proves each of the seven
actually fires, against a committed violating fixture under
`tests/fixtures/lint-zones/`. `import-x/no-restricted-paths` is a
blocklist, not an allowlist, so a "may import" cell above with no zone
naming it — most of middlewares' own imports, services importing validator
types, presenters importing constants — is simply unrestricted by lint,
not separately enforced: the table states the intended shape, and only
the six zones plus the controllers' type-only models rule are
lint-enforced. Controllers never import a repository or `database.service`
directly — every controller method calls a service method and shapes the
response.

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
set: the tenant's owner rows first (`lockOwners`, ordered by `id`), then
memberships ordered by `user_id` (`lockMemberships`) — written into
`user-membership.repository.ts`'s JSDoc on both methods, and enforced only
by convention plus a deadlock regression test
(`tests/integration/services/tenant-membership.service.test.ts`), since
Postgres itself has no way to enforce an application-level lock order.

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
  runs as a non-root user (uid 10001), and declares `HEALTHCHECK NONE` —
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
- **A retention job for `user_tokens`,** which grows by roughly 2,900 rows
  per active user per month and is never pruned. **Unassigned** — a
  scheduled job needs a scheduler, and there is none yet; see
  [DATABASE.md](DATABASE.md#user_tokens-grows-without-bound-and-nothing-prunes-it).
  This is recorded here deliberately — "a later plan will do it" reads the
  same as "nobody is doing it" right up until nobody does.

Everything else this list used to name as not-yet-built has since shipped,
by later plans not otherwise documented in this file: forgot/reset password
(`auth.routes.ts`'s `/forgot-password`/`/reset-password`), sessions and
Google OAuth (`passport.config.ts`'s `express-session` usage — see
CLAUDE.md's "OAuth" section), tenancy/RBAC (`tenant.controller.ts`,
`tenant.routes.ts` — see CLAUDE.md's "Multi-tenancy and RBAC" section), the
BullMQ job queue (`src/jobs/`, `src/workers/` — see CLAUDE.md's "Job queue"
and "Notifications" sections), and OpenTelemetry SDK wiring in the app
itself (`src/observability/tracing.ts` starts a `NodeSDK` and exports
traces and logs — see CLAUDE.md's "Observability" section). The rate
limiters this list used to describe as
covering only the four auth routes now also cover the tenant and invitation
routes (`createRateLimiter(RATE_LIMITS.createTenant)` and
`createRateLimiter(RATE_LIMITS.inviteTenantMember)` on `tenant.routes.ts`,
`createRateLimiter(RATE_LIMITS.invitationPreview)` and
`createRateLimiter(RATE_LIMITS.invitationAccept)` on `invitation.routes.ts`).
