# Architecture

How this API is put together: how a process boots and stops, where code goes,
what a request passes through, what runs in the background, and the decisions
that constrain a change. The threat model and every defence are in
[SECURITY.md](SECURITY.md), the tables and migrations in
[DATABASE.md](DATABASE.md), and the quick start, scripts and operator steps in
[README.md](README.md).

## Boot and process model

### Boot sequence

Three files, one job each:

```
src/index.ts    entrypoint: validates the environment, then boots
src/server.ts   owns the listening socket and the shutdown sequence
src/app.ts      builds the Express app: no listen, no workers, so tests import it
```

`main()` in `src/index.ts` raises `Error.stackTraceLimit` to
`ERROR_FRAME_LIMIT` (50), because V8 keeps 10 frames by default and error
tracking keeps 50. It then calls `getEnv()` and `assertEnvConsistent` inside a
`try`. An invalid environment prints one list (`Invalid environment:` from the
schema, or `Inconsistent environment:` from the cross-field rules) and sets
exit code 1 before any socket opens. Only then does `boot()` run.

`boot()` imports `@/server` and the worker supervisor **dynamically**.
`@/server` reaches `database.service.ts`, which calls `getEnv()` at module
scope, so a static import would throw on a bad environment before `main()`
could report it; a static worker import would load BullMQ into processes that
never start Workers. Then, in order:

