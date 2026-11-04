# Architecture

This file explains how the express-boilerplate API is built. It is for a
developer about to change the code. It covers:

- how a process boots and stops;
- where code goes;
- what a request passes through;
- what runs in the background;
- the design decisions that constrain a change.

Other documents cover the rest:

| Topic                                    | Where                      |
| ---------------------------------------- | -------------------------- |
| The threat model and every defence       | [SECURITY.md](SECURITY.md) |
| The tables and migrations                | [DATABASE.md](DATABASE.md) |
| The quick start, scripts, operator steps | [README.md](README.md)     |

Two frontends call this API: the customer web app (`WEB_URL`) and Apex, the
staff dashboard (`APEX_URL`, see [A second frontend: Apex](#a-second-frontend-apex)).

## Boot and process model

This section covers what happens between `node` starting and the first request,
how a process stops, the two health endpoints, and the shared Postgres, Redis
and queue clients.

### Boot sequence

Three files, one job each:

```
src/index.ts    entrypoint: validates the environment, then boots
src/server.ts   owns the listening socket and the shutdown sequence
src/app.ts      builds the Express app: no listen, no workers, so tests import it
```

`main()` in `src/index.ts` runs three steps:

1. It raises `Error.stackTraceLimit` to `ERROR_FRAME_LIMIT` (50 frames). V8,
   Node's JavaScript engine, keeps 10 frames by default, and error tracking
   keeps 50.
2. It calls `getEnv()` and `assertEnvConsistent` inside a `try`. An invalid
   environment prints one list and sets exit code 1 before any socket opens.
   The list starts `Invalid environment:` for a schema error, or
   `Inconsistent environment:` for a cross-field rule.
3. Only then does it run `boot()`.

`boot()` imports `@/server` and the worker supervisor **dynamically**, for two
reasons:

- `@/server` reaches `database.service.ts`, which calls `getEnv()` at module
  scope. A static import would throw on a bad environment before `main()`
  could report it.
- A static worker import would load BullMQ, the Redis-backed job queue
  library, into processes that never start Workers.

`boot()` then runs these steps in order:

1. When flags are configured, the flag snapshot finishes a first load
   ([Feature flags](#feature-flags)).
2. Every replica subscribes `reconcileQueuePause` to maintenance-mode reloads,
   because API-only replicas hold producer connections too. The
   maintenance-mode store finishes a first read
   ([Maintenance mode](#maintenance-mode)). Neither start rejects or waits for
   its pub/sub subscription, so the first request already sees both.
3. `startServer()` listens. A bind failure (`EADDRINUSE`, `EACCES`) logs one
   line, and the server's `error` event exits 1 through the shutdown handler.
4. `warnIfDeletionsPending` warns once when purged users wait in
   `analytics_deletions` while the PostHog personal key or project id is
   missing ([Analytics](#analytics)).
5. One shutdown handler (`createShutdownHandler`,
   `src/services/lifecycle.service.ts`) takes `SIGTERM`, `SIGINT`, an unhandled
   rejection and an uncaught exception. It runs `gracefulShutdown` once and
   exits with the highest code any caller asked for. It exits 1 if shutdown
   takes longer than `SHUTDOWN_TIMEOUT_MS`. A process fault takes three steps
   first:
   - it marks shutdown, so readiness answers 503;
   - it is reported and logged with one `errorId`;
   - the error-report queue is flushed for at most `ERROR_FATAL_FLUSH_MS`
     (2 s). A signal during that flush still exits 1.
6. With `WORKER_ENABLED`, `startWorkers()` starts the Workers
   ([Queues and Workers](#queues-and-workers)). It is skipped when shutdown
   began during the import. A failure to start rejects `boot()`, and the
   unhandled-rejection handler turns that into exit 1.

`startServer(port)` takes the port as a parameter because `getEnv()` is
memoised. A test cannot change `APP_PORT` after import, so it calls
`startServer(0)`.

`createApp()` (`src/app.ts`) also registers the domain-event subscribers
(onboarding and analytics). Registration is idempotent, so a test may build the
app more than once and still have them.

### Graceful shutdown

`gracefulShutdown(server, workers?)` (`src/server.ts`) runs these steps in this
order. Each step depends on the one before it:

1. Readiness starts answering 503 (`markShuttingDown`), and every open
   Server-Sent Events (SSE) stream ends (`closeAllStreams`). An SSE response
   never ends by itself, so it would hold `server.close()` open until the
   force-close.
2. The socket closes. Idle keep-alive connections are swept every 250 ms.
   Connections still open after `SERVER_DRAIN_TIMEOUT_MS` (5 s) are
   force-closed. No new request finds a closed pool.
3. The Workers close. `Worker#close()` lets the in-flight job finish, and that
   job needs the database and Redis, which are still open.
4. The error-report queue is flushed for at most `ERROR_SHUTDOWN_FLUSH_MS`
   (3 s). The flush runs after the Workers close, so a job's final failure is
   included. It runs before Redis closes, because the flush counts its outcome
   there.
5. The database, Redis, queue and notification-subscriber clients close, and
   the flag snapshot and maintenance-mode store stop.
6. OpenTelemetry flushes and shuts down last, so it exports the spans the
   earlier steps produce.

Every `close*()` is safe to call twice. `gracefulShutdown` never calls
`process.exit`; the `SHUTDOWN_TIMEOUT_MS` backstop belongs to the shutdown
handler.

### Health checks

The API has two health endpoints, and they check to different depths on
purpose. Neither is traced. Both routes are public
([SECURITY.md](SECURITY.md#error-tracking-what-reaches-posthog)).

**`GET /health`** is liveness. It touches no dependency, so a database blip
never makes an orchestrator restart a healthy process. It answers
`{ status: 'ok', uptime, release }`. `release` is `APP_VERSION`, the image's
git sha (`dev` outside an image).

**`GET /health/ready`** is readiness. Failing it only removes the pod from
rotation, so it checks more:

- It checks the database, Redis and both queue connections, in parallel.
- It answers 503 `not-ready` when any check fails, and 503 `shutting-down`
  once shutdown has begun. It names only the dependency, never a host or
  driver error.
- `READINESS_CHECK_DEADLINE_MS` (500 ms, `createReadinessProbe` in
  `src/services/readiness.service.ts`) bounds each check. A check that runs
  past it reports `false` and puts its name in `timedOut`. A 200 never carries
  `timedOut`. Set the orchestrator's probe timeout above 500 ms.
- A check still running at the deadline is left to finish, and is not started
  again until it does. A stalled database therefore holds one pool connection,
  not one per probe.
- The Redis check has its own 300 ms bound (`waitForRedisProbe`). It neither
  consults nor opens the request-path stall cooldown described under
  [Data layer](#data-layer).
- Before a queue connection's first `ready`, the probe waits for it. The probe
  therefore answers 503 at the deadline while that connection is still
  connecting.

### Data layer

Each process holds one Postgres client, one shared Redis client and two queue
connections. This section says how each is built and how each behaves when
Redis is down or stalled.

- **Postgres.** `src/services/database.service.ts` creates exactly one
  `postgres` client per process, at module scope, and one Drizzle
  (object-relational mapper) instance over it. A second client is a second
  pool and doubles the connection budget, which shows up only under load. The
  pool options (`databaseClientOptions`, `src/configs/database.config.ts`)
  are:
  - `max: DB_POOL_MAX`;
  - prepared statements off, because transaction pooling breaks them;
  - `DB_STATEMENT_TIMEOUT_MS` as each connection's `statement_timeout` when it
    is above 0.

  `src/database/migrate.ts` and the test global setup build their own clients
  without these options, so a statement timeout never cuts a migration short.
  `withTransaction(fn, executor)` reuses a transaction it is passed, with no
  savepoint, so an outer rollback always takes an inner write with it.

- **Redis.** `src/services/redis.service.ts` holds one shared node-redis
  client. It connects lazily on first use, so importing a repository in a unit
  test opens no socket. node-redis has no permanently-closed state of its own,
  so `closeRedis()` sets a `closed` flag that is never reset. The flag stops a
  readiness probe after shutdown from reopening the socket.
  `createRedisClient()` builds every extra client (the notification
  subscriber, the snapshot and maintenance-mode subscribers) with the same
  policy. Every key and channel goes through `redisKey(...parts)`, which adds
  the `REDIS_KEY_PREFIX` prefix.
- **Queues.** `src/services/queue.service.ts` owns the BullMQ queues and the
  two `ioredis` connections they run over. BullMQ needs `ioredis`, which cannot
  share node-redis's connection. The Workers' connection keeps the offline
  queue, which Workers need to ride out an outage. The producers' connection
  turns it off, so an enqueue during an outage rejects at once instead of
  holding its HTTP caller.

**Through a Redis outage.** Before a client's first `ready`, every Redis
client gives up after 3 retries, so boot and `/health/ready` report
unreachable instead of hanging. After its first `ready`, every client retries
forever, with a backoff capped at 5 s (`RECONNECT_DELAY_CAP_MS`), so an outage
never leaves a dead client behind. While a client reconnects, nothing waits
for Redis:

- node-redis runs with `disableOfflineQueue`;
- a producer enqueue rejects;
- the queue check reports `false` for a connection in any post-ready status
  other than `ready`.

A queue connection that gives up before its first `ready` is replaced on next
use, and Workers on it never recover by themselves. Start Workers only through
`startWorkers()`, which replaces them on a fresh connection. The file JSDoc of
`src/services/worker-supervisor.service.ts` explains why. A failed restart
keeps the queue check `false` until a later restart succeeds.

**Through a stalled Redis.** node-redis never times out a command it has
written. Its `connectTimeout` stops at the TCP (Transmission Control Protocol)
connect, and the handshake after it has no timer. The API adds two bounds:

- `getRedis()` bounds the shared client's whole connect at
  `REDIS_CONNECT_TIMEOUT_MS` (5 s), and destroys a client that runs out of
  time.
- Every Redis call a request waits on runs under a deadline
  (`src/services/redis-deadline.service.ts`), through one of two wrappers.

**`withRedisDeadline`** wraps reads and counters:

- the session denylist read;
- the rate-limit store;
- the staff-visit, view-audit and flag-exposure dedupes;
- the invitation recipient budget;
- the mail cooldowns;
- the maintenance-mode notice ids;
- the OAuth (Open Authorization) session store.

A call with no answer in `REDIS_REQUEST_DEADLINE_MS` (300 ms) fails. For the
next `REDIS_STALL_COOLDOWN_MS` (5 s), every such call fails at once without
asking Redis. The failure takes the caller's existing outage path (fail open,
memory, or `next(error)`), so the API handles a stall as an outage. Two
exceptions keep the rule from misfiring:

- A call that misses its deadline while the shared client's first connect is
  still inside its 5 s bound falls back without opening the cooldown. A slow
  connect is not a stall.
- The verdict waits one turn of the event loop after the timer. A reply
  already in the socket buffer when a blocked process wakes still wins.

**`waitForRedisWrite`** carries two kinds of write: those whose loss would
widen access (a session deny, a maintenance-mode change publish), and those
whose loss would let a dedupe or throttle key linger (its release). The API
always sends the write, cooldown or not. The request waits for it for at most
the deadline; a write still in flight then lands when Redis answers. If the
connection drops first, the write is lost and its failure logged.

Neither wrapper covers Workers, BullMQ, pub/sub, background publishes and
counters, or the staff status reads (bounded by `STATUS_READ_TIMEOUT_MS`). The
deadline is a design limit, not a fault detector: a Redis whose latency
regularly passes 300 ms trips the cooldown. What each caller then does is in
[SECURITY.md](SECURITY.md#revocation-and-the-session-denylist) and
[SECURITY.md](SECURITY.md#rate-limiting-one-store-prefix-per-limiter).

## Layers and directory rules

This section says where code goes: the layers and what each may import, the
lock order every transaction follows, the services that carry staff access,
and the file-naming rules.

### Layers

Each layer has one directory and one job:

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

- `import-x/no-restricted-paths`:
  - controllers may not import a repository or `database.service`;
  - controllers may not import another controller, except
    `base.controller.ts` and `helpers.controller.ts`;
  - services, repositories, policies, errors and presenters may not import
    controllers, routes or middlewares;
  - repositories may not import a service other than `database.service`;
  - policies may not import repositories, services or `database`;
  - configs may not import controllers.
- `@typescript-eslint/no-restricted-imports`: controllers import
  `database/models` for types only.
- `no-restricted-imports` over `src/**`, with `src/services/platform-*.service.ts`
  exempt. The 7 cross-tenant repositories (`platform-tenant`,
  `platform-stats`, `platform-user`, `platform-email`, `platform-onboarding`,
  `platform-billing`, `platform-tax`) stay out of every other module. A
  customer's "your tenants" is therefore never served from a query that sees
  every tenant.
- `import-x/no-cycle` over relative and `@/` imports.

`tests/unit/lint-gates.test.ts` lints the committed violations under
`tests/fixtures/lint-zones/` and `tests/fixtures/lint-cycle/` to prove each
rule fires. The zones are a blocklist, so an import edge no zone names is
unchecked. When a rule refuses an import, either the import is wrong, or the
zone config and the zone list above change in the same commit.

**Controllers.** Every route handler is a `BaseController` method
(`src/controllers/base.controller.ts`): an arrow-function field built through
`this.handle(handler)`. `handle` forwards a thrown or rejected error to
`next()` and never sends a response. When the headers were already sent, it
logs one `warn` and still forwards, and `errorHandler` destroys the socket.
Two handlers are not wrapped, and each file states its reason:

- `handleGoogleCallback` (`auth.controller.ts`) redirects every failure to
  the frontend;
- `streamNotifications` (`notification-stream.controller.ts`) is an SSE
  stream.

Each controller file exports one singleton, which its routes file imports.

**Services.** A service owns its transaction and never sends a response. Some
routes reply before the work: `POST /auth/link/request` answers 202 first.
There, the service exposes the work as a function the controller calls after
replying, and that function never rejects.

The service decides the authorization that matters, inside the transaction.
The router's `requireRole` is only the early, coarse gate. The service
re-reads the actor's role under lock and applies
`src/policies/tenant.policy.ts`. A controller may report `role` or `access`
but never authorizes on them.

**Repositories.** Every public method takes a final optional
`executor: DbExecutor = db`, so a caller can run it inside its own
transaction. `BaseRepository` owns three things:

- soft-delete filtering;
- `updatedAt` maintenance;
- translating a unique violation into a 409.

Only `users`, `user_tokens` and `tenants` have the `deletedAt` and `updatedAt`
columns it needs. Every other repository stands alone and says why in its file
JSDoc.

**Domain events.** A service that needs other features to react calls
`emitDomainEvent` (`src/services/domain-events.service.ts`) after its own
transaction commits, because Drizzle has no after-commit hook. The service
awaits the call, so every subscriber has run before the request answers. A
failing subscriber is logged, and never fails the emitter or the subscribers
after it. The subscribers are onboarding and the analytics forwarder.

**Lock order.** Every transaction that locks more than one row set takes the
locks in one fixed order, so two transactions never wait on each other in a
cycle. Postgres cannot enforce an application lock order. Instead, the JSDoc
of each lock method states its place, and deadlock regression tests hold it
(listed at the end of this part).

Issuing a link stands apart from the order. Issuing a sign-in, step-up or
invitation confirm link first takes a transaction-scoped advisory lock
(`lockLinkIssue`, `pg_advisory_xact_lock`, `user-token.repository.ts`) on one
of these:

- the address;
- the address and invitation, for a confirm link;
- the session.

It takes that lock alone, in a transaction that holds no other lock. It then
locks the live link rows it revokes, in id order, and nothing else, so it
joins no cycle. Without the advisory lock, two concurrent issues each revoke
before the other's insert commits, and both links stay live.

An invitation confirm link's insert also takes `FOR KEY SHARE` on its
invitation row, through the foreign key. The accept and revoke UPDATEs
(`FOR NO KEY UPDATE`) do not conflict with that lock. Two writes do conflict
with it: a resend, which rewrites the unique `token_hash` and so takes
`FOR UPDATE`, and the retention purge's delete. Each of them only waits:
neither takes a `user_tokens` row or the issue's advisory lock, so no cycle
forms.

Every transaction that locks more than one row set takes them in this order:

1. **The user row** (`lockById`, `user.repository.ts`). These take it:
   - a link, invitation or Google sign-in (`FOR SHARE`, before the refresh
     insert);
   - refresh rotation, logout and the refresh kills;
   - step-up;
   - the never-verified account claim;
   - tenant creation;
   - an owner invitation's accept, or any platform-tenant invitation's accept
     (`lockUserForOwnership`, `tenant-membership.service.ts`, before the
     claim).

   None of these goes on to lock a membership or tenant row. A customer
   invitation's accept, verify or confirm goes on only to the seat lock (step
   5), before its claims.

   A transaction that also locks token rows takes the user row, then the link
   row, then the refresh rows:
   - A step-up confirm locks the user row, claims its link, then moves the
     session's refresh rows (`confirmStepUpLink`, `step-up.service.ts`).
   - An invitation confirm locks the invitee's row `FOR SHARE` (or inserts the
     new account), takes the seat lock on a customer tenant, claims its link,
     claims the invitation (`claimForAcceptById`), inserts the membership and
     inserts the refresh row (`confirmInvitation`,
     `tenant-invitation.service.ts`).

   A deactivation, a staff sign-out and a sign-out of the other sessions take
   the user row, then revoke the address's links (`revokeSignInLinksOf`). A
   confirm that claimed its link before the user row would deadlock against
   them (`tests/integration/services/invitation-confirm-race.test.ts`).

2. **A tenant's owner rows** (`lockOwners`, in id order).
3. **Its memberships** (`lockMemberships`, in `user_id` order).
4. **The actor's platform-tenant membership**, `FOR SHARE`, when the actor has
   no membership in the tenant (`lockPlatformRole`, through `lockTenantAccess`
   in `tenant-access.service.ts`).
5. **A customer tenant's billing row, the seat lock** (`lockSeats`,
   `src/services/billing/seats.service.ts`, `FOR NO KEY UPDATE`).
   - Every write that adds a seat on the members limit takes it: an invite
     (after `lockActorRole`), the resend of an expired invitation, and an
     accept, invitation verify or confirm (after the user-row step). It comes
     before any invitation or membership-row write, so two such writes queue
     here and never both take the last seat.
   - The platform tenant has no billing row and takes no seat lock.
   - The billing sync (`syncTenantBilling`,
     `src/services/billing/billing-sync.service.ts`) locks only this row. It
     calls the payment provider only before or after its transaction, and so
     do the billing scheduler's writes.
   - A suspend or archive never touches this row. After its commit it queues
     a prompt cancel job. The scheduler's lifecycle step, which takes the same
     claim, is the fallback.
   - A user's delete takes it after the user row. A user's purge takes it
     after the memberships and the platform-role row, and before the user
     row's delete, to clear the user as payer (`clearPayer`).
   - A tenant purge takes it after the platform-role row, to check that no
     subscription arrived since its provider check.
   - The cancel marker (`markCancel`, `cancel-marker.service.ts`) is written
     in its own transaction before the provider call. It takes the cancelling
     owner's user row `FOR KEY SHARE` first, so its foreign key never locks
     that row after the billing row.
6. **For a tax document** (`issueInvoice`, `issueCreditNote`,
   `src/services/billing/tax-documents.service.ts`), after that billing row
   (`lockByTenantId`, `FOR NO KEY UPDATE`):
   - for a credit note, the invoice's `tax_documents` row (`lockInvoice`,
     `FOR NO KEY UPDATE`). The row is never deleted or re-keyed, and
     `FOR UPDATE` would conflict with the `FOR KEY SHARE` the credit note's
     foreign key takes on it;
   - then, last, the series counter (`allocateNumber`,
     `tax_document_counters`, `FOR NO KEY UPDATE`, because it only bumps
     `last_number`).

   Every tenant shares the counter, so the transaction holds it for the
   insert and its audit entry, and nothing else. Its bump and the insert
   commit or roll back together, so a series has no gap. The issue time is the
   database clock read after the counter lock, so a series is dated in its
   number order. When that time falls in a different financial year from the
   one locked, the transaction rolls back and runs once more in that year. The
   tax details are read unlocked and frozen into the document.

   Other tax writes:
   - A staff credit note first takes the actor's platform-role and user rows
     (`assertStillPlatformRole`, the staff-write exception below). It then
     takes the billing row, invoice row and counter, all in that one
     transaction.
   - A held-charge resolve takes the actor's platform-role and user rows,
     then only the held row, through its conditional `UPDATE`. Two resolves
     therefore queue there.
   - A tax details write first re-reads the actor's role under lock: an
     owner's owner and membership rows through `lockActorRole` (steps 2 and
     3), or staff's platform-role and user rows through
     `assertStillPlatformRole`. It then locks its own row (`lockDetails`, then
     a versioned `UPDATE`) and nothing else.
   - No issue transaction calls the payment provider.

7. **The tenant or settings row a write changes** (`lockById` in
   `tenant.repository.ts`, `lockByTenantId` in
   `tenant-settings.repository.ts`).
8. **A user's notification preference rows**, in `NOTIFICATION_TYPES` order
   (`updatePreferences`, `notification.service.ts`). That transaction locks
   nothing else; its foreign key takes `FOR KEY SHARE` on the user row.

A staff plan, price or billing settings edit locks the actor's platform-role
and user rows (`assertStillPlatformRole`). It then locks the plan row
(`lockPlan`) or the settings row (`lockSettings`, `plan.repository.ts`), and
nothing else. No tenant write locks either row, so neither joins a cycle. The
API tells the tenants a plan edit reaches after its commit.

Three writes take a user row later than step 1:

- **Staff writes** lock owner rows and platform memberships first. They then
  lock the actor's user row `FOR SHARE` (`assertStillPlatformRole`,
  `platform.service.ts`) and, for a user action, the target's user row
  (`lockStaffPair`, `platform-user.service.ts`). The tenant row comes last.
- **A role change to owner** takes the target's user row `FOR SHARE`
  (`lockUserForOwnership`) after the tenant's owner-row locks. A delete that
  holds those owner rows took them before the target's user row, so the role
  change queues there, holding nothing the delete wants. When the target is
  already an owner, the change skips this lock; that only avoids a redundant
  lock.
- **`pnpm platform:grant`** locks the platform tenant's owner rows and the
  account's membership, then the account's user row `FOR SHARE`
  (`grantInTransaction`, `platform.service.ts`). That is the mode a
  platform-invitation accept takes. An accept that holds the row while it
  waits for the grant's membership insert therefore coexists with the grant
  instead of deadlocking.

Each grant's `FOR SHARE` (an owner grant, or any platform-tenant invitation's
accept) conflicts with a staff delete's `FOR NO KEY UPDATE` on the target. A
grant that holds the row first commits before the delete reads on:

- a new customer tenant fails the delete's second ownership read (409);
- the role re-read after the user-row lock (`lockStaffPair`) sees a new
  platform role, so the rank rule and the last-owner guard apply to it.

A transaction that locks membership rows in both a customer tenant and the
platform tenant locks the customer tenant's first.

These deadlock regression tests hold the order:

- `tests/integration/services/tenant-membership.service.test.ts`
- `tests/integration/services/billing/cancel-marker.service.test.ts`
- `tests/integration/api/platform-user-race.test.ts`
- `tests/integration/services/billing/seat-lock-order.test.ts`
- `tests/integration/services/billing/tax-issue-race.test.ts`

**Lock modes.** A lock that only guards a read-then-write takes
`FOR NO KEY UPDATE`. `FOR UPDATE` would conflict with the `FOR KEY SHARE` lock
that every foreign-key insert takes on the row it references. On a tenant row,
`FOR UPDATE` would block that tenant's audit inserts and invitation accepts
for the whole transaction.

`FOR UPDATE` is only for a transaction that deletes the locked row or changes a
key column. A method that serves both cases takes a `RowLockMode`
(`src/types/lock-mode.ts`), which defaults to `'no key update'`. The user
row's modes are in
[SECURITY.md](SECURITY.md#deactivation-against-a-concurrent-sign-in). Lock
tests detect blocking with `pg_blocking_pids` (`tests/helpers/lock-probe.ts`),
not with sleeps.

### Platform access

Staff are the members of the one tenant with `is_platform` set, called the
platform tenant. Every other tenant is a customer tenant (a workspace). The
services below carry staff access. The routes in front of them check the
platform role first, and every write re-checks it under lock.

| Service                          | Job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant-access.service.ts`       | `lockTenantAccess`: locks owners, memberships and, when the actor has no membership, the platform membership, and returns the actor's access. Membership wins; the platform tenant is members-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `platform.service.ts`            | Reads a user's platform role (one indexed read, no cache), `assertStillPlatformRole` inside a staff write, and the grant behind `pnpm platform:grant`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `platform-tenant.service.ts`     | Staff tenant search and detail, create with an owner invitation, owner re-invitation, and the suspend, reactivate and archive transitions (`transitionLifecycle`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `platform-user.service.ts`       | The staff user directory and user actions (create with a welcome sign-in link, edit, staff-sent sign-in link, deactivate, reactivate, sign out, soft delete). Edits and state changes lock through `lockStaffPair`; the sign-in link checks rank without a lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `platform-purge.service.ts`      | `purgeUser` and `purgeTenant`, the only hard delete of a user or a tenant. With `retention.service.ts`, the only code that names the audit trigger's purge settings, and the only code that names `app.audit_redact`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `platform-stats.service.ts`      | The staff Overview: totals, the stuck threshold and zero-filled daily series.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `platform-email.service.ts`      | Message tracking: search, detail, masked preview, health, suppressions and resend, which runs the action that sent the mail, with that action's own gates and audit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `platform-onboarding.service.ts` | The staff funnel, tenant list and tab, the Overview's stuck count, manual completion, reminders, and `pnpm onboarding:reconcile`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `platform-flags.service.ts`      | The flag inspector and evaluate view ([Feature flags](#feature-flags)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `platform-billing.service.ts`    | One tenant's billing for staff: the read (provider ids, sources, grants, the newest 20 state changes and provider events, never the owner-only fields), its paged lists (state history, provider events, held subscriptions and invoices, sharing the read's throttled audit), resync, trial extension, grants and their revocation, and the staff cancel (`cancelSubscriptions`, shared with the owner's cancel). Each write locks the platform-role row, then the billing row. Platform-wide: the plans with prices and tenant counts, a plan change's preview, the plan edit (applied to every tenant on the plan at once, then pushed to their open apps), a new price (retiring the active one; subscribers keep theirs), the billing settings (with whether tax documents are on, whether any exists, and the configured effective date) and the alerts list. The read also counts the tenant's open held SEZ (Special Economic Zone) charges. |
| `platform-tax.service.ts`        | One tenant's tax records for staff: the tax details read and the manager's save (the owner's rules, with a reason), the document list with search and its PDFs, the admin's manual credit note (one transaction re-checks the admin role, then locks the billing row, the invoice and the counter), and the held SEZ charges with their resolve, which records staff work and issues nothing. Reads share the billing read's throttled audit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `platform-system.service.ts`     | `GET /platform/system/status`: the release, error tracking's counts, the flags' snapshot and the maintenance mode. An open object, one key per section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `audit.service.ts`               | `record(entry, tx)` in the caller's transaction with strict per-action metadata; the hourly platform-access entry; the tenant and platform audit-log reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Staff plan and settings edits take effect as follows:

- **A plan edit** applies to every tenant on the plan at once, including
  trialing tenants for Paid. A lowered limit deletes nothing: a tenant over it
  keeps its members but can add none. An edit that sends `entitlements` must
  send at least one key.
- **A new price** retires the active price of its interval. A subscriber keeps
  the price it pays, and a checkout already open at the old price completes at
  that price. The provider plan is made at the first checkout on the new
  price.
- **Trial settings** (`trialEnabled`, `trialDays`) apply to trials that start
  after the change.
- **`pastDueGraceDays`** applies at once to every past-due tenant, and to an
  active tenant whose paid period lapsed before the billing job ran, because
  the grace end is computed on each read.

One queued `publish-entitlements` billing job tells the tenants a plan edit or
a grace change reaches. It reads their records 500 at a time, so the edit
answers at once.

The staff tenant list's `billingState` and `planKey` are the stored values.
They trail a lapsed trial or period until the billing job's next run (at most
15 minutes). The platform tenant has neither value.

Each cross-tenant repository is imported by its own `platform-*` service only,
with two exceptions:

- `platform-purge.service.ts` also imports `platform-user.repository.ts`;
- `platform-billing.service.ts` also imports `platform-tax.repository.ts`, for
  the open held count and whether any tax document exists.

What staff may do, and the gates on it, are in
[SECURITY.md](SECURITY.md#platform-staff).

### Extending Apex

Apex is a template: a product adds its own fields, states and staff actions.
The step-by-step recipes are in
[CONTRIBUTING.md](CONTRIBUTING.md#extending-the-apex-api). These rules are not
obvious from a recipe:

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
(`*.controller.ts`, `*.service.ts`, `*.repository.ts` and so on). The
`check-file/filename-naming-convention` map in `eslint.config.mjs` lists the
suffixes, and `pnpm lint` fails on a misnamed file. The suffix is the singular
of the role, except `.validators`, `.utilities`, `.constants` and `.routes`.
Subfolders inherit their parent's rule, and every folder under `src/` is
kebab-case.

Directories with no filename rule:

- `src/errors/`: error classes and Postgres error handling (`HttpError`,
  `isUniqueViolation`, `redactedForLog`).
- `src/types/`: the `Express.Request` augmentation (`express.d.ts`) and the
  shared and domain types more than one layer uses (`actor.ts`, `flags.ts`,
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

No `index.ts` in `src/` re-exports other modules. Import the module directly
(`@/configs/env.config`, never `@/configs`). A barrel fails the filename rule
in every governed directory, and it hides real edges from
`import-x/no-cycle`. `src/routes/index.routes.ts` builds a router and
re-exports nothing, so it is not a barrel.

## Request lifecycle

This section follows a request through the API: the middleware order, sign-in
and its tokens, the error envelope, the list contract, request correlation,
the second frontend and email tracking.

### Request path: auth and beyond

`createApp()` mounts the steps below in this order, and Express runs them in
registration order:

| Step                                         | Why it sits there                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-powered-by` off, `trust proxy`            | `TRUST_PROXY` decides what `request.ip`, and so every IP-keyed limiter, sees; a malformed value throws at boot.                                                 |
| `helmet`                                     | First, so a preflight, a 404 or an error response already carries the headers.                                                                                  |
| `cors`                                       | Cross-origin resource sharing (CORS). An allowed preflight ends here; a disallowed origin gets no grant header and the request carries on.                      |
| `requestId`                                  | Every later response carries `X-Request-Id`.                                                                                                                    |
| `recordRouteTemplate`                        | Ahead of every router, so an error's `http_route` keeps the mount path ([Error tracking](#error-tracking)).                                                     |
| `requestContext`                             | Opens the per-request store the logger reads ([Request correlation](#request-correlation)).                                                                     |
| `maintenanceModeGate`                        | After `cors`, so a refusal carries the grant; before every router, the webhooks, the proxy and the body parsers ([Maintenance mode](#maintenance-mode)).        |
| `posthogSession`                             | Copies `X-POSTHOG-SESSION-ID` into the request context, for server events.                                                                                      |
| `/api/v1/webhooks/email`                     | Before the body parsers: a provider's signature covers the exact bytes, so the route reads them with its own `express.raw` ([Email tracking](#email-tracking)). |
| `/api/v1/webhooks/razorpay`                  | Before the body parsers for the same reason: Razorpay, the payment provider, signs the exact bytes. It verifies, records and queues on the `billing` queue.     |
| `/api/v1/collect`                            | Before the body parsers too: replay bodies stream to PostHog unread ([Analytics](#analytics)).                                                                  |
| `express.json` (1 MB), `urlencoded` (100 KB) | The body parsers.                                                                                                                                               |
| `GET /health`, `GET /health/ready`           | [Health checks](#health-checks).                                                                                                                                |
| `/api/v1`                                    | `createApiRouter()` (`src/routes/index.routes.ts`).                                                                                                             |
| 404, then `errorHandler`                     | Last, so it sees errors from everything before it.                                                                                                              |

`createApiRouter()` mounts one router per feature: `auth`, `account`,
`profile`, `notifications`, `tenants`, `invitations`, `platform`, `flags` and
`status`. A
new feature router is one more `router.use(...)` there, never a change to
`app.ts`.

- **Auth.** `resolveClientKind` runs first on the auth and invitation routers
  ([Native clients](#native-clients)). The auth router answers 415 to any body that is not
  `application/json` (`requireJsonContentType`, router-wide). Its open routes
  need no access token. `POST /auth/refresh` and `/auth/logout` check `Origin`
  first, then read the refresh cookie off the raw `Cookie` header; there is no
  `cookie-parser`. How each credential works is in
  [SECURITY.md](SECURITY.md#authentication).
- **`requireAuth`** (`src/middlewares/auth.middleware.ts`) is mounted
  router-wide on the profile, notification, tenant, platform and flags
  routers, so a route added there inherits it. Elsewhere it is mounted per
  route. It runs three steps:
  1. it verifies the bearer token;
  2. it refuses a session on the Redis denylist;
  3. it reloads the user by id.

  The reload is one database read per request, not cached on purpose: a
  deactivated or deleted account is refused on its next request, not when its
  token expires. Every response behind `requireAuth` sends
  `Cache-Control: no-store`, except the SSE stream, which sends `no-cache`.

- **Tenant routes** compose `resolveTenant()` and `requireRole(...)` per
  route. The tenant comes from `:slug` only. See
  [SECURITY.md](SECURITY.md#tenant-roles).
- **Platform routes** mount `requireAuth` router-wide. Their gates, the
  OPTIONS refusal and the staff-write log line are in
  [SECURITY.md](SECURITY.md#platform-staff).
- **Every authenticated write has a rate limiter.** Each limiter is built once
  per router and reused, so the in-memory fallback keeps one budget.
  `tests/unit/routes/route-limiters.test.ts` fails a write route without one.

### Sign-in, step-up and their tokens

A person signs in by an emailed link, by Google or by a passkey
(`PASSKEY_MODE`; [SECURITY.md](SECURITY.md#passkeys)). Step-up is the check
that a signed-in person is still present before a sensitive action. The auth
routes, all under `/api/v1`, are:

| Route                                                                                                                             | Service                                                            | What it does                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/link/request`                                                                                                         | `requestSignInLink` (`sign-in-link.service.ts`)                    | Answers 202 before any lookup, then mails a link (or, on Apex, a staff invitee's invitation) in the follow-up.                                                                                                                                                                                                       |
| `POST /auth/link/verify`                                                                                                          | `verifySignInLink`                                                 | Spends the link and signs in the account its address holds, creating a verified one on the first web click.                                                                                                                                                                                                          |
| `POST /invitations/verify`                                                                                                        | `verifyInvitation` (`tenant-invitation.service.ts`)                | Every click answers 202 and mails a confirm link in the follow-up (`requestInvitationConfirm`).                                                                                                                                                                                                                      |
| `POST /invitations/confirm`                                                                                                       | `confirmInvitation` (`tenant-invitation.service.ts`)               | Spends the confirm link and the invitation, signs the invitee in as a recent sign-in, and joins them.                                                                                                                                                                                                                |
| `GET /auth/google`, `GET /auth/google/callback`                                                                                   | `completeGoogleSignIn` (`google-auth.service.ts`)                  | Google sign-in.                                                                                                                                                                                                                                                                                                      |
| `POST /auth/step-up/link/request`, `/auth/step-up/link/verify`                                                                    | `requestStepUpLink`, `confirmStepUpLink` (`step-up.service.ts`)    | Any signed-in user: the request takes `{ app }`, mails a link bound to the calling session and answers `resendAvailableAt` and the link's `expiresAt`, and the verify confirms it for that session alone.                                                                                                            |
| `POST /auth/passkeys/step-up/options`, `/step-up/verify`                                                                          | `startPasskeyStepUp`, `finishPasskeyStepUp` (`step-up.service.ts`) | Any signed-in user: confirms it's them with a passkey, for the calling session alone.                                                                                                                                                                                                                                |
| `GET /auth/passkeys/config`                                                                                                       | `passkey.controller.ts`                                            | Public: answers `PASSKEY_MODE` in every mode.                                                                                                                                                                                                                                                                        |
| `POST /auth/passkeys/sign-in/options`, `/sign-in/verify`                                                                          | `startPasskeySignIn`, `finishPasskeySignIn` (`passkey.service.ts`) | Public: verifies the assertion, then signs in the account that owns the passkey, as a recent sign-in. `400 PASSKEY_UNKNOWN` for a missing row; `403 PASSKEY_NO_ACCESS` for an inactive, deleted, unverified or non-staff-on-Apex account (the last gets its own message). Options and verify have separate limiters. |
| `GET /auth/passkeys`, `POST /auth/passkeys/registration/options`, `/registration/verify`, `PATCH` and `DELETE /auth/passkeys/:id` | `passkey.service.ts`                                               | List (answers `userHandle` and `passkeys`, each with its `credentialId`), create, rename and delete (answers `userHandle` and the remaining `passkeys`) the caller's passkeys. Create and delete need a recent sign-in, checked before the limiter.                                                                  |
| `POST /platform/users/:id/sign-in-link`                                                                                           | `platform-user.service.ts`                                         | Staff send a user an ordinary sign-in link: Apex for staff, `WEB_URL` for anyone else.                                                                                                                                                                                                                               |
| `POST /auth/refresh`, `POST /auth/logout`                                                                                         | `session.service.ts`                                               | Rotate or revoke the refresh cookie's session.                                                                                                                                                                                                                                                                       |

**The tokens.** Four stores hold the credentials:

| Store                | What it holds                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_tokens`        | Three purposes: `refresh` (the session chain, with its `client` and `device_name`), `sign_in_link` (an address and an app, never a user) and `step_up_link` (a user and the session it elevates). |
| `user_passkeys`      | The passkeys: a public key and counters, never a private key.                                                                                                                                     |
| Redis                | Single-use passkey challenges, for 5 minutes (`passkey-challenge.service.ts`).                                                                                                                    |
| `tenant_invitations` | The invitation links.                                                                                                                                                                             |

Every token and link is 32 random bytes, and only its SHA-256 hash is stored.
[DATABASE.md](DATABASE.md#user_tokens) has the columns and the shape CHECK
constraint, and [SECURITY.md](SECURITY.md#email-links) has the lifetimes and
claims. `link-token.service.ts` issues, claims and peeks the two link purposes
and builds their URLs. Each URL goes through `withUtm`
(`src/utilities/utm.utilities.ts`), the one place that adds Urchin Tracking
Module (UTM) parameters to a link a user receives.

**The step-up flow.** A route behind `requireRecentAuth()` answers
`401 REAUTH_REQUIRED` once the session's `auth_time` is older than 10 minutes.
Every signed-in user, staff and customers alike, can then confirm it's them:

1. The client picks a method: a link (request, then verify from the mailed
   page) or a passkey (options, then verify). The link request names the app
   (`web` or `apex`) the page opens on; Apex is for staff only.
2. Both methods return a new access token and mint no session.
3. The waiting tab refreshes to pick up the new `auth_time` and retries the
   action once.

Google is not a step-up method. Google documents no account re-authentication,
so a Google round-trip cannot prove the person is present. The checks are in
[SECURITY.md](SECURITY.md#confirm-its-you).

**Required mode.** With `PASSKEY_MODE=required`, `requireAuth` ends with
`assertPasskeySetupDone`. An account with no passkey gets
`403 PASSKEY_SETUP_REQUIRED` outside `PASSKEY_SETUP_ALLOWED`
(`passkey.constants.ts`). The passkey count query runs only in that mode.

### Native clients

An iOS or Android app calls the same routes as the web app. It differs in one
thing: it holds its session in the response body, not in a cookie.
[SECURITY.md](SECURITY.md#native-clients) has the threat model.

**The branch.** `resolveClientKind` (`src/middlewares/native-client.middleware.ts`)
reads `X-Client` and sets `request.clientKind` to `web` or `native`. A native
request carrying `Origin` or any `Sec-Fetch-*` header gets
`400 NATIVE_CLIENT_REFUSED`. A handler never branches on the kind itself. It
goes through three helpers in `src/controllers/helpers.controller.ts`:

| Helper                       | A browser                                     | A native app                                                    |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `presentedRefreshToken`      | Reads the refresh cookie                      | Reads `refreshToken` from the body                              |
| `deliverRefreshToken`        | Sets the cookie, `Strict` unless told `'lax'` | Returns `refreshToken` and `refreshTokenExpiresAt` for the body |
| `clearPresentedRefreshToken` | Clears the cookie and its host-only form      | Does nothing                                                    |

`tests/unit/controllers/refresh-cookie-callers.test.ts` fails a controller that
calls the cookie functions directly. The Google callback is the one caller that
passes `'lax'`, and a native request to either Google route is refused.

**The session flow.**

1. A native sign-in calls `clientOf(request)`, which returns the kind and a
   device name read from `X-Device-Name`. `issueRefreshToken` stores both on the
   new `user_tokens` row.
2. A refresh passes only the kind to `rotateRefreshToken`. The row's
   `client` must equal it, or the call answers the unknown-token 401 before
   any transaction and kills no session.
3. Rotation copies `client` and `device_name` onto the new row, with the
   session id and start time.

**The columns.** Migration `0040` adds `user_tokens.client` (`web` or `native`;
a `CHECK` limits the values) and `user_tokens.device_name` (`varchar(64)`). It
backfills `web` on every existing refresh row. `user_tokens_shape_check` requires
a `client` on a refresh row and none on a link row.
[DATABASE.md](DATABASE.md#user_tokens) has the other columns.

**The sessions list.** `GET /auth/sessions` (`listLiveSessions`,
`src/services/session.service.ts`) answers the caller's live sessions, newest
use first, at most 100 (`MAX_LISTED_SESSIONS`), with no cursor. Each row has
`id`, `client`, `deviceName`, `createdAt`, `lastUsedAt` and `current`
(`src/presenters/session.presenter.ts`). Sessions past the 100th are not
listed. `POST /auth/sessions/revoke-others` ends all but the current one.

**Rate limits.** `refreshRateLimitKey` keys a native refresh by the hash of the
body token. `nativeRefreshIp` adds a per-IP ceiling for native requests only.
The numbers are in [SECURITY.md](SECURITY.md#rate-limits-behind-carrier-grade-nat).

**Settings the app reads.** `GET /status/client-settings` answers
`minimumAppVersion` as `{ ios, android }` from `MINIMUM_APP_VERSION_IOS` and
`MINIMUM_APP_VERSION_ANDROID`, each `null` when unset. It sends
`Cache-Control: public, max-age=300`. `WEBAUTHN_ANDROID_ORIGINS` adds the
Android app's origins to the passkey ceremony's expected origins
(`src/configs/passkey.config.ts`). `WEBAUTHN_IOS_ENABLED=true` makes boot refuse
a `WEBAUTHN_RP_ID` other than `WEB_URL`'s host, since iOS binds a passkey to
that host.

### Account deletion requests

A customer asks to delete their account at `POST /account/deletion-request`.
Staff complete it by hand. Both app stores require the first step to happen
inside the app. [SECURITY.md](SECURITY.md#account-deletion) has the rules.

| Piece                                  | Where                                                            | What it does                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST`/`GET /account/deletion-request` | `src/routes/account.routes.ts`, `account.controller.ts`          | Open a request (201) or return the open one (200); read the open one                                                                                                           |
| `requestAccountDeletion`               | `src/services/account-deletion.service.ts`                       | Locks the user row, inserts one open request, audits it, and after commit mails the receipt and alerts platform owners and admins                                              |
| `account_deletion_requests`            | `src/database/models/account-deletion-request.model.ts`          | One open row per user. `due_at` is the request time plus `ACCOUNT_DELETION_DAYS` times 24 hours                                                                                |
| `deleteUser`                           | `src/services/platform-user.service.ts`                          | Marks the open request completed in the delete's transaction, then mails "We deleted your account" after commit. Refuses with 409 while the requester pays a live subscription |
| `alertDueSoonDeletions`                | `src/services/account-deletion.service.ts`                       | Alerts owners and admins about open requests due within 5 days, overdue ones included                                                                                          |
| `due-soon-alert`                       | `src/jobs/account-deletion.job.ts`, `account-deletion.worker.ts` | The scheduler, daily at 04:00 UTC on the `account-deletion` queue, one job at a time                                                                                           |

- **The alert dedupes in Redis.** Each request is claimed under
  `redisKey('account-deletion-due-soon', requestId)` with a TTL that lasts
  until 30 days after `due_at`. A run that finds the key skips the request. So
  an overdue request is alerted again about every 30 days. A run that queues no
  alert releases the key, and the next run tries again.
- **Mail goes out after commit.** The receipt, the staff alert and the
  confirmation are queued once the transaction commits, and a queue failure is
  logged and skipped. The request or the delete is already recorded. No
  template here has a resend action, so staff cannot resend a confirmation
  that failed to queue.
- **The staff alert cannot be switched off,** and the requester is not a
  recipient. `account_deletion_requested` is in `NON_DISABLEABLE_EMAIL_TYPES`.
  It goes to platform owners and admins. A request with no one to alert is
  logged as a warning.
- **A paying requester answers 409.** When `deleteUser` would complete an
  open request and the user pays a live subscription (`isLiveSubscription`),
  it refuses with `REQUESTER_PAYS_SUBSCRIPTION`, naming the workspaces, before
  it writes anything. A co-owner takes over the payment method, or staff
  cancel the subscription, then staff retry. A delete with no open request
  clears the user as payer and leaves the subscription running.
- **The staff list arrives in part 2.** The alerts name a Deletion requests
  page in Apex. That page and its list API ship with part 2.

### Errors and the response envelope

Every response that `errorHandler` and the controllers write uses one
envelope, defined once in `src/utilities/response.utilities.ts`:

```json
{ "success": true, "message": "Success", "statusCode": 200, "data": {} }
{ "success": false, "message": "No route matches this method and path. Check both, then try again.", "statusCode": 404, "code": "not_found", "requestId": "…" }
{ "success": false, "message": "Your sign-in expired. Sign in again to continue.", "statusCode": 401, "code": "ACCESS_TOKEN_EXPIRED", "requestId": "…" }
```

The envelope's fields:

- **`code`** is one stable token a client branches on. Every 404 carries one,
  from `NOT_FOUND` (`src/errors/not-found-errors.ts`), and
  `tests/unit/errors/not-found-codes.test.ts` fails on a 404 thrown without
  it.
- **`errors`** is field-level validation detail, shaped by the validator. It is
  a separate field from `code`, so a client parsing `errors` never gets a
  different shape when `code` is present.
- **`data`** carries the payload. A success with no payload goes through
  `messageResponse`, which always sends `data: null`.
- **`errorId`** is on every 5xx `errorHandler` writes, except a maintenance
  refusal.

`/health`, `/health/ready` and the SSE stream-capacity 503 write their own
bodies.

A refusal a client can act on also carries `details`: structured facts next to
`code`.

- A plan limit's 402 `PLAN_LIMIT_REACHED` sends `{ key, used, limit }`.
- A plan feature's 402 `PLAN_FEATURE_REQUIRED` sends `{ key }`.
- A full workspace refusing an invitee's join sends no `details`, because the
  invitee is not a member.

`errorHandler` writes an `HttpError`'s `details` on a 4xx only, never on a 5xx.
A response without them has no `details` key.

The envelope is not RFC 9457 `problem+json` (Problem Details for HTTP APIs): switching would change what every
client parses on every response.

`errorHandler` (`src/middlewares/error.middleware.ts`) is the terminal
middleware. It takes four parameters because Express recognises an error
handler by its arity. It decides:

- **After the headers were sent**, nothing more can be written. It reports the
  error as a 500 (unless the client went away), logs it redacted with its
  `errorId`, and destroys the socket.
- **A maintenance refusal** gets its own body and `Retry-After`. It is
  unmasked and never logged.
- **The status** is, in order of preference: the `HttpError`'s status; a
  foreign error's 4xx `status` (the body parser's 400 or 413); 400 for text
  Postgres cannot store; else 500.
- **A 4xx** shows the `HttpError`'s message. It shows a foreign error's
  message only when that error marks it `expose`. A body-parser refusal
  answers its own copy and code (`malformed_json`, `payload_too_large`). A 4xx
  is not logged, except one value-free `warn` when Postgres refused a
  character in client text.
- **A 5xx** is masked with "Our server hit an error. Try again, and email {support address} with the error ID if it happens again.", where the address comes from `supportAddress`.
  The exception is an `HttpError` that sets `exposeMessage: true`, because its
  message is guidance written for the client (`billingBusy`,
  `providerFailure`, the payments-off and purge-check 502s). Either way, a 5xx
  gets an `errorId` and is logged redacted (`redactedForLog`,
  `src/errors/postgres-errors.ts`). A `PosthogUnavailableError` is not logged
  there, because its thrower already logged why. A 5xx is reported to error
  tracking only when the capture rule admits it
  ([Error tracking](#error-tracking)).

### List endpoints

Every endpoint that returns a table's rows answers one shape, built by one
helper, `listPage` (`src/utilities/list-page.utilities.ts`), from one
request schema, `listParamsSchema` (`src/validators/list.validators.ts`).

**The request.** A list takes these query parameters, plus its own filters:

| Parameter   | Meaning                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `search`    | 1–100 characters, trimmed, no NUL character. A literal, case-insensitive substring of the list's search columns. |
| `sort`      | One whitelisted key, with `-` first for descending.                                                              |
| `cursor`    | Opaque, from a previous page.                                                                                    |
| `direction` | `next` (the default), or `prev`, which needs a cursor.                                                           |
| `limit`     | 1–100 rows, default 20.                                                                                          |
| `total=1`   | Asks for a row count.                                                                                            |

An enum filter takes a comma list (`status=active,inactive`). The server
applies a filter's default, so a URL can omit it.

**The response.** The envelope's `data` is
`{ items, page: { nextCursor, prevCursor, hasNext, hasPrev, limit }, total? }`.
`total` appears only for `total=1`, as `{ count, capped }`. It is counted
exactly up to 1,000 rows, and reported as `{ count: 1000, capped: true }` past
them; a client then shows "1,000+". The query is
`select count(*) from (<the list> limit 1001)`.

| Endpoint                                          | `search`                                           | Filters                                                            | Sorts (default first)                         |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `GET /platform/tenants`                           | name, slug                                         | `state` (list; active, suspended)                                  | `name`, `created`, `-created`                 |
| `GET /platform/users`                             | email, first and last name, full name              | `status` (list; active, inactive), `verified`, `signedIn`, `staff` | `email`, `created`, `-created`, `-lastSignIn` |
| `GET /platform/emails`                            | recipient                                          | `status`, `template` (lists), `user`, `tenant`, `from`, `to`       | `-created`, `created`                         |
| `GET /platform/email-suppressions`                | address                                            | `state` (list; active)                                             | `-created`, `created`, `address`              |
| `GET /platform/onboarding/tenants`                | tenant name                                        | `state` (one; stuck)                                               | `progress` for stuck, else `-started`; `name` |
| `GET /platform/audit-log`                         | action, actor email, target email or name          | `tenant`, `actor`, `target`, `action`, `access` (lists)            | `-occurred`, `occurred`                       |
| `GET /tenants/:slug/audit-log`                    | action, actor email, the entry's own tenant's name | `action`, `access` (lists), `actor`                                | `-occurred`, `occurred`                       |
| `GET /platform/tenants/:id/billing/history`       | from state, to state, cause                        | `source` (list)                                                    | `-at`, `at`                                   |
| `GET /platform/tenants/:id/billing/events`        | type, error                                        | `status` (list; processed, unused, failed, pending)                | `-at`, `at` (received)                        |
| `GET /platform/tenants/:id/billing/subscriptions` | subscription id                                    | `provider`, `mode` (lists)                                         | `-firstSeen`, `firstSeen`                     |
| `GET /tenants/:slug/members`                      | email, full name                                   | `role` (list)                                                      | `name`, `email`, `role`, `-joined`            |
| `GET /tenants/:slug/invitations`                  | email                                              | `role` (list)                                                      | `-created`, `email`                           |
| `GET /tenants`                                    | name                                               | `role` (list)                                                      | `name`, `-joined`                             |
| `GET /notifications`                              | title, body                                        | `unread`                                                           | `-created`                                    |
| `GET /platform/flags`                             | key, description                                   | `kind`, `state` (lists)                                            | `key` (in memory)                             |
| `GET /platform/flags/unregistered`                | key                                                | none                                                               | `key` (in memory)                             |

`GET /platform/flags/meta` is not a list: it carries the traits reference and
the snapshot's age. The mark-read routes and the notification bell's `limit=5`
read do not use this contract.

**The seek.** A sort is a list of columns. The helper appends the row id, in
the first column's direction, as the tiebreaker. A page reads `limit + 1` rows
after the cursor's keys:

- one row comparison, `(a, id) > ($1, $2)`, when every column runs one way;
- the OR-expansion, `(a > $1) or (a = $1 and b < $2) or …`, when directions
  mix.

`prev` reverses every comparison and the order, then flips the page back.
Every sort column is NOT NULL, or coalesced the same way in the query and its
index. For example, `-lastSignIn` reads
`coalesce(last_logged_in_at, '-infinity')` through `lastSignInSort`, so
never-signed-in users come last.

A cursor whose row is gone is not a gap. When the rows after a cursor are gone
(deleted, or `prev` from the first row), the read answers the list's edge page
on that side. A page therefore never skips a row, and a client can always step
back. My-tenants ties break on `tenant_id`, so memberships created in the same
instant page in a stable order.

**The sort-and-index rule.** Each whitelisted sort has an index of exactly its
shape, filter prefix first: for example `(tenant_id, created_at, id)` for a
tenant's invitations, newest first.
`tests/integration/database/list-indexes.test.ts` runs `EXPLAIN` on the
helper's own query for every sort, and fails when the node under its `Limit`
is a Sort. The sorts of three lists (members, my tenants and onboarding) are
bounded instead, and the test says so:

- member `name` and `email`, and my-tenants `name`, order a joined row. They
  sort one tenant's members or one user's memberships, found through an index
  led by that tenant or user.
- onboarding orders the progress query's computed timestamps. It sorts the
  tracked tenants, read through an index.

Searches are covered in three ways:

- The tenants, users, emails and suppressions searches run on GIN
  (Generalized Inverted Index) trigram indexes (`pg_trgm`) of the same lowered
  expressions.
- The members, invitations, my-tenants, notifications and staff billing
  history, events and subscriptions searches are bounded by their tenant or
  user instead.
- The platform audit-log search has no index. It scans by `occurred_at` across
  the log, and so does its `total=1` count; this cost is accepted.

Migrations `0026_list_indexes.sql` and `0027_users_full_name_trgm.sql` build
the indexes. Their locking and the manual live-database path are in
[DATABASE.md](DATABASE.md).

**Cursors.** A cursor is base64url JSON `{ v, sort, keys, scope }`, a dot, and
a hash-based message authentication code (HMAC-SHA256) under `CURSOR_SECRET`
(`src/utilities/list-cursor.utilities.ts`). `scope` hashes the effective
search, filters (defaults applied, comma lists sorted) and sort, so a cursor
resumes only the view it came from.

A list whose rows depend on more than the query string sets `bound` on its
definition (`ListDefinition.bound`, `InMemoryListDefinition.bound`). Every list
also has a required `name`, unique among lists. `bindScope` folds the name and
the bound values into the scope:

- a tenant's members, invitations and audit log bind the tenant;
- my tenants and notifications bind the user.

A cursor from another tenant, user or list, even one with the same sort and
filters, is therefore refused as `CURSOR_INVALID`, never read as a seek. Every
other bad cursor gets the one `400` `InvalidCursorError` (`code: 'CURSOR_INVALID'`,
`errors.cursor: ['This list link is out of date. Reload the list from its first page.']`):

- empty, or over 4,096 characters;
- a bad signature;
- another version, sort or scope;
- keys of the wrong count or type.

A client drops the cursor and reloads the first page.
[SECURITY.md](SECURITY.md#input-and-output) has the threat.

**Audit lists.** The read kind is required: `scope: 'tenant' | 'platform'`
selects the joins and the search columns. A tenant read confines search to the
tenant: it matches no user-target email, and the only target it joins is the
entry's own tenant. `AUDIT_ACTIONS` is what a build may write. The API does
not write the actions in `RETIRED_AUDIT_ACTIONS`
(`src/constants/audit.constants.ts`), but their stored rows stay. The lists
therefore show them, and the `action` filter accepts them
(`STORED_AUDIT_ACTION_NAMES`).

**Flags.** `listPageInMemory` gives the same contract over an array already
searched and filtered. Two lists use it: the flags registry, and the flags
PostHog has that the registry lacks. Both lists are split from
`GET /platform/flags/meta`. A flag key longer than `LISTED_FLAG_KEY_MAX` (400
characters) cannot round-trip through a cursor. `listableUnregisteredFlags`
leaves such a key out of the lists and logs one warning per snapshot. The
system-status count uses the same function, so it agrees with the list. The
key still evaluates.

**Notifications.** `GET /notifications` uses the shared list contract. The SSE
`Last-Event-ID` replay is not a page: it reads the newest `SSE_REPLAY_LIMIT`
notifications through `listRecent` (see [Realtime (SSE)](#realtime-sse)).

**Adding a list.**

1. In the repository, export a `defineList({ name, base, id, sorts, toItem })`
   with a unique `name`, plus `bound` when the rows depend on a path tenant or
   the caller. A method calls `listPage(executor, definition, params)`.
   - `base(executor, seek)` selects the item's columns plus one text or number
     column per sort column (`timestampKey(…)` for a timestamp). It ANDs every
     filter, `searchCondition(search, [lowered expressions])` and `seek` into
     one `where`, and ends in `.$dynamic()`.
   - `toItem` drops the sort columns.
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
caller-supplied `X-Request-Id` only when it is a universally unique identifier
(UUID), because reflecting an arbitrary header is how log injection starts.
Otherwise it generates one.

`requestContext` then opens an `AsyncLocalStorage` store
(`src/services/request-context.service.ts`) for the request, and
`resolveTenant` adds the tenant to it. The logger's pino `mixin` reads that
store on every call. Each line logged during a request therefore carries:

- `requestId`;
- `tenantId`, once the tenant is resolved;
- `traceId` and `spanId`, while a span is active.

Callers never pass these fields. `mixinMergeStrategy` (`logger.service.ts`)
makes the mixin's fields win over a caller's field of the same name, so log
meta cannot spoof them.

### A second frontend: Apex

`APEX_URL` (optional) names the Apex staff dashboard. Links and redirects pick
a frontend with `frontendUrl(app)` (`src/services/frontend-links.service.ts`).
`app` is `'web'` or `'apex'`, never a URL. The function returns `APEX_URL` for
`'apex'` when that is set, and `WEB_URL` otherwise.

- Invitations to the platform tenant link to Apex. Every other invitation
  links to `WEB_URL` (`tenant-invitation.service.ts`).
- `POST /auth/link/request` takes `app`, which picks the frontend its link
  opens. The link's row keeps it, and verify reads it from the row, never from
  the request.
- A staff-sent sign-in link takes no `app`. The server links a staff target to
  Apex and anyone else to `WEB_URL` (`platform-user.service.ts`). A user that
  staff create gets a `welcome` mail whose sign-in link opens `WEB_URL`.
- `GET /auth/google?app=apex` stores the choice in the OAuth session, with a
  same-origin `redirect` when one is valid (`rememberOAuthApp`). The callback
  redirects to that frontend's `/auth/callback`, carrying the `redirect`, and
  `new=1` for a new account (`oauthIntentOf`,
  `src/controllers/helpers.controller.ts`). On Apex, Google signs in only an
  existing staff account and never creates one.

`isAllowedOrigin` (`src/utilities/origin.utilities.ts`) always grants
`WEB_URL`, `APEX_URL` and `CORS_ALLOWED_ORIGINS`, so an Apex served at
`APEX_URL` needs no CORS entry. Google calls back to `APP_URL` only. With
Google sign-in on and an Apex host other than `APP_URL`'s, `COOKIE_DOMAIN` must
therefore cover both hosts, and boot refuses otherwise.

### Email tracking

Every outbound email is one `email_messages` row. The row is created when the
mail is queued, in the caller's transaction when it has one. For a job that
reaches the email worker without a row, the worker creates it. The row holds:

- the recipient and the template;
- the user, tenant and invitation the mail is about;
- the frontend its link opens (`link_app`);
- the sender class and its `Message-ID`;
- the template's `previewVariables`.

It never holds a rendered body, a link or a token. Each send attempt is an
append-only `email_logs` row, and each provider event an `email_events` row. A
status only moves to a higher rank (`EMAIL_STATUS_RANK`,
`src/constants/email.constants.ts`), so the worker's `sent` never overwrites a
fast `delivered` event. `opened` and `clicked` never change the status.

A write that must commit the message row with its own writes creates the row in
its transaction (`createTrackedEmail`), and enqueues after commit
(`enqueueTrackedEmail`). The worker therefore never dequeues a job whose row it
cannot see. Provider webhooks (`src/services/email-webhook.service.ts`) apply
every event of a request in one transaction. Each event is matched by
`Message-ID` and stored once per provider event id. A hard bounce or complaint
suppresses the address.

The sender follows the template's sender class and nothing else
(`src/utilities/email-sender.utilities.ts`):

- a template whose links carry a token goes from `MAIL_FROM_TRANSACTIONAL`, or
  from `MAIL_FROM` while that is unset;
- every other template goes from `MAIL_FROM`.

Outside `local`, boot warns when both senders share a domain; why is in
[SECURITY.md](SECURITY.md#mail-at-rest). The operator guide (the webhook of Resend, the
email provider, suppressions, preview and resend, and `pnpm email:fire-event`) is
[Email tracking in README.md](README.md#email-tracking). Keep
`MAIL_FROM_TRANSACTIONAL` on its own domain with click tracking off; the steps
are under "Two senders" in [README.md](README.md#email-tracking).

## Background work: queues, schedulers, the outbox, retention

This section covers the work that runs outside a request: the BullMQ queues
and their Workers, the repeating schedules, the analytics outbox and the daily
retention purge.

### Queues and Workers

Seven BullMQ queues share the prefix `redisKey('bull')`:

- `getAllQueues()` returns every queue, and is what the staff status lists.
  `tests/integration/services/queue-registry.test.ts` fails when a queue is
  missing from it.
- `getPausableQueues()` is that list without `auth-email`, and is what full
  maintenance pauses.
- `emailQueueFor` (`src/jobs/email.job.ts`) picks an email's queue from its
  template, so no caller chooses it.

| Queue              | Carries                                                                                                                                                                                                                                                                                                        | Worker concurrency   | Job options                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`            | One tracked email per job (`addEmailJob`)                                                                                                                                                                                                                                                                      | `WORKER_CONCURRENCY` | 5 attempts, backoff from 5 s                                                                                                                                |
| `auth-email`       | The same, for `sign_in_link`, `step_up_link`, `welcome`, `tenant_invitation`, `invitation_confirm`, `passkey_created` and `passkey_deleted`; never paused                                                                                                                                                      | `WORKER_CONCURRENCY` | 5 attempts, backoff from 5 s                                                                                                                                |
| `notification`     | An in-app row and its optional email (`addNotificationJob`)                                                                                                                                                                                                                                                    | `WORKER_CONCURRENCY` | 3 attempts, backoff from 2 s                                                                                                                                |
| `maintenance`      | The retention purge                                                                                                                                                                                                                                                                                            | 1                    | 3 attempts, backoff from 60 s                                                                                                                               |
| `analytics`        | The outbox drain, the PostHog deletion tick and the flag definitions fetch                                                                                                                                                                                                                                     | 1                    | 1 attempt (the next tick is the retry); the last 100 failures kept                                                                                          |
| `billing`          | One job per Razorpay webhook event, which syncs the workspace that holds its subscription, a sync of one workspace, the prompt cancel after a suspend or archive, a workspace's `tax-reconcile` run (priority 10, so webhooks and syncs go first), and the frequent and daily runs (`src/jobs/billing.job.ts`) | 2                    | 31 attempts, backoff from 30 s doubling to 1 h: about 24 h for a provider outage; the eighth other failure stops it; failures kept 7 days; a run: 1 attempt |
| `account-deletion` | The daily due-soon alert for open account deletion requests (`src/jobs/account-deletion.job.ts`)                                                                                                                                                                                                               | 1                    | 3 attempts, backoff from 60 s                                                                                                                               |

Every Worker's `failed` handler first calls `reportFinalJobFailure`. It
reports to error tracking the attempt BullMQ will not retry
(`attemptsMade >= attempts`, or an `UnrecoverableError`). What happens next
depends on the Worker:

- **Email, auth-email, notification, maintenance, billing and account-deletion.** The handler
  logs a retryable attempt at `warn`. On the final attempt,
  `recordPermanentFailure` (`src/jobs/job-failure.job.ts`) scrubs the stored
  payload, marks an email's message `failed`, and logs `job failed permanently`
  once.
- **Billing, in addition.** A webhook job's final failure also marks its
  `billing_events` row failed and raises one `webhook_failing` staff alert per
  event. A `tax-reconcile` job's final failure raises one `tax_issue_failed`
  alert per workspace and India Standard Time (IST) day. A provider refusal
  that a retry cannot change fails a job at once. The billing Worker counts a
  job's provider-outage failures and its other failures apart, in the job's
  data (`outageFailures`, `otherFailures`):
  - the eighth outage failure, about an hour in, raises one "still retrying"
    staff alert, and the job keeps retrying;
  - the eighth other failure stops the job, however many outage attempts came
    before.
- **Analytics.** The handler only logs a `warn`: a failed tick loses nothing.

No handler rejects, because an unhandled rejection exits the process. What a
job payload may hold, and for how long, is in
[SECURITY.md](SECURITY.md#mail-at-rest).

`startWorkers()` starts the email, auth-email, notification, maintenance,
billing and account-deletion Workers. It starts the analytics Worker when analytics or PostHog's
private API is configured. `WORKER_ENABLED` (default `true`) runs the Workers
in the API process. To split them, set it to `false` on API-only pods and
`true` on a worker deployment that shares the Redis queues. The schedules
below then run only on the worker deployment.

### Schedulers

Each Worker generation upserts its schedules. These are BullMQ job schedulers,
stored in Redis under the prefix, so every replica shares one schedule and each
tick runs on one Worker:

| Scheduler             | Queue              | When                                | Registered when                         |
| --------------------- | ------------------ | ----------------------------------- | --------------------------------------- |
| `retention-purge`     | `maintenance`      | daily at 03:00 UTC                  | always                                  |
| `scheduler-frequent`  | `billing`          | every 15 min                        | always                                  |
| `scheduler-daily`     | `billing`          | daily at 03:30 UTC                  | always                                  |
| `due-soon-alert`      | `account-deletion` | daily at 04:00 UTC                  | always                                  |
| `analytics-drain`     | `analytics`        | every `ANALYTICS_DRAIN_INTERVAL_MS` | `POSTHOG_PROJECT_KEY` is set            |
| `analytics-deletions` | `analytics`        | every 60 s                          | the personal key and project id are set |
| `flag-definitions`    | `analytics`        | every 30 s                          | flags are configured                    |

Times in the table are in Coordinated Universal Time (UTC).

A failed registration logs a `warn`, and the next generation retries it. A new
generation starts only when the Worker connection gives up before its first
`ready`. A registration that fails while the Workers stay healthy therefore
waits for the next restart; a scheduler stored earlier keeps running
meanwhile.

The billing runs (`src/services/billing/billing-scheduler.service.ts`) are
lists of independent named steps. A step that fails is logged, and the rest
still run.

**`scheduler-frequent`** runs these steps:

- it moves lapsed trials to Free;
- it syncs workspaces whose grace, cancelling period (plus the 3-day buffer)
  or interval switch is due;
- it cancels the subscriptions of suspended workspaces (at cycle end) and
  archived workspaces (now);
- it lapses grants and upgrade requests;
- it sends the trial reminders:
  - 3 days before the end, except for a trial of 3 days or less;
  - on the last day, in the workspace's time zone;
  - halfway through a trial longer than 6 days.

A reminder re-reads its row before it sends. A workspace that left the trial
or Free, or was suspended, since the claim gets nothing. `scheduler-frequent`
runs with payments off too, and then skips the provider steps.

**`scheduler-daily`** is the reconcile. It queues a `sync-tenant` job for:

- every row that holds a subscription. It skips and counts rows of another
  provider or mode, and Free rows whose only subscription has ended. It does
  sync a Free row whose current subscription a failed cancel left running
  (a staff alert names it), so the cancel is tried again;
- each running subscription of the last 3 days whose notes name a workspace
  whose row does not hold it;
- each workspace whose webhook event failed in the last 3 days.

With Goods and Services Tax (GST) registration on, two more steps queue
`tax-reconcile` jobs:

- `tax_refunds` queues one hinted job per workspace with a processed refund,
  in the last 3 days, of an invoiced or held payment.
- `tax_backfill` queues one job for every customer workspace that tracks a
  subscription, once per `BILLING_GST_EFFECTIVE_FROM` value. It queues first,
  then sets a marker under `redisKey('billing-tax-backfill', date)`. A step
  that fails part way therefore leaves no marker, and the next run queues
  again, which issues nothing twice. The step exists so that a workspace whose
  subscriptions all ended before registration, which no sync reaches, is still
  invoiced.

`scheduler-daily` also sends two kinds of mail:

- the yearly renewal reminder, a week before the period ends. It never goes
  for a stand-in period end: one no later than the row's last sync, which an
  adoption of an unpaid cycle stores.
- the win-back emails, on days 7 and 30 after a trial or paid plan fell to
  Free.

A reminder is claimed in its `tenant_billing` column before it is sent, and a
suspended or archived workspace is never claimed.

**Overlapping runs.** Two overlapping runs act once: each step claims its
rows, re-checks them under the row lock, or leaves them to the sync's
versioned write. A run occupies one of the billing Worker's 2 slots while it
lasts, so webhook and sync jobs share the other slot. The daily run only
queues jobs and ends quickly.

**The lifecycle cancel** claims a suspended or archived workspace's row once.
It cancels every subscription id the row holds, whatever the row's state:

- the current subscription at its cycle end, for a suspended workspace that
  pays; otherwise now;
- a checkout and a switch, now.

A sync first brings in a checkout or switch that reads as paid. A paid
checkout is therefore adopted (and cancelled as the current subscription) or
refunded as a duplicate, never discarded. After that sync, the cancel reads
the lifecycle state again; a reactivated workspace is skipped and released.
The cancel then holds the claim again, because the sync released it when it
adopted the checkout. When another job took the claim first, that job cancels
and this one does nothing, so no cancel goes out twice.

A sync can have an archived workspace adopt a paid checkout or a found
subscription, when the workspace had no running one or the checkout would be
refunded as a duplicate. The sync then cancels that subscription now and
refunds it: nothing an archived workspace can use was bought. One staff alert
follows, raised once the refund's outcome is known and worded for it:
refunded, nothing paid, refunded in part, or a cancel or refund that failed
and what staff do at the provider.

The claim is released:

- when the workspace is reactivated;
- when a sync gives a suspended or archived workspace a new current
  subscription (an adoption or a handover) or an id it did not hold; this also
  queues the prompt cancel;
- once a day, for a cancel that failed and alerted staff more than a day ago.

A suspend followed by an archive replaces the suspension's cycle-end cancel
with an immediate one. The claim taken before the archive is released, because
the archive stamps `deleted_at` with its statement's time. A claim taken after
that statement, but before the archive commits, keeps the cycle-end cancel.

Each suspend and archive also queues a `lifecycle-cancel` job after its
commit. The job runs the same step for that workspace alone
(`runLifecycleCancelFor`), through the same claim. The cancel therefore goes
out at once, and the frequent run is only the fallback.

**Reactivation** sends the warnings the suspension held back
(`sendHeldBackWarnings`):

- a payment that stopped;
- a Paid plan that ends at the cycle end, from an owner's cancel or the
  suspension's own, which the provider can't undo.

Each warning goes under the stamp it had, so none goes twice. The stamps live
in the email and notification rows, which the retention purge deletes. A
suspension longer than their retention can therefore send a warning again on
reactivation.

**A tenant purge** reads every subscription id the row holds, whatever its
state. The purge is refused:

- with 409, while the provider shows any of them as running;
- with 502, when the provider doesn't know one (keys of another account);
- with 503 or 502, when the provider can't be read;
- with 502, with payments off or for a row of another provider or mode, while
  the row holds any subscription id. A halted subscription on a Free row can
  resume at the provider.

A row with no subscription id purges, and the billing row then goes with the
tenant.

The analytics Worker runs one job at a time, so this process never has two of
its jobs talking to PostHog at once. Two replicas may; the drain and the
deletion tick each lease their rows.

### The outbox

Server analytics events reach PostHog through a transactional outbox
(`analytics_outbox`), never from a request. A row is written in one of two
ways:

- in the same transaction as the change it describes, inside a savepoint;
- for a product event, on the pool right after commit.

A failed insert is logged at `warn` and never fails the user's action
(`src/services/analytics/analytics-outbox.service.ts`). The drain leases a
batch in one autocommit statement, so it holds no pool connection while it
calls PostHog. The full pipeline is under [Analytics](#analytics).

### Retention

The daily `retention-purge` job (`runRetentionPurge`,
`src/services/retention.service.ts`) runs one rule per table, in this order:

1. `user_tokens`
2. `tenant_invitations`
3. `email_events`
4. `email_logs`
5. `email_messages`
6. read notifications
7. unread notifications
8. `audit_logs`
9. `analytics_outbox`

Each rule's window is its `RETENTION_*_DAYS` (or
`ANALYTICS_OUTBOX_RETENTION_DAYS`) variable, and 0 turns the rule off.

- A rule deletes in batches of 5000 rows by primary key, each batch in its own
  short transaction, until a batch comes back short. A batch skips locked
  rows, which the next run deletes.
- A failing rule is logged, and the others still run. The job then throws,
  naming each failed table, so BullMQ retries it. Every rule is idempotent.
- The 3 email tables share `RETENTION_EMAIL_LOGS_DAYS` and are dated by the
  message's `created_at`. The rule deletes events, then attempts, then the
  messages left with neither, so no batch cascades. Suppressions never
  expire.
- The audit rule is off by default (`RETENTION_AUDIT_LOGS_DAYS=0`). Its batch
  sets `app.audit_purge` and `app.audit_purge_before` transaction-locally,
  which is the only way past the append-only trigger
  ([SECURITY.md](SECURITY.md#the-audit-log)).
- An outbox row still there after `ANALYTICS_OUTBOX_RETENTION_DAYS` has never
  been delivered, so that rule logs what it drops at `warn`.

## Realtime (SSE)

This section covers the Server-Sent Events (SSE) stream that pushes a signed-in
user's notifications, and billing changes, to their open apps.

`GET /api/v1/notifications/stream`
(`src/controllers/notification-stream.controller.ts`) pushes a user's
notifications live, behind `requireAuth`.

```
notification Worker ── insert notifications row ── emitNotification
   └─ PUBLISH redisKey('notifications')   (on failure: deliver to this process only)
every replica with an open stream: one subscriber ── local emitter ── each stream of that user
```

- **Opening.** Every refusal is thrown before `writeHead`, so `errorHandler`
  answers it with the JSON envelope:
  - 503 while shutting down;
  - 429 `too_many_streams` over `SSE_MAX_STREAMS_PER_USER`;
  - 401 with code `ACCESS_TOKEN_EXPIRED` for a token without a session id. The
    heartbeat closes streams by session id, so a stream without one would
    outlive a logout.

  At `SSE_MAX_STREAMS_TOTAL` for the process, the stream writes 503
  `stream_capacity` with `Retry-After: 30` itself, because `errorHandler`
  would mask a 503 and log it as a fault. The stream sends
  `X-Accel-Buffering: no` (nginx buffers proxied responses otherwise) and
  `retry: 3000`.

- **Replay.** On reconnect, the client sends `Last-Event-ID`, and the stream
  replays what it missed, at most the 100 newest. The live listener is
  registered before the replay query. Notifications arriving during the replay
  are queued and written after it, skipping ids the replay sent, so nothing
  falls between the two.
- **Upkeep.** Every `SSE_HEARTBEAT_INTERVAL_MS`, the stream checks its session
  against the denylist, closes when the session is denied, and writes `:ping`.
  The stream ends at the access token's expiry, so the client reconnects and
  `requireAuth` runs again. A client with more than 1 MiB unread is destroyed.
- **Fanout.** Live delivery crosses replicas over Redis pub/sub on one channel
  (`src/services/notification-emitter.service.ts`).
  - Each process opens its own subscriber client on its first stream, so a
    publish-only pod never opens one. It uses `createRedisClient()`, not
    `duplicate()`, which would copy the shared client's reconnect state.
  - Delivery is best effort, not durable. The database row and
    `Last-Event-ID` are the durable path, which is why this is pub/sub and not
    Redis Streams.
  - When the subscriber reconnects, or starts late while streams are open,
    every open stream is closed, so its client replays the gap.
  - A publish that fails is delivered locally instead. A publish whose reply
    is lost may arrive twice.
- **Entitlements.** The same channel carries a second message kind,
  `{ kind: 'entitlements_changed', userId, tenantId, slug }`. It is published
  once per member of a workspace whose plan, billing state or grants changed
  (`publishEntitlementsChanged`, `src/services/billing/billing-events.service.ts`).
  The stream writes it as `event: entitlements_changed` with
  `{ tenantId, slug }` and no `id:` line, so `Last-Event-ID` stays a
  notification id. Nothing replays it, because the client reads fresh
  entitlements on its next load.
- **Shutdown.** The stream registry (`src/services/lifecycle.service.ts`)
  lets `gracefulShutdown` end every stream first.

## Analytics, flags and error tracking

This section covers analytics, billing events, error tracking, feature flags
and observability. Analytics (billing events included), error tracking and
flags run on PostHog, the product analytics service. All three are off until
configured (`src/configs/analytics.config.ts`):

| Feature                                   | Needs                                               |
| ----------------------------------------- | --------------------------------------------------- |
| Analytics                                 | `POSTHOG_PROJECT_KEY`                               |
| The person deletion and `pnpm flags:sync` | `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` |
| Error tracking                            | The project key and `ERROR_TRACKING_ENABLED`        |
| Flags                                     | `POSTHOG_FEATURE_FLAGS_KEY` and the project key     |

What each sends, and what it never does, is in
[SECURITY.md](SECURITY.md#analytics-and-error-tracking-privacy). The operator
steps are in [Analytics (PostHog) in README.md](README.md#analytics-posthog).

### Analytics

Three paths reach PostHog, and no others:

- **PostHog's private API** (`/api/projects/…`). The person deletions and
  `pnpm flags:sync` are its only callers; no request handler calls it.
- **Server events**, only through the outbox drain and the error reporter,
  both through `sendBatch` (`posthog-batch.service.ts`).
- **Browser events**, only through the `/api/v1/collect` proxy.

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
  `enqueueAuditAnalytics`. Events come from three sources:
  - the audit hook, which covers every audited action;
  - domain-event subscribers (`analytics-forwarder.service.ts`), for product
    events;
  - the webhook transaction, for email events.

  The event builder (`analytics-event-builder.service.ts`) holds every
  personally identifiable information (PII) rule. `enqueueAnalyticsOrThrow` is
  for a caller that handles the failure itself: the groups backfill, flag
  exposure, and the throttled billing events, which release their throttle key
  when the write fails. Passkey events:
  - a passkey sign-in emits the same `user_signed_in` event as a link, with
    `method: 'passkey'`;
  - creating and deleting a passkey send `passkey_created` and
    `passkey_deleted` (`AUDIT_EVENT_RENAMES`), with the provider name and never
    a credential ID;
  - a claim that clears passkeys sends `passkeys_cleared_on_claim` with the
    count.

- **The drain** (`analytics-drain.service.ts`) deletes an acknowledged row.
  - A retryable answer keeps every row under its lease, with a backoff of
    `least(2^attempts × 5 s, 600 s)`, and ends the drain. Retryable answers are
    no answer, 429, 5xx, or an endpoint-level 401, 403, 404, 405, 407 or 408.
    An outage therefore costs one timeout per tick. A wrong key or host drops
    nothing and logs one `error` per tick.
  - A rejected batch is split in halves until the refused row is alone. A row
    refused alone 3 times is dropped.
  - When a batch and both its halves are rejected, the first row of each half
    is sent alone. If PostHog refuses both, it is refusing everything, so no
    row is counted and the drain logs one `error`.
  - During an outage of any length, only the retention rule removes rows.
- **At least once.** A row is deleted only after PostHog acknowledged it. A
  crash between the two resends the row with the same `uuid` (the row id).
  PostHog deduplicates on `uuid` eventually, without a guarantee, so a
  consumer that needs exactness dedupes by `uuid`.
- **Signing and GeoIP.** `toPosthogBatchEvent` adds `server_sig` to every event
  it sends ([SECURITY.md](SECURITY.md#server-events)). It also adds
  `$geoip_disable: true`, which turns off PostHog's IP-address location lookup,
  because server events reach PostHog from the data centre's address.
- **Groups.** A tenant's name, status and creation date reach PostHog only as
  `$groupidentify` properties. The outbox stores a marker (`$group_type`,
  `$group_key`), never the name. The drain fills in `$group_set` from the
  tenant row when it sends the batch (`resolveGroupMarkers`,
  `analytics-group-marker.service.ts`).
  - A process drains one batch at a time. On one Worker, whichever marker
    reaches PostHog last carries the latest committed state.
  - Two Worker replicas whose drains overlap can deliver an older marker after
    a newer one. The next marker for that tenant corrects it.
  - `pnpm analytics:backfill-groups` queues one marker per tenant.

  A tenant with a billing row also gets its plan properties:
  - `plan` and `billing_state`;
  - `billing_interval`, while paying;
  - `trial_start_date` and `trial_end_date`;
  - `trial_plan_name`: the plan a trial gives, once it had one;
  - `limit_hits_30d`;
  - `open_upgrade_requests`;
  - `paid_since`: the latest move to `active` from a state that does not pay.

  `limit_hits_30d` counts the plan refusals of 30 days: every
  `plan_limit_reached`, and every feature refusal, including those the hourly
  throttle kept from sending `plan_feature_blocked`. It comes from a Redis
  sorted set per tenant (`plan-limit-hits.service.ts`), because the outbox
  drops a row once it is sent. When Redis cannot answer, the key is left out
  rather than sent as 0. Every billing event queues its tenant's marker, so the
  properties follow each change.

- **Purges and what stays in PostHog.**
  1. `purgeUser`, in its own transaction, writes an `analytics_deletions` row
     due an hour later, and deletes the user's undelivered outbox rows. The
     hour is there because PostHog deletes only events it ingested before the
     request.
  2. The `analytics-deletions` tick deletes the claimed ids' outbox rows again,
     so an event committed after the purge cannot recreate the person.
  3. The tick then asks `persons/bulk_delete/` to delete each person with
     their events and recordings.

  Any answer but a 2xx with an empty `deletion_errors` keeps the rows, with a
  backoff of `least(2^attempts, 360)` minutes. The failure is logged at
  `warn`. It is logged at `error` instead when PostHog refused the key or
  project (a 401, 403 or 404 answer), or when a row is a day old.

  PostHog cannot delete a group. `purgeTenant` therefore queues a marker that
  the drain sends with the group's name cleared and its status `purged`. The
  tenant's events stay in PostHog, under its id.

- **The proxy** (`src/routes/analytics-proxy.routes.ts`) streams bodies
  untouched:
  - `/static/*` and `/array/<POSTHOG_PROJECT_KEY>/*` go to the assets host;
  - everything else goes to the ingest host;
  - another project's `/array/*`, and a path that could climb out of its
    prefix, answer the unknown-route 404;
  - without `POSTHOG_PROJECT_KEY`, it answers 503.

  It sits ahead of the body parsers. It has no `on.error` handler, because one
  would make http-proxy-middleware skip its own error response.

### Billing events

The billing events are product domain events
(`src/services/billing/billing-analytics.service.ts`). They are emitted after
the change commits, or after a refused write rolls back, and never inside a
transaction. Every one joins its tenant's group and carries `plan` and
`billing_state` as they are after the change.

**Who an event names.** A change made by the provider, a job or the reconcile
is sent as the person it is attributed to, with `access: 'system'`. That person
is the owner who started the checkout, the payer, or the user whose trial it
is, skipping a soft-deleted account. Only when nobody is left is it a system
event.

- A trial's events fall back to the payer, then the checkout's starter, when
  no one claimed the trial: for example, a trial staff gave to a workspace
  that paid before.
- The owner who started the checkout is `checkoutStartedBy`: the last owner
  who opened it. Say one owner opens a checkout, another reopens it, and the
  first pays and confirms. `checkout_confirmed` and `subscription_activated`
  then name the second owner, while the payer on record is the first.
- Storing a new checkout clears the payer and the billing address. When the new
  subscription becomes current with no payer on record, the sync sets the
  owner who started the checkout as payer, and clears the billing address too,
  because it was the earlier payer's. A payer the confirm recorded is never
  replaced, so an earlier payer is never named for the new subscription.
- Deleting or purging an account clears it as payer, with its billing address,
  wherever it paid. The subscription keeps running.
- A payer demoted from owner stays the payer, because the mandate is theirs,
  and no one is told they left.
- Staff are never named. A staff member's own action in a customer tenant
  sends no product event, because its audit entry is forwarded already. A
  staff-made change goes to the person the rules name.
- An invitee refused at the door is not a member, so that refusal is a system
  event with no use or cap.

The property `reason` is on the PII drop list. A downgrade therefore sends
`downgrade_cause`, and a failed payment sends `failure_code`.

**Deduplication.** Some events are fixed by a stamp: the row version a change
wrote, a subscription, a dispute, or a trial's end. Such an event gets:

- a row id derived from that stamp (`dedupedRowId`);
- a time taken from the same data, never the clock: the write's `updatedAt`,
  the subscription's first cycle, or a fixed lead before the trial's end.

A repeat before or after the drain is therefore the same `uuid`, timestamp,
event and `distinct_id`, which PostHog deduplicates. A refusal has no stamp
and no repeat path; its time is when it happened.

`plan_feature_blocked` and `plan_limit_approaching` are written with
`enqueueAnalyticsOrThrow` after their hourly throttle key is claimed. The key
is released when the write fails, so a failure never silences them for the
hour.

**The cancel marker.** An owner's cancel writes a marker on the billing row
before it calls the provider (`cancel_marker_*`,
`src/services/billing/cancel-marker.service.ts`), whether or not analytics is
on. A cancel whose webhook arrives first therefore still reads `by: owner`.
Its move to Free reads cause `cancelled` in the mail and in analytics alike,
for a past-due subscription too.

- The marker counts for 15 minutes, and only while it names the current
  subscription.
- The cancel's own write clears it, and so does a cancel that fails.
- A suspended or archived workspace's cancel reads `by: suspension`, whatever
  the marker says.
- A staff cancel sets the same marker, which reads `by: staff`; the
  suspension rule overrides it too. Only the staff cancel's own write reads
  `by: staff` on a suspended workspace.

A sync that an owner's or a staff member's request runs only brings in what
the provider did, so it reads the provider's cause. For example, a
subscription already cancelled at the provider when an owner asks to cancel
reads `by: customer_bank`.

**Three readings of billing state.** Three readings of a workspace's billing
feed analytics, and they can briefly disagree:

- group properties and diff events use the stored state;
- flag traits use the state read with the clock, so a trial that ended reads
  `free` before the job moves it;
- refusals use the effective entitlements the request was refused on.

The events:

| Event                                                                 | Sent from                                                                                                                                                                                                                                             | `distinct_id`                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `trial_started`                                                       | `createTenant`, and the join that starts a staff-made tenant's trial                                                                                                                                                                                  | the creator, or the owner who joined                                                               |
| `trial_reminder_sent { days_left }`                                   | the three-day, last-day and midpoint trial reminders, once sent                                                                                                                                                                                       | the trial's user, else the payer, else the checkout's starter, else system                         |
| `trial_extended { days }`                                             | `extendTrial` (staff), once per extension                                                                                                                                                                                                             | the trial's user, else the payer, else the checkout's starter, else system; never the staff member |
| `trial_ended`                                                         | `emitBillingDiff`: a trialing row moves to Free                                                                                                                                                                                                       | the trial's user, else the payer, else the checkout's starter, else system                         |
| `plan_limit_approaching { key, used, limit }`                         | an invite or an expired invitation's resend whose seat moves the limit into its "approaching" band (`limitUsage`, as the app shows it), from the use read under the seat lock; once per tenant, key and hour                                          | the member who wrote                                                                               |
| `plan_limit_reached { key, used, limit }`                             | an invite or resend the members limit refused, after its rollback; a refused join sends `{ key }` only                                                                                                                                                | the inviter; system for a refused join                                                             |
| `plan_feature_blocked { key }`                                        | `requireFeature`; once per tenant, key and hour                                                                                                                                                                                                       | the member refused                                                                                 |
| `upgrade_requested { key, surface }`                                  | `requestUpgrade`, after the request opens, and again when a lapsed one reopens                                                                                                                                                                        | the member who asked                                                                               |
| `upgrade_request_fulfilled`                                           | `emitBillingDiff`, for each request a move to Paid fulfilled                                                                                                                                                                                          | the requester                                                                                      |
| `checkout_started { interval, amount_minor, currency, during_trial }` | `startCheckout`, for an upgrade (not an interval switch or a card change)                                                                                                                                                                             | the owner                                                                                          |
| `checkout_confirmed`                                                  | `confirmCheckout`, for an upgrade checkout                                                                                                                                                                                                            | the last owner who opened the checkout (`checkoutStartedBy`), else the owner who confirmed         |
| `subscription_activated { interval }`                                 | `emitBillingDiff`: the row becomes `active` with a new subscription                                                                                                                                                                                   | the last owner who opened the checkout (`checkoutStartedBy`), else the payer                       |
| `subscription_renewed`                                                | `emitBillingDiff`: an active row's paid period moves forward on the same subscription; not the first paid cycle of a subscription adopted before it was paid, whose stored period end was a stand-in (`isFirstPaidCycle`)                             | the payer; the checkout's starter for a first charge                                               |
| `payment_failed { failure_code }`                                     | `emitBillingDiff`: `pastDueSince` is set; `retrying`, `halted` or `paused`                                                                                                                                                                            | the payer; the checkout's starter for a first charge                                               |
| `subscription_recovered`                                              | `emitBillingDiff`: a past-due row is active again                                                                                                                                                                                                     | the payer                                                                                          |
| `subscription_halted`                                                 | `emitBillingDiff`: `haltedAt` is set                                                                                                                                                                                                                  | the payer; the checkout's starter for a first charge                                               |
| `subscription_cancel_scheduled { by }`                                | `emitBillingDiff`: a cancel at period end (not a switch's), an owner's cancel before the first charge, or a staff cancel that ends Paid now; `by` is `owner`, `customer_bank` (the provider reported a cancel no owner made), `staff` or `suspension` | the owner who cancelled, else the payer                                                            |
| `subscription_interval_change_scheduled`                              | `emitBillingDiff`: the next subscription is authenticated on the other interval                                                                                                                                                                       | the owner who started the switch                                                                   |
| `downgraded_to_free { downgrade_cause }`                              | `emitBillingDiff`: the row becomes `free`; `trial_ended`, `payment_failed`, `cancelled` (an owner's own cancel too, of a past-due subscription included), `staff` or `lifecycle`                                                                      | the payer; for `trial_ended`, as `trial_ended`                                                     |
| `payer_left`                                                          | `sendPayerLeft`, while a subscription runs                                                                                                                                                                                                            | the payer (system for a deleted account)                                                           |
| `duplicate_subscription_refunded { refund_cause }`                    | the sync's refund of a duplicate subscription (`refund_cause: duplicate`), of an interval switch paid after the current subscription renewed (`late_switch`), or of one an archived workspace adopted (`archived`); only when a payment was refunded  | the payer                                                                                          |
| `billing_reconciled { field }`                                        | `emitBillingDiff` from the reconcile: the first column it repaired                                                                                                                                                                                    | the payer                                                                                          |
| `dispute_opened`                                                      | the dispute webhook, when the tenant's dispute flag turns on                                                                                                                                                                                          | the payer                                                                                          |

The billing actions are audited too:

- owner actions: `billing_checkout_started`, `billing_cancel_scheduled`,
  `billing_interval_switch_scheduled` and `billing_card_change_started`;
- staff actions: `billing_resynced`, `billing_trial_extended`,
  `billing_grant_added`, `billing_grant_revoked`,
  `billing_cancelled_by_staff`, `billing_viewed`, `plan_updated`,
  `plan_price_created` and `billing_settings_updated`.

The audit entries are the action log under other names. In dashboards, count
the product events above, never both. A staff action sends no product event of
its own except `trial_extended`. The billing change a staff action makes is
sent as the person the rules attribute it to, never the staff member.

**Metric definitions** (from the billing design):

- trial-to-paid at 30 and 90 days;
- free-to-paid at 180 days;
- time to upgrade;
- paywall hit rate: tenants with ≥1 limit or feature block ÷ active tenants;
- conversion per prompt surface;
- payment recovery rate: `subscription_recovered` tenants ÷ `payment_failed`
  tenants;
- churn by `downgrade_cause`.

### Error tracking

Server errors go to PostHog Error Tracking as `$exception` events, from one
capture point per kind of failure and never from a logger transport:

| Where                                                                                   | When                                                                                  | `capture_point` |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------- |
| `errorHandler` (`error.middleware.ts`), through `reportErrorWithSpan`                   | a 5xx the capture rule admits; a failure after the headers were sent, recorded as 500 | `http`          |
| `uncaughtException` and `unhandledRejection` (`index.ts`), through `reportError`        | always                                                                                | `process`       |
| each Worker's `failed` listener, through `reportFinalJobFailure` (`job-failure.job.ts`) | the attempt BullMQ will not retry                                                     | `job`           |

**The capture rule** (`shouldCaptureHttpError`) decides which errors are
reported:

- An error that is not an `HttpError` and resolves to 500 is reported.
- An `HttpError` of 500 or more is a deliberate answer. It is reported only
  when it wraps a `cause`.
- A `PosthogUnavailableError` is never reported. PostHog being unreachable is
  its meaning, and its thrower already logged why.
- A 4xx, and a client that went away, are never reported.

Each analytics tick has one attempt, so every failed tick is a final failure
and is reported. The throttle bounds a run of them.

**The reporter** (`src/services/errors/error-reporter.service.ts`).
`reportError` checks the global cap first; past it, nothing is built. Then it
builds, scrubs, throttles and queues one event synchronously, with no I/O, and
returns its id. The id (a UUIDv7) is minted first. It is therefore returned
even when error tracking is off, the event is throttled, or building failed;
the id then names a log line, not an event. The limits
(`error-tracking.constants.ts`):

- at most 10 events per fingerprint, and 100 in all per process, in any
  rolling minute;
- a flush every 5 s, or at once when 50 events wait, one request at a time
  outside a deadline flush;
- at most 500 events queued; past that, the oldest is dropped as
  `buffer_full`;
- while PostHog asks to retry, a back-off from 5 s doubling to 300 s. A batch
  is dropped as `retry_exhausted` after `ERROR_RETRY_LIMIT` (5) sends, the
  number the system status answers as `errorTracking.retryLimit`.

The queue is in memory, not the outbox, because errors can happen while the
database is down. The reporter never depends on Redis; Redis only counts
outcomes for the status page. A failure inside the reporter is caught, logged
at most once a minute and never reported, so the reporter cannot recurse.
`errorHandler` reports through `reportErrorWithSpan`, which also returns the
scrubbed stand-in that the active span records, so a 5xx is built once.

**Flushes on the way out.** `flushErrorReports(deadline)` ignores any back-off.
It sends until the queue is empty, PostHog asks to retry, or the deadline
passes. It also waits for a request already in flight, which may carry the
fatal event. A process fault flushes for `ERROR_FATAL_FLUSH_MS` (2 s), and
graceful shutdown for `ERROR_SHUTDOWN_FLUSH_MS` (3 s).

**`errorId` and the route.** Every 5xx `errorHandler` writes, except a
maintenance refusal, carries an `errorId` in its body and on its log line. A
reported error's id is its `$exception` uuid. A `PosthogUnavailableError` 502
also carries one, but it names nothing: that error is neither logged nor
reported there.

The route template on an event comes from `recordRouteTemplate`
(`route-template.middleware.ts`). Express restores `request.baseUrl` before an
error reaches `errorHandler`. The middleware therefore records the mount path
when the router assigns `request.route`, and puts a mount parameter's value
back as its name.

**System status.** `GET /platform/system/status` (platform admin, not
audited) answers `{ release, errorTracking, flags, maintenance }`:

- `release`: the image's `APP_VERSION`;
- `errorTracking`: the reporter's sent and dropped counts over the last 15
  minutes, summed from Redis across every process, with the retry limit
  (`retryLimit`);
- `flags`: the flags' snapshot state;
- `maintenance`: the maintenance mode as the answering replica sees it.

`STATUS_READ_TIMEOUT_MS` (2 s) bounds each section that reads Redis. With a
stalled Redis, that section answers what it reports when Redis fails.

### Feature flags

Flags are declared in code and evaluated on the server, from a snapshot of
PostHog's flag definitions. The API enforces them on its routes and serves
them to the customer app (react-boilerplate) and to Apex (apex-boilerplate).
Rollouts, kills and experiments are edited in PostHog. The registry
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

- **Registry.** Each entry has:
  - a key and a description;
  - a kind: `boolean`, or `multivariate` with `variants`;
  - a fallback;
  - a scope (`user` or `tenant`);
  - which apps' browsers receive it;
  - whether it is an experiment.

  `assertFlagRegistry` refuses a malformed registry when the module loads. An
  experiment is multivariate with `control` first. `FlagKey` makes an
  unregistered key a type error.

- **Traits** are only `FLAG_TRAITS`: `platform_role`, `tenant_role`,
  `app_env`, `account_created_days`, `tenant_created_days`, and the tenant's
  `plan` and `billing_state`. They are built from the database at evaluation
  time. `plan` and `billing_state` are read with the clock (a trial that ended
  reads `free` before the job moves it), and are also the tenant group's
  properties. The other traits are never stored in PostHog. There is no `app`
  trait, so a route gate and the UI always agree.
- **Snapshot** (`flag-snapshot.service.ts`). Each process loads the snapshot at
  boot, and reloads it on a `reload` message and every 60 s. It keeps its copy
  when a reload fails or reads an older snapshot. A process that never loaded
  one answers every fallback. The stored snapshot carries a fingerprint of the
  registry and the parser version. When that differs from the running code's,
  the job fetches without `If-None-Match`, so a 200 re-parses with the current
  rules.
- **Evaluation** (`flag-evaluator.service.ts`) is pure and never throws. It
  answers the registry fallback, with a `fallback:*` reason, in these cases:
  no snapshot; a missing, inactive or unsupported flag; a tenant-scoped flag
  with no tenant. A definition using a construct the evaluator cannot
  reproduce, or a key it does not know, is marked unsupported and never
  evaluated.
- **Route gates** (`requireFlag`, `flag.middleware.ts`) mount after
  `requireAuth`, after `resolveTenant()` for a tenant-scoped flag, and before
  validators. A closed gate answers the unknown-route 404 and records no
  exposure. `tests/unit/routes/flag-gates.test.ts` fails a tenant-scoped gate
  outside `/tenants/:slug/…`.
- **Client reads and exposure.** `GET /tenants/:slug/flags` and `GET /flags`
  serve the customer app; `GET /platform/me/flags` serves Apex. The route fixes
  the app, and the answer carries values, never traits or reasons. The
  matching `POST …/exposures` takes `{ keys }` and re-evaluates each key on the
  server. It records `$feature_flag_called` once per session, tenant, key and
  response, and only for a matched condition or a holdout.
- **Inspector.** None of these routes calls PostHog:
  - `GET /platform/flags` pages the registry with each flag's live state;
  - `GET /platform/flags/unregistered` pages the flags PostHog has that the
    registry lacks;
  - `GET /platform/flags/meta` carries the traits reference and the snapshot's
    age;
  - `GET /platform/flags/evaluate` answers one user's traits and values. It is
    the one place traits leave the server, so each read is audited as
    `user.flags_evaluated` before anything is evaluated.
- **Kill-switch latency.** An edit in PostHog reaches every process on the next
  30 s fetch and its `reload` message, or on the 60 s backstop. The fetch
  shares the one-at-a-time `analytics` Worker with the drain and the deletion
  tick, so with PostHog slow it can wait behind both.

`pnpm flags:sync` creates every registered flag the project lacks, inactive at
0 %. It never edits or deletes a flag. The steps, and how to start an
experiment, are in [README.md](README.md#feature-flags).

### Observability

**Tracing.** `src/observability/tracing.ts` loads through Node's `--import`,
before `index.ts` and before environment validation. It therefore reads
`process.env` directly, and never `getEnv()` or the logger. Without
`OTEL_EXPORTER_OTLP_ENDPOINT` it starts nothing.

- node-redis (the shared client) and postgres.js have no installed
  instrumentation, so their calls appear as gaps in a trace.
- `/health`, `/health/ready` and `/api/v1/collect/` get no spans.

The file's JSDoc explains the setup.

**Logs.** `src/services/logger.service.ts` is the one logger. Each record
carries `source` (the caller's `file:line`) and the correlation fields from
[Request correlation](#request-correlation). An Error-valued field is redacted
with `redactedForLog` when it carries a database query.

**Slack.** With `SLACK_WEBHOOK_URL` set, records at or above `SLACK_LOG_LEVEL`
also go to Slack. Repeats of one `source` and message within 60 s are counted
and summarised once. The message, source, request id and stack are scrubbed
with the error tracker's `scrubText` first.

## Billing

Every customer workspace is on a plan: Free, or Paid through a Razorpay
subscription. A workspace starts with a trial of Paid when it is created. This
section is the map of billing; the detail lives in the sections it links.

- **Tables.** `plans`, `plan_prices`, `tenant_billing` (one row per customer
  workspace: state, plan, trial, paid period and provider ids),
  `user_trials`, `tenant_entitlement_grants`, `billing_settings`,
  `billing_events`, `tenant_billing_subscriptions` (every subscription a
  workspace has held, for the invoice list), `billing_state_history`,
  `upgrade_requests`, `user_banner_dismissals` and `billing_alerts`
  ([DATABASE.md](DATABASE.md#models-and-tables)). The platform tenant has no
  billing row.
- **States and entitlements.** A row is `trialing`, `free`, `active` or
  `past_due`. Reads act on the effective state
  (`effectiveBillingState`, `src/utilities/billing-rules.utilities.ts`). The
  clock can move the effective state to Free before a job writes it, in three
  cases:
  - a trial past its end;
  - a cancelling period past its end plus 3 days;
  - a past-due grace past its end.

  The entitlements are the plan's values, filled from the registry
  (`src/constants/entitlements.constants.ts`) and overridden by staff grants.
  `requireFeature` and `assertWithinLimit` enforce them
  (`src/services/billing/entitlements.service.ts`). Adding one is a recipe in
  [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-plan-gated-feature).

- **Seats.** Every write that adds a member takes the seat lock (the billing
  row) at its place in the [lock order](#layers).
- **One sync path.** Only `syncTenantBilling`
  (`src/services/billing/billing-sync.service.ts`) maps the provider's
  subscriptions onto a row, under the row lock, with a versioned write. A
  checkout confirm, a webhook job, a staff resync, the frequent run and the
  daily reconcile all call it. The mapping itself is pure
  (`src/utilities/billing-state-machine.utilities.ts`). A failed provider read
  writes nothing, and the job retries.
- **Confirm after the webhook.** The payment webhook can land before the
  browser's confirm, and promote the checkout to current. A confirm of that
  current subscription answers 200 when all four hold:
  - the row still bills on it;
  - its signature verifies;
  - the confirming owner started the checkout;
  - the subscription is younger than a checkout lives plus its margin
    (`CHECKOUT_EXPIRY_MS + NEXT_CHECKOUT_MARGIN_MS`).

  The confirm then syncs, and records `checkout_confirmed` (deduped per
  subscription). While the owner is still the payer of that subscription, it
  records the owner's address as the billing address: the one thing the
  adoption leaves to the confirm. It never changes the payer, so a replay
  after another owner's card change takes nothing back. Any other confirm of
  the current subscription, outside a card change, is `CHECKOUT_MISMATCH`.

- **Owner cancel.** An owner's cancel keeps Paid until the cycle end. Two
  kinds of subscription are cancelled now instead, and the workspace returns
  to its trial or moves to Free at once (`cancelPaid`,
  `src/services/billing/checkout.service.ts`):
  - a deferred start, which is not charged yet;
  - a past-due subscription, whose paid time is over.

  On an active workspace, both cancels are confirmed once per subscription,
  whoever cancelled. Each owner gets a `billing_paid_cancelled` notice carrying
  the `paid_cancelled` mail, and the billing address gets that mail. The
  period-end variant says when Paid ends. The variant for a deferred start's
  return to its trial says no payment was taken and when the trial ends
  (`billingTransitions`).

- **Interval switch.** A switch starts a next subscription at the period end.
  Once the next one is authenticated, the sync cancels the current one at its
  cycle end. Three rules keep a switch from double-charging:
  - A switch inside the checkout's hour, plus an hour's margin, before the
    renewal is refused with 409 `SWITCH_TOO_CLOSE_TO_RENEWAL`.
  - A checkout that starts at the period end (a switch or a resubscribe)
    lapses at least an hour before it, so it can't be paid after the renewal
    charged.
  - The sync may still read a next subscription as paid after the current one
    renewed: a new cycle whose invoice is paid, because the provider moves the
    cycle start before the money arrives. That next subscription is cancelled
    and refunded as a duplicate, and the current one kept.
- **Mail recipients.** Billing mail goes to the workspace's active owners, and
  to the billing address the payer gave when it is no owner's
  (`src/services/billing/billing-emails.service.ts`). Once the payer is no
  longer an active member, that address gets only mail about the mandate their
  card still backs:
  - the renewal reminder;
  - a failed payment;
  - a cancel;
  - a move to Free after a failed payment or a cancel.

  A payer who leaves while the subscription runs is reported to the remaining
  owners. An active subscription still charges the payer's card until the
  owners update the payment method. A past-due one keeps Paid only until its
  grace ends.

- **Provider.** `getBillingProvider()`
  (`src/services/billing/billing-provider.service.ts`) answers:
  - Razorpay, when its keys are set;
  - the fake, when `BILLING_FAKE_PROVIDER` is set (local only). The fake keeps
    its subscriptions in Redis so the API and the worker agree;
  - null otherwise. Plans, trials, limits, grants and staff tooling still
    work, and every owner billing write and the webhook answer the
    unknown-route 404.
- **Jobs and schedulers.** The `billing` queue carries one job per webhook
  event, workspace syncs, the prompt lifecycle cancel, tax runs and the two
  runs ([Queues and Workers](#queues-and-workers), [Schedulers](#schedulers)).
- **Tax documents.** With GST registration on, a workspace's tax run
  (`src/services/billing/tax-reconcile.service.ts`) works in three phases:
  1. It plans with no lock held. The plan covers the paid charges of the
     workspace's current, next and tracked subscriptions since the
     registration date. It also covers the processed refunds of each invoiced
     charge that is hinted, or that is not fully credited and was paid within
     200 days.
  2. It issues each invoice, and each credit note after its invoice, through
     `tax-documents.service.ts`. A Special Economic Zone (SEZ) buyer's charge
     is held instead of invoiced.
  3. After the commits, it raises the staff alerts: one `tax_invoice_late` per
     run, one `tax_credit_note_late` per late note, one `tax_held_sez` per
     hold, and one `tax_issue_failed` per refund larger than what is left to
     credit. Such a refund is never issued capped.

  A processed refund of a held charge (hinted, or paid within 200 days) raises
  one `tax_held_sez` alert and issues nothing: staff credit it by hand. A run
  that fails part way still raises the alerts for what it committed, before
  rethrowing. A provider error fails the run for a retry; what it issued
  stays.

  These queue a tax run:
  - every sync that ends `synced`;
  - a `refund.processed` webhook;
  - a `refund.processed` webhook that reaches no workspace's sync too: its run
    is hinted with the payment and queued after the handling resolves, so a
    retried attempt queues none;
  - the two daily tax steps.

  `pnpm billing:tax-reconcile` plans every workspace that tracks a
  subscription (or the one named with `--tenant`) and prints counts. It writes
  nothing until `--apply` queues the same job
  ([README.md](README.md#tax-documents-dry-run-and-backfill)).
  - _Tables._ `tenant_tax_details` (the buyer's legal name, address, state,
    GST Identification Number (GSTIN) and SEZ flag, one row per workspace),
    `tax_documents` (every invoice and credit note, with a frozen snapshot of
    each printed field), `tax_document_counters` (the last number per type and
    financial year) and `tax_held_charges` (an SEZ buyer's charges, held for
    staff).
  - _Numbering._ A number is `PREFIX/YY-YY/NNNNN`: a prefix of 1 to 3
    characters, the financial year from the IST issue date, and at least five
    digits, 16 characters at most in all. Each type and year has one series.
    A number is allocated only inside the transaction that inserts the
    document, under the counter's row lock, taken last
    (see [Lock order](#layers)). A failed insert therefore rolls the number
    back, and a series has no gap.
  - _Immutability._ No code updates or deletes a `tax_documents` row. A fix is
    a credit note against the invoice, never an edit. The snapshot holds the
    seller, buyer, place of supply, amounts and description as issued, so a
    document prints the same after the workspace changes its details.
  - _PDF._ `tax-pdf.service.ts` lays one A4 page out in built-in Helvetica from
    the stored row alone. The PDF dates come from the issue time, and the
    producer is a fixed string, so one row always renders the same bytes.
    - The rupee sign has no glyph in those fonts, so PDFs print `Rs.`.
    - Input fields take Latin text only, so every character renders: tax
      details, the seller variables, and a staff credit note's reason, which
      prints on the customer's note.
    - A workspace name or plan name that isn't Latin prints as the slug or
      `Paid plan`. `taxDocumentLines` writes any other character as `?`.
    - Only the workspace's owner downloads a PDF; staff download through their
      audited route.
  - _Export._ `GET /platform/billing/tax-export?period=YYYY-MM|YYYY-Qn`
    (`platform-tax-export.service.ts`) returns a zip of GSTR-1 CSVs. GSTR-1
    is the GST return of outward supplies. The zip covers every document
    issued in an IST month or financial-year quarter, purged workspaces'
    documents included. The route is admin only, takes step-up and is
    audited. It builds the zip in memory, which suits a few thousand
    documents.
  - _Registration off._ With `BILLING_GST_REGISTERED=false`, issuing stops. A
    run does nothing, and the owner's tax-details write and every staff write
    answer 404 `tax_documents_disabled`. Reads and PDFs stay for a workspace
    that already has documents, so a customer keeps what was issued.
  - _E-invoicing._ This app does not get an Invoice Reference Number (IRN), so
    it fits a seller below the e-invoicing turnover limit (₹5 crore, which is
    ₹50 million). `BILLING_EINVOICE_REQUIRED=true` stops boot while
    registration is on.
  - _Known limit._ A refunded duplicate or late-switch subscription from before
    this release is not tracked. A `BILLING_GST_EFFECTIVE_FROM` earlier than
    the deploy can therefore miss its charges and refunds. Set the date on or
    after the deploy, or have an accountant issue those documents by hand.
  - _Purge._ `tax_documents.tenant_id` is `ON DELETE SET NULL`. GST records are
    kept 72 months, so documents survive a tenant purge and stay in the export.
    `tenant_tax_details` and `tax_held_charges` are deleted with the tenant.

- **Events and pushes.** Every change emits its product events
  ([Billing events](#billing-events)) and tells the workspace's open apps over
  SSE ([Realtime (SSE)](#realtime-sse)).
- **Staff.** `platform-billing.service.ts` serves Apex's billing views and
  writes ([Platform access](#platform-access)).
- **Maintenance.** The billing routes have their rows in
  `MAINTENANCE_ROUTE_RULES`. `read_only` refuses the owner writes. `full` lets
  only the public plan list and the Razorpay webhook through. The webhook
  records each event, and `full` pauses the `billing` queue with the others, so
  the events wait and run when maintenance ends
  ([Maintenance mode](#maintenance-mode)).
- **Before launch.** No real tenant exists yet. A database switched from
  Razorpay test keys to live keys keeps the test-mode ids on its rows. The
  sync skips them as another mode, and a purge of such a workspace refuses
  with 502 until staff clear those ids from its row.
- **Dev seed and time travel.** `pnpm billing:seed` (local, with
  `BILLING_FAKE_PROVIDER=true`) creates 13 `billing-*` workspaces, one per
  billing state. `pnpm billing:time-travel` moves one back in time
  ([README.md](README.md#billing-dev-seed)).

## Maintenance mode

A platform owner puts the product into maintenance from Apex, without a
deploy. The mode has three values:

| Mode        | Effect                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`       | Normal service.                                                                                                                                    |
| `read_only` | Refuses customer writes with 503 `READ_ONLY_MODE`.                                                                                                 |
| `full`      | Refuses every route not on its let-through list with 503 `MAINTENANCE_MODE`, refuses a non-staff sign-in, and pauses every queue but `auth-email`. |

The let-through list, and the controls on changing the mode, are in
[SECURITY.md](SECURITY.md#maintenance-mode). The operator steps are in
[README.md](README.md#maintenance-mode).

- **State.** One row, `maintenance_mode_state`, is the source of truth; its
  migration seeds `off`, version 0. A change is a compare-and-set on
  `version`, written with its `platform.maintenance_mode_changed` audit entry
  in one transaction. A stale `expectedVersion` answers 409
  `MAINTENANCE_MODE_CONFLICT`.
- **Propagation.** Each replica keeps the mode in memory
  (`src/services/maintenance-mode/maintenance-mode-store.service.ts`). A change
  publishes `reload` on `redisKey('maintenance-mode')`. Every replica rereads
  the row on that message, on a subscriber reconnect, and every 10 s
  (`MAINTENANCE_MODE_RELOAD_INTERVAL_MS`) whatever happens.
  - A row whose version is not above the copy's is ignored, so overlapping
    reloads never roll the state back.
  - A replica whose first read fails serves `off` with `known: false`, logs an
    error and keeps retrying.
  - A later failure keeps the last known mode, so a replica never flips open
    or closed on its own.
- **The gate.** `maintenanceModeGate`
  (`src/middlewares/maintenance-mode.middleware.ts`) reads only the replica's
  store, never Postgres or Redis. The only request-path reads of the row are
  the staff view and change behind `/platform/maintenance-mode`
  (`getPlatformMaintenanceMode` and the change's row lock).
  - The gate stamps `Maintenance-Mode: off | read_only | full` on every
    response it sees.
  - It decides by method and path from `MAINTENANCE_ROUTE_RULES`
    (`src/constants/maintenance-mode.constants.ts`). An unclassified path gets
    the default: reads go through in `read_only`, and nothing goes through in
    `full`.
  - On the customer routes Apex calls (`MAINTENANCE_STAFF_ROUTES`), the gate
    only marks the refusal, and `requireAuth` lets platform staff through.

  `tests/unit/routes/maintenance-mode-gates.test.ts` fails on a route with no
  rule, a rule with no route, and a staff-pass route outside `requireAuth`.

- **Refusal.** A refusal is a 503 with `Retry-After: 30` and
  `{ success, statusCode, code, message, mode, since, requestId }`. `message`
  is the owner's customer message. CORS exposes `Maintenance-Mode` and
  `Retry-After`. Clients detect maintenance by the 503 and its `code`, never by
  a bare 502 or 503.
- **Queues** (`maintenance-mode-queues.service.ts`). `full` pauses every queue
  in `getPausableQueues()` with BullMQ's queue-wide `pause()`. That is every
  queue but `auth-email`, which carries the sign-in, step-up, welcome,
  invitation, invitation confirm and passkey notice mail
  (`AUTH_EMAIL_TEMPLATE_KEYS`, `src/jobs/email.job.ts`). Staff can therefore
  still sign in to switch maintenance off.
  - The pause is a flag in Redis that every replica's Workers obey: running
    jobs finish, and waiting ones stay.
  - Every replica reconciles on every reload. This repairs a crash between the
    commit and the pause, and a Redis outage.
  - A reload pauses only once the mode has been `full` for
    `MAINTENANCE_MODE_PAUSE_GRACE_MS` (10 s), so the change's notices go out
    first.
  - In any other mode, a reload resumes the queues, after removing the
    duplicate scheduler runs gathered while paused (`dedupeSchedulerJobs`).
    Each Worker start re-upserts its schedulers, and a paused queue keeps every
    extra run.
  - Pause and resume are idempotent, so replicas reconciling at once are
    harmless.
- **A change** (`PUT /api/v1/platform/maintenance-mode`,
  `maintenance-mode.service.ts`) runs these steps:
  1. it commits;
  2. it publishes;
  3. it rereads its own copy;
  4. it queues an in-app and email notice to every other platform owner and
     admin, for a switch-on, an escalation or a switch-off.

  Entering `full` waits for those notices for up to
  `MAINTENANCE_MODE_NOTICE_WAIT_MS` (10 s), then pauses the queues, unless a
  later change superseded it. Once the row has committed, no later failure
  turns the change into an error.

- **Status.** Two public routes answer in every mode, so a signed-out page can
  state a link's lifetime and the support address during maintenance:
  - `GET /api/v1/status/maintenance` answers the mode, the customer message and
    when it began, from memory.
  - `GET /api/v1/status/client-settings` answers what the frontends state in
    their copy: `signInLinkTtlSeconds`, `stepUpLinkTtlSeconds`,
    `invitationTtlSeconds` (each rounded down to the second) and
    `supportEmail` (`clientSettingsFrom`,
    `src/services/client-settings.service.ts`). It sends
    `Cache-Control: public, max-age=300`.

  Why the values may be public is in
  [SECURITY.md](SECURITY.md#maintenance-mode). The system status has a
  `maintenance` section with the queues' pause state, and whether the last
  change's notices are still pending.

## Configuration

This section covers how the API reads its environment, every environment
variable, and the cross-variable checks boot runs.

All configuration is read through `getEnv()` (`src/configs/env.config.ts`). It
validates `process.env` against a Zod schema once, on first call, and memoises
the result.

- An empty value counts as unset, because a `.env` copied from `.env.example`
  keeps `KEY=` lines.
- `getEnv()` is lazy because a module-scope parse would throw during import
  resolution.
- In `src/`, only `env.config.ts`, `tracing.ts`, `logger.service.ts` and
  `index.ts` may read `process.env` (`no-restricted-properties`). `tracing.ts`
  is the exception that matters, because it loads before validation.

`.env` is loaded twice, on purpose:

1. `pnpm dev` and `pnpm start` pass `--env-file-if-exists=.env` to Node, so the
   values reach `tracing.ts`, which loads before any app module.
2. `env.config.ts` also loads `.env` with `dotenv`, which never overrides a key
   already set. It therefore only fills keys Node left unset. `tsx` scripts
   such as `pnpm db:migrate` rely on it. This load is skipped under Vitest,
   whose environment `tests/helpers/setup-global.ts` assembles.

The Docker image's `CMD` passes no env file: the image has no `.env`, and the
orchestrator supplies the environment.

`.env.example` and the table below are generated from the schema: each row's
text is that variable's `.describe()`. Do not edit the rows by hand. Change the
schema, then regenerate with `pnpm env:example` and `pnpm --silent env:table`
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
| `WEBAUTHN_ANDROID_ORIGINS`            | no       | —                          | Origins of the Android app that may use passkeys, comma-separated, each android:apk-key-hash: followed by the 43-character base64url SHA-256 of the app signing certificate. Unset means no Android origin.                                                                                                                                                                                                                                                                                                                                                                                               |
| `WEBAUTHN_IOS_ENABLED`                | no       | `false`                    | Whether the iOS app uses passkeys. iOS binds a passkey to the host of WEB_URL, so boot refuses true when WEBAUTHN_RP_ID is set to anything else. Defaults to false.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MINIMUM_APP_VERSION_IOS`             | no       | —                          | The oldest iOS app version the app should allow, as major.minor.patch. The server only publishes it at GET /api/v1/status/client-settings; the app enforces it. Unset means no minimum.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MINIMUM_APP_VERSION_ANDROID`         | no       | —                          | The oldest Android app version the app should allow, as major.minor.patch. The server only publishes it at GET /api/v1/status/client-settings; the app enforces it. Unset means no minimum.                                                                                                                                                                                                                                                                                                                                                                                                               |
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
| `ACCOUNT_DELETION_DAYS`               | no       | `30`                       | Days after a customer asks to delete their account by which staff must complete it. The receipt mail states this date. At least 1, at most 30. Defaults to 30.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
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
| `SUPPORT_EMAIL`                       | no       | —                          | The support address customer mail, API error messages and the apps name: mail and the apps, for a step only support can take, such as restoring a suspended or archived workspace; an error, for a failure that happens again. The apps read it from the public GET /api/v1/status/client-settings. A bare address, no display name. Unset uses support@ on the domain of MAIL_FROM.                                                                                                                                                                                                                      |
| `APP_NAME`                            | no       | `Express Boilerplate`      | Product name in outbound email copy and notification text for the customer app: a sign-in link, welcome or invitation into it, and the maintenance-mode and onboarding reminder messages. Mail whose link opens Apex names APEX_APP_NAME instead. Defaults to "Express Boilerplate".                                                                                                                                                                                                                                                                                                                      |
| `APEX_APP_NAME`                       | no       | `Apex`                     | Name of the Apex staff dashboard in email copy: the subject and sign-off of every mail whose link opens Apex (a staff sign-in link or welcome, a step-up link, a staff invitation and its confirm link). Chosen by the frontend the link targets, whether or not APEX_URL is set. Defaults to "Apex".                                                                                                                                                                                                                                                                                                     |
| `RESEND_WEBHOOK_SECRET`               | no       | —                          | Signing secret of the Resend webhook endpoint (Resend dashboard, Webhooks, the endpoint's signing secret: whsec_ followed by base64). Enables POST /api/v1/webhooks/email/resend, which verifies each event's Svix signature with it; absent, that route answers 404. Subscribe the endpoint to the email.* events: delivered, delivery_delayed, bounced, complained, opened, clicked, failed and suppressed.                                                                                                                                                                                             |
| `FAKE_EMAIL_WEBHOOK_SECRET`           | no       | `fake-webhook`             | Signs local fake email webhook events (`pnpm email:fire-event`), as an HMAC-SHA256 hex digest in the x-fake-signature header. Read only when APP_ENV is local, the one environment that serves POST /api/v1/webhooks/email/fake. Defaults to "fake-webhook"; not a credential.                                                                                                                                                                                                                                                                                                                            |
| `RAZORPAY_KEY_ID`                     | no       | —                          | Razorpay API key id (Razorpay dashboard, Account and Settings, API keys): rzp_test_ for test mode, rzp_live_ for live mode. Set it with RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET to turn on paid plans; with none of the three set, paid checkout and the Razorpay webhook answer 404. Live keys are accepted only when APP_ENV is prod.                                                                                                                                                                                                                                                           |
| `RAZORPAY_KEY_SECRET`                 | no       | —                          | Razorpay API key secret that pairs with RAZORPAY_KEY_ID. Set all three Razorpay variables or none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RAZORPAY_WEBHOOK_SECRET`             | no       | —                          | Signing secret of the Razorpay webhook endpoint (Razorpay dashboard, Webhooks). Verifies each event on POST /api/v1/webhooks/razorpay. Set all three Razorpay variables or none.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`    | no       | —                          | The webhook signing secret you rotated away from. While set, events signed with it still verify, so a rotation drops no event. Unset it once Razorpay sends only the new secret. Needs RAZORPAY_WEBHOOK_SECRET.                                                                                                                                                                                                                                                                                                                                                                                           |
| `BILLING_GST_REGISTERED`              | no       | `false`                    | Whether the business is registered for GST. When false, prices show without a GST line. Defaults to false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `BILLING_SELLER_GSTIN`                | no       | —                          | The seller's GSTIN, printed on every tax document. Required when BILLING_GST_REGISTERED is true. Its first two digits must match BILLING_SELLER_STATE_CODE. This app doesn't issue e-invoices, so it fits sellers under the e-invoicing turnover limit.                                                                                                                                                                                                                                                                                                                                                   |
| `BILLING_SELLER_LEGAL_NAME`           | no       | —                          | The seller's legal name, printed on every tax document. Latin letters only; curly quotes are stored straight. Required when BILLING_GST_REGISTERED is true.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `BILLING_SELLER_ADDRESS`              | no       | —                          | The seller's address, printed on every tax document. Separate printed lines with ' \| '. Latin letters only. Required when BILLING_GST_REGISTERED is true.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `BILLING_SELLER_STATE_CODE`           | no       | —                          | The two-digit GST state code of the seller's registration, such as 29. Decides CGST and SGST against IGST. Required when BILLING_GST_REGISTERED is true.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `BILLING_SAC_CODE`                    | no       | —                          | The 6-digit SAC code printed on every invoice, such as 998314. Required when BILLING_GST_REGISTERED is true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `BILLING_GST_EFFECTIVE_FROM`          | no       | —                          | The first day tax documents cover, as YYYY-MM-DD, read as 00:00 IST. Required when BILLING_GST_REGISTERED is true. Set it on or after the day this release is deployed: refunded duplicate subscriptions from before that day aren't tracked, so their charges get no documents.                                                                                                                                                                                                                                                                                                                          |
| `BILLING_EINVOICE_REQUIRED`           | no       | `false`                    | Set true if your turnover requires e-invoicing. This app can't get IRNs, so true stops boot while BILLING_GST_REGISTERED is true. Defaults to false.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `BILLING_INVOICE_PREFIX`              | no       | `INV`                      | Prefix of invoice numbers, 1 to 3 capital letters or digits, so a number with a 6-digit serial still fits the 16 characters GST allows. Don't change it inside a financial year: the series is counted per type and year, whatever the prefix. Defaults to INV.                                                                                                                                                                                                                                                                                                                                           |
| `BILLING_CREDIT_NOTE_PREFIX`          | no       | `CN`                       | Prefix of credit note numbers, 1 to 3 capital letters or digits, so a number with a 6-digit serial still fits the 16 characters GST allows. Don't change it inside a financial year: the series is counted per type and year, whatever the prefix. Defaults to CN.                                                                                                                                                                                                                                                                                                                                        |
| `BILLING_FAKE_PROVIDER`               | no       | `false`                    | Replaces Razorpay with an in-process fake for the dev seed and end-to-end runs. Only APP_ENV=local accepts it, and it cannot be set together with Razorpay keys. Defaults to false.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SMTP_CONNECTION_TIMEOUT_MS`          | no       | `3000`                     | Milliseconds to wait for each SMTP connection attempt to establish before failing. Also the timeout for the first try of each DNS query; the resolver doubles it on each retry, and the OS-lookup fallback has no timeout. A host that resolves to several addresses can take it once per address. Boot checks that it plus SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS and the 5s HTTP drain stays at least 5s under SHUTDOWN_TIMEOUT_MS; that assumes one address and is a sanity check, not a per-send deadline. nodemailer's own defaults are 2 minutes to connect and 30 seconds per DNS query. |
| `SMTP_GREETING_TIMEOUT_MS`            | no       | `5000`                     | Milliseconds to wait for the SMTP server's greeting after connecting. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 30 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SMTP_SOCKET_TIMEOUT_MS`              | no       | `7000`                     | Milliseconds of inactivity before an open SMTP connection is closed. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 10 minutes.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SHUTDOWN_TIMEOUT_MS`                 | no       | `25000`                    | Milliseconds graceful shutdown may take before the process exits with code 1 anyway. Defaults to 25000, under Kubernetes' default 30s termination grace period.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### `APP_ENV` and `NODE_ENV`

The two variables answer different questions:

- **`APP_ENV`** names the deployment: `local`, `dev`, `qa` or `prod`. It has no
  default, and boot fails without it, so a deploy that forgets it cannot run
  with local settings. The Docker image sets `NODE_ENV=production` but never
  `APP_ENV`.
- **`NODE_ENV`** is what Express reads. Only `production` hides stack traces in
  Express's built-in error handler.

Behaviour that depends on the deployment derives from `APP_ENV` only through
the helpers in `env.config.ts` (`isCookieSecure`, `logFormat`,
`requiresSmtpTls`, `isFakeEmailWebhookAllowed`), never at a call site.

### Boot-time consistency checks

Cross-variable rules live in `assertEnvConsistent`
(`src/configs/env-consistency.config.ts`), not in the schema, because an
object-level `.refine()` would break `getDatabaseUrl()`'s `.pick()`. The check
lists every problem in one message, each naming the variable and the fix, and
exits 1.

The rules, by `APP_ENV` (SMTP is the Simple Mail Transfer Protocol, and TLS is
Transport Layer Security):

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

The 10000 ms is two parts: the 5 s HTTP drain, which runs before the in-flight
send is awaited, and 5 s of headroom for the closes. The 3 s error-report flush
comes out of that headroom. The check assumes one address and no Domain Name System (DNS) delay, so
it is a sanity check, not a per-send deadline.

In every deployment, boot refuses:

- only one of `SMTP_USERNAME` and `SMTP_PASSWORD` set;
- a `COOKIE_DOMAIN` that `APP_URL`'s host is neither equal to nor within,
  because browsers reject every cookie it would set;
- `APEX_URL` on another host than `APP_URL`, with `GOOGLE_CLIENT_ID` set,
  unless `COOKIE_DOMAIN` covers the Apex host;
- `POSTHOG_FEATURE_FLAGS_KEY` without `POSTHOG_PROJECT_KEY`;
- only some of `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and
  `RAZORPAY_WEBHOOK_SECRET` set;
- a `rzp_live_` key outside `APP_ENV=prod`, and a `rzp_test_` key in prod;
- `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` without the current secret;
- `BILLING_FAKE_PROVIDER` outside `APP_ENV=local`, or with Razorpay keys set;
- with `BILLING_GST_REGISTERED=true`:
  - a missing seller GSTIN, legal name, address, state code, Services
    Accounting Code (SAC) or effective date;
  - a GSTIN whose state differs from `BILLING_SELLER_STATE_CODE`;
  - `BILLING_EINVOICE_REQUIRED=true`, because this app can't get IRNs;
  - one prefix for both invoices and credit notes.

In every deployment, boot warns:

- when seller variables are set while `BILLING_GST_REGISTERED` is false;
- when `COOKIE_SECURE` resolves true with `GOOGLE_CLIENT_ID` set and
  `TRUST_PROXY=false`. express-session would then never send the OAuth cookie
  behind a TLS-terminating proxy;
- when only one of `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` is set.

Two secrets sign the API's credentials, and a third is not needed:

- `JWT_ACCESS_SECRET` signs access tokens, which are JSON Web Tokens (JWTs);
- `SESSION_SECRET` signs the OAuth session cookie and keys the analytics
  signature;
- there is no refresh-token secret, because a refresh token is an opaque
  random string ([SECURITY.md](SECURITY.md#sessions-and-tokens)).

## Docker and deploying

This section covers the local Docker Compose stack, the production image, and
the GitHub Actions workflows that build, release and deploy it.

### Local infrastructure

`docker-compose.yml` runs the services the app needs; the app itself runs on
the host. The file's `dev` and `prod` profiles can also run the app and both
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

The OTel Collector is the OpenTelemetry Collector, and OTLP is the
OpenTelemetry Protocol.

Every published port binds `127.0.0.1` only. No other machine can therefore
reach Postgres with its fixed password, Redis with no password, Grafana's
anonymous admin or Mailpit. Postgres is pinned to 18 because the migrations
use `uuidv7()` as a column default, which is built in from Postgres 18.

**Host ports 5433 and 6380 are deliberate.** A native Postgres or Redis on
5432 or 6379 wins `localhost` connections over Docker's wildcard bind.
Postgres then fails loudly (wrong role), but Redis fails silently: any Redis
answers `PING`, so a dev server or the test suite would seem to work against
an unrelated instance. `tests/unit/connection-target.test.ts` reads the
committed `docker-compose.yml` and `.env.test` and asserts they agree. It does
not check `getEnv()`, because the continuous integration (CI) services publish
the default ports.

The collector's image has no shell, `curl` or `wget`, so it carries no Docker
`healthcheck`.

### Docker

`Dockerfile` builds in four stages from a digest-pinned `node:26-alpine`:

1. `base` installs Corepack and creates the non-root user (uid 10001).
2. `deps` installs with `--frozen-lockfile`, in a layer cached apart from the
   application code. `pnpm-workspace.yaml` and `.npmrc` travel with the
   lockfile, because pnpm reads its build allow-list and release-age settings
   from them at install time.
3. `build` runs `pnpm build`, then `pnpm prune --prod --ignore-scripts`.
   `pnpm install --prod` would leave dev dependencies in the virtual store;
   prune removes them, so neither `tsc` nor `drizzle-kit` ships.
4. `runner`:
   - sets `NODE_ENV=production`;
   - copies only `node_modules`, `dist/` and `package.json`;
   - runs as uid 10001;
   - declares `HEALTHCHECK NONE`. The orchestrator owns liveness and readiness
     through `/health` and `/health/ready`, and a second signal could disagree
     with them under load;
   - turns `ARG GIT_SHA=dev` into `APP_VERSION`.

   The `CMD` is
   `node --enable-source-maps --import ./dist/observability/tracing.js dist/index.js`,
   so tracing loads before the app and a stack trace names the `.ts` line.

The image starts only the app. Run migrations from the same image with
`node dist/database/migrate.js` (`pnpm db:migrate:prod`), which reads only
`DATABASE_URL`. To run the image against the compose stack:

```bash
docker build -t express-boilerplate .
docker run --rm -p 4040:4040 --env-file .env \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL=postgres://boilerplate:boilerplate@host.docker.internal:5433/boilerplate \
  -e REDIS_URL=redis://host.docker.internal:6380 \
  express-boilerplate
```

The `-e` overrides are required: `.env` says `localhost`, which inside the
container is the container itself. Without them, `/health` still answers 200,
and `/health/ready` answers 503 at its deadline.

### Deploying

A push to `main` runs `.github/workflows/deploy.yml`, which runs these jobs:

1. It calls `ci.yml` as a gate (`workflow_call`).
2. It builds and pushes `ghcr.io/<repo>:sha-<commit>` and `:main` to the
   GitHub Container Registry (GHCR), with a software bill of materials (SBOM)
   and a build provenance attestation. It passes the commit sha as `GIT_SHA`.
3. It runs the `deploy` job in the `production` environment. That job is a
   placeholder: no deployment target is chosen.

Two other triggers do less:

- A manual `workflow_dispatch` from another branch builds and pushes only the
  sha image.
- A `vX.Y.Z` tag builds nothing. Its `promote` job waits for the image `main`
  built for that commit, and adds `:X.Y.Z`, `:X.Y` and `:X` to the same digest
  ([CONTRIBUTING.md](CONTRIBUTING.md#releases)).

The image job also passes the frontends' source-map settings
(`POSTHOG_SOURCEMAP_PROJECTS`, `POSTHOG_CLI_HOST`, `POSTHOG_CLI_TOKEN`), which
the frontend images use to upload source maps. This Dockerfile uses only
`GIT_SHA`. `ci.yml`'s concurrency group is keyed on `github.event_name`,
because under `workflow_call`, `github.workflow` is the caller's name. CI's
`docker` job builds the image with a known `GIT_SHA`, and checks that
`/health` reports it and that the process runs with `--enable-source-maps`.

`release.yml` merges its release pull request (PR) with `--auto`, falling back
to a direct merge. Only a ruleset on `main` makes that fallback wait for CI:
one that requires the checks `lint`, `test`, `docker`, `gitleaks` and
`pr-title`. Add that ruleset before relying on the release flow. The release
App and the merge settings are in
[CONTRIBUTING.md](CONTRIBUTING.md#releases).
