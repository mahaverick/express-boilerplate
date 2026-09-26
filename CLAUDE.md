# CLAUDE.md

Gotchas and non-derivable context only — things a maintainer (human or
agent) would otherwise rediscover the hard way. This file does not
summarize [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[STRUCTURE.md](STRUCTURE.md), [DATABASE.md](DATABASE.md),
[CONTRIBUTING.md](CONTRIBUTING.md), or [MIGRATIONS.md](MIGRATIONS.md) —
read those for how things work. This file is for the reasoning that isn't
visible from reading the code, and the traps that look like a good idea
until you check.

## Environment and processes

- **`getEnv()` is lazy on purpose.** A module-scope `parseEnv(process.env)`
  would throw during import resolution, which is the exact failure mode
  this repo was rebuilt to remove (one bad env var used to crash a
  completely unrelated test file at import time, and the error looked
  nothing like its cause). It also **memoises** — once called, the parsed
  environment is frozen for the process. A test cannot change behavior by
  assigning to `process.env` after any module has already called
  `getEnv()`; pass the value in as an argument instead (see
  `startServer(port)` in `src/server.ts`, which exists specifically because
  `APP_PORT` can't be overridden this way once `database.service.ts` has
  already read it at module scope).
- **`.env` loading lives in `env.config.ts`, guarded by `process.env.VITEST`.**
  `config({ quiet: true })` from `dotenv` runs at module scope, unless
  Vitest set `process.env.VITEST` first. Do not remove the guard: without
  it, a developer's local `.env` would load underneath
  `tests/helpers/setup-global.ts`'s own environment (process env >
  `.env.test.local` > `.env.test`), leaking personal config into the suite
  — a test that passes on one machine and fails on another for reasons
  that look nothing like configuration. `quiet: true` is also load-bearing:
  without it, dotenv's own startup banner lands on stdout ahead of
  anything this process prints, which corrupts a command whose output is
  meant to be machine-readable (a CI step piping JSON, for instance).
  `.env` also reaches `tracing.ts`, which loads first: `pnpm dev` and
  `pnpm start` pass `--env-file-if-exists=.env` to Node. The Docker `CMD`
  does not; the image has no `.env`, and the orchestrator supplies the
  environment.
- **`APP_ENV` names the deployment; `NODE_ENV` is Express's.** `APP_ENV`
  (`local`/`dev`/`qa`/`prod`) is required and every environment-dependent
  default derives from it, only through the helpers in `env.config.ts`
  (`isCookieSecure`, `logFormat`, `requiresSmtpTls`). Never read `APP_ENV` or
  `NODE_ENV` at a call site to pick behaviour. Cross-variable rules live in
  `assertEnvConsistent` (`env-consistency.config.ts`), called first in
  `index.ts`, not in the schema: an object-level `.refine()` breaks
  `getDatabaseUrl()`'s `.pick()`.
- **`/health` is shallow, `/health/ready` is deep, on purpose.** Making
  `/health` check the database would turn a transient blip into a restart
  loop. Don't "improve" liveness by adding a dependency check to it.
- **The compose stack's Postgres/Redis ports (5433/6380) are not a
  typo.** A native Postgres or Redis on the default ports wins the bind
  over Docker's wildcard bind, and the Redis case fails **silently** — any
  Redis answers `PING`. See `docker-compose.yml`'s header comment and
  ARCHITECTURE.md for the full reasoning; a committed test
  (`tests/unit/connection-target.test.ts`) guards against reverting this — by
  reading `docker-compose.yml` and `.env.test` off disk and asserting they
  agree, **not** by asserting on `getEnv()` at runtime. That distinction is
  load-bearing: CI's `services:` publish the container-default ports, so CI
  runs against 5432/6379, and a runtime assertion was guaranteed red on the
  first pull request. The invariant worth guarding
  belongs to the committed files.
