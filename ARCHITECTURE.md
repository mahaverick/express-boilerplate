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

**`server.ts`** exports `startServer(port?)` and `gracefulShutdown(server)`.
`startServer` takes the port as a parameter rather than reading it from
`getEnv()` internally, specifically so tests can bind an ephemeral port
(`startServer(0)`) without the environment's memoised, already-parsed
`APP_PORT` getting in the way. `gracefulShutdown` closes the socket first
(so no new request can arrive), waits for it to drain, then closes the
database and Redis clients — deliberately in that order.

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
shared by `UserRepository` and `UserTokenRepository`, each of which
supplies only the four concrete Drizzle queries `BaseRepository` cannot
express generically (see `base.repository.ts`'s own header comment for
why). See [DATABASE.md](DATABASE.md) for both models. `EmailLogRepository`
is deliberately NOT one of them — it does not extend `BaseRepository` at
all. The `email_logs` table it queries is append-only audit data: it has no
`updatedAt`/`deletedAt` columns for `BaseRepository` to require, nothing
ever updates or soft-deletes a row once written, and there is no unique
constraint on the table for a 23505-to-409 translation to have anything to
translate. Sharing the base class here would mean inheriting `update()` and
`softDelete()` methods whose very existence contradicts what an audit log
is — see `email-log.model.ts` and `email-log.repository.ts`'s own header
comments for the full reasoning.

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
  states: `rl:verify-email:` and the two-layer
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
result. No other module reads `process.env` directly — an eslint rule
(`no-restricted-properties`) enforces this outside `env.config.ts` itself.
See [DATABASE.md](DATABASE.md) for `getDatabaseUrl()`, the narrower sibling
function `drizzle.config.ts` uses.

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
[`src/middlewares/error.middleware.ts`](src/middlewares/error.middleware.ts))
is the exception type any handler can throw or forward to `next()` to
produce a specific status code. `errorHandler` is the terminal middleware:
it masks the message on a 5xx (returning `"Internal server error"`) but
**logs the original error** via `console.error` first — masking the
message from the client without logging it anywhere would leave an
operator with nothing to search and a bug report with nothing to point at.
A 4xx is never logged; it isn't a server failure.

`errorHandler` takes four parameters and is registered last, because
Express identifies error-handling middleware by arity — a handler with
fewer than four parameters is silently treated as ordinary middleware that
never sees an error. The unused fourth parameter is prefixed `_next`
accordingly.

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
Tempo (trace storage), Grafana (`:3100`, Tempo pre-provisioned as its data
source), and Mailpit (a local SMTP sink with a web UI at `:8025`) —
everything the app needs to boot locally, none of it currently required to
be exercised by the app itself outside the database/Redis clients. The
collector forwards traces to Tempo; the app can also be pointed at the
collector directly via `OTEL_EXPORTER_OTLP_ENDPOINT` — see CLAUDE.md's
"Observability" section for what `src/observability/tracing.ts` does and
does not instrument.

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
the committed **files**, not `getEnv()` at runtime: GitHub Actions
`services:` cannot remap container ports, so CI necessarily runs against
5432/6379, and the earlier runtime version of this assertion was guaranteed
to fail on the first pull request.

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

- **Forgot/reset password.** Email verification itself now ships — see
  "The B3 seam" above. Reset does not: no `/forgot-password` or
  `/reset-password` route exists, so a squatted, unverified address has no
  recovery path yet. Owned by plan B3 Task 6.
- **Sessions, MFA, or OAuth/social login.** `SESSION_SECRET` remains a
  required-but-unread placeholder. Owned by plan B4.
- **Security headers/CSP, or a general-purpose rate limiter.** All four
  auth routes are rate-limited, each with its own store prefix (see
  SECURITY.md); no other route is. `x-powered-by` is disabled and nothing
  else touches response headers. **Security headers/CSP is unassigned**:
  spec §13 mandates `helmet` with an explicit Content-Security-Policy and no
  plan owns it — see SECURITY.md's table. CORS itself is no longer in this
  list — a later plan (the multi-frontend seam) added the `cors` middleware
  and an origin allowlist keyed on `WEB_URL`/`CORS_ALLOWED_ORIGINS`; see
  SECURITY.md's "CORS" section.
- **Tenancy or RBAC.** Every authenticated user acts only on their own
  resources; there is no role or organization model. Owned by plan B5.
- OpenAPI documentation, or a bootstrap/seed script (`pnpm bootstrap` does
  not exist — do not run it).
- Queues, or anything else that would consume BullMQ (listed, not yet
  adopted, in [MIGRATIONS.md](MIGRATIONS.md)). `nodemailer` is the one
  already-listed dependency that plan B3 is expected to actually adopt,
  once email delivery lands.
- **A retention job for `user_tokens`,** which grows by roughly 2,900 rows
  per active user per month and is never pruned. Also **unassigned** — a
  scheduled job needs a scheduler, and there is none yet; see
  [DATABASE.md](DATABASE.md#user_tokens-grows-without-bound-and-nothing-prunes-it).
- OpenTelemetry SDK wiring in the app itself — the collector container runs
  and `OTEL_EXPORTER_OTLP_ENDPOINT` is a recognised, optional variable, but
  nothing in `src/` currently starts an SDK or exports a span.

Most of these are explicitly owned by a later plan (named inline above).
Two are **not owned by anything**: security headers/CSP and the
`user_tokens` retention job. That is recorded here deliberately — "a later
plan will do it" reads the same as "nobody is doing it" right up until
nobody does.
