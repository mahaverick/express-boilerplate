# CLAUDE.md

Rules and gotchas for anyone, human or agent, changing this repo: the changes
that look right and break something silently. Each rule gives its reason and
points at the code or doc that holds the detail. How things work is in
[ARCHITECTURE.md](ARCHITECTURE.md); the threat model and defences are in
[SECURITY.md](SECURITY.md).

## Auth and access

- **Name it `isPasswordValid`, not `verifyPassword`.** Answer
  `unicorn/consistent-boolean-name` by renaming, never with an `ignore` entry.
- **`verifyAccessToken` never throws.** It returns `{ ok: true; payload }` or
  `{ ok: false; reason: 'expired' | 'invalid' }`, and `'expired'` means only
  `jsonwebtoken`'s `TokenExpiredError` (`src/services/session.service.ts`).
  Don't derive a third reason from an error message.
- **Keep the user-row lock modes and their placement.** Login keeps
  `lastLoggedInAt` and `autoJoinSafely` outside the transaction that re-reads
  the hash `FOR SHARE` and issues the token, so that lock covers only the
  re-read and the insert. The refresh kills run after the rotation commits,
  never inside it. The lock each of them takes is in
  [SECURITY.md](SECURITY.md#password-change-and-reset-against-a-concurrent-login).
- **A wrong step-up password answers 400, never 401** (`reauthenticate`,
  `src/services/auth.service.ts`): clients sign out on a 401.
- **The refresh cookie's name, path and domain come only from
  `refreshCookieSpec`** (`src/constants/auth.constants.ts`), and the
  controller reads it only through `currentRefreshCookie(env)`. A browser
  silently drops a `__Host-` cookie with a `Domain` or a path other than `/`,
  which looks like a logout. Under `COOKIE_SECURE` never add a fallback to the
  unprefixed `refreshToken` name: anyone who can plant it would sign the victim
  into their session. Put `COOKIE_DOMAIN` on the set, the clear and the OAuth
  session cookie alike, since a clear with another domain leaves the cookie
  behind. See [SECURITY.md](SECURITY.md#the-refresh-cookie).
- **The OAuth refresh cookie stays `SameSite=Lax`** (a decision, set by
  `setOAuthRefreshTokenCookie`, `src/controllers/auth.controller.ts`). It costs
  nothing, since both routes that act on the cookie are `POST`s behind the
  Origin check and the one `GET` that reads it, the callback, only revokes, and
  it lasts only until the first rotation re-sets it `Strict`. See
  [SECURITY.md](SECURITY.md#the-refresh-cookie).
- **Never link a Google identity to an address Google has not verified.**
  `resolveGoogleUser` (`src/services/google-auth.service.ts`) refuses it,
  because linking an unverified address is an account takeover. Don't relax
  that check or the never-verified-account claim; see
  [SECURITY.md](SECURITY.md#google-sign-in).
- **`APP_URL` must match the Google Cloud Console redirect URI exactly,**
  scheme and trailing slash included.
- **Behind TLS termination, set `TRUST_PROXY` and forward
  `X-Forwarded-Proto`.** When `COOKIE_SECURE` resolves true, `oauth.sid` is
  `Secure`, and express-session silently skips a `Secure` cookie on a request
  it doesn't see as HTTPS, which breaks Google sign-in.
- **Platform auto-join grants `viewer` only, and runs after the
  timing-equalised credential check.** A wider grant gives one compromised
  inbox on a `PLATFORM_EMAIL_DOMAINS` domain write access to every tenant; an
  earlier run leaks whether an address is registered.

### Tenants and roles

- **A tenant route composes `resolveTenant()` and `requireRole(...)`, and the
  tenant comes from `:slug` only.** A header selector that can name a different
  tenant than the path is a confused-deputy hole. Non-members get 404, not 403.
  To scope a new model: give it a `tenantId` column, take the tenant from
  `tenantPrincipal(request)` (`src/controllers/helpers.controller.ts`), filter
  on it in the repository, and mount the route under `/tenants/:slug/…`.
- **Services re-read the actor's role under lock and never trust
  `request.principal.role`.** `requireRole` is only the early gate; a role
  lost or lowered mid-request must still refuse the write
  ([ARCHITECTURE.md](ARCHITECTURE.md#layers)). A controller may report `role`
  or `access` but never authorizes on them.
- **Members join by invitation only, with one fixed 202 for any address.**
  Don't add a "no such user" 404 or a direct add: either reveals who has an
  account. The raw token travels in a JSON body, never an API URL, because
  tracing and proxy logs record URLs. See
  [SECURITY.md](SECURITY.md#invitations).
- **Keep the revoke UPDATE in `TenantInvitationRepository.createPending`.**
  `tenant_invitations_pending_unique` can't filter on `now()`, so an expired
  invitation still holds the slot, and without the UPDATE every re-invite after
  an expiry fails with 409.
- **Build a limiter once per router and mount that instance on every route
  that shares its budget** (the invite limiter on invite and resend in
  `src/routes/tenant.routes.ts`): two instances keep two in-memory fallback
  budgets.
- **Every authenticated write needs a limiter.** Mount
  `createRateLimiter(RATE_LIMITS.authenticatedWrite)` after `requireAuth` on a
  new `POST`/`PUT`/`PATCH`/`DELETE`, or give the route its own spec.
  `tests/unit/routes/route-limiters.test.ts` fails otherwise, and an allowlist
  entry there needs a reason.

### Staff routes

- **A staff route answers a refused caller exactly what an unknown path on the
  same router answers,** for every method, body and header. On a `/platform`
  route that means the role gate runs first: `requirePlatformRole`, then
  `requireJsonContentType`, then `requireRecentAuth()` where it applies, then
  the limiter. Anything earlier answers a non-staff caller a 415, `RateLimit-*`
  headers or a 401 `REAUTH_REQUIRED`. A staff route inside another router,
  today only `POST /auth/reauthenticate`, keeps that router's shared gates
  ahead of its role gate, because an unknown sibling path meets them too: the
  auth router's JSON gate gives a non-JSON body the same 415 an unknown
  `/auth/*` path gets, and the role gate then comes before the limiter. Keep
  `refusePlatformOptions` on every staff route's path, after any shared gate
  that would answer first, or Express answers OPTIONS with an `Allow` header.
  Pin each staff route by comparing it with an unknown sibling path, not with
  `/api/v1/<unknown>`: `tests/integration/api/platform-route-gates.test.ts`.
  See [SECURITY.md](SECURITY.md#platform-staff).
- **Only `src/services/platform-*.service.ts` import the five cross-tenant
  `platform-*` repositories** (lint enforces it). "Your tenants" stays on
  `TenantRepository.listForUser`; never serve it from a query that sees every
  tenant.
- **The platform tenant's member rules stay on the platform tenant.** There an
  owner may act on another owner (`canPlatformActorModifyTarget`), and a role
  change, a removal, leaving, an invitation and a resend need step-up
  (`requireRecentAuthOnPlatformTenant`), because every platform role reads
  every user and tenant; a revoke only removes a pending grant and needs none.
  On a customer tenant an owner acts only on their own ownership.
- **Staff acting on a customer tenant through platform access give a reason**
  (`requireRecentAuthAndReasonOnPlatformAccess`), and the service re-checks it
  under lock (`assertStaffReasonGiven`), since a membership deleted after
  `resolveTenant` leaves only platform access. See
  [SECURITY.md](SECURITY.md#step-up-and-a-stated-reason).
- **Route only the no-owner case through `createOwnerInvitation`.** It skips
  `canActorGrantRole` because its route's gate (platform admin, step-up, a
  reason) authorizes it.

### Audit

- **Record the audit entry in the write's own transaction:**
  `record(entry, tx)` (`src/services/audit.service.ts`). Never put an address
  or a token in metadata; record `hostnameDomain(email) ?? null`. Metadata
  schemas are strict, so a new key fails until its schema lists it.
- **`audit_logs` is append-only.** Only `retention.service.ts` and
  `platform-purge.service.ts` set `app.audit_purge`/`app.audit_purge_before`,
  and only `platform-purge.service.ts` sets `app.audit_redact`
  (`tests/unit/audit-purge-setting.test.ts`). Always pass the actor:
  the database can't tell a redacted `user` entry from one written without an
  actor. Tests delete audit rows with `truncateAuditLogs()`
  (`tests/helpers/audit-log.ts`) before a tenant or user, since the foreign
  keys are RESTRICT; don't add a `BEFORE TRUNCATE` trigger, or only a superuser
  can clean up. See [SECURITY.md](SECURITY.md#the-audit-log).

## Data

- **One Postgres client per process** (`src/services/database.service.ts`).
  A second client is a second pool, which doubles the connection budget and
  shows only under load ([ARCHITECTURE.md](ARCHITECTURE.md#data-layer)).
- **Row locks default to `FOR NO KEY UPDATE`.** Pass `'update'` (`RowLockMode`,
  `src/types/lock-mode.ts`) only when the transaction deletes the row or
  changes a key column: `FOR UPDATE` blocks the `FOR KEY SHARE` every
  foreign-key insert takes. Take locks in the documented order
  ([ARCHITECTURE.md](ARCHITECTURE.md#layers)); Postgres can't enforce it.
- **Bind a timestamp in raw `sql` as `${date.toISOString()}::timestamptz`.**
  A `Date` inside a `sql` template reaches postgres-js unserialised and the
  query fails; `lt(column, date)` is fine.
- **A list sort's timestamp key is validated by `sortAtField`**
  (`src/validators/cursor.validators.ts`), which `timestampSort` binds; never
  a bare regex or `z.iso.datetime()`: they let month 13 or year 0000 through,
  and the `::timestamptz` cast then fails as a 500.
- **Free-text fields use `safeText`:** single-line by default,
  `{ multiline: true }` for prose.
- **Every Redis key and channel goes through `redisKey()`**
  (`src/services/redis.service.ts`). Each test worker runs under its own
  prefix, and a literal key escapes it.
- **Wrap a Redis call a request waits on in `withRedisDeadline`**
  (`src/services/redis-deadline.service.ts`), with `getRedis()` inside the
  operation: node-redis never times out a written command, so a stalled Redis
  would hold the request. Two kinds of write use `waitForRedisWrite` instead,
  which is never skipped for the stall cooldown: a write whose loss would widen
  access (a session deny, a maintenance-mode change), and a dedupe or throttle
  key's release. A lost release does not widen access; the key lingers until it
  expires, which suppresses an audit or exposure record meanwhile. See
  [ARCHITECTURE.md](ARCHITECTURE.md#data-layer).
- **Don't remove the Redis clients' retry strategies, and start Workers only
  through `startWorkers()`** (`src/services/worker-supervisor.service.ts`).
  Without the strategies readiness hangs instead of reporting unreachable;
  Workers started one by one never recover from an outage. An outage test goes
  through a local TCP proxy (`tests/helpers/redis-proxy.ts`); never stop the
  shared Redis. See [ARCHITECTURE.md](ARCHITECTURE.md#data-layer).
- **Don't add a dependency check to `/health`.** It is liveness; a deep check
  goes on `/health/ready` through `createReadinessProbe`, which bounds it
  ([ARCHITECTURE.md](ARCHITECTURE.md#health-checks)).

## Jobs

- **Enqueue mail with `addEmailJob()` or `addNotificationJob()`, never
  `sendMail()` directly.** `sendMail()` never rejects; it returns
  `'sent' | 'failed'`, which the worker uses to decide whether BullMQ retries.
- **Never call `addEmailJob()` inside a transaction.** It inserts the message
  row on its own pool connection, so as many concurrent callers as
  `DB_POOL_MAX` deadlock. A write that must commit the row with its own writes
  calls `createTrackedEmail(…, tx)` inside and `enqueueTrackedEmail()` after
  commit, as `sendOnboardingReminder` does.
- **Work a controller starts after replying never rejects.** It wraps itself
  in `try`/`catch`; anything that can reject runs before the reply, where
  `BaseController.handle()` forwards it to `next()`.
- **A Worker's `failed` handler never rejects:** an unhandled rejection exits
  the process. The last attempt goes through `recordPermanentFailure`
  (`src/jobs/job-failure.job.ts`), and the terminal test is
  `attemptsMade >= attempts`, not `+ 1`, because BullMQ counts the attempt
  before it emits `failed`. Mount a new Worker's `failed` listener with
  `reportFinalJobFailure` first.
- **`registration_attempt` mail never goes through the notification worker:**
  an in-app row would be an enumeration oracle. `tenant_invitation` mail goes
  through `addEmailJob()` directly, since the invitee may have no account.
- **Some email channels can't be switched off** (`verify_email`,
  `password_reset_requested`, `password_changed`, `tenant_invitation`,
  `maintenance_mode_changed`): disabling them would lock a user out or silence
  the mail an account owner must see. `PUT /notifications/preferences`
  answers 400 for `emailEnabled: false` on any of them (the repository's
  `upsert` refuses it too); `inAppEnabled` can still be switched off for any
  type the caller can see. Change `NON_DISABLEABLE_EMAIL_TYPES`
  (`src/repositories/notification-preference.repository.ts`) and
  `NON_DISABLEABLE_NOTIFICATION_TYPES`
  (`src/validators/notification.validators.ts`) together, or a client can
  save an email preference the repository then ignores.
- **Notification `metadata` never holds `variables`.** Verification tokens
  live there; the worker strips them before the insert and the email fan-out
  reads them from the job payload (`src/workers/notification.worker.ts`).
- **The SSE stream authenticates with `Authorization: Bearer` and refuses a
  token with no `sid`** (`requireSessionId`,
  `src/controllers/notification-stream.controller.ts`). The revocation
  heartbeat closes streams by session id, so a sid-less stream would outlive a
  logout. Never put a credential in its URL. See
  [ARCHITECTURE.md](ARCHITECTURE.md#realtime-sse).

## Analytics, flags and error tracking

- **The `/api/v1/collect` proxy is the only request path to PostHog's ingest,
  and the staff timeline and Errors reads are the only request paths to its
  private API.** Server events leave only through the drain and the error
  reporter, via `sendBatch`; a request writes an outbox row and nothing else.
  See [ARCHITECTURE.md](ARCHITECTURE.md#analytics).
- **Send PostHog only the HogQL templates in `timeline-query.service.ts` and
  `errors-query.service.ts`,** with every id, range and cursor in `values`. A
  timeline row carries only `TIMELINE_PROP_KEYS`; a new builder key fails
  `tests/unit/constants/timeline.constants.test.ts` until it is allowlisted
  or excluded. Keep a cursor's timestamp the string PostHog returned: a `Date`
  drops its microseconds.
- **Trust a row's server fields only when its `server_sig` verifies**
  (`analytics-signature.service.ts`): the project key is public, so any
  browser can send `source: 'audit'`. Read a staff view's latest event with
  `argMax(column, (timestamp, uuid))` on every column; per-column
  `argMax(column, timestamp)` can mix two events with one timestamp, and the
  signature never verifies.
- **Add a staff read view's audit through `auditThrottledView`**
  (`platform-view-audit.service.ts`) and its event name to
  `TIMELINE_EXCLUDED_EVENTS`, so no timeline lists its own audit.
- **Outbox writes go through `enqueueAnalytics`, or `enqueueAuditAnalytics`
  for an audit entry,** never the repository: their savepoint and `try`/`catch`
  keep a failed insert from failing the user's action. `enqueueAnalyticsOrThrow`
  is for a caller that handles the failure itself (the groups backfill and
  flag exposure).
- **Never store `$group_set` in the outbox.** A `$groupidentify` row is a
  marker the drain fills at send time (`resolveGroupMarkers`); a stored
  snapshot sent late would overwrite a newer one in PostHog.
- **A user purge deletes the user's outbox rows in its transaction**
  (`deleteForDistinctId`): an event sent after PostHog deletes the person
  recreates it.
- **An audit action whose forwarded name collides with a product or
  `email_*` event goes in `AUDIT_EVENT_RENAMES`;** the builder's collision test
  fails until it does.
- **Don't hold a pool connection across `sendBatch`.** The drain's claim is one
  autocommit statement for that reason;
  `tests/integration/services/analytics/analytics-drain-outage.test.ts` runs a
  hanging PostHog against a one-connection pool.
- **Keep the analytics proxy ahead of `express.json` and give it no
  `on.error`** (`src/app.ts`, `analytics-proxy.routes.ts`). A body parser
  ahead of it consumes or refuses replay bodies; an `on.error` handler makes
  http-proxy-middleware skip its own error response, so a failed upstream
  request never answers. Log through a plugin.
- **Report a server error only from its one capture point:** `errorHandler`,
  the process-fault handlers in `src/index.ts`, or a Worker's `failed` listener
  through `reportFinalJobFailure`. Never add a logger transport, and never
  report an error the code already handles and logs. A deliberate 5xx
  `HttpError` is reported only when it carries `{ cause }`. See
  [ARCHITECTURE.md](ARCHITECTURE.md#error-tracking).
- **Keep `recordRouteTemplate` ahead of every router** (`src/app.ts`): Express
  restores `request.baseUrl` before `errorHandler` runs, so without it an
  event's `http_route` loses its mount path.
- **Gate a route with `requireFlag(key)` after `requireAuth`, after
  `resolveTenant()` for a tenant-scoped flag, and before validators.** A closed
  gate answers the unknown-route 404, never a 403 or a flag-specific message;
  a tenant-scoped gate outside `/tenants/:slug/…` answers 404 for everyone and
  fails `tests/unit/routes/flag-gates.test.ts`.
- **Never take a flag value from a client, and never add a PII or `app`
  trait.** The exposure routes re-evaluate on the server, and targeting traits
  are only `FLAG_TRAITS`. Read a flag in request code through
  `flagContextFor(request)`, which memoises per request; a worker uses
  `flagContextForUser`. See [ARCHITECTURE.md](ARCHITECTURE.md#feature-flags).
- **`pnpm flags:sync` never edits or deletes a PostHog flag, and never prints
  a PostHog answer body:** the body names the flag's creator.

## Maintenance mode

- **Every new route needs a row in `MAINTENANCE_ROUTE_RULES`**
  (`src/constants/maintenance-mode.constants.ts`).
  `tests/unit/routes/maintenance-mode-gates.test.ts` fails on a route with no
  rule and on a rule with no route. A customer route Apex calls also joins
  `MAINTENANCE_STAFF_ROUTES` and sits behind `requireAuth`, which runs the
  staff pass.
- **Never read Postgres or Redis for the mode in a request, except behind
  `/platform/maintenance-mode`.** The gate reads the replica's in-memory store
  (`getMaintenanceMode()`), so a request costs nothing extra and a Redis or
  Postgres outage can't flip it. The two exceptions are the staff view
  (`getPlatformMaintenanceMode`) and the change's row lock
  (`lockMaintenanceModeState`). See
  [ARCHITECTURE.md](ARCHITECTURE.md#maintenance-mode).
- **A test that changes the mode** writes the row with a higher version
  (`storeMaintenanceMode`, `tests/helpers/maintenance-mode.ts`) and calls
  `reloadMaintenanceMode()`
  (`src/services/maintenance-mode/maintenance-mode-store.service.ts`), and
  resets it the same way (`resetMaintenanceMode`): a store ignores a row whose
  version is not above its copy's. **A test that pauses the queues resumes
  them** (`setAllQueuesPaused(false)`) before the file ends: the pause is a flag
  in Redis under the worker's prefix, and the next file's jobs would never run.

## Tests

- **No test file lives under `src/`** (lint enforces it). Tests go in
  `tests/unit/` or `tests/integration/`, mirroring the subject's `src/` path,
  named `.test.ts`. Support code lives in `tests/helpers/` and
  `tests/fixtures/`.
- **A test that reaches the real database or Redis lives under
  `tests/integration/`, never `tests/unit/`.** The git hooks run unit tests
  with Docker down, and `vitest.unit.config.ts` excludes by path only. Check
  where a test's dependencies reach, not where its assertions live.
- **HTTP tests use `request` or `agent` from `tests/helpers/request.ts`, never
  supertest directly** (lint enforces it). A hand-rolled test server calls
  `listen(0, '127.0.0.1')`: on macOS a `::` bind can take a port another
  process holds on `127.0.0.1`.
- **Enable analytics in a test with a mock, never `process.env`.** `getEnv()`
  is memoised, so a mock is what lets one file switch analytics per test. Each
  file runs in its own process (forks, with vitest's default isolation), so
  neither leaks into another file. A test that only reads outbox rows mocks
  `isAnalyticsEnabled`, as
  `tests/integration/services/analytics-outbox.service.test.ts` does; one that
  sends mocks `getEnv()` with a key and a `POSTHOG_HOST` pointing at
  `startFakePosthog()` (`tests/helpers/fake-posthog.ts`). Delete
  `analytics_outbox` rows in the file's own hooks, since the worker's
  database is shared by its files.
- **Never set `process.env` to change config after `getEnv()` has run;** pass
  the value as an argument instead, as `startServer(port)` takes the port.
- **An integration test that asserts mail delivery starts its own
  `startEmailWorker()`** (and `startNotificationWorker()` for verification
  mail): `createApp()` starts no worker. In `afterAll`, close it before
  `obliterate` and `closeQueue()`. `tests/integration/api/auth.test.ts` shows
  both.
- **A test that reads data `recordPermanentFailure` scrubbed waits for its log
  line** (`waitForLoggedCall`, `tests/helpers/queue-jobs.ts`), not the
  `failed` event.
- **A test asserting live notification delivery first calls
  `waitForNotificationSubscriber`** (`tests/helpers/notification-subscriber.ts`).
- **Test a retention rule with `runRetentionPurge(now, days)`,** `now` years
  in the past: a past `now` keeps other files' rows out of every predicate
  (`tests/integration/services/retention.service.test.ts`).
- **The suite runs at `LOG_LEVEL=silent`.** Debug with
  `LOG_LEVEL=debug pnpm test <file>`.
- **To change test parallelism, change `WORKER_COUNT`**
  (`tests/helpers/worker-database.ts`), which provisions one database per
  worker and sets `maxWorkers`. A worker with no database fails as a bare
  connection error. Two concurrent `pnpm test` runs on one compose stack share
  the worker databases and prefixes, so they are unsupported.
- **The compose ports 5433/6380 are deliberate,** so the stack never meets a
  native Postgres or Redis. `tests/unit/connection-target.test.ts` checks the
  committed `docker-compose.yml` and `.env.test`, never `getEnv()` at runtime,
  because CI's services publish 5432/6379.
- **A `docker-compose.yml` service without `profiles:` is infrastructure
  only.** Plain `docker compose up -d --wait` (the Quickstart, CI and the test
  setup) must start nothing else; every app service sits behind the `dev` or
  `prod` profile, and every published port binds `127.0.0.1`.
- **Never break a file under `src/` on disk to prove a test catches it:** the
  broken state is a real vulnerability another session can commit. Use
  `withMutatedMethod` or `withMutatedModule` (`tests/helpers/mutate.ts`), which
  mutate process memory for one callback. Red/green evidence comes from a
  committed test gated by `MUTATION_PROOF === '1'`, as
  `tests/integration/services/token-reuse-mutation.test.ts` is. If the helpers
  can't reach the target, extend `mutate.ts`.
- **Don't build a leak assertion on `JSON.stringify(err)`:** an `Error`'s
  `message` and `stack` are non-enumerable, so it prints `{}`. Use
  `util.inspect(err, { depth: null })`. A `DrizzleQueryError`'s `query` and
  `params` are enumerable, so the same line is load-bearing in one test and
  vacuous in the next.
- **For a guard `a && b`, a test supplies the case where `a` is true and `b`
  is false;** otherwise `b` can be deleted with the suite green.
- **Before trusting a width, regex or prefix check, compute what it must
  reject and compare.** A 64-character column can't "structurally" exclude a
  64-character hex token; prefer a shape constraint (a `CHECK` on a pattern)
  to a width.
- **Run a check; don't read it.** A `CHECK` built with drizzle's `sql`
  template and bound values compiles and fails only when the migration runs.
  Prove an `@ts-expect-error` guards what it claims by removing it and
  watching the specific error appear.
- **Don't assert a constant against itself, or `toStrictEqual` between two
  calls that both throw:** either passes whatever the code does.
- **A helper's JSDoc matches its body:** a helper documented as polling
  polls, because the next caller relies on the comment.

### Test timing rules

`tests/helpers/timing.ts` holds the only two real-time waits a test may use.
Lint rejects the sleep forms under `tests/`: a `sleep()` call, a `setTimeout`
inside `new Promise`, `setTimeout` imported from `timers/promises`, and
`.waitForTimeout()`. That file is the only exemption.

1. Wait on a condition, never on a duration: `waitUntil(check, { message })`.
2. A deliberate wait is `settle(ms, reason)`. The reason names what can't be
   observed ("absence has no event", "poll interval").
3. Wall-clock upper bounds only when the bound is the claim under test. Each
   carries a comment naming what it proves and either references a product
   constant by name or has at least 10x headroom over a measured figure: the
   p99, or the worst measured run where the test has no p99 (as
   `tests/unit/lint-gates.test.ts` does for its cold lint runs).
4. No exact counts of process-wide resources. Count only what the test itself
   created.
5. Negative checks use a barrier event where one exists, and otherwise
   `settle` with a reason.
6. Never raise a timeout to fix a flake before its mechanism is known.

## Code conventions

- **Use `pnpm` only,** never npm or yarn (`packageManager` in
  `package.json`). Hooks call `pnpm exec`, never `npx`, which downloads the
  newest version of a tool missing from `node_modules`.
- **Read configuration through `getEnv()`, never at module scope.** It is lazy
  and memoised: parsing at import time would crash every importing file on one
  bad variable. Only `src/configs/env.config.ts`,
  `src/observability/tracing.ts`, `src/services/logger.service.ts` and
  `src/index.ts` read `process.env` (lint enforces it); `tracing.ts` loads via
  `--import` before validation.
- **Pick environment-dependent behaviour only through the `env.config.ts`
  helpers** (`isCookieSecure`, `logFormat`, `requiresSmtpTls`), never by
  reading `APP_ENV` or `NODE_ENV` at a call site. Cross-variable rules go in
  `assertEnvConsistent` (`env-consistency.config.ts`): an object-level
  `.refine()` on the schema breaks `getDatabaseUrl()`'s `.pick()`. Keep the
  `process.env.VITEST` guard and `quiet: true` around `.env` loading: without
  them a developer's `.env` loads under the tests, and dotenv's banner lands on
  stdout. See [ARCHITECTURE.md](ARCHITECTURE.md#configuration).
- **Log through `logger` (`@/services/logger.service`), never `console.*`**
  (lint enforces it). Don't pass `requestId` in log meta (the request-context
  mixin adds it and wins) and don't prefix messages with `[module]` (the
  `source` field names the caller). The facade is `(message, meta)`; direct
  pino calls are `(meta, message)`.
- **Log an error as an object, never `error.message`.** A Drizzle error's
  message embeds the bound parameters; the serializer redacts an error object
  and its `cause` chain, but not a string. A query-shaped value that isn't an
  `Error` needs `redactedForLog` at the call site.
- **No barrel files.** Import the module directly, never through a
  re-exporting `index.ts` ([ARCHITECTURE.md](ARCHITECTURE.md#no-barrel-files)).
- **When a layer-boundary rule refuses an import,** either the import is wrong
  or the zone list in `eslint.config.mjs` and its description in
  [ARCHITECTURE.md](ARCHITECTURE.md#layers) change in the same commit.
- **A route handler is a `BaseController` method built with
  `this.handle(handler)`** (`src/controllers/base.controller.ts`), unless it
  has a documented, file-local reason not to (a redirect, an SSE stream).
- **helmet is the first middleware** (`src/app.ts`), so its headers are on a
  preflight, a 404 and an error response too.
- **Comments.** Every named function, method, class, interface, type alias and
  exported const has a JSDoc description, tests included
  (`jsdoc/require-jsdoc`). Describe behaviour in prose; don't repeat the types
  in `@param`/`@returns`. Every other comment is a file JSDoc
  (`/** @file … */`) or a one-line `//` why, with no history;
  `local/comment-style` checks the form.
- **Scope an eslint disable as narrowly as the rule allows,** and give a
  scoped disable of a type-aware rule a comment on why the call site is safe.
- **Don't import or "fix" `tests/fixtures/lint-cycle/` or
  `tests/fixtures/lint-zones/`.** They are committed violations that
  `tests/unit/lint-gates.test.ts` lints to prove each gate fires.
- **Keep `tsconfig.json` and `tsconfig.typecheck.json` separate.** The build
  config compiles `src/` with `rootDir: ./src`; widening its `include` to
  `tests/` breaks the build with `TS6059`. The typecheck config is the wide one
  lint uses.
- **`drizzle.config.ts` uses `getDatabaseUrl()`, not `getEnv()`,** so
  `drizzle-kit` needs only `DATABASE_URL`
  ([DATABASE.md](DATABASE.md#drizzleconfigts-and-why-it-only-needs-database_url)).
- **Don't remove `tracing.ts`'s OTel loader hook** (`register()`): without it
  the CommonJS pino imported from ESM is never instrumented. After editing
  `otel-collector.yaml`, run `docker compose restart otel-collector`: it is
  bind-mounted, and `docker compose up -d` doesn't pick up the change.
- **A change is done when `pnpm lint`, `pnpm lint:docs`, `pnpm format:check`,
  `pnpm knip`, `pnpm test:coverage` and `pnpm build` all exit 0**
  ([CONTRIBUTING.md](CONTRIBUTING.md#before-you-open-a-pr)). Don't drop
  type-aware lint from pre-commit to speed it up.
- **Keep `ci.yml`'s concurrency group keyed on `github.event_name`, not
  `github.workflow`:** when `deploy.yml` calls `ci.yml`, `github.workflow` is
  the caller's name.
- **If the release App key is revoked, fix it; don't switch `release.yml` to
  `GITHUB_TOKEN`,** whose PRs and tags start no workflow
  ([CONTRIBUTING.md](CONTRIBUTING.md#releases)).

## Unused code (knip)

- **`pnpm knip` must exit 0.** Answer a finding by deleting the symbol, or by
  dropping its `export` when its own file still uses it. An export only a test
  imports counts as used.
- **Silence a false positive only in `knip.jsonc`, with a `//` comment above
  the entry naming what knip can't see** (a path string, a `--import` preload,
  a tool that reads the file). Use `entry` for a file loaded by path and
  `ignoreFiles` for a file nothing imports by design.
- **`pnpm knip --production` is an audit, not a gate:** it drops the tests, so
  every test seam shows up.

## Versions

- **Keep `typescript` within the `typescript` peer range of the
  `typescript-eslint` version `package.json` pins:** `pnpm lint` depends on its
  type-aware rules. Bump TypeScript past that range only once a
  `typescript-eslint` release admits it, and lift the matching hold in
  `renovate.json` with it.
- **Lift the TypeScript and Node holds in `renovate.json` by hand, never by
  merging a Renovate PR;** the steps are in
  [CONTRIBUTING.md](CONTRIBUTING.md#dependency-policy).

## Never install

- **A PostHog client SDK for sending events** (`posthog-node`). Its capture
  only queues an event, so the drain could not tell whether a batch landed;
  `src/services/analytics/posthog-batch.service.ts` sends `POST /batch/` with
  `fetch` instead.
- **`svix`.** The Resend signature check is a few lines of `node:crypto`
  (`src/services/email-webhook-resend.service.ts`), and a dependency would bring
  its own tree under the 3-day release-age rule.