- **The Redis clients' retry strategies are load-bearing, not
  decoration.** Before a client's first `ready`, every client gives up after
  a few retries, so `isRedisReachable()`/`isQueueReachable()` (and
  `GET /health/ready`) report unreachable instead of hanging at boot
  (`redis-unreachable.service.test.ts` and `queue-unreachable.service.test.ts`
  pin this by timing out if removed). After `ready`, every client retries
  forever with backoff, so an outage never leaves a dead client behind
  (`redis-outage.service.test.ts`, via a local TCP proxy, never by stopping
  the shared Redis). While a client reconnects, nothing waits for Redis to
  come back: node-redis runs with `disableOfflineQueue`; BullMQ producers
  get their own ioredis connection with the offline queue off, so an enqueue
  rejects; `isQueueReachable` checks both queue connections and reports false
  for one in any post-ready status but `ready`; and `closeQueue` disconnects
  instead of queueing a `QUIT`. Only BullMQ Workers keep the offline queue,
  which they need. A queue connection that gives up before its first `ready`
  is replaced on next use (the producer's Queues with it). Workers on it
  never recover by themselves: BullMQ does not re-initialise a connection
  whose init failed, and when that failure is not one BullMQ counts as a
  connection error (ECONNREFUSED, or "Connection is closed."), such as
  ECONNRESET, its fetch loop retries with no delay, starving the event loop.
  So `startWorkers()` (`worker-supervisor.service.ts`) closes them inside
  that connection's `'end'` event, before they can spin, and starts new ones
  on a fresh connection (`worker-outage.test.ts`). If starting them throws,
  it closes any it started. At boot it rethrows, so the process exits 1. On
  a restart it can't throw from inside `'end'`, so `isQueueReachable()`
  reports false until the next pre-ready reconnect restarts them or the
  process restarts. Start Workers through it, not one by one, in anything
  that runs through an outage.
- **`drizzle.config.ts` uses `getDatabaseUrl()`, not `getEnv()`.** Routing
  it through `getEnv()` would make every `drizzle-kit` invocation require
  JWT/session secrets that have nothing to do with writing a migration. See
  DATABASE.md.

## Logging

- **`logger` from `@/services/logger.service`, not `console.*`.** An ESLint
  `no-restricted-properties` rule enforces this for `src/`. Two files are
  exempt: `logger.service.ts` (writes through pino and uses `console.error` in
  the Slack destination's failure path to avoid re-entry) and
  `index.ts` (pre-boot error path where the logger is not available).
- **Request-id correlation is automatic.** The `requestContext` middleware
  wraps each request in an `AsyncLocalStorage` context. The logger reads from
  it on every call — callers never pass the id. Code outside a request (startup,
  Redis error handler) simply omits the field. `mixinMergeStrategy`
  (logger.service.ts) makes the mixin's correlation fields win over a
  caller-supplied field of the same name — a caller passing `requestId` in
  meta cannot override the real ALS value.
- **Caller file:line is automatic.** The logger parses `new Error().stack` on
  each call. The `[moduleName]` prefixes that some call sites used to include
  in their messages are redundant — the `source` field handles it.
- **Slack destination deduplicates by `${source}:${message}`.** The first
  occurrence sends immediately; duplicates within a 60-second window are
  suppressed. A summary is sent after the window expires if any were suppressed.
- **pino, format from `logFormat(env)`:** `LOG_FORMAT` when set, else
  pino-pretty on `APP_ENV=local` and JSON everywhere else.
  `createPinoLogger` keeps the winston-era shape (`level` label, ISO
  `timestamp`, `message`). Direct pino calls are `(meta, message)`;
  application code uses the `logger` facade, which keeps `(message, meta)`.
- **Log errors as objects; the serializer redacts them.** `serializeErrors`
  (`logger.service.ts`) replaces any logged error that carries a query and
  its parameters with `redactedForLog(error)`. That covers each top-level
  Error-valued key and its `cause` chain, five errors deep. A string gets
  none of that: a Drizzle error's `message` embeds the bound parameters, so
  `{ error: error.message }` logs them. Calling `redactedForLog` at a call
  site is idempotent and still fine, and a query-shaped value that isn't an
  `Error` still needs it.

## Job queue

- **`addEmailJob()` from `@/jobs/email.job`, not `sendMail()` directly.**
  Email sending goes through a BullMQ queue. `auth.service.ts`'s `register`
  and `requestPasswordReset`, and `verification.service.ts`'s
  `prepareResendVerification`, each do the enqueuing. `register` and
  `prepareResendVerification` return a closure the controller starts with
  `void` after replying; `requestPasswordReset` does its own work
  internally, also started with `void` after the reply. Once one of these
  is running post-reply — the returned closures, and all of
  `requestPasswordReset` — it never rejects: each wraps its own work in
  `try`/`catch` and logs a failure rather than throwing it. `register`
  and `prepareResendVerification` themselves can still reject, but only
  BEFORE that point: `register` rethrows any database error that isn't the
  expected 409 (`auth.service.ts`), and `prepareResendVerification` awaits
  an unguarded `findByEmail` (`verification.service.ts`) — both calls are
  awaited by the controller ahead of the reply, so a rejection there is an
  ordinary pre-reply error `BaseController.handle()` forwards to `next()`,
  not a post-reply one. `sendVerificationMail` (`verification.service.ts`)
  enqueues via `addNotificationJob()` (see "Notifications" below), not
  `addEmailJob()` directly. `sendRegistrationAttemptMail`
  (`auth.service.ts`) and `tenant-invitation.service.ts`'s
  `dispatchInvitationMessages` both call `addEmailJob()` directly instead.
- **`WORKER_ENABLED` gates the in-process workers.** Default `true` (API +
  workers in one process). Set `false` for API-only pods; a separate worker
  deployment sets `true` and processes jobs from the shared Redis queues.
  `WORKER_CONCURRENCY` (default 5) sets the email and notification workers'
  concurrency; the maintenance worker always runs one job at a time.
- **A job's final failure is its only `error` line.** Each worker's
  `failed` handler logs a retryable attempt at `warn`. On the last attempt
  (attempts used up, or `UnrecoverableError`) it calls
  `recordPermanentFailure` (`src/jobs/job-failure.job.ts`), which scrubs
  every `…Url`/`…Token` key in the stored data, then logs
  `job failed permanently` once. BullMQ counts the attempt before it emits
  `failed`, so the terminal test is `attemptsMade >= attempts`, not `+ 1`.
  The handler must never reject, because an unhandled rejection exits the
  process; `recordPermanentFailure` catches its own errors. A test that
  reads the scrubbed data waits for the log line (`waitForLoggedCall`,
  `tests/helpers/queue-jobs.ts`), not for the `failed` event, since the
  scrub runs after it.
- **The retention purge runs on the `maintenance` queue.**
  `ensureRetentionSchedule()` (`src/jobs/maintenance.job.ts`) upserts one
  scheduler. The worker supervisor calls it each time it starts a worker
  generation (boot is the first); a failure logs `warn` and is retried with
  the next generation, which starts only after a worker connection gives up
  before its first ready. It is idempotent, so every replica calls it. To
  test a rule, call `runRetentionPurge(now, days)` directly, with `now`
  years in the past and explicit `days`. `getEnv()` is memoised, and a past
  `now` keeps every other file's rows out of every predicate. See
  `tests/integration/services/retention.service.test.ts`.
- **Every Redis key and channel goes through `redisKey()`**
  (redis.service.ts): `REDIS_KEY_PREFIX` + `:` + parts, covering BullMQ
  (`bull`), rate limits (`rl:<name>`), the denylist, OAuth sessions (`sess`)
  and the notification channel. Never write a literal key. Each vitest worker
  runs under `test-w${VITEST_POOL_ID}` (tests/helpers/redis-prefix.ts), so a
  Worker in pool 1 never processes pool 2's jobs, and global setup clears
  only `test-w*:rl:*`, so a dev server sharing the compose Redis keeps its
  keys. Two concurrent `pnpm test` runs on one compose stack still share
  those prefixes, as they share the worker databases; that is unsupported.
- **`sendMail()` returns `'sent' | 'failed'`**, not `void`. The worker uses
  this to decide whether BullMQ should retry. The never-reject guarantee
  (Ruling G) is unchanged.
- **An integration test that asserts mail was delivered must run its own
  `startEmailWorker()`.** Nothing else in the test process consumes a queued
  job — `createApp()`/`startServer()` never start one, only `index.ts`'s
  `boot()` does, and tests never import that. See
  `tests/integration/api/auth.test.ts` and `verification.test.ts` for the
  pattern: one `Worker` for the whole file, started as a module-level
  `const worker = startEmailWorker()` (not `beforeAll` — `unicorn/no-top-level-assignment-in-function`
  rejects reassigning a top-level `let` from inside it, and `startEmailWorker()`
  is synchronous so a plain `const` works), closed in `afterAll` before
  `getEmailQueue().obliterate({ force: true })` and `closeQueue()` — same
  ordering `gracefulShutdown` uses. A test asserting _verification_ mail
  delivery specifically also needs a `startNotificationWorker()` alongside
  it — that mail only reaches the "email" queue after the notification
  worker fans the `verify_email` job out to it (see "Notifications" below);
  the same two files show both workers started and closed together.

## Notifications

- **`addNotificationJob()` from `@/jobs/notification.job`, not `addEmailJob()`
  directly,** for events that have both in-app and email channels. The
  notification worker checks preferences and fans out. `registration_attempt`
  is the exception — email-only, never routed through the notification worker
  (an in-app row would be an enumeration oracle — see Ruling G).
- **`tenant_invitation` goes the other way round.** The invitation email is
  enqueued with `addEmailJob()` directly, because the invitee may have no
  account. The notification job, sent only to a live, verified invitee,
  carries no `email`. The type isn't configurable, and the mailed link is
  the only way to accept.
- **`verify_email` email channel is not user-disableable.** A user who
  disables email for verification locks themselves out. The preference
  repository returns `true` for it regardless.
- **`metadata` on the notifications table must NOT contain `variables`.**
  Verification tokens live in `variables`. The worker strips them before
  the database insert — the email fan-out reads them from the job payload,
  not from the stored row.
- **SSE stream at `GET /api/v1/notifications/stream`** authenticates the
  same way every other route does — `Authorization: Bearer <jwt>`, behind
  `requireAuth` — with no credential riding in the URL. It used to read a
  `?token=<jwt>` query parameter instead, because `EventSource` cannot set
  custom headers; the client now opens the connection with `fetch`, which
  can. See `docs/superpowers/specs/2026-09-23-sse-auth-and-multi-frontend-design.md`
  §0 for why a short-lived single-use ticket and cookie-based auth were both
  designed and then rejected in favour of this. One asymmetry is
  deliberate, not drift: `requireAuth` tolerates a bearer token that
  verifies but carries no `sid` claim (bounded by the token's own expiry),
  while this stream's handler (`requireSessionId`,
  notification-stream.controller.ts) rejects one outright — the revocation
  heartbeat can only close an already-open connection by session id, so a
  sid-less stream would survive a logout or revocation until its token
  expired, rather than closing at the next heartbeat.
- **Live notifications cross replicas via Redis pub/sub** on
  `redisKey('notifications')` (notification-emitter.service.ts). The
  publishing process gets its own copy back through its subscriber, and
  delivers locally only when the publish fails. The subscriber is opened on
  the first `onNotification`, not at boot, and when it reconnects after an
  outage every open stream is closed so clients replay the gap via
  `Last-Event-ID`. A subscriber that fails to start while streams are open is
  retried on a backoff (1s, doubling to 30s) until it starts or the last
  stream closes, and that late start closes every open stream the same way.
  A failed attempt closes nothing, so an outage causes no reconnect storm.
  Delivery is asynchronous: a test asserting live delivery
  must first call `waitForNotificationSubscriber`
  (`tests/helpers/notification-subscriber.ts`).

## OAuth

- **Google OAuth is optional.** When `GOOGLE_CLIENT_ID` is unset, the OAuth
  routes are not mounted. `passport.config.ts`'s `configurePassport()`
  throws at boot if `GOOGLE_CLIENT_ID` is set without `GOOGLE_CLIENT_SECRET`
  — the reverse (a secret with no client id) is not checked, since
  `GOOGLE_CLIENT_ID` alone already gates whether Google login is enabled at
  all, and a lone `GOOGLE_CLIENT_SECRET` never reaches that check.
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
- **Sessions are OAuth-scoped only.** `express-session` runs on
  `/auth/google` and `/auth/google/callback` only (5-minute TTL). The rest
  of the API is stateless (JWT).
- **`oauth.sid` needs `req.secure` when `COOKIE_SECURE` resolves true.**
  express-session silently skips a `Secure` Set-Cookie on a non-HTTPS
  request, so behind TLS termination set `TRUST_PROXY` and forward
  `X-Forwarded-Proto`. Boot warns when Google login is on and
  `TRUST_PROXY=false`.
- **The refresh cookie's name, path and domain come only from
  `refreshCookieSpec`** (`auth.constants.ts`). The controller gets the
  current cookie only through its `currentRefreshCookie(env)`, and calls
  `refreshCookieSpec` directly only for the legacy forms it clears. It gives `__Host-refreshToken`
  at `/` when secure with no `COOKIE_DOMAIN`, `__Secure-refreshToken` at
  `/api/v1/auth` with it, and plain `refreshToken` on local http. Don't
  write the name or path anywhere else. A browser silently drops a
  `__Host-` cookie set with a `Domain` or a path other than `/`, and that
  looks like a logout, not an error. Refresh and logout also read the
  legacy `refreshToken` (`LEGACY_REFRESH_TOKEN_COOKIE_NAME`), and a
  response clears it when the request presented it. The fallback goes at
  the next major.
- **`COOKIE_DOMAIN` goes on the refresh-cookie set, its clear, and the OAuth
  session cookie.** A clear with a different domain leaves the cookie behind.
  After a domain change the browser sends two cookies of the same name,
  oldest first, and `readCookie` (`auth.controller.ts`) takes the last, the
  most recently created. Reading the first would hand a stale token
  to reuse detection, which revokes the live session. Reverting to an earlier
  domain is the one case last-wins misses: an overwritten cookie keeps its
  original creation time.

## Multi-tenancy and RBAC

- **Opt-in seam.** Existing routes are unaffected. New routes compose
  `resolveTenant()` and `requireRole(...)` middleware as needed.
- **`resolveTenant()`** reads the tenant slug from `request.params.slug` —
  the only tenant selector this codebase has. There is deliberately no
  header-based alternative: trusting a client-supplied header to name a
  DIFFERENT tenant than the URL's own `:slug` would let a caller send one
  tenant in the path and another in the header, with whichever a handler
  forgets to re-check becoming a confused-deputy hole.
- **Non-members get 404** (not 403). Ruling G — don't leak tenant existence.
  Staff (members of the `is_platform` tenant) are the one exception: in a
  tenant they don't belong to, `resolveTenant` admits them with their
  platform role as the effective role (`access: 'platform'`). A staff user
  who IS a member gets only their membership role: membership wins. The
  platform tenant itself is members-only.
- **5-tier roles:** owner > admin > manager > editor > viewer. The
  actor→target matrix (`canActorModifyTarget`) is a pure function in
  `src/policies/tenant.policy.ts`, applied inside
  `src/services/tenant-membership.service.ts`'s `changeRole`/`removeMember`
  — which re-read the actor's own membership under lock, inside the same
  transaction, before evaluating it against the matrix. That re-read closes
  the actor-side role race: a demotion that lands between the coarse
  route-level `requireRole` gate and the write cannot slip through on a
  stale role. See ARCHITECTURE.md's `## Layers` section for the lock order
  (owner rows, then memberships by `user_id`, then the actor's
  platform-tenant membership `FOR SHARE`). `requireRole(...roles)`
  itself treats each listed role as a floor (`isRoleAtLeast`), not an exact
  match. Every member and invitation write re-applies the route's own bar
  on the role it just re-read: `changeRole` requires owner; `removeMember`,
  `invite`, `resend`, `revoke`, `updateTenant` and `updateSettings` all
  require admin (`lockActorRole`/`lockActorAndTarget`,
  `tenant-membership.service.ts`: the first calls `resolveActorAccess`, the
  second calls `lockTenantAccess` directly — both in
  `tenant-access.service.ts` and taking the same lock order, so a staff
  user demoted mid-request is refused the same way). The two statuses
  this can produce are both races, not routine errors: an actor with no way
  into the tenant by the time the write locks it — a member removed, or a
  staff user whose platform role is gone — gets 404 `Tenant not found` (the
  same not-a-member answer `resolveTenant` gives), and one demoted below the
  bar mid-request gets 403 `Insufficient permissions`.
- **`request.principal`** carries
  `{ tenantId, tenantSlug, isPlatformTenant, role, memberRole, platformRole, access }`
  after `resolveTenant` runs. `role` is the effective role that
  `requireRole` checks. Services never trust it: they re-read access under
  lock. A controller may report
  `role`/`access` (`GET /tenants/:slug` does) but never authorize on them.
  Separate from `request.user` (the authenticated identity, not the
  authorization context).
- **Tenant context in logs.** `tenantId` appears in every log line for
  tenant-scoped requests, read from the same `RequestContext`
  AsyncLocalStorage store the request-id uses.
- **Members join by invitation only; there is no direct add.** `POST
/tenants/:slug/invitations` answers 202 with one fixed body whether or not
  the address has an account. The one exception is 409 `already_member`,
  which only an owner or admin can see. Don't bring back a "no such user"
  404: that enumeration oracle is why `POST /tenants/:slug/members` was
  removed. Accepting (`POST /invitations/accept`) needs a signed-in user
  whose **verified** address equals the invited one (403
  `invitation_email_mismatch` or `invitation_email_unverified`), so a
  forwarded link is useless to anyone else. The raw token lives only in the mailed link. The
  table stores its SHA-256 (`hashToken`), and the `tenant_invitation` in-app
  notification's metadata is `{ tenantSlug, invitationId }` only. Resend
  and revoke answer 404 `invitation_not_found` for a UUID that is not a
  pending invitation, but 400 validation for a `:id` that is not a UUID at
  all.
- **An expired invitation still holds its pending slot.**
  `tenant_invitations_pending_unique` can't filter on `now()`, so
  `TenantInvitationRepository.createPending` revokes the old pending row
  before it inserts. Remove that UPDATE and every re-invite after an expiry
  fails with a 409.
- **Invite and resend share one 30-per-hour budget.** Under Redis they
  merge by the `rl:invite-tenant-member:` prefix and the user-id key. On the
  in-memory fallback each limiter instance counts alone, so
  `createTenantRouter` builds `createRateLimiter(RATE_LIMITS.inviteTenantMember)`
  once and mounts it on both (`tests/unit/routes/tenant.routes.test.ts` pins
  this). Calling `createRateLimiter` again per route would split the budget
  only while Redis is down.
- **The raw token is never in an API URL.** Preview and accept both take
  `{ token }` in a JSON body (`POST /invitations/preview`,
  `POST /invitations/accept`). The only URL that carries the token is the
  frontend page the email links to, and both sides send
  `Referrer-Policy: no-referrer` (helmet.config.ts here). Don't add a
  `GET ?token=` form: HTTP tracing (`url.query`) and proxy access logs
  record URLs, and OTel's default redaction list doesn't include `token`.
- **Resend re-checks `canActorGrantRole`** against the invitation's role,
  because resending re-issues it. There is no `authorize` callback: resend
  and invite each re-read the actor's own membership under lock inside
  `src/services/tenant-invitation.service.ts`'s transaction — requiring at
  least admin, the same bar the route itself gates on — and evaluate
  `canActorGrantRole` against that read — the same actor-side race fix
  `changeRole`/`removeMember` use. Revoke re-reads the actor's membership
  under lock too, at the same admin bar, closing the same race, but has no
  role being granted, so it has nothing for `canActorGrantRole` to check.
- **Every tenant, member and invitation write records its audit entry in
  the same transaction.** Call `record(entry, tx)` from
  `audit.service.ts` after the write, with the write's own `tx`. A pool
  write survives a rollback, and `audit-writes.test.ts` catches it. Each
  action's metadata schema is a strict object schema (`z.strictObject`), so
  a new key fails the write until the schema lists it. Never put an
  address or a token in metadata. For an address, record
  `hostnameDomain(email) ?? null` (`utilities/email.utilities.ts`), as the
  invitation service's `auditEmailDomain` does: the schemas accept only a
  lowercase dotted hostname (or null, on the invitation actions), and
  `emailDomain` can return a value they reject.
- **`audit_logs` is append-only, and that bites test cleanup.** A trigger
  refuses every UPDATE. It refuses DELETE too, except in a retention purge
  transaction that set `app.audit_purge` to `on` and
  `app.audit_purge_before` past the row's `occurred_at` (off by default:
  `RETENTION_AUDIT_LOGS_DAYS=0`). It reads each through `coalesce`: an unset
  `current_setting(…, true)` is NULL, and a plpgsql `IF` on NULL does not
  raise. Only `retention.service.ts` may set them
  (`tests/unit/audit-purge-setting.test.ts`). Its foreign keys to `users`
  and `tenants` are RESTRICT. So an `afterEach` that deletes a tenant or user that has
  audit rows fails. Call `truncateAuditLogs()`
  (`tests/helpers/audit-log.ts`) first. TRUNCATE fires no row trigger;
  don't add a `BEFORE TRUNCATE` trigger, or only a superuser can clean up.
- **Staff routes answer 404, and the limiter sits after the gate.**
  `requirePlatformRole` (`platform.middleware.ts`) answers non-staff with
  the app's own `404 Not found`. In `platform.routes.ts` the limiter comes
  after it, the reverse of `tenant.routes.ts`: a limiter first would put
  `RateLimit-*` headers on the 404 and reveal the route.
- **The all-tenants repository has one importer.**
  `repositories/platform-tenant.repository.ts` may be imported only from
  `services/platform-*.service.ts` (a `no-restricted-imports` block in
  `eslint.config.mjs`). "Your tenants" stays on
  `TenantRepository.listForUser`. Don't merge the two paths.
- **Auto-join grants viewer, and nothing more.** `PLATFORM_EMAIL_DOMAINS`
  admits verified addresses as `viewer` only. It runs after the credential
  check and never fails a sign-in. Don't widen the grant — a single
  compromised inbox on a listed domain would then get write access across
  every customer tenant, not just read — and don't run it before the
  timing-equalised credential check, which would leak whether an address
  is registered through response timing.

### How to scope your own model by tenant

1. Add `tenantId` column to your model:
   ```typescript
   tenantId: varchar('tenant_id', { length: 36 })
     .notNull()
     .references(() => tenantModel.id, { onDelete: 'cascade' })
   ```
2. In your repository, filter by tenant:
   ```typescript
   const tenantId = requestContextStore.getStore()?.tenant?.tenantId
   if (!tenantId) throw new Error('Tenant context required')
   // Add .where(eq(model.tenantId, tenantId)) to your queries
   ```
3. Mount the route behind `resolveTenant()` on a `/tenants/:slug/*` route —
   it reads the slug from `request.params.slug`, the only source this
   middleware supports:
   ```typescript
   router.get('/tenants/:slug/projects', requireAuth, resolveTenant(), listProjects)
   ```
   A resource route with no `:slug` segment of its own has no tenant to
   resolve — nest it under `/tenants/:slug/*` instead of inventing a second
   selector.

## Observability

- **`src/observability/tracing.ts` loads via `--import` before the app.**
  It reads `process.env` directly (not `getEnv()`), because it must
  initialize before env validation. It reports `deployment.environment.name`
  from `APP_ENV`, or nothing when that is unset. `pnpm dev` and `pnpm start`
  pass `--env-file-if-exists=.env` to Node, so `.env` is loaded before it
  starts. When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the file is a
  complete no-op — no SDK started, no spans generated.
- **Trace-id appears in log output** as `traceId` and `spanId` fields when
  OTEL is active. When disabled, these fields are simply absent.
- **`IORedisInstrumentation` covers BullMQ's Redis traffic, not
  `redis.service.ts`'s.** This codebase has two Redis clients:
  `redis.service.ts` (direct app code — health checks, rate limiting) uses
  the `redis` package (node-redis); `queue.service.ts` (BullMQ) uses
  `ioredis`. `@opentelemetry/instrumentation-ioredis` only patches
  `ioredis`, so BullMQ's queue operations get spans and `redis.service.ts`'s
  direct calls do not. There is no `instrumentation-redis` (node-redis)
  package installed — adding one is a follow-up, not an oversight.
- **No Postgres instrumentation.** This codebase uses `postgres` (postgres.js),
  not `pg`. `@opentelemetry/instrumentation-pg` only instruments `pg`.
  Express + HTTP + ioredis(BullMQ) covers the request lifecycle; database
  calls appear as gaps in traces.
- **Grafana** at `http://localhost:3100` with Tempo as the default data
  source. Anonymous admin access enabled for local dev.
- **Logs reach Loki.** `PinoInstrumentation` (log sending on, correlation
  off — the mixin already writes `traceId`/`spanId`) exports records over
  OTLP; the collector forwards to Loki; in Grafana a log line links to its
  trace and a trace to its logs. Loki has no host port — query it through
  Grafana.
- **`tracing.ts` registers OTel's ESM loader hook** — without it the
  CommonJS pino imported from ESM is never patched (proved 2026-09-24).
- **The Docker image loads tracing via `--import`.** The Dockerfile CMD is
  `node --enable-source-maps --import ./dist/observability/tracing.js dist/index.js`.
- **Editing `otel-collector.yaml` needs `docker compose restart
otel-collector`.** It is bind-mounted; `docker compose up -d` does not
  pick up content changes to an already-running container's bind mount.

## Git hooks and CI

- **Pre-commit takes ~4.6s, and that is a deliberate trade, not a
  regression to fix.** About 70% of it is ESLint's type-aware cold start —
  building the TypeScript program to run `typescript-eslint`'s
  `recommendedTypeChecked` rules. It is not removable without dropping
  type-aware linting, which is what catches floating and misused promises
  — the dominant real-bug class in async Express code. `eslint --cache`
  does **not** help here: `lint-staged` only ever passes the files you
  changed, so the cache never has a hit to give.
- **Both hooks run unit tests only, via `vitest.unit.config.ts`, and
  need no Docker.** That config drops `tests/integration/**` and the base
  config's `globalSetup`, which creates and migrates the per-worker Postgres
  databases and fails outright when Postgres is down, even on a unit-only
  run. `vitest --changed HEAD` fans out along the import graph, so without
  the exclusion, editing a widely-imported file (a service, a response
  utility) pulls integration tests into pre-commit. A hook that fails
  whenever Docker happens to be down gets disabled with `--no-verify`
  permanently, and then it protects nothing. `pre-push` runs `pnpm lint`
  (ESLint and typecheck) and `pnpm test:unit`. Integration tests and the
  coverage gate run in CI, which main requires. **The exclusion is by path
  only, not by what a test actually touches** — so a test that hits the
  real database or Redis MUST live under `tests/integration/`, never
  `tests/unit/`, regardless of what else is colocated there. This bit
  during the auth work: an early draft of `auth.middleware.test.ts` was
  placed under `tests/unit/middlewares/` because it sat next to the
  middleware's other unit tests, but it called `UserRepository` against the
  real per-worker Postgres database — so with Docker down, any commit
  touching that file (or anything importing it) failed pre-commit outright,
  the exact failure mode this exclusion exists to prevent. It was relocated
  to `tests/integration/middlewares/auth.middleware.test.ts` once caught.
  Where a test's assertions live is not evidence of where its dependencies
  reach — check the second, not the first.
- **Hooks call `pnpm exec`, never `npx`.** `npx eslint` on a machine
  without `node_modules` populated yet silently downloads the newest
  ESLint and lints against a version this repo never tested against its
  own config.
- **A no-op `pnpm install` (already up to date) skips root lifecycle
  scripts entirely**, including `prepare`. You cannot verify that
  `"prepare": "husky"` actually installs hooks by re-running `pnpm install`
  in a checkout that's already installed — it proves nothing either way.
  Test it from a fresh clone.
- **Renovate, not dependabot.** Weekly, grouped, 3-day minimum release age;
  pnpm enforces the same 3 days on install (`minimumReleaseAge` in
  `pnpm-workspace.yaml`). Minor, patch and digest updates auto-merge once
  the required checks pass; majors and the pinned toolchain (`node`,
  `typescript`, the devcontainer image) wait for a human. Vulnerability
  fixes open immediately, outside the schedule and release-age wait,
  labelled `security`; Renovate adds the fixed version to
  `minimumReleaseAgeExclude` in the same PR, so CI's frozen install accepts
  it. Delete the Renovate-added version once it is 3 days old (Renovate
  appends `|| <ver>` to an existing entry). Actions are pinned
  to commit SHAs, and Renovate keeps those pins current. TypeScript
  is held `<6.1.0`, and every Node version pin — the docker `node` image,
  `.nvmrc`, `actions/setup-node`'s `node-version:`, and the devcontainer's
  `mcr.microsoft.com/devcontainers/typescript-node` image tag — is held
  `<25` by `renovate.json` rules — lift them deliberately, not by merging a
  Renovate PR. The explicit Corepack pin in `Dockerfile`,
  `.devcontainer/devcontainer.json`, and `README.md` is tracked by a
  `customManagers` regex entry in `renovate.json`, since none of Renovate's
  built-in managers see a version embedded in a shell command or prose.
  Requires the Renovate GitHub App on the repo. Renovate does
  not touch `package.json`'s `engines.node` or `devEngines.runtime.version`
  either way, since both are `>=` ranges, not pinned versions — when the
  Node 26 move happens, bump those two by hand alongside the held pins.
- **`ci.yml` is also the deploy gate.** `deploy.yml` (push to `main`) calls
  it via `workflow_call`, then builds and pushes `ghcr.io/<repo>:sha-<commit>`
  and `:main` with SBOM and provenance attestations, then runs a placeholder
  `deploy` job bound to the `production` environment. Keep CI's concurrency
  group keyed on `github.event_name`, not `github.workflow`: when `deploy.yml`
  calls `ci.yml`, `github.workflow` is the caller's name. Non-PR runs are
  grouped per commit so a newer push never drops a pending one. A manual
  `workflow_dispatch` from a non-`main` branch still builds and pushes the
  sha-tagged image, but never moves the `:main` tag and never runs `deploy`
  — both are conditioned on running from `refs/heads/main`.
- **Releases merge themselves.** `release.yml` queues release-please's PR
  with `--auto`; it merges once required checks pass. It uses a GitHub App
  token (variable `RELEASE_APP_CLIENT_ID`, secret `RELEASE_APP_PRIVATE_KEY`;
  Contents and Pull requests read/write) — not `GITHUB_TOKEN`, whose PRs and
  tags start no workflow. The `vX.Y.Z` tag runs `deploy.yml`'s `promote` job,
  which builds nothing: it waits for `:sha-<commit>` from `main`'s run and adds
  `:X.Y.Z`, `:X.Y` and `:X` to that same digest; tag runs skip `ci`, `image`
  and `deploy`. If the App key is revoked, releases stop — fix it, don't use
  `GITHUB_TOKEN`.

## Testing

- **No test file lives under `src/`.** Tests go in `tests/unit/` or
  `tests/integration/`, mirroring the src/ path of their subject
  (`src/services/queue.service.ts` →
  `tests/unit/services/queue.service.test.ts`); shared support lives in
  `tests/helpers/` and `tests/fixtures/`, imported by relative path. Names are
  `.test.ts`, never `.spec.`, never in a `__tests__/` folder. Linted:
  `check-file/filename-blocklist` rejects any `*.test.*`, `*.spec.*`,
  `__tests__/` or `src/tests/` file under `src/`, and vitest only collects
  `tests/**/*.test.ts`.
- **HTTP tests use `request` from `tests/helpers/request`, never supertest
  directly, and a hand-rolled test server calls `listen(0, '127.0.0.1')`:** a
  `::` bind can share a port another process holds on `127.0.0.1`, and the
  request then reaches that process. Lint enforces the supertest import.
- **The suite runs with `LOG_LEVEL=silent`** (`.env.test` and the CI env
  block). Many tests drive deliberate failure paths — Redis down, SMTP
  failing, OAuth errors — and at `info` the logger buried the results under
  ~1,300 lines of correct-but-useless output. To see logs while debugging,
  run `LOG_LEVEL=debug pnpm test <file>`; the real environment beats
  `.env.test`. A test that asserts on the real logger's output pins its own
  level, as `tests/unit/services/logger.service.test.ts` does.
- **Each vitest worker gets its own, physically separate database, and
  `WORKER_COUNT` is the one number that drives that.**
  `tests/helpers/worker-database.ts` provisions `WORKER_COUNT` databases up
  front (in global setup, before any worker spawns) and assigns one per
  worker via vitest's own `VITEST_POOL_ID`. `vitest.config.ts` imports
  `WORKER_COUNT` for `maxWorkers` rather than hard-coding the same number a
  second time — a worker assigned a pool id with no database provisioned
  for it fails as a bare connection error, with nothing pointing at
  "`maxWorkers` and `WORKER_COUNT` disagree" as the actual cause. If you
  ever need more (or fewer) parallel workers, change `WORKER_COUNT` in that
  one file; do not add a separate `maxWorkers` override anywhere else. This
  also means two tests in different files are never racing against the
  same rows just because they both insert a user — they are in different
  databases entirely, not merely different transactions.

## Proving a security behaviour is real, without hand-editing `src/`

- **Never break `src/` on disk to prove a test would catch the breakage.**
  Across B1 and B2, temporarily hand-editing a file under `src/` was the
  single most valuable verification technique this project used — it found
  six lint gates that reported success while enforcing nothing, a bcrypt
  cost test that passed when both sides were lowered, and a `no-cycle`
  fixture blind to the exact bug it existed for. It also has a real cost:
  four separate CRITICAL/HIGH security-scanner alerts fired on states that
  were never meant to be committed (reuse detection disabled, a rate-limit
  key reduced to IP-only, logout not revoking, mass assignment reopened),
  each needing three independent verifications before it could be
  dismissed — and the day a real vulnerability appears, it will look
  exactly like those four. Once, a live mass-assignment hole sat in a
  **tracked** file while a crashed agent's work was being rescued with
  `git add -A`; it was not committed, but only because of a marker-grep
  added after an earlier near-miss. That is a convention holding, not a
  guarantee.
- **Use `tests/helpers/mutate.ts` instead, always.** Both of its helpers
  mutate something held only in process memory, for the lifetime of one
  callback, and restore it in a `finally` — including when the callback
  throws or its returned promise rejects. No file under `src/` is ever
  opened for writing, so `git status --porcelain` cannot show a change that
  was never made, and there is nothing for a crashed agent's `git add -A`
  to pick up.
  - `withMutatedMethod(target, methodName, implementation, run)` — the
    default. Swaps one method on a shared, already-mutable object
    (almost always `SomeClass.prototype`) via a plain property assignment,
    saved and restored around `run`. Reaches every existing instance,
    including a module-private singleton already constructed elsewhere
    (e.g. `UserTokenRepository.prototype.revokeAllForSession`, which reaches
    the private instance `session.service.ts` builds at module scope) — no
    module reloading involved.
  - `withMutatedModule(dependencyPath, overrides, loadSubject, run)` —
    only when the export has no shared mutable object to reach, e.g. a
    plain function captured BY VALUE at another module's load time.
    `loginRateLimitKey` (`rate-limit.constants.ts`) is private to that
    module and reached only through `RATE_LIMITS.login.keyBy`, so there is
    no exported binding this helper could replace directly; the login
    rate-limiter's own mutation proof instead wraps `rateLimit` itself
    (the third-party `express-rate-limit` import in
    `rate-limit.middleware.ts`) to force whatever `keyGenerator`
    `createRateLimiter` passed down to an IP-only function, reproducing the
    same observable bug a composite key collapsing to IP alone would cause.
    Uses `vi.doMock` + `vi.resetModules()`, then a fresh `import()` of the
    subject so its own imports resolve to the mutated dependency.
    `loadSubject` must be a thunk whose body is a literal `import('...')`
    written at the call site — never a path built from a variable — so the
    bundler can resolve this repo's `@/` alias and infer the subject's type
    without a cast. This variant is not free: `vi.resetModules()` discards
    the WHOLE worker module cache, so every module between the subject and
    the mutated dependency re-evaluates, including ones with real side
    effects — `database.service.ts` opens a fresh postgres pool every time
    it is re-evaluated, and nothing closes the previous one. A handful of
    calls proving one mutation is fine; don't call it in a loop.
- **Getting red/green evidence needs zero file edits.** Commit the
  demonstration once, gated behind an environment variable
  (`it.runIf(process.env.MUTATION_PROOF === '1')(...)`), reproducing the
  real test's own assertions against the mutated dependency. Running it
  twice — once with the variable set, once without — produces a red
  transcript and a green transcript with nothing changed on disk between
  them; see `tests/integration/services/token-reuse-mutation.test.ts` for
  the pattern proven against reuse detection.
- **A rule without the reason gets bypassed the first time the harness is
  inconvenient.** If `withMutatedMethod`/`withMutatedModule` genuinely
  cannot reach what needs mutating, that is a signal to extend
  `tests/helpers/mutate.ts` with a third pattern — not license to fall back
  to editing a file under `src/`, even "just for a minute," even on a
  branch, even with the intention of reverting it. The whole point is that
  a hand-edit's window — however short — is a window where a real
  vulnerability sits on disk in a worktree other sessions and tools can
  read, stage, and commit.

## Verifying a claim, and two ways this project has been wrong

Ten tests have been found here that passed while enforcing nothing — one of them
_inside a fix written to close exactly that class_. Two techniques found almost
all of them, and both are cheap:

- **Measure the value against what it is supposed to exclude.** `email_logs`
  shipped an `error_code varchar(64)` justified as "structurally unable to hold a
  token". A raw token is `randomBytes(32)` hex-encoded — **exactly 64
  characters**. The width chosen as the gate fit the secret precisely. The column
  is now `varchar(32)` _plus_ a CHECK constraint on `^[A-Z][A-Z0-9_]*$`, because
  tokens are lowercase hex and nodemailer codes are uppercase: a shape constraint
  makes the secret unrepresentable, where a width only makes it awkward. Before
  trusting any width, regex, or prefix check, compute the thing it must reject
  and compare.
- **Run it; do not read it.** A `CHECK` constraint built with drizzle's normal
  `sql` template and interpolated values _compiles, type-checks, and passes
  review_ — and fails when the migration executes, because Postgres rejects bound
  parameters inside a DDL `CHECK`. Only running the migration surfaced it. The
  same applies to `@ts-expect-error`: an unused one is itself a `tsc` error, so a
  green tree proves every directive is consumed — but removing one and watching
  the specific error appear proves it guards what it claims to.

Assertions that silently cannot fail, seen here more than once:

- `JSON.stringify(err)` on an `Error` is `"{}"` — `message`, `stack` and
  `response` are non-enumerable. A leak assertion built on it passes whether or
  not anything is redacted. Use `util.inspect(err, { depth: null })`. (A
  `DrizzleQueryError` _is_ partly enumerable — `query` and `params` survive — so
  the same line can be load-bearing in one file and vacuous in the next. Check,
  do not assume.)
- A guard of the form `a && b` where no test supplies a case that is `a`-true and
  `b`-false: the `b` clause can be deleted with the suite still green.
- Asserting a constant against itself (`expect(render(v).templateKey).toBe(KEY)`),
  or `toStrictEqual` between two calls that both throw.
- A helper whose JSDoc claims it polls a budget while its body does one
  unwaited fetch.

## Writing a plan for this repo

B1's plan was ~1800 lines and needed almost no correction. B3's was 183 and
produced **seven** briefs whose stated facts were wrong — a column width that fit
the secret, a logging library that did not exist here at the time (there was
no pino until 2026-09-24; the convention was `console.error` plus
`error.middleware.ts`'s `redactedForLog`), a
normalisation that had never been implemented, and an instruction to install
`@types/nodemailer`, which nodemailer 10 makes dead because it ships its own
types. Each cost a full fix round.

The compression always falls on exactly the thing that must not be omitted: the
exact values. If a task's text says "implement" without naming columns, types and
signatures, it is not a task yet.

Related: implementers on B3 were right against the brief **seven times**, every
time because the dispatch asked them to argue rather than comply. Keep that
instruction in any dispatch written here.

## Auth and tokens

- **`isPasswordValid`, not `verifyPassword`.**
  `unicorn/consistent-boolean-name` requires a boolean-returning function to
  start with `is`/`has`/`can`/etc.; `verifyPassword` doesn't. The
  alternative — an `ignore` entry in `eslint.config.mjs` carving out that
  one name — was deliberately rejected in favour of renaming, on the same
  reasoning this repo already applied to `pingDatabase`/`pingRedis` ->
  `isDatabaseReachable`/`isRedisReachable`: a boilerplate should answer the
  same lint rule the same way everywhere, not once by renaming and once by
  a config carve-out for a name a plan happened to specify first. Don't
  rename it back to match a spec's literal wording; the lint rule's intent
  (a boolean-returning name reads as a question) is what should win.
- **`verifyAccessToken` returns a discriminated result, not a thrown
  error.** Its type is a union of `{ ok: true; payload }` and
  `{ ok: false; reason: 'expired' | 'invalid' }`
  (`src/services/session.service.ts`) rather than throwing on rejection.
  This exists so `requireAuth` (`src/middlewares/auth.middleware.ts`) can
  tell a client "your token expired, try refreshing" apart from "this token
  is no good, log in again" using only a fact `jsonwebtoken` itself already
  verified — a caller re-deriving "expired" by peeking at the token's own
  unverified `exp` claim after a generic thrown rejection would be trusting
  exactly the data verification just said not to trust. `reason: 'expired'`
  is set ONLY for `jsonwebtoken`'s own `TokenExpiredError`; every other
  rejection (bad signature, wrong algorithm, malformed structure, missing
  `sub`) is `'invalid'`, and that's a closed set of two — don't add a third
  case based on an error message, since only `verifyAccessToken` ever calls
  `jwt.verify` and sees what it actually threw.
- **Password change and reset hold the user row; login re-reads under
  it.** The writes lock the user `FOR NO KEY UPDATE`, write the hash and
  revoke the `user_tokens` rows in one transaction. Login compares outside
  any transaction, then locks `FOR SHARE`, re-reads the hash and issues the
  refresh token in one. Keep `lastLoggedInAt` and `autoJoinSafely` outside
  that transaction: `autoJoinSafely` takes the owners → memberships lock
  chain, and nesting it under the user-row lock adds a lock-order case. The
  Redis denylist is written after commit and never fails the request
  (`denySessionsAfterCommit`); a failure there is one `error` line. The
  Google claim, logout and both kills take the user row `FOR NO KEY UPDATE`
  through `revokeSessionUnderUserLock` or a locked `revokeSessionRows`;
  rotation takes it `FOR SHARE`. The kills run after the rotation's
  transaction commits, never inside it. SECURITY.md, "Password change and
  reset against a concurrent login", has the full table.

## Code conventions

- **helmet is the first middleware** (`src/configs/helmet.config.ts`).
  Anything that must answer without security headers does not exist here;
  don't mount routes above it.
- **In `src/`, `process.env` is read only where `eslint.config.mjs` exempts
  it** from `no-restricted-properties`. The exemptions are
  `env.config.ts` (parsing is its job), `tracing.ts` (it loads before
  validation), and `logger.service.ts` and `index.ts` (whose exemption exists
  for `console.*`; `index.ts` also hands `process.env` to
  `assertEnvConsistent` for its removed-name check). Everything else reads
  `getEnv()`.
- **`tests/fixtures/lint-cycle/` proves `import-x/no-cycle` fires on both a
  relative AND an aliased (`@/`) import.** `a.ts`/`b.ts` is the relative
  pair; `cycle-a.ts`/`cycle-b.ts` is the aliased pair, and carries its own
  `tsconfig.json`, mapping `@/*` to `./*` — it does not sit under `src/`,
  because `tests/unit/lint-gates.test.ts` lints it with a dedicated ESLint
  instance whose resolver is pointed at that local tsconfig, not the
  repo's root one. `tests/fixtures/lint-zones/` holds one committed
  violating fixture per layer-boundary zone (`eslint.config.mjs`'s
  `import-x/no-restricted-paths`) — see ARCHITECTURE.md's `## Layers`
  section. Do not import any of these fixtures from real code, and do not
  "fix" the cycles.
- **No barrel files, anywhere, deliberately.** No `index.ts` re-export
  module in any directory. Imports are direct (`@/services/foo.service`).
  A barrel would fail `check-file`'s per-directory naming rule (an
  `index.ts` under `src/services/` can't end in `.service`), and — the
  reason that actually matters as this codebase grows — it hides real
  edges from `import-x/no-cycle`. A cycle routed through a barrel is
  invisible to that rule; this codebase would rather see the cycle.
- **`pnpm lint` runs `tsc` once, against `tsconfig.typecheck.json` only.**
  It used to run `tsc --noEmit` (the build config) first as well. That was
  redundant: `tsconfig.typecheck.json` extends `tsconfig.json` and its
  `include` is a strict superset (`src/**/*` plus `tests/**/*` plus
  `drizzle.config.ts`), so the first invocation could not catch anything the
  second missed — verified by putting a type error in `src/` and confirming
  `pnpm lint` still exits non-zero. Both config files stay, for the reason
  below.
- **`tsconfig.json` and `tsconfig.typecheck.json` are not
  interchangeable, and must not be merged.** `tsconfig.json` is the build
  config: `rootDir: ./src`, and it covers `src/` only — this is what
  `tsc` uses to emit `dist/`. `tsconfig.typecheck.json` extends it and
  widens `include` to also cover `tests/` and `drizzle.config.ts` — this is
  what lets eslint's type-aware rules, and `pnpm lint`'s `tsc --noEmit`, see
  test files at all. Widening the **build** config's
  `include` to add `tests/` does not make tests type-check as part of the
  build — it breaks the build, with `TS6059` ("file is not under
  `rootDir`"), because `rootDir` and an `include` outside it directly
  contradict each other.
- **TypeScript is pinned `~6.0.3`, not 7.** `typescript-eslint@8.70.0`
  (the only TS-aware lint toolchain in this repo) peers
  `typescript: >=4.8.4 <6.1.0`, which excludes all of 7.x. See
  [MIGRATIONS.md](MIGRATIONS.md) for the full spike and the exact unblock
  condition. Don't bump `typescript` on its own without checking that
  peer range has moved.
- **Every authenticated write needs a limiter.** Mount
  `createRateLimiter(RATE_LIMITS.authenticatedWrite)` after `requireAuth` on
  a new `POST`/`PUT`/`PATCH`/`DELETE` route, or give the route its own spec.
  Reuse the router's one `writeLimiter` instance, so the in-memory fallback
  keeps one budget per router. `route-limiters.test.ts` walks the router and
  fails otherwise. It finds a limiter by the `RATE_LIMITER_MARK` symbol that
  `createRateLimiter` sets, so a hand-rolled `rateLimit()` doesn't count.
  Its allowlist is for routes that can't carry a limiter, each entry with
  its reason.
- **Row locks default to `FOR NO KEY UPDATE`.** `FOR UPDATE` conflicts with
  the `FOR KEY SHARE` lock every foreign-key insert takes, so holding it on
  a tenant blocks that tenant's audit inserts and invitation accepts until
  commit. Pass `'update'` (`RowLockMode`, `src/types/lock-mode.ts`) only in
  a transaction that deletes the locked row or changes a key column.
- **Bind a timestamp in raw `sql` as `${date.toISOString()}::timestamptz`.**
  drizzle's postgres-js driver installs identity serializers for timestamp
  types, so a `Date` inside a `sql` template reaches the driver
  unserialised and the query fails. Column comparisons built with
  `lt(column, date)` are fine; `sql` templates and test seeds are not.
- **Free-text fields use `safeText`.** A new free-text field in a validator
  gets it too: single-line by default, `{ multiline: true }` for prose.