1. When flags are configured, the flag snapshot finishes a first load
   ([Feature flags](#feature-flags)).
2. Every replica subscribes `reconcileQueuePause` to maintenance-mode reloads
   (API-only replicas hold producer connections too), and the maintenance-mode
   store finishes a first read ([Maintenance mode](#maintenance-mode)).
   Neither start rejects or waits for its pub/sub subscription, so the first
   request already sees both.
3. `startServer()` listens. A bind failure (`EADDRINUSE`, `EACCES`) logs one
   line, and the server's `error` event exits 1 through the shutdown handler.
4. `warnIfDeletionsPending` warns once when purged users wait in
   `analytics_deletions` while the PostHog personal key or project id is
   missing ([Analytics](#analytics)).
5. `SIGTERM`, `SIGINT`, an unhandled rejection and an uncaught exception all go
   through one shutdown handler (`createShutdownHandler`,
   `src/services/lifecycle.service.ts`). It runs `gracefulShutdown` once, exits
   with the highest code any caller asked for, and exits 1 if shutdown takes
   longer than `SHUTDOWN_TIMEOUT_MS`. A process fault first marks shutdown, so
   readiness answers 503, then is reported and logged with one `errorId` and
   the error-report queue is flushed for at most `ERROR_FATAL_FLUSH_MS` (2 s);
   a signal during that flush still exits 1.
6. With `WORKER_ENABLED`, `startWorkers()` starts the Workers
   ([Queues and Workers](#queues-and-workers)). It is skipped when shutdown
   began during the import, and a failure to start rejects `boot()`, which the
   unhandled-rejection handler turns into exit 1.

`startServer(port)` takes the port as a parameter because `getEnv()` is
memoised: a test cannot change `APP_PORT` after import, so it calls
`startServer(0)`.

`createApp()` (`src/app.ts`) also registers the domain-event subscribers
(onboarding and analytics). Registration is idempotent, so a test may build the
app more than once and still have them.

### Graceful shutdown

`gracefulShutdown(server, workers?)` (`src/server.ts`) runs in this order, and
the order matters:

1. Readiness starts answering 503 (`markShuttingDown`), and every open SSE
   stream is ended (`closeAllStreams`): an SSE response never ends by itself,
   so it would hold `server.close()` open until the force-close.
2. The socket closes. Idle keep-alive connections are swept every 250 ms, and
   connections still open after `SERVER_DRAIN_TIMEOUT_MS` (5 s) are
   force-closed. No new request finds a closed pool.
3. The Workers close. `Worker#close()` lets the in-flight job finish, and that
   job needs the database and Redis, which are still open.
4. The error-report queue is flushed for at most `ERROR_SHUTDOWN_FLUSH_MS`
   (3 s): after the Workers, so a job's final failure is included, and before
   Redis closes, since the flush counts its outcome there.
5. The database, Redis, queue and notification-subscriber clients close, and
   the flag snapshot and maintenance-mode store stop.
6. OpenTelemetry flushes and shuts down last, so it exports the spans the
   earlier steps produce.

Every `close*()` is safe to call twice. `gracefulShutdown` never calls
`process.exit`; the `SHUTDOWN_TIMEOUT_MS` backstop is the shutdown handler's.

### Health checks

Two endpoints, deliberately different depths. Neither is traced.

- **`GET /health`** is liveness. It touches no dependency, so a database blip
  never makes an orchestrator restart a healthy process. It answers
  `{ status: 'ok', uptime, release }`, where `release` is `APP_VERSION`, the
  image's git sha (`dev` outside an image). Both routes are public
  ([SECURITY.md](SECURITY.md#error-tracking-what-reaches-posthog)).
- **`GET /health/ready`** is readiness. Failing it only removes the pod from
  rotation, so it checks the database, Redis and both queue connections, in
  parallel, and answers 503 `not-ready` when any fails, or 503
  `shutting-down` once shutdown has begun. It names only the dependency, never
  a host or driver error. Each check is bounded by
  `READINESS_CHECK_DEADLINE_MS` (500 ms, `createReadinessProbe` in
  `src/services/readiness.service.ts`); a check that runs past it reports
  `false` and its name in `timedOut`, which a 200 never carries. Set the
  orchestrator's probe timeout above 500 ms. A check still running at the
  deadline is left to finish and is not started again until it does, so a
  stalled database holds one pool connection, not one per probe. The Redis
  check has its own 300 ms bound (`waitForRedisProbe`) that neither consults
  nor opens the request-path stall cooldown described under
  [Data layer](#data-layer). Before a queue connection's first `ready`, the
  probe waits for it, so it answers 503 at the deadline while that connection
  is still connecting.

### Data layer

- **Postgres.** `src/services/database.service.ts` creates exactly one
  `postgres` client, and one Drizzle instance over it, per process, at module
  scope. A second client is a second pool and double the connection budget,
  which shows up only under load. The pool options
  (`databaseClientOptions`, `src/configs/database.config.ts`) are
  `max: DB_POOL_MAX`, prepared statements off (transaction pooling breaks
  them), and `DB_STATEMENT_TIMEOUT_MS` as each connection's
  `statement_timeout` when it is above 0. `src/database/migrate.ts` and the
  test global setup build their own clients without these, so a statement
  timeout never cuts a migration short. `withTransaction(fn, executor)` reuses
  a transaction it is passed, with no savepoint, so an outer rollback always
  takes an inner write with it.
- **Redis.** `src/services/redis.service.ts` holds one shared node-redis
  client, connected lazily on first use, so importing a repository in a unit
  test opens no socket. A `closed` flag, set by `closeRedis()` and never reset,
  stops a readiness probe after shutdown from reopening the socket: node-redis
  has no permanently-closed state of its own. `createRedisClient()` builds any
  extra client (the notification subscriber, the snapshot and maintenance-mode
  subscribers) with the same policy. Every key and channel goes through
  `redisKey(...parts)`, which prefixes `REDIS_KEY_PREFIX`.
- **Queues.** `src/services/queue.service.ts` owns the BullMQ queues and the
  two `ioredis` connections they run over (BullMQ needs `ioredis`, which cannot
  share node-redis's connection). The Workers' connection keeps the offline
  queue, which Workers need to ride out an outage. The producers' connection
  turns it off, so an enqueue during an outage rejects at once instead of
  holding its HTTP caller.

**Through a Redis outage.** Before a client's first `ready`, every Redis
client gives up after three retries, so boot and `/health/ready` report
unreachable instead of hanging. After it, every client retries forever, with a
backoff capped at 5 s (`RECONNECT_DELAY_CAP_MS`), so an outage never leaves a
dead client behind. While a client reconnects nothing waits for Redis:
node-redis runs with `disableOfflineQueue`, a producer enqueue rejects, and the
queue check reports `false` for a connection in any post-ready status but
`ready`.

A queue connection that gives up before its first `ready` is replaced on next
use, and Workers on it never recover by themselves, so start Workers only
through `startWorkers()`, which replaces them on a fresh connection; why is in
the file JSDoc of `src/services/worker-supervisor.service.ts`. A failed restart
keeps the queue check `false` until a later one succeeds.

**Through a stalled Redis.** node-redis never times out a command it has
written, and its `connectTimeout` stops at the TCP connect: the handshake after
it has no timer. So `getRedis()` bounds the shared client's whole connect at
`REDIS_CONNECT_TIMEOUT_MS` (5 s) and destroys a client that runs out of time,
and every Redis call a request waits on runs under a deadline
(`src/services/redis-deadline.service.ts`):

- **`withRedisDeadline`** wraps reads and counters: the session denylist read,
  the rate-limit store, the staff-visit, view-audit and flag-exposure dedupes,
  the invitation recipient budget, the mail
  cooldowns, the maintenance-mode notice ids and the OAuth session store. A
  call with no answer in `REDIS_REQUEST_DEADLINE_MS` (300 ms) fails, and for
  the next `REDIS_STALL_COOLDOWN_MS` (5 s) every such call fails at once
  without asking Redis. The failure takes the caller's existing outage path
  (fail open, memory, or `next(error)`), so a stall is handled as an outage. A
  call that misses its deadline while the shared client's first connect is
  still inside its 5 s bound falls back without opening the cooldown: a slow
  connect is not a stall. The verdict waits one turn of the event loop after
  the timer, so a reply already in the socket buffer when a blocked process
  wakes still wins.
- **`waitForRedisWrite`** carries the writes whose loss would widen access (a
  session deny, a maintenance-mode change publish) or let a dedupe or throttle
  key linger (its release). It is always sent, cooldown or not; the request
  waits for it at most the deadline, and one still in flight then lands when
  Redis answers. If the connection drops first the write is lost and its
  failure logged.

Workers, BullMQ, pub/sub, background publishes and counters, and the staff
status reads (bounded by `STATUS_READ_TIMEOUT_MS`) are outside both. The
deadline is a design limit, not a fault detector: a Redis whose latency
regularly passes 300 ms trips the cooldown. What each caller then does is in
[SECURITY.md](SECURITY.md#revocation-and-the-session-denylist) and
[SECURITY.md](SECURITY.md#rate-limiting-one-store-prefix-per-limiter).

## Layers and directory rules

### Layers

| Layer        | Directory              | Job                                                                     |
| ------------ | ---------------------- | ----------------------------------------------------------------------- |
| routes       | `src/routes/`          | Wire middleware to controller methods; one router per feature.          |
| middlewares  | `src/middlewares/`     | Cross-cutting request handling: auth, tenant, gates, limits, errors.    |
| controllers  | `src/controllers/`     | Parse and validate input, call services, shape the response. HTTP only. |
| services     | `src/services/`        | Business rules, transactions, authorization, side effects. Never send.  |
| policies     | `src/policies/`        | Pure authorization predicates that return booleans and never throw.     |
| repositories | `src/repositories/`    | Queries only.                                                           |
| presenters   | `src/presenters/`      | Pure mappers from a row to its wire shape.                              |
| validators   | `src/validators/`      | Zod schemas and `parseBody`.                                            |
| jobs         | `src/jobs/`            | A queue's job payloads, default options and schedules.                  |
| workers      | `src/workers/`         | One BullMQ Worker per queue.                                            |
| configs      | `src/configs/`         | The validated environment and library configuration.                    |
| constants    | `src/constants/`       | Fixed values: limits, names, keys, registries.                          |
| utilities    | `src/utilities/`       | Small pure helpers.                                                     |
| errors       | `src/errors/`          | Error classes and Postgres error handling.                              |
| templates    | `src/templates/email/` | One plain function per email: subject, text and HTML.                   |

`eslint.config.mjs` turns the boundaries that matter into `error`-level gates:

- `import-x/no-restricted-paths`: controllers may not import a repository or
  `database.service`; controllers may not import another controller, except
  `base.controller.ts` and `helpers.controller.ts`; services, repositories,
  policies, errors and presenters may not import controllers, routes or
  middlewares; repositories may not import a service other than
  `database.service`; policies may not import repositories, services or
  `database`; configs may not import controllers.
- `@typescript-eslint/no-restricted-imports`: controllers import
  `database/models` for types only.
- `no-restricted-imports` over `src/**`, with `src/services/platform-*.service.ts`
  exempt: the six cross-tenant repositories (`platform-tenant`,
  `platform-stats`, `platform-user`, `platform-email`, `platform-onboarding`,
  `platform-billing`)
  stay out of every other module, so "your tenants" is never served from a
  query that sees every tenant.
- `import-x/no-cycle` over relative and `@/` imports.

`tests/unit/lint-gates.test.ts` lints the committed violations under
`tests/fixtures/lint-zones/` and `tests/fixtures/lint-cycle/` to prove each
rule fires. The zones are a blocklist, so an edge no zone names is unchecked.
When a rule refuses an import, either the import is wrong or the zone config
and the zone list above change in the same commit.

**Controllers.** Every route handler is a `BaseController` method
(`src/controllers/base.controller.ts`), an arrow-function field built through
`this.handle(handler)`, which forwards a thrown or rejected error to `next()`
and never sends a response. After the headers were sent it logs one `warn` and
still forwards, and `errorHandler` destroys the socket. Two handlers are not
wrapped, each with a file-local reason: `handleGoogleCallback`
(`auth.controller.ts`) redirects every failure to the frontend, and
`streamNotifications` (`notification-stream.controller.ts`) is an SSE stream.
Each controller file exports one singleton, which its routes file imports.

**Services.** A service owns its transaction and never sends a response. Where
a route replies before the work (`POST /auth/link/request` answers 202
first), the service exposes the work as a function the controller calls after
replying, and that function never rejects. Authorization that matters is
decided inside the transaction: the router's `requireRole` is the early coarse
gate, and the service re-reads the actor's role under lock and applies
`src/policies/tenant.policy.ts`. A controller may report `role` or `access`
but never authorizes on them.

**Repositories.** Every public method takes a final optional
`executor: DbExecutor = db`, so a caller runs it inside its own transaction.
`BaseRepository` owns soft-delete filtering, `updatedAt` maintenance and the
unique-violation-to-409 translation; only `users`, `user_tokens` and `tenants`
have the `deletedAt` and `updatedAt` it needs. Every other repository stands
alone and says why in its file JSDoc.

**Domain events.** A service that needs other features to react calls
`emitDomainEvent` (`src/services/domain-events.service.ts`) after its own
transaction commits, since Drizzle has no after-commit hook, and awaits it, so
every subscriber has run before the request answers. A failing subscriber is
logged and never fails the emitter or the subscribers after it. Onboarding and
the analytics forwarder are the subscribers.

**Lock order.** Issuing a sign-in, step-up or invitation confirm link first
takes a transaction-scoped advisory lock on the address, the address and
invitation (for a confirm link), or the session (`lockLinkIssue`,
`pg_advisory_xact_lock`, `user-token.repository.ts`), alone, in a transaction
that holds no other lock; it then locks the live link rows it revokes, in id
order, and nothing else, so it joins no cycle. Without it two concurrent
issues each revoke before the other's insert commits, and both links stay
live. An invitation confirm link's insert also takes `FOR KEY SHARE` on its
invitation row (the foreign key), which the accept and revoke UPDATEs
(`FOR NO KEY UPDATE`) do not conflict with. A resend, which rewrites the
unique `token_hash` and so takes `FOR UPDATE`, and the retention purge's
delete do. Each only waits: neither takes a `user_tokens` row or the issue's
advisory lock, so no cycle forms. Every transaction that locks more than one row set takes them
in this order:

1. the user row (`lockById`, `user.repository.ts`), for a link, invitation or
   Google sign-in (`FOR SHARE`, before the refresh insert), refresh rotation,
   logout, the refresh kills, step-up, the never-verified account claim,
   tenant creation, and an owner invitation's or any platform-tenant
   invitation's accept (`lockUserForOwnership`,
   `tenant-membership.service.ts`, before the claim);
   none of these goes on to lock a membership or tenant row, and a customer
   invitation's accept, verify or confirm goes on only to the seat lock
   (5 below), before its claims. One that also
   locks token rows takes the user row, then the link row, then the refresh
   rows: a step-up confirm locks the user row, claims its link and then moves
   the session's refresh rows (`confirmStepUpLink`, `step-up.service.ts`); an
   invitation confirm locks the invitee's row `FOR SHARE` (or inserts the new
   account), then takes the seat lock on a customer tenant, then claims its
   link, then claims the invitation
   (`claimForAcceptById`), inserts the membership and inserts the refresh row
   (`confirmInvitation`, `tenant-invitation.service.ts`). A deactivation, a
   staff sign-out and a sign-out of the other sessions take the user row and
   then revoke the address's links (`revokeSignInLinksOf`), so a confirm that
   claimed its link before the user row would deadlock against them
   (`tests/integration/services/invitation-confirm-race.test.ts`). A one-click
   invitation verify inserts the new account and takes the seat lock before it
   claims the invitation and inserts the refresh row;
2. a tenant's owner rows (`lockOwners`, in id order);
3. its memberships (`lockMemberships`, in `user_id` order);
4. when the actor has no membership there, the actor's platform-tenant
   membership `FOR SHARE` (`lockPlatformRole`, through `lockTenantAccess` in
   `tenant-access.service.ts`);
5. a customer tenant's billing row, the seat lock (`lockSeats`,
   `src/services/billing/seats.service.ts`, `FOR NO KEY UPDATE`), taken by
   every write that adds a seat on the members limit: an invite (after
   `lockActorRole`), the resend of an expired invitation, and an accept,
   invitation verify or confirm (after the user-row step). It comes before
   any invitation or membership-row write, so two such writes queue here and
   never both take the last seat. The platform tenant has no billing row and
   takes no seat lock. The billing sync (`syncTenantBilling`,
   `src/services/billing/billing-sync.service.ts`) locks only this row, and
   calls the payment provider only before or after its transaction; so do the
   billing scheduler's writes. A suspend or archive never touches it: the
   scheduler cancels for them;
6. the tenant or settings row a write changes (`lockById` in
   `tenant.repository.ts`, `lockByTenantId` in `tenant-settings.repository.ts`);
7. a user's notification preference rows, in `NOTIFICATION_TYPES` order
   (`updatePreferences`, `notification.service.ts`); that transaction locks
   nothing else (its foreign key takes `FOR KEY SHARE` on the user row).

Three writes take a user row later. Staff writes lock owner rows and platform
memberships first, then the actor's user row `FOR SHARE`
(`assertStillPlatformRole`, `platform.service.ts`) and, for a user action, the
target's (`lockStaffPair`, `platform-user.service.ts`), then the tenant row. A
role change to owner takes the target's user row `FOR SHARE`
(`lockUserForOwnership`) after the tenant's owner-row locks: a delete that
holds them took them before the target's user row, so the role change queues
there holding nothing the delete wants. Skipping the lock when the target is
already an owner only avoids a redundant lock. Each grant's `FOR SHARE` (an
owner grant, or any platform-tenant invitation's accept) conflicts with a
staff delete's `FOR NO KEY UPDATE` on the target. A grant that holds the row
first commits before the delete reads on: a new customer tenant fails its
second ownership read (409), and a new platform role is seen by the role
re-read after the user-row lock (`lockStaffPair`), so the rank rule and the
last-owner guard apply to it. `pnpm platform:grant` locks the platform
tenant's owner rows and the account's membership, then the account's user row
`FOR SHARE` (`grantInTransaction`, `platform.service.ts`), the mode a
platform-invitation accept takes, so an accept that holds the row while it
waits for the grant's membership insert coexists with it instead of
deadlocking. A transaction that locks
membership rows in both a customer tenant and the platform tenant locks the
customer tenant's first. Postgres cannot enforce an application lock order;
the JSDoc of each lock method states its place, and deadlock regression tests
(`tests/integration/services/tenant-membership.service.test.ts`,
`tests/integration/api/platform-user-race.test.ts`,
`tests/integration/services/billing/seat-lock-order.test.ts`) hold it.

**Lock modes.** A lock that only guards a read-then-write takes
`FOR NO KEY UPDATE`, because `FOR UPDATE` conflicts with the `FOR KEY SHARE`
lock every foreign-key insert takes on the row it references: on a tenant it
would block that tenant's audit inserts and invitation accepts for the whole
transaction. `FOR UPDATE` is only for a transaction that deletes the locked row
or changes a key column; a method that serves both takes a `RowLockMode`
(`src/types/lock-mode.ts`) defaulting to `'no key update'`. The user row's
modes are in
[SECURITY.md](SECURITY.md#deactivation-against-a-concurrent-sign-in).
Lock tests detect blocking with `pg_blocking_pids`
(`tests/helpers/lock-probe.ts`), not with sleeps.

### Platform access

Staff are the members of the one tenant with `is_platform` set. These services
carry staff access; the routes in front of them check the platform role first,
and every write re-checks it under lock.

| Service                          | Job                                                                                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant-access.service.ts`       | `lockTenantAccess`: locks owners, memberships and, when the actor has no membership, the platform membership, and returns the actor's access. Membership wins; the platform tenant is members-only.                                                              |
| `platform.service.ts`            | Reads a user's platform role (one indexed read, no cache), `assertStillPlatformRole` inside a staff write, and the grant behind `pnpm platform:grant`.                                                                                                           |
| `platform-tenant.service.ts`     | Staff tenant search and detail, create with an owner invitation, owner re-invitation, and the suspend, reactivate and archive transitions (`transitionLifecycle`).                                                                                               |
| `platform-user.service.ts`       | The staff user directory and user actions (create with a welcome sign-in link, edit, staff-sent sign-in link, deactivate, reactivate, sign out, soft delete). Edits and state changes lock through `lockStaffPair`; the sign-in link checks rank without a lock. |
| `platform-purge.service.ts`      | `purgeUser` and `purgeTenant`, the only hard delete of a user or a tenant. With `retention.service.ts`, the only code that names the audit trigger's purge settings, and the only code that names `app.audit_redact`.                                            |
| `platform-stats.service.ts`      | The staff Overview: totals and zero-filled daily series.                                                                                                                                                                                                         |
| `platform-email.service.ts`      | Message tracking: search, detail, masked preview, health, suppressions and resend, which runs the action that sent the mail, with that action's own gates and audit.                                                                                             |
| `platform-onboarding.service.ts` | The staff funnel, tenant list and tab, the Overview's stuck count, manual completion, reminders, and `pnpm onboarding:reconcile`.                                                                                                                                |
| `platform-flags.service.ts`      | The flag inspector and evaluate view ([Feature flags](#feature-flags)).                                                                                                                                                                                          |
| `platform-system.service.ts`     | `GET /platform/system/status`: the release, error tracking's counts, the flags' snapshot and the maintenance mode. An open object, one key per section.                                                                                                          |
| `audit.service.ts`               | `record(entry, tx)` in the caller's transaction with strict per-action metadata; the hourly platform-access entry; the tenant and platform audit-log reads.                                                                                                      |

Each cross-tenant repository is imported by its own `platform-*` service only;
`platform-user.repository.ts` also by `platform-purge.service.ts`. What staff may do, and the gates on it, are in
[SECURITY.md](SECURITY.md#platform-staff).

### Extending Apex

Apex is a template: a product adds its own fields, states and staff actions.
The step-by-step recipes are in
[CONTRIBUTING.md](CONTRIBUTING.md#extending-the-apex-api). The rules a recipe
does not make obvious:

- A new staff route is not done until its row is in
  `tests/integration/api/platform-route-gates.test.ts` (the completeness check
  fails without it) and its audit action is mirrored in
  `apex-boilerplate/src/constants/audit-actions.ts`.
- `TENANT_LIFECYCLE_STATES` also feeds the `tenants` CHECK constraint, so a
  new state needs a generated migration.
- A template whose variables carry a token must be `transactional` (the type
  enforces it) and needs a `resendAction` that re-issues the token, or `null`.
- An audit entry for an edit lists the changed field names, never their values.

### Directory rules

Every file in a governed directory carries its role as a suffix
(`*.controller.ts`, `*.service.ts`, `*.repository.ts` and so on): the
`check-file/filename-naming-convention` map in `eslint.config.mjs` is the list,
and `pnpm lint` fails on a misnamed file. The suffix is the singular of the
role, except `.validators`, `.utilities`, `.constants` and `.routes`.
Subfolders inherit their parent's rule, and every folder under `src/` is
kebab-case.

Directories with no filename rule:

- `src/errors/`: error classes and Postgres error handling (`HttpError`,
  `isUniqueViolation`, `redactedForLog`).
- `src/types/`: the `Express.Request` augmentation (`express.d.ts`) and the
  shared and domain types several layers use (`actor.ts`, `flags.ts`,
  `onboarding.ts`).
- `src/scripts/`: tools a `package.json` script runs through `tsx`, never
  imported by the app. They live under `src/` so `tsc` and type-aware lint see
  them.
- `src/database/`: `migrate.ts` beside `models/` and `migrations/`. Migrations
  are generated by `drizzle-kit` and committed; see
  [DATABASE.md](DATABASE.md).
- `src/observability/`: `tracing.ts`, loaded by path through `--import`.
- `scripts/` (repo root): repo tooling (`lint-docs.mjs`, `comment-style.mjs`,
  `history-patterns.mjs`), imported by `eslint.config.mjs` and the tests, never
  by the app.

`src/index.ts`, `src/server.ts` and `src/app.ts` sit directly under `src/`:
they name the three stages of the [boot sequence](#boot-sequence), not a role a
suffix could encode. No test file lives under `src/`.

A new top-level concern under `src/` gets its naming rule in
`eslint.config.mjs` in the same change.

#### No barrel files

There is no re-exporting `index.ts` anywhere in `src/`. Import the module
directly (`@/configs/env.config`, never `@/configs`). A barrel fails the
filename rule in every governed directory, and it hides real edges from
`import-x/no-cycle`. `src/routes/index.routes.ts` builds a router and
re-exports nothing, so it is not a barrel.

## Request lifecycle

### Request path: auth and beyond

`createApp()` mounts, in this order, and Express runs them in registration
order:

| Step                                         | Why it sits there                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-powered-by` off, `trust proxy`            | `TRUST_PROXY` decides what `request.ip`, and so every IP-keyed limiter, sees; a malformed value throws at boot.                                                 |
| `helmet`                                     | First, so a preflight, a 404 or an error response already carries the headers.                                                                                  |
| `cors`                                       | An allowed preflight ends here; a disallowed origin gets no grant header and the request carries on.                                                            |
| `requestId`                                  | Every later response carries `X-Request-Id`.                                                                                                                    |
| `recordRouteTemplate`                        | Ahead of every router, so an error's `http_route` keeps the mount path ([Error tracking](#error-tracking)).                                                     |
| `requestContext`                             | Opens the per-request store the logger reads ([Request correlation](#request-correlation)).                                                                     |
| `maintenanceModeGate`                        | After `cors`, so a refusal carries the grant; before every router, the webhooks, the proxy and the body parsers ([Maintenance mode](#maintenance-mode)).        |
| `posthogSession`                             | Copies `X-POSTHOG-SESSION-ID` into the request context, for server events.                                                                                      |
| `/api/v1/webhooks/email`                     | Before the body parsers: a provider's signature covers the exact bytes, so the route reads them with its own `express.raw` ([Email tracking](#email-tracking)). |
| `/api/v1/webhooks/razorpay`                  | Before the body parsers for the same reason: Razorpay signs the exact bytes. It verifies, records and queues on the `billing` queue.                            |
| `/api/v1/collect`                            | Before the body parsers too: replay bodies stream to PostHog unread ([Analytics](#analytics)).                                                                  |
| `express.json` (1 MB), `urlencoded` (100 KB) | The body parsers.                                                                                                                                               |
| `GET /health`, `GET /health/ready`           | [Health checks](#health-checks).                                                                                                                                |
| `/api/v1`                                    | `createApiRouter()` (`src/routes/index.routes.ts`).                                                                                                             |
| 404, then `errorHandler`                     | Last, so it sees errors from everything before it.                                                                                                              |

`createApiRouter()` mounts one router per feature: `auth`, `profile`,
`notifications`, `tenants`, `invitations`, `platform`, `flags` and `status`. A
new feature router is one more `router.use(...)` there, never a change to
`app.ts`.

- **Auth.** The auth router refuses any body that is not `application/json`
  with 415 (`requireJsonContentType`, router-wide). Its open routes need no
  access token; `POST /auth/refresh` and `/auth/logout` read the refresh cookie
  off the raw `Cookie` header (there is no `cookie-parser`) and check `Origin`
  first. How each credential works is in
  [SECURITY.md](SECURITY.md#authentication).
- **`requireAuth`** (`src/middlewares/auth.middleware.ts`) is mounted
  router-wide on the profile, notification, tenant, platform and flags
  routers, so a route added there inherits it, and per route elsewhere. It
  verifies the bearer token, refuses a session on the Redis denylist, then
  reloads the user by id. That reload is one database read per request,
  deliberately not cached: a deactivated or deleted account is refused on its
  next request, not when its token expires. Every response behind it is
  `Cache-Control: no-store`, except the SSE stream, which sends `no-cache`.
- **Tenant routes** compose `resolveTenant()` and `requireRole(...)` per
  route; the tenant comes from `:slug` only. See
  [SECURITY.md](SECURITY.md#tenant-roles).
- **Platform routes** mount `requireAuth` router-wide; their gates, the
  OPTIONS refusal and the staff-write log line are in
  [SECURITY.md](SECURITY.md#platform-staff).
- **Every authenticated write has a limiter**, built once per router and
  reused, so the in-memory fallback keeps one budget;
  `tests/unit/routes/route-limiters.test.ts` fails a write route without one.

### Sign-in, step-up and their tokens

A person signs in by an emailed link, by Google or by a passkey
(`PASSKEY_MODE`; [SECURITY.md](SECURITY.md#passkeys)). The auth routes, all
under `/api/v1`:

| Route                                                                                                                             | Service                                                            | What it does                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/link/request`                                                                                                         | `requestSignInLink` (`sign-in-link.service.ts`)                    | Answers 202 before any lookup, then mails a link (or, on Apex, a staff invitee's invitation) in the follow-up.                                                                                                                                                                                                       |
| `POST /auth/link/verify`                                                                                                          | `verifySignInLink`                                                 | Spends the link and signs in the account its address holds, creating a verified one on the first web click.                                                                                                                                                                                                          |
| `POST /invitations/verify`                                                                                                        | `verifyInvitation` (`tenant-invitation.service.ts`)                | A new address on a customer invitation joins in one transaction; any other click answers 202 and mails a confirm link in the follow-up (`requestInvitationConfirm`).                                                                                                                                                 |
| `POST /invitations/confirm`                                                                                                       | `confirmInvitation` (`tenant-invitation.service.ts`)               | Spends the confirm link and the invitation, signs the invitee in as a recent sign-in, and joins them.                                                                                                                                                                                                                |
| `GET /auth/google`, `GET /auth/google/callback`                                                                                   | `completeGoogleSignIn` (`google-auth.service.ts`)                  | Google sign-in.                                                                                                                                                                                                                                                                                                      |
| `POST /auth/step-up/link/request`, `/auth/step-up/link/verify`                                                                    | `requestStepUpLink`, `confirmStepUpLink` (`step-up.service.ts`)    | Any signed-in user: the request takes `{ app }`, mails a link bound to the calling session, and the verify confirms it for that session alone.                                                                                                                                                                       |
| `POST /auth/passkeys/step-up/options`, `/step-up/verify`                                                                          | `startPasskeyStepUp`, `finishPasskeyStepUp` (`step-up.service.ts`) | Any signed-in user: confirms it's them with a passkey, for the calling session alone.                                                                                                                                                                                                                                |
| `GET /auth/passkeys/config`                                                                                                       | `passkey.controller.ts`                                            | Public: answers `PASSKEY_MODE` in every mode.                                                                                                                                                                                                                                                                        |
| `POST /auth/passkeys/sign-in/options`, `/sign-in/verify`                                                                          | `startPasskeySignIn`, `finishPasskeySignIn` (`passkey.service.ts`) | Public: verifies the assertion, then signs in the account that owns the passkey, as a recent sign-in. `400 PASSKEY_UNKNOWN` for a missing row; `403 PASSKEY_NO_ACCESS` for an inactive, deleted, unverified or non-staff-on-Apex account (the last gets its own message). Options and verify have separate limiters. |
| `GET /auth/passkeys`, `POST /auth/passkeys/registration/options`, `/registration/verify`, `PATCH` and `DELETE /auth/passkeys/:id` | `passkey.service.ts`                                               | List (answers `userHandle` and `passkeys`, each with its `credentialId`), create, rename and delete (answers `userHandle` and the remaining `passkeys`) the caller's passkeys. Create and delete need a recent sign-in, checked before the limiter.                                                                  |
| `POST /platform/users/:id/sign-in-link`                                                                                           | `platform-user.service.ts`                                         | Staff send a user an ordinary sign-in link: Apex for staff, `WEB_URL` for anyone else.                                                                                                                                                                                                                               |
| `POST /auth/refresh`, `POST /auth/logout`                                                                                         | `session.service.ts`                                               | Rotate or revoke the refresh cookie's session.                                                                                                                                                                                                                                                                       |

**The tokens.** `user_tokens` holds three purposes: `refresh` (the session
chain), `sign_in_link` (an address and an app, never a user) and
`step_up_link` (a user and the session it elevates). `user_passkeys` holds the
passkeys (a public key and counters, never a private key), and single-use
passkey challenges live in Redis for 5 minutes
(`passkey-challenge.service.ts`). `tenant_invitations`
holds the invitation links. Every one is 32 random bytes with only its SHA-256
stored; [DATABASE.md](DATABASE.md#user_tokens) has the columns and the shape
CHECK, and [SECURITY.md](SECURITY.md#email-links) the lifetimes and claims.
`link-token.service.ts` issues, claims and peeks the two link purposes and
builds their URLs, each through `withUtm` (`src/utilities/utm.utilities.ts`),
the one place UTM parameters are added to a link a user receives.

**The step-up flow.** A route behind `requireRecentAuth()` answers
`401 REAUTH_REQUIRED` once the session's `auth_time` is older than 10 minutes.
Every signed-in user can then confirm it's them, staff and customers alike.
The client picks a method: a link (request, then verify from the mailed page)
or a passkey (options, then verify). Both return a new access token and mint
no session. The link request names the app (`web` or `apex`) the page opens
on; Apex is for staff only. The waiting tab refreshes to pick up the new
`auth_time` and retries the action once. Google is not a step-up method:
Google documents no account re-authentication, so a Google round-trip cannot
prove the person is present. The checks are in
[SECURITY.md](SECURITY.md#confirm-its-you).

**Required mode.** With `PASSKEY_MODE=required`, `requireAuth` ends with
`assertPasskeySetupDone`: an account with no passkey gets
`403 PASSKEY_SETUP_REQUIRED` outside `PASSKEY_SETUP_ALLOWED`
(`passkey.constants.ts`). The count query runs only in that mode.

### Errors and the response envelope

Every response `errorHandler` and the controllers write uses one envelope,
defined once in
`src/utilities/response.utilities.ts`:

```json
{ "success": true, "message": "Success", "statusCode": 200, "data": {} }
{ "success": false, "message": "No route matches this method and path. Check both, then try again.", "statusCode": 404, "code": "not_found", "requestId": "…" }
{ "success": false, "message": "Your sign-in expired. Sign in again to continue.", "statusCode": 401, "code": "ACCESS_TOKEN_EXPIRED", "requestId": "…" }
```

`code` is one stable token a client branches on. Every 404 carries one, from
`NOT_FOUND` (`src/errors/not-found-errors.ts`), and
`tests/unit/errors/not-found-codes.test.ts` fails on a 404 thrown without it; `errors` is field-level
validation detail, shaped by the validator. They are separate fields, so a
client parsing `errors` never gets a different shape when `code` is present. A
success with no payload goes through `messageResponse`, which always sends
`data: null`. Every 5xx `errorHandler` writes, except a maintenance refusal,
also carries `errorId`. `/health`, `/health/ready` and the SSE stream-capacity
503 write their own bodies.

A refusal a client can act on also carries `details`, structured facts next
to `code`: a plan limit's 402 `PLAN_LIMIT_REACHED` sends
`{ key, used, limit }` and a plan feature's 402 `PLAN_FEATURE_REQUIRED` sends
`{ key }`. `errorHandler` writes an `HttpError`'s `details` on a 4xx only,
never on a masked 5xx, and a response without them has no `details` key. A
full workspace refusing an invitee's join sends none, since the invitee is
not a member.

The envelope is not RFC 9457 `problem+json`: switching would change what every
client parses on every response.

`errorHandler` (`src/middlewares/error.middleware.ts`) is the terminal
middleware. It takes four parameters because Express recognises an error
handler by arity. It decides:

- **After the headers were sent**, nothing more can be written: it reports the
  error as a 500 (unless the client went away), logs it redacted with its
  `errorId`, and destroys the socket.
- **A maintenance refusal** gets its own body and `Retry-After`, unmasked and
  never logged.
- **The status** is the `HttpError`'s, else a foreign error's 4xx `status` (the
  body parser's 400 or 413), else 400 for text Postgres cannot store, else 500.
- **A 4xx** shows the `HttpError`'s message, or a foreign error's only when it
  marks it `expose`; a body-parser refusal answers its own copy and code
  (`malformed_json`, `payload_too_large`). It is not logged, except one value-free `warn` when
  Postgres refused a character in client text.
- **A 5xx** is masked ("Our server hit an error. Try again, and contact support with the error ID if it happens again."), gets an `errorId`, and is
  logged redacted (`redactedForLog`, `src/errors/postgres-errors.ts`), except a
  `PosthogUnavailableError`, whose thrower already logged why. It is reported
  to error tracking only when the capture rule admits it
  ([Error tracking](#error-tracking)).

### List endpoints

Every endpoint that returns a table's rows answers one shape, built by one
helper, `listPage` (`src/utilities/list-page.utilities.ts`), from one
request schema, `listParamsSchema` (`src/validators/list.validators.ts`).

**The request.** `search` (1–100 characters, trimmed, no NUL; a literal,
case-insensitive substring of the list's search columns), `sort` (one
whitelisted key, `-` first for descending), `cursor` (opaque, from a previous
page), `direction` (`next`, the default, or `prev`, which needs a cursor),
`limit` (1–100, default 20) and `total=1`, plus the list's own filters. An
enum filter takes a comma list (`status=active,inactive`); a filter's default
is applied by the server, so a URL can omit it.

**The response.** The envelope's `data` is
`{ items, page: { nextCursor, prevCursor, hasNext, hasPrev, limit }, total? }`.
`total` appears only for `total=1`: `{ count, capped }`, counted exactly up to
1,000 rows and reported as `{ count: 1000, capped: true }` past them (a client
shows "1,000+"; the query is `select count(*) from (<the list> limit 1001)`).

| Endpoint                           | `search`                                           | Filters                                                            | Sorts (default first)                         |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `GET /platform/tenants`            | name, slug                                         | `state` (list; active, suspended)                                  | `name`, `created`, `-created`                 |
| `GET /platform/users`              | email, first and last name, full name              | `status` (list; active, inactive), `verified`, `signedIn`, `staff` | `email`, `created`, `-created`, `-lastSignIn` |
| `GET /platform/emails`             | recipient                                          | `status`, `template` (lists), `user`, `tenant`, `from`, `to`       | `-created`, `created`                         |
| `GET /platform/email-suppressions` | address                                            | `state` (list; active)                                             | `-created`, `created`, `address`              |
| `GET /platform/onboarding/tenants` | tenant name                                        | `state` (one; stuck)                                               | `progress` for stuck, else `-started`; `name` |
| `GET /platform/audit-log`          | action, actor email, target email or name          | `tenant`, `actor`, `target`, `action`, `access` (lists)            | `-occurred`, `occurred`                       |
| `GET /tenants/:slug/audit-log`     | action, actor email, the entry's own tenant's name | `action`, `access` (lists), `actor`                                | `-occurred`, `occurred`                       |
| `GET /tenants/:slug/members`       | email, full name                                   | `role` (list)                                                      | `name`, `email`, `role`, `-joined`            |
| `GET /tenants/:slug/invitations`   | email                                              | `role` (list)                                                      | `-created`, `email`                           |
| `GET /tenants`                     | name                                               | `role` (list)                                                      | `name`, `-joined`                             |
| `GET /notifications`               | title, body                                        | `unread`                                                           | `-created`                                    |
| `GET /platform/flags`              | key, description                                   | `kind`, `state` (lists)                                            | `key` (in memory)                             |
| `GET /platform/flags/unregistered` | key                                                | none                                                               | `key` (in memory)                             |

`GET /platform/flags/meta` is not a list: it carries the traits reference and
the snapshot's age. The mark-read routes and the bell's `limit=5` read are
unchanged.

**The seek.** A sort is a list of columns; the helper appends the row id, in
the first column's direction, as the tiebreaker. A page reads `limit + 1` rows
after the cursor's keys: one row comparison `(a, id) > ($1, $2)` when every
column runs one way, the OR-expansion `(a > $1) or (a = $1 and b < $2) or …`
when they mix. `prev` reverses every comparison and the order, then flips the
page back. Every sort column is NOT NULL, or coalesced the same way in the
query and its index (`-lastSignIn` reads `coalesce(last_logged_in_at,
'-infinity')` through `lastSignInSort`, so never-signed-in users come last).
A cursor whose row is gone is not a gap: when the rows after a cursor are gone
(deleted, or `prev` from the first row), the read answers the list's edge page
on that side, so a page never skips a row and a client can always step back.
My-tenants ties break on `tenant_id`, so memberships created in the same
instant page in a stable order.

**The sort-and-index rule.** Each whitelisted sort has an index of exactly
its shape, filter prefix first: `(tenant_id, created_at, id)` for a tenant's
invitations newest first. `tests/integration/database/list-indexes.test.ts`
EXPLAINs the helper's own query for every sort and fails when the node under
its `Limit` is a Sort. Three are bounded instead and say so there: member
`name` and `email` and my-tenants `name` order a joined row, so they sort one
tenant's members or one user's memberships, found through an index led by
that tenant or user; onboarding orders the progress query's computed
timestamps, so it sorts the tracked tenants, read through an index. The tenants,
users, emails and suppressions searches run on GIN trigram indexes (`pg_trgm`)
of the same lowered expressions. The members, invitations, my-tenants and
notifications searches are bounded by their tenant or user instead. The
platform audit-log search has no index: it scans by `occurred_at` across the
log, and so does its `total=1` count, which is accepted. Migrations
`0026_list_indexes.sql` and `0027_users_full_name_trgm.sql` build the indexes;
their locking and the manual live-database path are in
[DATABASE.md](DATABASE.md).

**Cursors.** A cursor is base64url JSON `{ v, sort, keys, scope }`, a dot,
and an HMAC-SHA256 under `CURSOR_SECRET` (`src/utilities/list-cursor.utilities.ts`).
`scope` hashes the effective search, filters (defaults applied, comma lists
sorted) and sort, so a cursor resumes only the view it came from. A list whose
rows depend on more than the query string sets `bound` on its definition
(`ListDefinition.bound`, `InMemoryListDefinition.bound`). Every list also has a
required `name`, unique among lists, and `bindScope` folds the name and the
bound values into the scope: a tenant's members, invitations and audit log
bind the tenant, my tenants and notifications bind the user. A cursor from
another tenant, user or list, even one with the same sort and filters, is
therefore refused as `CURSOR_INVALID`, never read as a seek. Anything else is
the one `400` `InvalidCursorError` (`code: 'CURSOR_INVALID'`,
`errors.cursor: ['This list link is out of date. Reload the list from its first page.']`): empty, over 4,096 characters, a bad
signature, another version, sort or scope, or keys of the wrong count or type.
A client drops the cursor and reloads the first page.
[SECURITY.md](SECURITY.md#input-and-output) has the threat.

**Audit lists.** The read kind is required: `scope: 'tenant' | 'platform'`
selects the joins and the search columns. A tenant read confines search to the
tenant: it matches no user-target email, and the only target it joins is the
entry's own tenant. Actions in `RETIRED_AUDIT_ACTIONS`
(`src/constants/audit.constants.ts`) are no longer written but their stored
rows stay, so they are listed and accepted by the `action` filter
(`STORED_AUDIT_ACTION_NAMES`); `AUDIT_ACTIONS` is what a build may write.

**Flags.** `listPageInMemory` gives the same contract over an array already
searched and filtered: the flags registry and the flags PostHog has that it
lacks. Both lists are split from `GET /platform/flags/meta`. A flag key longer
than `LISTED_FLAG_KEY_MAX` (400) cannot round-trip through a cursor, so
`listableUnregisteredFlags` leaves it out of the lists and logs one warning
per snapshot; the system-status count uses the same function, so it agrees
with the list. The key still evaluates.

**Notifications.** `GET /notifications` is the shared list. The SSE
`Last-Event-ID` replay is not a page: it reads the newest `SSE_REPLAY_LIMIT`
notifications through `listRecent` (see [Realtime (SSE)](#realtime-sse)).

**Adding a list.**

1. In the repository, export a `defineList({ name, base, id, sorts, toItem })`
   (a unique `name`, plus `bound` when the rows depend on a path tenant or the caller):
   `base(executor, seek)` selects the item's columns plus one text or number
   column per sort column (`timestampKey(…)` for a timestamp), ANDs every
   filter, `searchCondition(search, [lowered expressions])` and `seek` into
   one `where`, and ends in `.$dynamic()`; `toItem` drops the sort columns. A
   method calls `listPage(executor, definition, params)`.
2. In the validator, `listParamsSchema({ sorts, defaultSort, filters })`, with
   `listFilter(name, values)` for an enum filter and its default in the field.
3. The service maps items if it must; the controller sends the page as `data`.
4. Add each sort's index to the model, generate the migration, and add one
   `EXPLAIN` row per sort to `list-indexes.test.ts`.
5. Add a `describeListContract` block to
   `tests/integration/api/list-contract.test.ts`
   (`tests/helpers/list-contract.ts` lists what it proves).

### Request correlation

`requestId` (`src/middlewares/request-id.middleware.ts`) honours a
caller-supplied `X-Request-Id` only when it is a UUID, since reflecting an
arbitrary header is how log injection starts, and otherwise generates one.
`requestContext` then opens an `AsyncLocalStorage` store
(`src/services/request-context.service.ts`) for the request, and
`resolveTenant` adds the tenant to it. The logger's pino `mixin` reads that
store on every call, so each line logged during a request carries `requestId`,
and `tenantId` once the tenant is resolved, plus `traceId` and `spanId` while a
span is active. Callers never pass them, and `mixinMergeStrategy`
(`logger.service.ts`) makes the mixin's fields win over a caller's field of the
same name, so log meta cannot spoof them.

### A second frontend: Apex

`APEX_URL` (optional) names the Apex staff dashboard. Links and redirects pick
a frontend with `frontendUrl(app)` (`src/services/frontend-links.service.ts`),
where `app` is `'web'` or `'apex'`, never a URL: it returns `APEX_URL` for
`'apex'` when that is set, and `WEB_URL` otherwise.

- Invitations to the platform tenant link to Apex; every other invitation
  links to `WEB_URL` (`tenant-invitation.service.ts`).
- `POST /auth/link/request` takes `app`, which picks the frontend its link
  opens. The link's row keeps it, and verify reads it from the row, never from
  the request.
- A staff-sent sign-in link takes no `app`: the server links a staff target
  to Apex and anyone else to `WEB_URL` (`platform-user.service.ts`). A user
  staff create gets a `welcome` mail whose sign-in link opens `WEB_URL`.
- `GET /auth/google?app=apex` stores the choice in the OAuth session, with a
  same-origin `redirect` when one is valid (`rememberOAuthApp`), and the
  callback redirects to that frontend's `/auth/callback`, carrying the
  `redirect` and `new=1` for a new account (`oauthIntentOf`,
  `src/controllers/helpers.controller.ts`). On Apex, Google signs in only an
  existing staff account and never creates one.

`isAllowedOrigin` (`src/utilities/origin.utilities.ts`) always grants
`WEB_URL`, `APEX_URL` and `CORS_ALLOWED_ORIGINS`, so an Apex served at
`APEX_URL` needs no CORS entry. Google calls back to `APP_URL` only, so with
Google sign-in on and an Apex host other than `APP_URL`'s, `COOKIE_DOMAIN` must
cover both, and boot refuses otherwise.

### Email tracking

Every outbound email is one `email_messages` row, created when the mail is
queued (in the caller's transaction when it has one), or by the email worker for
a job that reaches it without one: the recipient, the template, the user, tenant
and invitation it is about, the frontend its link opens (`link_app`), the sender
class, its `Message-ID`, and the template's `previewVariables`, never a rendered
body, a link or a token. Each send attempt is an append-only `email_logs` row,
and each provider event an `email_events` row. A status only moves to a higher
rank (`EMAIL_STATUS_RANK`, `src/constants/email.constants.ts`), so a fast
`delivered` event is never overwritten by the worker's `sent`; `opened` and
`clicked` never change it.

A write that must commit the message row with its own writes creates it in its
transaction (`createTrackedEmail`) and enqueues after commit
(`enqueueTrackedEmail`), so the worker never dequeues a job whose row it cannot
see. Provider webhooks (`src/services/email-webhook.service.ts`) apply every
event of a request in one transaction, matched by `Message-ID` and stored once
per provider event id, and a hard bounce or complaint suppresses the address.

The sender follows the template's sender class and nothing else
(`src/utilities/email-sender.utilities.ts`): a template whose links carry a
token goes from `MAIL_FROM_TRANSACTIONAL` (or `MAIL_FROM` while that is unset),
everything else from `MAIL_FROM`. Outside `local`, boot warns when both senders
share a domain; why is in [SECURITY.md](SECURITY.md#mail-at-rest). The operator
guide (the Resend webhook, suppressions, preview and resend, and
`pnpm email:fire-event`) is
[Email tracking in README.md](README.md#email-tracking). Keep
`MAIL_FROM_TRANSACTIONAL` on its own domain with click tracking off; the steps
are under "Two senders" in [README.md](README.md#email-tracking).

## Background work: queues, schedulers, the outbox, retention

### Queues and Workers

Six BullMQ queues share the prefix `redisKey('bull')`. `getAllQueues()`
returns every one, and is what the staff status lists;
`tests/integration/services/queue-registry.test.ts` fails when a queue is
missing from it. `getPausableQueues()` is that list without `auth-email`, and
is what full maintenance pauses. `emailQueueFor` (`src/jobs/email.job.ts`)
picks an email's queue from its template, so no caller chooses it.

| Queue          | Carries                                                                                                                                                                         | Worker concurrency   | Job options                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------- |
| `email`        | One tracked email per job (`addEmailJob`)                                                                                                                                       | `WORKER_CONCURRENCY` | 5 attempts, backoff from 5 s                                          |
| `auth-email`   | The same, for `sign_in_link`, `step_up_link`, `welcome`, `tenant_invitation`, `invitation_confirm`, `passkey_created` and `passkey_deleted`; never paused                       | `WORKER_CONCURRENCY` | 5 attempts, backoff from 5 s                                          |
| `notification` | An in-app row and its optional email (`addNotificationJob`)                                                                                                                     | `WORKER_CONCURRENCY` | 3 attempts, backoff from 2 s                                          |
| `maintenance`  | The retention purge                                                                                                                                                             | 1                    | 3 attempts, backoff from 60 s                                         |
| `analytics`    | The outbox drain, the PostHog deletion tick and the flag definitions fetch                                                                                                      | 1                    | 1 attempt (the next tick is the retry); the last 100 failures kept    |
| `billing`      | One job per Razorpay webhook event, which syncs the workspace that holds its subscription, a sync of one workspace, and the frequent and daily runs (`src/jobs/billing.job.ts`) | 2                    | 8 attempts, backoff from 30 s; failures kept 7 days; a run: 1 attempt |

Every Worker's `failed` handler first calls `reportFinalJobFailure`, which
reports the attempt BullMQ will not retry (`attemptsMade >= attempts`, or an
`UnrecoverableError`) to error tracking. The email, auth-email, notification,
maintenance and billing handlers then log a retryable attempt at `warn`; on the final
one `recordPermanentFailure` (`src/jobs/job-failure.job.ts`) scrubs the stored
payload, marks an email's message `failed`, and logs `job failed permanently`
once. A billing webhook job's final failure also marks its `billing_events`
row failed and raises one `webhook_failing` staff alert per event; a provider
refusal a retry cannot change fails it at once. What a job payload may hold, and for how long, is in
[SECURITY.md](SECURITY.md#mail-at-rest). The analytics handler only logs a
`warn`: a failed tick loses nothing. No handler rejects, since an unhandled
rejection exits the process.

`startWorkers()` starts the email, auth-email, notification, maintenance and
billing Workers, and the analytics Worker when analytics or PostHog's private API is
configured.
`WORKER_ENABLED` (default `true`) runs them in the API process. To split them,
set it to `false` on API-only pods and `true` on a worker deployment that
shares the Redis queues; the schedules below then run only on the worker
deployment.

### Schedulers

Each Worker generation upserts its schedules (BullMQ job schedulers, stored in
Redis under the prefix, so every replica shares one schedule and each tick runs
on one Worker):

| Scheduler             | Queue         | When                                | Registered when                         |
| --------------------- | ------------- | ----------------------------------- | --------------------------------------- |
| `retention-purge`     | `maintenance` | daily at 03:00 UTC                  | always                                  |
| `scheduler-frequent`  | `billing`     | every 15 min                        | always                                  |
| `scheduler-daily`     | `billing`     | daily at 03:30 UTC                  | always                                  |
| `analytics-drain`     | `analytics`   | every `ANALYTICS_DRAIN_INTERVAL_MS` | `POSTHOG_PROJECT_KEY` is set            |
| `analytics-deletions` | `analytics`   | every 60 s                          | the personal key and project id are set |
| `flag-definitions`    | `analytics`   | every 30 s                          | flags are configured                    |

A failed registration logs a `warn` and is retried with the next generation. A
new generation starts only when the Worker connection gives up before its first
`ready`, so a registration that fails while the Workers stay healthy waits for
the next restart; a scheduler stored earlier keeps running meanwhile.

The billing runs (`src/services/billing/billing-scheduler.service.ts`) are
lists of independent named steps; a step that fails is logged and the rest
still run. `scheduler-frequent` moves lapsed trials to Free, syncs workspaces
whose grace, cancelling period (plus the 3-day buffer) or interval switch is
due, cancels the subscriptions of suspended (at cycle end) and archived (now)
workspaces, lapses grants and upgrade requests, and sends the trial
reminders: three days before the end (not for a trial of three days or
less), on the last day in the workspace's time zone, and halfway through a
trial longer than six days. A reminder re-reads its row before it sends, and a
workspace that left the trial or Free, or was suspended, since the claim gets
nothing. It runs with payments
off too, skipping the provider steps. `scheduler-daily` is the reconcile: it queues
a `sync-tenant` job for every row that holds a subscription (rows of another
provider or mode, and Free rows whose only subscription has ended, are skipped
and counted), for each running subscription of the last three days whose
notes name a workspace whose row does not hold it, and for each workspace
whose webhook event failed in the last three days. It also sends the yearly
renewal reminder a week before the period ends and the win-back emails on days
7 and 30 after a trial or paid plan fell to Free. A reminder is claimed in its
`tenant_billing` column before it is sent, and a suspended or archived
workspace is never claimed. Two overlapping runs act
once: each step claims its rows, re-checks them under the row lock, or leaves
them to the sync's versioned write. A run occupies one of the billing
Worker's two slots while it lasts, so webhook and sync jobs share the other;
the daily run only queues jobs and ends quickly. A suspend followed by an
archive replaces the suspension's cycle-end cancel with an immediate one: the
claim taken before the archive is released.

The analytics Worker runs one job at a time, so this process never has two of
its jobs talking to PostHog at once. Two replicas may; the drain and the
deletion tick each lease their rows.

### The outbox

Server analytics events reach PostHog through a transactional outbox
(`analytics_outbox`), never from a request. A row is written in the same
transaction as the change it describes, inside a savepoint, or on the pool
right after commit for a product event; a failed insert is logged at `warn` and
never fails the user's action (`src/services/analytics/analytics-outbox.service.ts`).
The drain leases a batch in one autocommit statement, so no pool connection is
held while PostHog is called. The full pipeline is under
[Analytics](#analytics).

### Retention

The daily `retention-purge` job (`runRetentionPurge`,
`src/services/retention.service.ts`) runs one rule per table, in this order:
`user_tokens`, `tenant_invitations`, `email_events`, `email_logs`,
`email_messages`, read notifications, unread notifications, `audit_logs` and
`analytics_outbox`. Each rule's window is its `RETENTION_*_DAYS` (or
`ANALYTICS_OUTBOX_RETENTION_DAYS`) variable, and 0 turns it off.

- A rule deletes in batches of 5000 by primary key, each in its own short
  transaction, until a batch comes back short. A batch skips locked rows,
  which the next run deletes.
- A failing rule is logged and the others still run; the job then throws,
  naming each failed table, so BullMQ retries it. Every rule is idempotent.
- The three email tables share `RETENTION_EMAIL_LOGS_DAYS` and are dated by
  the message's `created_at`: events, then attempts, then the messages left
  with neither, so no batch cascades. Suppressions never expire.
- The audit rule is off by default (`RETENTION_AUDIT_LOGS_DAYS=0`). Its batch
  sets `app.audit_purge` and `app.audit_purge_before` transaction-locally,
  which is the only way past the append-only trigger
  ([SECURITY.md](SECURITY.md#the-audit-log)).
- An outbox row still there after `ANALYTICS_OUTBOX_RETENTION_DAYS` has never
  been delivered, so that rule logs what it drops at `warn`.

## Realtime (SSE)

`GET /api/v1/notifications/stream`
(`src/controllers/notification-stream.controller.ts`) pushes a user's
notifications live, behind `requireAuth`.

```
notification Worker ── insert notifications row ── emitNotification
   └─ PUBLISH redisKey('notifications')   (on failure: deliver to this process only)
every replica with an open stream: one subscriber ── local emitter ── each stream of that user
```

- **Opening.** Every refusal is thrown before `writeHead`, so `errorHandler`
  answers it with the JSON envelope: 503 while shutting down, 429
  `too_many_streams` over `SSE_MAX_STREAMS_PER_USER`, and 401 with code
  `ACCESS_TOKEN_EXPIRED` for a token without a session id, because the
  heartbeat closes streams by session id and a sid-less stream would outlive a
  logout. At `SSE_MAX_STREAMS_TOTAL` for the process it writes 503
  `stream_capacity` with `Retry-After: 30` itself, since `errorHandler` would
  mask a 503 and log it as a fault. The stream sends `X-Accel-Buffering: no`
  (nginx buffers proxied responses otherwise) and `retry: 3000`.
- **Replay.** On reconnect the client sends `Last-Event-ID`, and the stream
  replays what it missed, at most the 100 newest. The live listener is
  registered before the replay query, and notifications arriving during it are
  queued and written after, skipping ids the replay sent, so nothing falls
  between the two.
- **Upkeep.** Every `SSE_HEARTBEAT_INTERVAL_MS` the stream checks its session
  against the denylist, closing it when denied, and writes `:ping`. It ends at
  the access token's expiry, so the client reconnects and `requireAuth` runs
  again. A client with more than 1 MiB unread is destroyed.
- **Fanout.** Live delivery crosses replicas over Redis pub/sub on one
  channel (`src/services/notification-emitter.service.ts`). Each process opens
  its own subscriber client (`createRedisClient()`, not `duplicate()`, which
  would copy the shared client's reconnect state) on the first stream, so a
  publish-only pod never opens one. Delivery is best effort, not durable: the
  database row and `Last-Event-ID` are the durable path, which is why this is
  pub/sub and not Redis Streams. When the subscriber reconnects, or starts late
  while streams are open, every open stream is closed so its client replays
  the gap. A publish that fails is delivered locally instead, and one whose
  reply is lost may arrive twice.
- **Entitlements.** The same channel carries a second message kind,
  `{ kind: 'entitlements_changed', userId, tenantId, slug }`, published once
  per member of a workspace whose plan, billing state or grants changed
  (`publishEntitlementsChanged`, `src/services/billing/billing-events.service.ts`).
  The stream writes it as `event: entitlements_changed` with `{ tenantId, slug }`
  and no `id:` line, so `Last-Event-ID` stays a notification id; nothing
  replays it, since the client reads fresh entitlements on its next load.
- **Shutdown.** The stream registry (`src/services/lifecycle.service.ts`)
  lets `gracefulShutdown` end every stream first.

## Analytics, flags and error tracking

All three run on PostHog and are off until configured
(`src/configs/analytics.config.ts`): analytics needs `POSTHOG_PROJECT_KEY`; the
person deletion and `pnpm flags:sync` need
`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`; error tracking needs the
project key and `ERROR_TRACKING_ENABLED`; flags need `POSTHOG_FEATURE_FLAGS_KEY`
and the project key. What each sends, and what it never does, is in
[SECURITY.md](SECURITY.md#analytics-and-error-tracking-privacy); the operator
steps are in [Analytics (PostHog) in README.md](README.md#analytics-posthog).

### Analytics

No request handler calls PostHog's private API (`/api/projects/…`): the
person deletions and `pnpm flags:sync` are its only callers. Server events reach PostHog only through
the outbox drain and the error reporter, both through `sendBatch`
(`posthog-batch.service.ts`); browser events reach it only through the
`/api/v1/collect` proxy.

```
request ── service transaction ── audit insert ── savepoint: analytics_outbox insert
        ├─ after commit: product domain event ─── analytics_outbox insert (pool)
        ├─ email webhook transaction ─────────── savepoint: analytics_outbox insert
        └─ purgeUser transaction ──────────────── analytics_deletions insert + the user's outbox rows deleted

analytics Worker, every ANALYTICS_DRAIN_INTERVAL_MS
  claimBatch: one autocommit UPDATE … FOR UPDATE SKIP LOCKED, 60 s lease
  resolveGroupMarkers: one tenant read
  (connection released) ── POST <POSTHOG_HOST>/batch/ (10 s timeout)

analytics Worker, every 60 s
  claimDue: up to 10 due rows, one autocommit UPDATE, 180 s lease
  (connection released) ── POST <app host>/api/projects/<id>/persons/bulk_delete/

browser posthog-js ── /api/v1/collect/* ── its limiter ── stream ── ingest or assets host
```

- **Writes** go only through `enqueueAnalytics` and, for an audit entry,
  `enqueueAuditAnalytics`. The audit hook covers every audited action; product
  events come from domain-event subscribers (`analytics-forwarder.service.ts`);
  email events from the webhook transaction. The event builder
  (`analytics-event-builder.service.ts`) holds every PII rule.
  `enqueueAnalyticsOrThrow` is for a caller that handles the failure itself:
  the groups backfill and flag exposure. A passkey sign-in emits the same
  `user_signed_in` event as a link, with `method: 'passkey'`; creating and
  deleting a passkey send `passkey_created` and `passkey_deleted`
  (`AUDIT_EVENT_RENAMES`), with the provider name and never a credential ID;
  a claim that clears passkeys sends `passkeys_cleared_on_claim` with the count.
- **The drain** (`analytics-drain.service.ts`) deletes an acknowledged row.
  A retryable answer (no answer, 429, 5xx, or an endpoint-level 401, 403, 404,
  405, 407 or 408) keeps every row under its lease with a backoff of
  `least(2^attempts × 5 s, 600 s)`, and ends the drain, so an outage costs one
  timeout per tick; a wrong key or host drops nothing and logs one `error` per
  tick. A rejected batch is split in halves until the refused row is alone; a
  row refused alone three times is dropped. When a batch and both its halves
  are rejected, the first row of each half is sent alone: if PostHog refuses
  both, it is refusing everything, so no row is counted and the drain logs one
  `error`. During an outage of any length only the retention rule removes rows.
- **At least once.** A row is deleted only after PostHog acknowledged it, so a
  crash between the two resends it with the same `uuid` (the row id). PostHog
  deduplicates on `uuid` eventually, without a guarantee, so a consumer that
  needs exactness dedupes by `uuid`.
- **Signing and GeoIP.** `toPosthogBatchEvent` adds `server_sig` to every event
  it sends ([SECURITY.md](SECURITY.md#server-events)), and
  `$geoip_disable: true`, since server events reach PostHog from the data
  centre's address.
- **Groups.** A tenant's name, status and creation date reach PostHog only as
  `$groupidentify` properties. The outbox stores a marker (`$group_type`,
  `$group_key`), never the name, and the drain fills in `$group_set` from the
  tenant row when it sends the batch (`resolveGroupMarkers`,
  `analytics-group-marker.service.ts`). A process drains one batch at a time,
  so on one Worker whichever marker reaches PostHog last carries the latest
  committed state; two Worker replicas whose drains overlap can deliver an
  older one after a newer one, and the next marker for that tenant corrects
  it. `pnpm analytics:backfill-groups` queues one marker per tenant.
- **Purges and what stays in PostHog.** `purgeUser` writes an
  `analytics_deletions` row due an hour later (PostHog deletes only events it
  ingested before the request) and deletes the user's undelivered outbox rows,
  in its own transaction. The `analytics-deletions` tick deletes the claimed
  ids' outbox rows again, so an event committed after the purge cannot
  recreate the person, then asks `persons/bulk_delete/` to delete each person
  with their events and recordings. Anything but a 2xx with an empty
  `deletion_errors` keeps the rows with a backoff of `least(2^attempts, 360)`
  minutes, logged at `warn`, or at `error` when PostHog refused the key or
  project (401, 403, 404) or a row is a day old. PostHog
  cannot delete a group, so `purgeTenant` queues a marker that the drain sends
  with the group's name cleared and its status `purged`; the tenant's events
  stay, under its id.
- **The proxy** (`src/routes/analytics-proxy.routes.ts`) sends `/static/*` and
  `/array/*` to the assets host and everything else to the ingest host,
  streaming bodies untouched. It sits ahead of the body parsers and has no
  `on.error` handler, which would make http-proxy-middleware skip its own error
  response. Without `POSTHOG_PROJECT_KEY` it answers 503.

### Error tracking

Server errors go to PostHog Error Tracking as `$exception` events, from one
capture point per kind of failure and never from a logger transport:

| Where                                                                                   | When                                                                                  | `capture_point` |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------- |
| `errorHandler` (`error.middleware.ts`), through `reportErrorWithSpan`                   | a 5xx the capture rule admits; a failure after the headers were sent, recorded as 500 | `http`          |
| `uncaughtException` and `unhandledRejection` (`index.ts`), through `reportError`        | always                                                                                | `process`       |
| each Worker's `failed` listener, through `reportFinalJobFailure` (`job-failure.job.ts`) | the attempt BullMQ will not retry                                                     | `job`           |

**The capture rule** (`shouldCaptureHttpError`). An error that is not an
`HttpError` and resolves to 500 is reported. An `HttpError` of 500 or more is a
deliberate answer, reported only when it wraps a `cause`. A
`PosthogUnavailableError` never is: PostHog being unreachable is its meaning,
and its thrower already logged why. A 4xx, and a client that went away, never
are. Each analytics tick has one attempt, so every failed tick is a final
failure and is reported; the throttle bounds a run of them.

**The reporter** (`src/services/errors/error-reporter.service.ts`).
`reportError` checks the global cap first; past it, nothing is built. Then it
builds, scrubs, throttles and queues one event synchronously, with no I/O, and
returns its id. The id (a UUIDv7) is minted first, so it is returned also when
error tracking is off, the event is throttled, or building failed; it then
names a log line, not an event. The limits (`error-tracking.constants.ts`):

- at most 10 events per fingerprint and 100 in all per process in any rolling
  minute;
- a flush every 5 s, or at once when 50 events wait, one request at a time
  outside a deadline flush;
- at most 500 queued, the oldest dropped as `buffer_full` past that;
- while PostHog asks to retry, a back-off from 5 s doubling to 300 s, and a
  batch dropped as `retry_exhausted` after 5 retried sends.

The queue is in memory, not the outbox, because errors often happen while the
database is down, and the reporter never depends on Redis, which only counts
outcomes for the status page. A failure inside the reporter is caught, logged
at most once a minute and never reported, so the reporter cannot recurse.
`errorHandler` reports through `reportErrorWithSpan`, which also returns the
scrubbed stand-in the active span records, so a 5xx is built once.

**Flushes on the way out.** `flushErrorReports(deadline)` ignores any back-off
and sends until the queue is empty, PostHog asks to retry, or the deadline
passes; it also waits for a request already in flight, which may carry the
fatal event. A process fault flushes for `ERROR_FATAL_FLUSH_MS` (2 s) and
graceful shutdown for `ERROR_SHUTDOWN_FLUSH_MS` (3 s).

**`errorId` and the route.** Every 5xx `errorHandler` writes, except a
maintenance refusal, carries an `errorId` in its body and on its log line; a
reported error's id is its `$exception` uuid. A `PosthogUnavailableError` 502
also carries one, but it names nothing: that error is neither logged nor
reported there. The route template on an event comes from `recordRouteTemplate`
(`route-template.middleware.ts`): Express restores `request.baseUrl` before an
error reaches `errorHandler`, so the mount path is recorded when the router
assigns `request.route`, and a mount parameter's value is put back as its name.

**System status.** `GET /platform/system/status` (platform admin, not
audited) answers `{ release, errorTracking, flags, maintenance }`: the image's
`APP_VERSION`, the reporter's sent and dropped counts over the last 15 minutes
summed from Redis across every process, the flags' snapshot state, and the
maintenance mode as the answering replica sees it. Each section that reads
Redis is bounded by `STATUS_READ_TIMEOUT_MS` (2 s), so a stalled Redis answers
that section with what it reports when Redis fails.

### Feature flags

Flags are declared in code, evaluated on the server from a snapshot of
PostHog's flag definitions, enforced on API routes and served to react and
apex. Rollouts, kills and experiments are edited in PostHog; the registry
(`src/constants/flags.constants.ts`) says which flags exist and what they fall
back to.

```
PostHog project (one per environment)
  │ GET <POSTHOG_HOST>/flags/definitions, with the feature flags key and the stored ETag
  ▼
flag-definitions job (analytics queue, every 30 s)
  │ 200: parse, mark unsupported constructs, SET <prefix>:flags:v1:snapshot, PUBLISH reload
  │ 304: touch checkedAt (compare-and-set) · failure: keep the snapshot
  ▼
every API and worker process: in-memory snapshot (reload on message, 60 s backstop)
  ├─ requireFlag(key)                   route gate: unknown-route 404 unless on
  ├─ flagsFor / isEnabled / variantOf   service reads; variantOf records exposure
  ├─ GET …/flags                        the app's client flags
  ├─ POST …/flags/exposures             re-evaluate, dedupe, $feature_flag_called → outbox
  └─ /platform/flags (+ /unregistered, /meta, /evaluate), system status
```

- **Registry.** Each entry has a key, a description, `boolean` or
  `multivariate` with `variants`, a fallback, a scope (`user` or `tenant`),
  which apps' browsers receive it, and whether it is an experiment.
  `assertFlagRegistry` refuses a malformed registry when the module loads; an
  experiment is multivariate with `control` first. `FlagKey` makes an
  unregistered key a type error.
- **Traits** are only `FLAG_TRAITS`: `platform_role`, `tenant_role`,
  `app_env`, `account_created_days` and `tenant_created_days`, built from the
  database at evaluation time and never stored in PostHog. There is no `app`
  trait, so a route gate and the UI always agree.
- **Snapshot** (`flag-snapshot.service.ts`). Each process loads it at boot,
  reloads on a `reload` message and every 60 s, and keeps its copy when a
  reload fails or reads an older one; a process that never loaded one answers
  every fallback. The stored snapshot carries a fingerprint of the registry and
  the parser version; when it differs from the running code's, the job fetches
  without `If-None-Match`, so a 200 re-parses with the current rules.
- **Evaluation** (`flag-evaluator.service.ts`) is pure and never throws: with
  no snapshot, a missing, inactive or unsupported flag, or a tenant-scoped flag
  with no tenant, it answers the registry fallback with a `fallback:*` reason.
  A definition using a construct the evaluator cannot reproduce, or a key it
  does not know, is marked unsupported and never evaluated.
- **Route gates** (`requireFlag`, `flag.middleware.ts`) mount after
  `requireAuth`, after `resolveTenant()` for a tenant-scoped flag, and before
  validators; a closed gate answers the unknown-route 404 and records no
  exposure. `tests/unit/routes/flag-gates.test.ts` fails a tenant-scoped gate
  outside `/tenants/:slug/…`.
- **Client reads and exposure.** `GET /tenants/:slug/flags` and `GET /flags`
  serve react, `GET /platform/me/flags` serves apex; the route fixes the app,
  and the answer carries values, never traits or reasons. The matching
  `POST …/exposures` takes `{ keys }`, re-evaluates each key on the server and
  records `$feature_flag_called` once per session, tenant, key and response,
  only for a matched condition or a holdout.
- **Inspector.** `GET /platform/flags` pages the registry with each flag's
  live state, `GET /platform/flags/unregistered` pages the flags PostHog has
  that the registry lacks, and `GET /platform/flags/meta` carries the traits
  reference and the snapshot's age; `GET /platform/flags/evaluate` answers
  one user's traits and values, the one place traits leave the server, so each
  read is audited as `user.flags_evaluated` before anything is evaluated. None
  of them calls PostHog.
- **Kill-switch latency.** An edit in PostHog reaches every process on the next
  30 s fetch and its `reload` message, or the 60 s backstop. The fetch shares
  the one-at-a-time `analytics` Worker with the drain and the deletion tick, so
  with PostHog slow it can wait behind both.

`pnpm flags:sync` creates every registered flag the project lacks, inactive at
0 %, and never edits or deletes one; the steps, and how to start an experiment,
are in [README.md](README.md#feature-flags).

### Observability

**Tracing.** `src/observability/tracing.ts` loads through Node's `--import`,
before `index.ts` and before environment validation, so it reads `process.env`
directly and never `getEnv()` or the logger. Without
`OTEL_EXPORTER_OTLP_ENDPOINT` it starts nothing. node-redis (the shared
client) and postgres.js have no installed instrumentation, so their calls
appear as gaps in a trace; `/health`, `/health/ready` and `/api/v1/collect/`
get no spans. How it is set up is in the file's JSDoc.

**Logs.** `src/services/logger.service.ts` is the one logger; each record
carries `source` (the caller's `file:line`) and the correlation fields from
[Request correlation](#request-correlation), and an Error-valued field is
redacted with `redactedForLog` when it carries a database query.

**Slack.** With `SLACK_WEBHOOK_URL` set, records at or above `SLACK_LOG_LEVEL`
also go to Slack. Repeats of one `source` and message within 60 s are counted
and summarised once, and the message, source, request id and stack are
scrubbed with the error tracker's `scrubText` first.

## Maintenance mode

A platform owner puts the product into maintenance from Apex, without a
deploy: `read_only` refuses customer writes with 503 `READ_ONLY_MODE`, and
`full` refuses every route not on its let-through list with 503
`MAINTENANCE_MODE`, refuses a non-staff sign-in, and pauses every queue but
`auth-email`. The
let-through list, and the controls on changing the mode, are in
[SECURITY.md](SECURITY.md#maintenance-mode); the operator steps in
[README.md](README.md#maintenance-mode).

- **State.** One row, `maintenance_mode_state` (its migration seeds `off`,
  version 0), is the source of truth. A change is a compare-and-set on
  `version`, written with its `platform.maintenance_mode_changed` audit entry
  in one transaction; a stale `expectedVersion` answers 409
  `MAINTENANCE_MODE_CONFLICT`.
- **Propagation.** Each replica keeps the mode in memory
  (`src/services/maintenance-mode/maintenance-mode-store.service.ts`). A change
  publishes `reload` on `redisKey('maintenance-mode')`, and every replica
  rereads the row on that message, on a subscriber reconnect, and every 10 s
  (`MAINTENANCE_MODE_RELOAD_INTERVAL_MS`) whatever happens. A row whose version
  is not above the copy's is ignored, so overlapping reloads never roll the
  state back. A replica whose first read fails serves `off` with
  `known: false`, logs an error and keeps retrying; a later failure keeps the
  last known mode, so a replica never flips open or closed on its own.
- **The gate.** `maintenanceModeGate`
  (`src/middlewares/maintenance-mode.middleware.ts`) reads only the replica's
  store, never Postgres or Redis. The only request-path reads of the row are
  the staff view and change behind `/platform/maintenance-mode`
  (`getPlatformMaintenanceMode` and the change's row lock). The gate stamps
  `Maintenance-Mode: off | read_only | full` on every response it sees and
  decides by method and path from `MAINTENANCE_ROUTE_RULES`
  (`src/constants/maintenance-mode.constants.ts`); an unclassified path gets
  the default, reads through in `read_only` and nothing in `full`. On the
  customer routes Apex calls (`MAINTENANCE_STAFF_ROUTES`) the gate only marks
  the refusal, and `requireAuth` lets platform staff through.
  `tests/unit/routes/maintenance-mode-gates.test.ts` fails on a route with no
  rule, a rule with no route, and a staff-pass route outside `requireAuth`.
- **Refusal.** 503 with `Retry-After: 30` and
  `{ success, statusCode, code, message, mode, since, requestId }`, where
  `message` is the owner's customer message. CORS exposes `Maintenance-Mode`
  and `Retry-After`. Clients detect maintenance by the 503 and its `code`,
  never by a bare 502 or 503.
- **Queues** (`maintenance-mode-queues.service.ts`). `full` pauses every queue
  in `getPausableQueues()` with BullMQ's queue-wide `pause()`. That is every
  queue but `auth-email`, which carries the sign-in, step-up, welcome,
  invitation, invitation confirm and passkey notice mail (`AUTH_EMAIL_TEMPLATE_KEYS`,
  `src/jobs/email.job.ts`), so
  staff can still sign in to switch maintenance off. The pause is a flag in
  Redis that every replica's Workers obey: running jobs finish, waiting ones
  stay. Every replica reconciles on every reload, which repairs a crash
  between the commit and the pause and a Redis outage. A reload pauses only once the mode has been
  `full` for `MAINTENANCE_MODE_PAUSE_GRACE_MS` (10 s), so the change's notices
  go out first, and resumes in any other mode after removing the duplicate
  scheduler runs gathered while paused (`dedupeSchedulerJobs`): each Worker
  start re-upserts its schedulers, and a paused queue keeps every extra run.
  Pause and resume are idempotent, so replicas reconciling at once are
  harmless.
- **A change** (`PUT /api/v1/platform/maintenance-mode`,
  `maintenance-mode.service.ts`) commits, then publishes, rereads its own copy
  and queues an in-app and email notice to every other platform owner and admin
  for a switch-on, an escalation or a switch-off. Entering `full` waits for
  those notices up to `MAINTENANCE_MODE_NOTICE_WAIT_MS` (10 s), then pauses the
  queues unless a later change superseded it. Once the row has committed, no
  later failure turns the change into an error.
- **Status.** `GET /api/v1/status/maintenance` is public and answers the
  mode, the customer message and when it began, from memory. The system status
  has a `maintenance` section with the queues' pause state and whether the
  last change's notices are still pending.

## Configuration

All configuration is read through `getEnv()` (`src/configs/env.config.ts`),
which validates `process.env` against a Zod schema once, on first call, and
memoises the result. An empty value counts as unset, since a `.env` copied from
`.env.example` keeps `KEY=` lines. `getEnv()` is lazy because a module-scope
parse would throw during import resolution. In `src/`, only `env.config.ts`,
`tracing.ts`, `logger.service.ts` and `index.ts` may read `process.env`
(`no-restricted-properties`); `tracing.ts` is the notable one, since it loads
before validation.

`.env` is loaded twice, on purpose. `pnpm dev` and `pnpm start` pass
`--env-file-if-exists=.env` to Node, so the values reach `tracing.ts`, which
loads before any app module. `env.config.ts` also loads `.env` with `dotenv`,
which never overrides a key already set, so it only fills keys Node left unset;
`tsx` scripts such as `pnpm db:migrate` rely on it. It is skipped under Vitest,
whose environment `tests/helpers/setup-global.ts` assembles. The Docker
image's `CMD` passes no env file: the image has no `.env`, and the orchestrator
supplies the environment.

`.env.example` and the table below are generated from the schema: each row's
text is that variable's `.describe()`. Change the schema, then regenerate with
`pnpm env:example` and `pnpm --silent env:table`
([CONTRIBUTING.md](CONTRIBUTING.md#adding-renaming-or-removing-an-environment-variable)).
`tests/unit/architecture-env-table.test.ts` fails when the table differs from
what `pnpm env:table` prints.

### Environment variables

| Variable                              | Required | Default                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | -------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                             | **yes**  | —                          | Which deployment this is: local, dev, qa or prod. Required. COOKIE_SECURE and LOG_FORMAT default from it, and SMTP requires TLS everywhere but local.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NODE_ENV`                            | **yes**  | —                          | Node runtime mode: development, test or production. Required. Express reads it directly, and only production hides stack traces in its built-in error handler, so every APP_ENV but local must run production. test is for the test suite.                                                                                                                                                                                                                                                                                                                                                                |
| `APP_PORT`                            | no       | `4040`                     | Port the HTTP server listens on. Defaults to 4040.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `APP_URL`                             | **yes**  | —                          | Public origin of this API. Used to build the Google OAuth callback URL (passport.config.ts) — must match a redirect URI registered in Google Cloud Console exactly, including scheme and trailing slash. http://localhost:4040 locally.                                                                                                                                                                                                                                                                                                                                                                   |
| `WEB_URL`                             | **yes**  | —                          | Public origin of the frontend, with no query or fragment. Sign-in and invitation links are built from it — the link points at your frontend, which POSTs the token to this API. http://localhost:5173 locally.                                                                                                                                                                                                                                                                                                                                                                                            |
| `APEX_URL`                            | no       | —                          | Public origin of the Apex staff dashboard, e.g. https://admin.example.com, with no query or fragment. When set, platform-tenant invitation links, step-up links, and the sign-in link and Google sign-in flows started with app "apex", point here instead of WEB_URL. Unset sends every link to WEB_URL. Google sign-in from a host other than APP_URL also needs COOKIE_DOMAIN covering both.                                                                                                                                                                                                           |
| `PASSKEY_MODE`                        | no       | `optional`                 | Whether users sign in with passkeys. off: every passkey route answers 404 and stored passkeys are kept. optional: users may create passkeys. required: every user must have one. Defaults to optional.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `WEBAUTHN_RP_ID`                      | no       | —                          | The domain a passkey is bound to, e.g. domain.com. It must equal the host of WEB_URL and APEX_URL, or be a parent domain of both. Changing it makes every stored passkey unusable. Unset uses the host of WEB_URL.                                                                                                                                                                                                                                                                                                                                                                                        |
| `DATABASE_URL`                        | **yes**  | —                          | Postgres connection URL. The compose stack publishes Postgres on localhost:5433: postgres://boilerplate:boilerplate@localhost:5433/boilerplate.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `REDIS_URL`                           | **yes**  | —                          | Redis connection URL. The compose stack publishes Redis on localhost:6380: redis://localhost:6380.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `DB_POOL_MAX`                         | no       | `10`                       | Most open connections in the Postgres pool, per process. Defaults to 10. The test suite sets 2, so its parallel workers stay under Postgres's default 100 connections.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DB_STATEMENT_TIMEOUT_MS`             | no       | `30000`                    | Milliseconds a single SQL statement may run before Postgres cancels it (statement_timeout). Defaults to 30000 (30s). 0 sends no limit, leaving the server's own setting. A statement_timeout in DATABASE_URL's query string overrides it. PgBouncer, in every pool mode, refuses a startup parameter not listed in its ignore_startup_parameters, so behind it set 0 or list statement_timeout there.                                                                                                                                                                                                     |
| `JWT_ACCESS_SECRET`                   | **yes**  | —                          | Signs and verifies access tokens (session.service.ts). Any 32+ character string works; use `openssl rand -hex 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SESSION_SECRET`                      | **yes**  | —                          | Signs the express-session cookie used during the Google OAuth round-trip (passport.config.ts). Any 32+ character string works; use `openssl rand -hex 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CURSOR_SECRET`                       | no       | —                          | Signs the opaque cursors every list endpoint returns, so a client cannot forge or edit one (list-cursor.utilities.ts). Any 32+ character string works; use `openssl rand -hex 32`. Required whenever APP_ENV is not local, and the same on every replica, since any replica may verify a cursor another signed. Unset on local means each process generates its own, so a restart sends clients back to the first page. Changing it does the same everywhere.                                                                                                                                             |
| `GOOGLE_CLIENT_ID`                    | no       | —                          | Google OAuth 2.0 client ID. When absent, Google login is disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GOOGLE_CLIENT_SECRET`                | no       | —                          | Google OAuth 2.0 client secret. Required when GOOGLE_CLIENT_ID is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ACCESS_TOKEN_TTL`                    | no       | `15m`                      | Access token lifetime, as an ms()-parseable duration string (e.g. "15m"). Defaults to 15m.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `REFRESH_TOKEN_TTL`                   | no       | `30d`                      | Refresh token lifetime, as an ms()-parseable duration string (e.g. "30d"). Defaults to 30d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SESSION_ABSOLUTE_TTL`                | no       | `30d`                      | Hard ceiling on one login session, measured from the login itself and never reset by rotation, as an ms()-parseable duration string (e.g. "30d"). Past it, refreshing fails and the user signs in again. Defaults to 30d.                                                                                                                                                                                                                                                                                                                                                                                 |
| `SIGN_IN_LINK_TTL`                    | no       | `15m`                      | How long an emailed sign-in link stays valid, as an ms()-parseable duration (e.g. "15m"). Kept short because the link is a full credential and a new one is one click away; staff-sent and welcome links use it too, and so does the invitation confirm link. Defaults to 15m.                                                                                                                                                                                                                                                                                                                            |
| `SIGN_IN_LINK_MAIL_COOLDOWN`          | no       | `1m`                       | Shortest gap between two sign-in link mails to one address, as an ms()-parseable duration (e.g. "1m"). A request inside the gap answers the same 202 and mails nothing. Also the gap between two invitation confirm links to one address, counted separately. Defaults to 1m, matching the sign-in page's 60-second resend countdown.                                                                                                                                                                                                                                                                     |
| `SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT`  | no       | `10`                       | Most sign-in link mails one address may receive in 24 hours. A request past it answers the same 202 and mails nothing, so nobody can mail-bomb an address through the sign-in form. Defaults to 10.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `STEP_UP_LINK_TTL`                    | no       | `15m`                      | How long an emailed step-up confirmation link stays valid, as an ms()-parseable duration (e.g. "15m"). Kept short because it elevates a session and a new one is one click away. Defaults to 15m.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `STEP_UP_LINK_COOLDOWN`               | no       | `1m`                       | Shortest gap between two step-up confirmation mails for one account, across all its sessions, as an ms()-parseable duration (e.g. "1m"), so an account cannot be mail-bombed through its own sessions. Defaults to 1m.                                                                                                                                                                                                                                                                                                                                                                                    |
| `INVITATION_TTL`                      | no       | `3d`                       | How long a tenant invitation link stays valid, as an ms()-parseable duration string (e.g. "3d"). Resending an invitation issues a new link with a fresh lifetime. Defaults to 3d.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `INVITATION_RESEND_COOLDOWN`          | no       | `10m`                      | How long after an invitation is mailed before it can be resent, as an ms()-parseable duration string. A resend sooner answers 429 invitation_resend_cooldown. Defaults to 10m.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `INVITATION_RECIPIENT_DAILY_LIMIT`    | no       | `10`                       | Most tenant invitation mails (invites and resends) one address may receive in 24 hours, across every tenant and sender, of which one tenant may send at most 3; past either the sender gets 429 RATE_LIMITED. Staff owner-invitations of new tenants are not counted. Defaults to 10.                                                                                                                                                                                                                                                                                                                     |
| `TRUST_PROXY`                         | no       | `false`                    | How much of X-Forwarded-For to believe. "false" (default) trusts none: correct when clients reach this app directly, WRONG behind a proxy, where every IP-keyed rate limiter then shares one bucket for the whole deployment. Behind a proxy set the NUMBER of proxies in front of this app (e.g. "1"), or a comma-separated list of trusted proxy addresses/subnets or presets ("loopback", "linklocal", "uniquelocal"). Never "true" — it is refused, because it lets any client spoof its own IP and bypass the limiters.                                                                              |
| `RATE_LIMIT_SCALE`                    | no       | —                          | Multiplies the limit of every limiter createRateLimiter builds from its RATE_LIMITS spec, for an end-to-end run that sends every request from one IP; windows and keys stay as they are. An explicit override (flag-evaluate, via FLAG_EVALUATE_REQUESTS_PER_MINUTE) and the counters outside RATE_LIMITS (mail cooldowns, invitation recipient ceiling, SSE stream cap) are not scaled. Local only: boot refuses any value but 1 unless APP_ENV is local, so it can never raise a deployed limit. A whole number from 1 to 100. Unset means 1.                                                           |
| `COOKIE_SECURE`                       | no       | —                          | Whether the refresh-token and OAuth session cookies carry the Secure attribute ("true" or "false"). Defaults from APP_ENV: false on local, true elsewhere. With Secure on behind a TLS-terminating proxy, TRUST_PROXY must be set, or the OAuth session cookie is never sent.                                                                                                                                                                                                                                                                                                                             |
| `COOKIE_DOMAIN`                       | no       | —                          | Domain attribute for the refresh-token and OAuth session cookies, e.g. "example.com" to share them with subdomains. Unset means host-only cookies, the narrowest scope. Boot refuses a value that APP_URL's host is not within, since browsers would reject the cookies. With COOKIE_SECURE on, setting or unsetting it on a live deployment signs users in again once; the cookie names and scopes are in SECURITY.md, "The refresh cookie".                                                                                                                                                             |
| `CORS_ALLOWED_ORIGINS`                | no       | —                          | Extra browser origins allowed to call this API, comma-separated (e.g. "https://admin.example.com,https://shop.example.com"). WEB_URL and APEX_URL are always allowed and need no entry. POST /auth/refresh and /auth/logout also refuse a present Origin that is none of these, so list every other frontend origin (SECURITY.md, "CSRF"). Leave empty for a single-frontend deployment. Never a wildcard: this API sends credentials, and the CORS spec forbids "*" with credentials.                                                                                                                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | no       | —                          | Absent means tracing is disabled; the SDK is never started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OTEL_SERVICE_NAME`                   | no       | `express-boilerplate`      | Service name reported in OTEL traces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LOG_LEVEL`                           | no       | `info`                     | Console log level: error, warn, info or debug. silent disables logging entirely (the test suite uses it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LOG_FORMAT`                          | no       | —                          | Console log format: json or pretty. Defaults from APP_ENV: pretty on local, json elsewhere. pretty needs the pino-pretty devDependency; without it the logger writes json.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SLACK_WEBHOOK_URL`                   | no       | —                          | Slack Incoming Webhook URL for log alerting. When unset, no Slack transport is registered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SLACK_LOG_LEVEL`                     | no       | `error`                    | Minimum log level that triggers a Slack notification. Defaults to error; set to warn if you want Slack alerts for warnings too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `WORKER_ENABLED`                      | no       | `true`                     | Whether the BullMQ workers (email, auth-email, notification and maintenance, plus analytics when POSTHOG_PROJECT_KEY is set or POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID both are) start in-process alongside the HTTP server. Set to false for API-only pods behind a load balancer; a separate worker deployment sets this to true. The daily retention purge, the analytics drain, the feature flag definitions fetch and the PostHog deletion of purged users run only where this is true.                                                                                                      |
| `WORKER_CONCURRENCY`                  | no       | `5`                        | Jobs the email, auth-email and notification workers each process at once, per process. Defaults to 5. The email and auth-email workers both send mail, so a process runs up to 2 × WORKER_CONCURRENCY SMTP sends at once; size it against the mail provider rate limit. The maintenance and analytics workers always run one job at a time.                                                                                                                                                                                                                                                               |
| `RETENTION_TOKENS_DAYS`               | no       | `7`                        | Days to keep a user_tokens row (a refresh token, a mailed token or an emailed link) once it has expired, or once it was revoked without ever being used (logout, reuse, a sign-out of other sessions, a newer link). A token rotated away is kept until it expires, because reuse detection needs it. 0 never purges; at most 36500. Defaults to 7.                                                                                                                                                                                                                                                       |
| `RETENTION_INVITATIONS_DAYS`          | no       | `30`                       | Days to keep a tenant invitation after the latest of its expiry, acceptance and revocation. 0 never purges; at most 36500. Defaults to 30.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RETENTION_EMAIL_LOGS_DAYS`           | no       | `90`                       | Days to keep email tracking rows: each email message with its send attempts (email_logs) and provider events, dated by the message's creation; an attempt row with no message is dated by its own. Suppressions never expire. 0 never purges; at most 36500. Defaults to 90.                                                                                                                                                                                                                                                                                                                              |
| `RETENTION_NOTIFICATIONS_READ_DAYS`   | no       | `90`                       | Days to keep a notification after it was read. 0 never purges; at most 36500. Defaults to 90.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RETENTION_NOTIFICATIONS_UNREAD_DAYS` | no       | `365`                      | Days to keep a notification nobody read, counted from when it was created. 0 never purges; at most 36500. Defaults to 365.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RETENTION_AUDIT_LOGS_DAYS`           | no       | `0`                        | Days to keep an audit_logs row. Defaults to 0, which keeps the audit log forever. Set a number of days, at most 36500, only where your compliance rules allow deleting audit history.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ONBOARDING_STUCK_AFTER_DAYS`         | no       | `7`                        | Days without onboarding progress after which a tracked tenant that is not complete or dismissed counts as stuck in the staff funnel and lists. At least 1, at most 36500. Defaults to 7.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POSTHOG_PROJECT_KEY`                 | no       | —                          | PostHog project API key (phc_…) of the project this environment reports to. Unset disables analytics entirely: no events are recorded, none are sent, and /api/v1/collect answers 503. Use one project per environment, shared with the frontends.                                                                                                                                                                                                                                                                                                                                                        |
| `POSTHOG_HOST`                        | no       | `https://us.i.posthog.com` | PostHog ingest host that server events are sent to and /api/v1/collect forwards to, with no trailing path. Defaults to https://us.i.posthog.com; an EU project uses https://eu.i.posthog.com.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POSTHOG_ASSETS_HOST`                 | no       | —                          | PostHog assets host that /api/v1/collect/static and /api/v1/collect/array forward to. Unset derives it from POSTHOG_HOST: https://eu-assets.i.posthog.com for an eu. host, otherwise https://us-assets.i.posthog.com. Tests point it at a fake.                                                                                                                                                                                                                                                                                                                                                           |
| `ANALYTICS_OUTBOX_RETENTION_DAYS`     | no       | `7`                        | Days an analytics event may wait in the outbox, while PostHog is unreachable or refuses it, before it is dropped unsent with a warning. At least 1, at most 365. Defaults to 7.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ANALYTICS_DRAIN_INTERVAL_MS`         | no       | `5000`                     | Milliseconds between analytics outbox drains, each of which sends one batch to PostHog. At least 1000, at most 600000. Defaults to 5000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ANALYTICS_DRAIN_BATCH_SIZE`          | no       | `500`                      | Most analytics events one drain claims and sends in one PostHog batch. At least 1, at most 1000. Defaults to 500.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POSTHOG_PERSONAL_API_KEY`            | no       | —                          | PostHog personal API key (phx_…) that user purges delete PostHog persons with and pnpm flags:sync creates feature flags with. Give it only the scopes person:write, group:read, feature_flag:read and feature_flag:write, and create it on a service account rather than a person. Set it together with POSTHOG_PROJECT_ID; without both, queued person deletions wait.                                                                                                                                                                                                                                   |
| `POSTHOG_PROJECT_ID`                  | no       | —                          | Numeric id of the PostHog project that POSTHOG_PERSONAL_API_KEY reads from and deletes in: the project POSTHOG_PROJECT_KEY reports to. Set it together with POSTHOG_PERSONAL_API_KEY.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POSTHOG_APP_HOST`                    | no       | —                          | PostHog app origin that person deletions call and that staff deep links open, with no trailing path. Unset derives it from POSTHOG_HOST: https://eu.posthog.com for an eu. host, otherwise https://us.posthog.com. Set it for a self-hosted PostHog. Tests point it at a fake.                                                                                                                                                                                                                                                                                                                            |
| `POSTHOG_FEATURE_FLAGS_KEY`           | no       | —                          | PostHog feature flags secure API key (phs_…, in Project settings under Feature flags) that the workers fetch feature flag definitions with every 30 seconds. It is a secret and never reaches a browser. Set it together with POSTHOG_PROJECT_KEY; without it every flag answers the fallback its code registry entry declares.                                                                                                                                                                                                                                                                           |
| `FLAG_EVALUATE_REQUESTS_PER_MINUTE`   | no       | `20`                       | Flag evaluations (GET /platform/flags/evaluate) one staff user may make a minute before the API answers 429. At least 1, at most 1000. Defaults to 20.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ERROR_TRACKING_ENABLED`              | no       | `true`                     | Whether unexpected server errors are sent to PostHog Error Tracking as $exception events. Takes effect only when POSTHOG_PROJECT_KEY is set. Defaults to true; false stops sending them, and an error still gets its errorId.                                                                                                                                                                                                                                                                                                                                                                             |
| `APP_VERSION`                         | no       | `dev`                      | The release this process runs, normally the deployed git commit sha, sent as release on every $exception event and answered by GET /health and GET /api/v1/platform/system/status. The Docker image sets it from its GIT_SHA build arg, which deploy.yml passes as the commit sha; operators do not set it. 1 to 64 letters, digits, ".", "_" and "-". Defaults to dev.                                                                                                                                                                                                                                   |
| `REDIS_KEY_PREFIX`                    | no       | `express-boilerplate`      | Namespace for every Redis key and channel this app uses: BullMQ queues (`<prefix>:bull`), rate-limit counters (`<prefix>:rl`), the session denylist (`<prefix>:denylist`), OAuth sessions (`<prefix>:sess`), the platform-access audit dedupe (`<prefix>:audit`), the error-tracking counters (`<prefix>:errors`) and the notification channel (`<prefix>:notifications`). Lowercase letters, digits, ":", "_" and "-", with no trailing colon. Give each app or environment sharing one Redis its own value; changing it abandons every existing key.                                                    |
| `SSE_HEARTBEAT_INTERVAL_MS`           | no       | `30000`                    | Milliseconds between `:ping` heartbeat comments on an open notification SSE stream (notification-stream.controller.ts). Defaults to 30000 (30s).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SSE_MAX_STREAMS_PER_USER`            | no       | `5`                        | Most notification SSE streams one user may hold open at once, per process. A request over the cap gets 429 too_many_streams. Defaults to 5 (several tabs and devices).                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SSE_MAX_STREAMS_TOTAL`               | no       | `2000`                     | Most notification SSE streams this process holds open at once, across all users (1-100000). A request over the cap gets 503 stream_capacity with Retry-After: 30, and the client retries with backoff. Size it under what the proxy in front can hold: each stream through nginx costs it two connections (client and upstream). Defaults to 2000.                                                                                                                                                                                                                                                        |
| `SMTP_HOST`                           | no       | `127.0.0.1`                | SMTP server host. Defaults to 127.0.0.1, where the compose Mailpit service listens; an IP literal skips a DNS lookup on every send.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SMTP_PORT`                           | no       | `1025`                     | SMTP server port. Defaults to 1025 — Mailpit's SMTP port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SMTP_USERNAME`                       | no       | —                          | SMTP username. Absent means no authentication is attempted, which is correct for Mailpit and wrong for most real providers. Set it together with SMTP_PASSWORD: boot refuses one without the other.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SMTP_PASSWORD`                       | no       | —                          | SMTP password. Set it together with SMTP_USERNAME: boot refuses one without the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MAIL_FROM`                           | no       | `no-reply@example.com`     | The From address of the general sender: every email whose links carry no token (onboarding reminder, maintenance-mode notice), and token emails too while MAIL_FROM_TRANSACTIONAL is unset. Mailpit accepts any value; a real provider may require this to be a verified sender.                                                                                                                                                                                                                                                                                                                          |
| `MAIL_FROM_TRANSACTIONAL`             | no       | —                          | The From address of the transactional sender: every email whose link carries a token (sign-in link, step-up link, welcome, tenant invitation). Put it on a domain whose provider click tracking is off, since a tracked link is rewritten through the provider, token included. Unset uses MAIL_FROM; outside APP_ENV=local, boot warns when the two share a domain.                                                                                                                                                                                                                                      |
| `APP_NAME`                            | no       | `Express Boilerplate`      | Product name in outbound email copy and notification text for the customer app: a sign-in link, welcome or invitation into it, and the maintenance-mode and onboarding reminder messages. Mail whose link opens Apex names APEX_APP_NAME instead. Defaults to "Express Boilerplate".                                                                                                                                                                                                                                                                                                                      |
| `APEX_APP_NAME`                       | no       | `Apex`                     | Name of the Apex staff dashboard in email copy: the subject and sign-off of every mail whose link opens Apex (a staff sign-in link or welcome, a step-up link, a staff invitation and its confirm link). Chosen by the frontend the link targets, whether or not APEX_URL is set. Defaults to "Apex".                                                                                                                                                                                                                                                                                                     |
| `RESEND_WEBHOOK_SECRET`               | no       | —                          | Signing secret of the Resend webhook endpoint (Resend dashboard, Webhooks, the endpoint's signing secret: whsec_ followed by base64). Enables POST /api/v1/webhooks/email/resend, which verifies each event's Svix signature with it; absent, that route answers 404. Subscribe the endpoint to the email.* events: delivered, delivery_delayed, bounced, complained, opened, clicked, failed and suppressed.                                                                                                                                                                                             |
| `FAKE_EMAIL_WEBHOOK_SECRET`           | no       | `fake-webhook`             | Signs local fake email webhook events (`pnpm email:fire-event`), as an HMAC-SHA256 hex digest in the x-fake-signature header. Read only when APP_ENV is local, the one environment that serves POST /api/v1/webhooks/email/fake. Defaults to "fake-webhook"; not a credential.                                                                                                                                                                                                                                                                                                                            |
| `RAZORPAY_KEY_ID`                     | no       | —                          | Razorpay API key id (Razorpay dashboard, Account and Settings, API keys): rzp_test_ for test mode, rzp_live_ for live mode. Set it with RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET to turn on paid plans; with none of the three set, paid checkout and the Razorpay webhook answer 404. Live keys are accepted only when APP_ENV is prod.                                                                                                                                                                                                                                                           |
| `RAZORPAY_KEY_SECRET`                 | no       | —                          | Razorpay API key secret that pairs with RAZORPAY_KEY_ID. Set all three Razorpay variables or none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RAZORPAY_WEBHOOK_SECRET`             | no       | —                          | Signing secret of the Razorpay webhook endpoint (Razorpay dashboard, Webhooks). Verifies each event on POST /api/v1/webhooks/razorpay. Set all three Razorpay variables or none.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`    | no       | —                          | The webhook signing secret you rotated away from. While set, events signed with it still verify, so a rotation drops no event. Unset it once Razorpay sends only the new secret. Needs RAZORPAY_WEBHOOK_SECRET.                                                                                                                                                                                                                                                                                                                                                                                           |
| `BILLING_GST_REGISTERED`              | no       | `false`                    | Whether the business is registered for GST. When false, prices show without a GST line. Defaults to false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `BILLING_FAKE_PROVIDER`               | no       | `false`                    | Replaces Razorpay with an in-process fake for the dev seed and end-to-end runs. Only APP_ENV=local accepts it, and it cannot be set together with Razorpay keys. Defaults to false.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SMTP_CONNECTION_TIMEOUT_MS`          | no       | `3000`                     | Milliseconds to wait for each SMTP connection attempt to establish before failing. Also the timeout for the first try of each DNS query; the resolver doubles it on each retry, and the OS-lookup fallback has no timeout. A host that resolves to several addresses can take it once per address. Boot checks that it plus SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS and the 5s HTTP drain stays at least 5s under SHUTDOWN_TIMEOUT_MS; that assumes one address and is a sanity check, not a per-send deadline. nodemailer's own defaults are 2 minutes to connect and 30 seconds per DNS query. |
| `SMTP_GREETING_TIMEOUT_MS`            | no       | `5000`                     | Milliseconds to wait for the SMTP server's greeting after connecting. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 30 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SMTP_SOCKET_TIMEOUT_MS`              | no       | `7000`                     | Milliseconds of inactivity before an open SMTP connection is closed. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 10 minutes.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SHUTDOWN_TIMEOUT_MS`                 | no       | `25000`                    | Milliseconds graceful shutdown may take before the process exits with code 1 anyway. Defaults to 25000, under Kubernetes' default 30s termination grace period.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### `APP_ENV` and `NODE_ENV`

`APP_ENV` names the deployment: `local`, `dev`, `qa` or `prod`. It has no
default and boot fails without it, so a deploy that forgets it cannot run with
local settings; the Docker image sets `NODE_ENV=production` but never
`APP_ENV`. `NODE_ENV` is what Express reads, and only `production` hides stack
traces in its built-in error handler. Behaviour that depends on the
deployment derives from `APP_ENV` only through the helpers in `env.config.ts`
(`isCookieSecure`, `logFormat`, `requiresSmtpTls`,
`isFakeEmailWebhookAllowed`), never at a call site.

### Boot-time consistency checks

Cross-variable rules live in `assertEnvConsistent`
(`src/configs/env-consistency.config.ts`), not in the schema: an object-level
`.refine()` would break `getDatabaseUrl()`'s `.pick()`. It lists every problem
in one message, each naming the variable and the fix, and exits 1.

|                                                                                                                                           | `local`  | `dev`, `qa`, `prod` |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------- |
| `COOKIE_SECURE` when unset                                                                                                                | `false`  | `true`              |
| `LOG_FORMAT` when unset                                                                                                                   | `pretty` | `json`              |
| SMTP must upgrade to TLS                                                                                                                  | no       | yes                 |
| `NODE_ENV` other than `production`                                                                                                        | allowed  | refused             |
| `SMTP_HOST` `localhost`/`127.0.0.1`, `SMTP_PORT` 1025, `MAIL_FROM` or `MAIL_FROM_TRANSACTIONAL` `no-reply@example.com`                    | allowed  | refused             |
| `MAIL_FROM_TRANSACTIONAL` unset or on `MAIL_FROM`'s domain                                                                                | allowed  | warning             |
| SMTP timeouts summing to more than `SHUTDOWN_TIMEOUT_MS` − 10000                                                                          | warning  | refused             |
| `POSTHOG_PROJECT_KEY` set with `TRUST_PROXY=false`                                                                                        | allowed  | warning             |
| `WEBAUTHN_RP_ID` (default: `WEB_URL`'s host) not equal to, or a parent of, the host of `WEB_URL` or `APEX_URL`, unless `PASSKEY_MODE=off` | refused  | refused             |

The 10000 is the 5 s HTTP drain, which runs before the in-flight send is
awaited, plus 5 s of headroom for the closes; the 3 s error-report flush comes
out of that headroom. The check assumes one address and no DNS delay, so it is
a sanity check, not a per-send deadline.

Everywhere:

- only one of `SMTP_USERNAME` and `SMTP_PASSWORD` set is refused;
- a `COOKIE_DOMAIN` that `APP_URL`'s host is neither equal to nor within is
  refused, because browsers reject every cookie it would set;
- `APEX_URL` on another host than `APP_URL` with `GOOGLE_CLIENT_ID` set is
  refused unless `COOKIE_DOMAIN` covers the Apex host;
- `POSTHOG_FEATURE_FLAGS_KEY` without `POSTHOG_PROJECT_KEY` is refused;
- only some of `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and
  `RAZORPAY_WEBHOOK_SECRET` set is refused, as is a `rzp_live_` key outside
  `APP_ENV=prod`, a `rzp_test_` key in prod, and
  `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` without the current secret;
- `BILLING_FAKE_PROVIDER` outside `APP_ENV=local`, or with Razorpay keys set,
  is refused;
- a warning when `COOKIE_SECURE` resolves true with `GOOGLE_CLIENT_ID` set and
  `TRUST_PROXY=false` (express-session would never send the OAuth cookie behind
  a TLS-terminating proxy), and when only one of `POSTHOG_PERSONAL_API_KEY` and
  `POSTHOG_PROJECT_ID` is set.

`JWT_ACCESS_SECRET` signs access tokens and `SESSION_SECRET` signs the OAuth
session cookie and keys the analytics signature; there is no refresh-token
secret, because a refresh token is an opaque random string
([SECURITY.md](SECURITY.md#sessions-and-tokens)).

## Docker and deploying

### Local infrastructure

`docker-compose.yml` runs the services the app needs; the app itself runs on
the host. Its `dev` and `prod` profiles can also run the app and both
frontends in containers; see
[Run everything with Docker](README.md#run-everything-with-docker).

| Service        | Host port                        | Notes                                                                                 |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| Postgres 18    | 5433                             | User, password and database `boilerplate`; also provisions the test role and database |
| Redis          | 6380                             |                                                                                       |
| OTel Collector | 4318 (OTLP HTTP), 13133 (health) | Forwards traces to Tempo and logs to Loki                                             |
| Tempo          | 3200                             | Trace storage                                                                         |
| Loki           | none                             | Log storage; query it through Grafana                                                 |
| Grafana        | 3100                             | Anonymous admin; Tempo and Loki pre-provisioned                                       |
| Mailpit        | 1025 (SMTP), 8025 (web UI)       | Local SMTP sink; the app's SMTP defaults point here                                   |

Every published port binds `127.0.0.1` only, so no other machine reaches
Postgres with its fixed password, Redis with none, Grafana's anonymous admin or
Mailpit. Postgres is pinned to 18 because the migrations use `uuidv7()` as a
column default, built in from 18.

**Host ports 5433 and 6380 are deliberate.** A native Postgres or Redis on
5432/6379 wins `localhost` connections over Docker's wildcard bind. Postgres
then fails loudly (wrong role), but Redis fails silently: any Redis answers
`PING`, so a dev server or the test suite would seem to work against an
unrelated instance. `tests/unit/connection-target.test.ts` reads the committed
`docker-compose.yml` and `.env.test` and asserts they agree, rather than
checking `getEnv()`, because CI's services publish the default ports. The
collector's image has no shell, `curl` or `wget`, so it carries no Docker
`healthcheck`.

### Docker

`Dockerfile` builds in four stages from a digest-pinned `node:24-alpine`:

- `base` installs Corepack and creates the non-root user (uid 10001).
- `deps` installs with `--frozen-lockfile`, in a layer cached apart from the
  application code. `pnpm-workspace.yaml` and `.npmrc` travel with the
  lockfile, because pnpm reads its build allow-list and release-age settings
  from them at install time.
- `build` runs `pnpm build`, then `pnpm prune --prod --ignore-scripts`:
  `pnpm install --prod` would leave dev dependencies in the virtual store, and
  prune removes them, so neither `tsc` nor `drizzle-kit` ships.
- `runner` sets `NODE_ENV=production`, copies only `node_modules`, `dist/` and
  `package.json`, runs as uid 10001, and declares `HEALTHCHECK NONE`: the
  orchestrator owns liveness and readiness through `/health` and
  `/health/ready`, and a second signal could disagree with them under load.
  `ARG GIT_SHA=dev` becomes `APP_VERSION`. The `CMD` is
  `node --enable-source-maps --import ./dist/observability/tracing.js dist/index.js`,
  so tracing loads before the app and a stack trace names the `.ts` line.

The image starts only the app. Run migrations from the same image with
`node dist/database/migrate.js` (`pnpm db:migrate:prod`), which reads only
`DATABASE_URL`. To run it against the compose stack:

```bash
docker build -t express-boilerplate .
docker run --rm -p 4040:4040 --env-file .env \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL=postgres://boilerplate:boilerplate@host.docker.internal:5433/boilerplate \
  -e REDIS_URL=redis://host.docker.internal:6380 \
  express-boilerplate
```

The `-e` overrides matter: `.env` says `localhost`, which inside the container
is the container. Without them `/health` still answers 200 and `/health/ready`
answers 503 at its deadline.

### Deploying

A push to `main` runs `.github/workflows/deploy.yml`. It calls `ci.yml` as a
gate (`workflow_call`), then builds and pushes `ghcr.io/<repo>:sha-<commit>` and
`:main` to GHCR with an SBOM and a build provenance attestation, passing the
commit sha as `GIT_SHA`, then runs the `deploy` job in the `production`
environment. That job is a placeholder: no deployment target is chosen. A manual
`workflow_dispatch` from another branch builds and pushes only the sha image. A
`vX.Y.Z` tag builds nothing: its `promote` job waits for the image `main` built
for that commit and adds `:X.Y.Z`, `:X.Y` and `:X` to the same digest
([CONTRIBUTING.md](CONTRIBUTING.md#releases)). The image job also passes the
frontends' source-map settings (`POSTHOG_SOURCEMAP_PROJECTS`,
`POSTHOG_CLI_HOST`, `POSTHOG_CLI_TOKEN`), which the frontend images use to
upload source maps; this Dockerfile uses only `GIT_SHA`. `ci.yml`'s concurrency
group is keyed on `github.event_name`, because under `workflow_call`
`github.workflow` is the caller's name. CI's `docker` job builds the image with
a known `GIT_SHA` and checks that `/health` reports it and that the process runs
with `--enable-source-maps`.

`release.yml` merges its release PR with `--auto`, falling back to a direct
merge. Only a ruleset on `main` that requires the checks `lint`, `test`,
`docker`, `gitleaks` and `pr-title` makes that fallback wait for CI, so add it
before relying on the release flow. The release App and the merge settings
are in [CONTRIBUTING.md](CONTRIBUTING.md#releases).
