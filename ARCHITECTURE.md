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
parsing, `GET /health`, `GET /health/ready`, a 404 catch-all, then
`errorHandler`. Order is load-bearing — Express matches middleware and
routes in registration order, and the error handler must be registered
last to see errors from everything before it.

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
```

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

This envelope shape (`{ success, message, statusCode, errors }`) is not RFC
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
and Mailpit (a local SMTP sink with a web UI at `:8025`) — everything the
app needs to boot locally, none of it currently required to be exercised
by the app itself outside the database/Redis clients.

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

This plan builds the platform: environment validation, the database/Redis
clients, the app/server split, health checks, the error contract, the test
harness and its coverage gate, git hooks, and CI. It does **not** build:

- Any route beyond `/health` and `/health/ready` — no controllers, no
  repositories, no validators.
- Authentication, sessions, or MFA.
- Any Drizzle model — `src/database/models/` does not exist yet. See
  [DATABASE.md](DATABASE.md).
- OpenAPI documentation, or a bootstrap/seed script (`pnpm bootstrap` does
  not exist — do not run it).
- Queues, email sending, or anything else that would consume BullMQ or
  nodemailer (both listed, not yet adopted, in
  [MIGRATIONS.md](MIGRATIONS.md)).
- OpenTelemetry SDK wiring in the app itself — the collector container runs
  and `OTEL_EXPORTER_OTLP_ENDPOINT` is a recognised, optional variable, but
  nothing in `src/` currently starts an SDK or exports a span.

Each of these is explicitly owned by a later plan.
