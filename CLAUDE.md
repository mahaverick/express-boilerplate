# CLAUDE.md

Rules and gotchas for anyone, human or agent, changing this repo: the traps
that look like a good idea until you check. How things work lives in the docs
listed in [README.md](README.md#documentation-index); this file links to them
rather than repeating them.

## Environment and processes

- **Use `pnpm` only**, never npm or yarn. `package.json` pins it in
  `packageManager`.
- **`getEnv()` is lazy and memoised.** Never parse the environment at module
  scope: one bad variable would crash every importing file at import time.
  Once any module has called `getEnv()`, assigning to `process.env` changes
  nothing, so a test passes the value as an argument instead (as
  `startServer(port)` in `src/server.ts` takes the port).
- **Keep the `process.env.VITEST` guard around `.env` loading** in
  `env.config.ts`. Without it a developer's `.env` loads underneath the test
  environment (`tests/helpers/setup-global.ts`) and a test passes on one
  machine only. `config({ quiet: true })` is load-bearing too: without it
  dotenv's banner lands on stdout ahead of machine-readable output.
- **`APP_ENV` is required and names the deployment** (`local`/`dev`/`qa`/`prod`).
  Every environment-dependent default derives from it only through the helpers
  in `env.config.ts` (`isCookieSecure`, `logFormat`, `requiresSmtpTls`). Never
  read `APP_ENV` or `NODE_ENV` at a call site to pick behaviour. Cross-variable
  rules go in `assertEnvConsistent` (`env-consistency.config.ts`), not in the
  schema: an object-level `.refine()` breaks `getDatabaseUrl()`'s `.pick()`.
- **Don't add a dependency check to `/health`.** It is liveness; the deep check
  is `/health/ready`. See [ARCHITECTURE.md](ARCHITECTURE.md#health-checks).
- **The compose ports 5433/6380 are deliberate.**
  `tests/unit/connection-target.test.ts` guards them by reading the committed
  `docker-compose.yml` and `.env.test`, never by asserting on `getEnv()` at
  runtime: CI's services publish 5432/6379. See
  [ARCHITECTURE.md](ARCHITECTURE.md#local-infrastructure).
- **Don't remove the Redis clients' retry strategies.** Before a client's
  first `ready` they give up after a few retries, so readiness reports
  unreachable instead of hanging; after it they retry forever
  (`redis-unreachable.service.test.ts`, `queue-unreachable.service.test.ts`,
  `redis-outage.service.test.ts`). Start BullMQ Workers through
  `startWorkers()` (`worker-supervisor.service.ts`), never one by one, in
  anything that runs through an outage. An outage test goes through a local
  TCP proxy; never stop the shared Redis. The mechanism is in
  [ARCHITECTURE.md](ARCHITECTURE.md#data-layer).
- **`drizzle.config.ts` uses `getDatabaseUrl()`, not `getEnv()`**, so
  `drizzle-kit` needs only `DATABASE_URL`, not the JWT and session secrets.

## Logging

- **Use `logger` from `@/services/logger.service`, never `console.*`, in
  `src/`.** `no-restricted-properties` is off in four files:
  `configs/env.config.ts` (its job is parsing `process.env`), and three that
  run where the logger can't: `logger.service.ts` (the Slack destination's
  failure path, which must not re-enter the logger), `index.ts` (the pre-boot
  error path) and `observability/tracing.ts` (it loads before the app).
- **Don't pass `requestId` in log meta.** The request-context mixin adds it,
  and its fields win over a caller's field of the same name. See
  [ARCHITECTURE.md](ARCHITECTURE.md#request-correlation).
- **Don't prefix messages with `[moduleName]`.** The `source` field already
  names the caller's file and line.
- **Direct pino calls are `(meta, message)`;** application code uses the
  `logger` facade, which is `(message, meta)`.
- **Log errors as objects, never `error.message`.** A Drizzle error's message
  embeds the bound parameters; `serializeErrors` redacts a logged error object
  and its `cause` chain, but not a string. A query-shaped value that isn't an
  `Error` still needs `redactedForLog` at the call site.

## Job queue

- **Enqueue mail with `addEmailJob()` (`@/jobs/email.job`) or
  `addNotificationJob()` (`@/jobs/notification.job`), never `sendMail()`
  directly.** Work a controller starts with `void` after replying wraps itself
  in `try`/`catch` and never rejects; anything that can reject runs before the
  reply, where `BaseController.handle()` forwards it to `next()`.
- **Never call `addEmailJob()` inside a transaction:** it takes its own pool
  connection, so as many concurrent callers as `DB_POOL_MAX` deadlock. A write
  that must commit the message row with its own writes calls
  `createTrackedEmail(…, tx)` inside and `enqueueTrackedEmail()` after commit,
  as `sendOnboardingReminder` does.
- **A worker's `failed` handler must never reject:** an unhandled rejection
  exits the process. A retryable attempt logs `warn`; the last one calls
  `recordPermanentFailure` (`src/jobs/job-failure.job.ts`), which scrubs every
  `…Url`/`…Token` key and logs `job failed permanently` once. BullMQ counts
  the attempt before it emits `failed`, so the terminal test is
  `attemptsMade >= attempts`, not `+ 1`. A test that reads the scrubbed data
  waits for the log line (`waitForLoggedCall`, `tests/helpers/queue-jobs.ts`),
  not the `failed` event.
- **To test a retention rule, call `runRetentionPurge(now, days)` directly,**
  with `now` years in the past and explicit `days`: `getEnv()` is memoised,
  and a past `now` keeps other files' rows out of every predicate. See
  `tests/integration/services/retention.service.test.ts`.
- **Every Redis key and channel goes through `redisKey()`**
  (`redis.service.ts`); never write a literal key. Each vitest worker runs
  under its own prefix, `test-w<pool id>` (`tests/helpers/redis-prefix.ts`).
  Two concurrent `pnpm test` runs on one compose stack are unsupported: they
  share those prefixes and the worker databases.
- **`sendMail()` never rejects.** It returns `'sent' | 'failed'`, which the
  worker uses to decide whether BullMQ retries.
- **An integration test that asserts mail delivery runs its own
  `startEmailWorker()`:** `createApp()`/`startServer()` start no worker. Start
  it as a module-level `const worker = startEmailWorker()`, and in `afterAll`
  close it before `getEmailQueue().obliterate({ force: true })` and
  `closeQueue()`. Verification mail also needs `startNotificationWorker()`,
  which fans `verify_email` out to the email queue.
  `tests/integration/api/auth.test.ts` and `verification.test.ts` show both.

## Notifications

- **Use `addNotificationJob()` for an event with in-app and email channels.**
  The worker checks preferences and fans out. `registration_attempt` is
  email-only and never goes through the notification worker: an in-app row
  would be an enumeration oracle.
- **`tenant_invitation` mail goes through `addEmailJob()` directly,** since
  the invitee may have no account. The notification job, sent only to a live,
  verified invitee, carries no `email`.
- **The `verify_email` email channel is not user-disableable.** The preference
  repository returns `true` for it regardless.
- **Notification `metadata` must NOT contain `variables`.** Verification tokens
  live there; the worker strips them before the insert, and the email fan-out
  reads them from the job payload.
- **The SSE stream (`GET /api/v1/notifications/stream`) authenticates with
  `Authorization: Bearer` through `requireAuth`;** never put a credential in
  its URL. Its handler (`requireSessionId`) rejects a token with no `sid`
  claim, which `requireAuth` accepts: the revocation heartbeat closes streams
  by session id, so a sid-less stream would outlive a logout.
- **Live notifications cross replicas over Redis pub/sub** on
  `redisKey('notifications')`. The subscriber opens on the first
  `onNotification`; when it reconnects, or starts late while streams are open,
  every open stream is closed and clients replay the gap via `Last-Event-ID`.
  A test asserting live delivery first calls `waitForNotificationSubscriber`
  (`tests/helpers/notification-subscriber.ts`).

## OAuth

- **Google OAuth is optional.** With `GOOGLE_CLIENT_ID` unset the routes are
  not mounted; `configurePassport()` throws at boot on a `GOOGLE_CLIENT_ID`
  without a `GOOGLE_CLIENT_SECRET`.
- **`auth_providers` tracks every sign-in method.** Email users get an
  `'email'` row; Google users get `'email'` and `'google'` rows. A user with
  `passwordHash: null` is federated-only.
- **An email match needs Google's verification, and a never-verified local
  account is taken over** (`findOrCreateByGoogle`, `google-auth.service.ts`).
  A Google identity is first looked up by `(google, profile.id)`. Failing
  that, an address Google has not verified never links to an existing account
  and never creates one (403 `email_not_verified`). A Google-verified address
  that matches an account whose email was never verified claims it
  (`claimUnverifiedAccount`): every session is revoked, the password and any
  other Google link are removed, and the email is marked verified. A match
  whose email is verified is linked and otherwise left alone. Don't relax
  either check: linking an unverified address is an account takeover.
- **The OAuth callback's refresh cookie is `sameSite: 'lax'`**, not
  `'strict'`: the callback is a cross-site redirect from Google.
- **`APP_URL` must match the Google Cloud Console redirect URI exactly**,
  scheme and trailing slash included.
- **Sessions are OAuth-scoped only.** `express-session` runs on `/auth/google`
  and `/auth/google/callback` (5-minute TTL); the rest of the API is stateless.
- **`oauth.sid` needs `req.secure` when `COOKIE_SECURE` resolves true.**
  express-session silently skips a `Secure` cookie on a non-HTTPS request, so
  behind TLS termination set `TRUST_PROXY` and forward `X-Forwarded-Proto`.
- **The refresh cookie's name, path and domain come only from
  `refreshCookieSpec`** (`auth.constants.ts`); don't write them anywhere else.
  A browser silently drops a `__Host-` cookie with a `Domain` or a path other
  than `/`, which looks like a logout. The controller reads the current cookie
  only through `currentRefreshCookie(env)`. Refresh and logout also read the
  legacy `refreshToken` cookie (`LEGACY_REFRESH_TOKEN_COOKIE_NAME`); a login,
  a successful refresh, a Google sign-in or a logout clears it when presented,
  and a refresh answered 401 clears only the cookie name it read.
- **`COOKIE_DOMAIN` goes on the refresh-cookie set, its clear, and the OAuth
  session cookie.** A clear with a different domain leaves the cookie behind.
  After a domain change the browser sends two cookies of one name, oldest
  first; `readCookie` (`auth.controller.ts`) takes the last, because handing a
  stale token to reuse detection would revoke the live session.

## Multi-tenancy and RBAC

- **New tenant routes compose `resolveTenant()` and `requireRole(...)`.**
  `requireRole` treats each listed role as a floor (`isRoleAtLeast`; owner >
  admin > manager > editor > viewer, `MEMBERSHIP_ROLES`).
- **The tenant comes from `:slug` only.** Don't add a header-based selector: a
  header naming a different tenant than the path is a confused-deputy hole.
- **Non-members get 404, not 403**, so a response never reveals that a tenant
  exists. Staff (members of the `is_platform` tenant) reach a tenant they
  don't belong to with their platform role (`access: 'platform'`); a staff
  user who is a member gets their membership role. The platform tenant itself
  is members-only.
- **Member and invitation writes re-read the actor's role under lock and
  re-apply the route's bar** inside their transaction (`lockActorRole`,
  `lockActorAndTarget`): `changeRole` needs owner; `removeMember`, `invite`,
  `resend`, `revoke`, `updateTenant` and `updateSettings` need admin. An actor
  who lost access mid-request gets 404 `Tenant not found`; one demoted below
  the bar gets 403 `Insufficient permissions`. The actor→target matrix is
  `canActorModifyTarget` (`src/policies/tenant.policy.ts`). Lock order:
  [ARCHITECTURE.md](ARCHITECTURE.md#layers).
- **Services never trust `request.principal.role`;** they re-read access under
  lock. A controller may report `role`/`access` but never authorizes on them.
- **Members join by invitation only.** Don't add a "no such user" 404
  or a direct add: `POST /tenants/:slug/invitations` answers one fixed 202
  either way (409 `already_member` is the one exception). Accepting needs a
  signed-in user whose **verified** address equals the invited one (403
  `invitation_email_mismatch` / `invitation_email_unverified`). The table
  stores the token's SHA-256 (`hashToken`).
- **Keep the revoke UPDATE in `TenantInvitationRepository.createPending`.**
  `tenant_invitations_pending_unique` can't filter on `now()`, so an expired
  invitation still holds the pending slot; without the UPDATE every re-invite
  after an expiry fails with 409.
- **Build the invite limiter once and mount it on invite and resend.**
  `createTenantRouter` does, so the in-memory fallback keeps one 30-per-hour
  budget (`tests/unit/routes/tenant.routes.test.ts`).
- **The raw invitation token never goes in an API URL.** Preview and accept
  take `{ token }` in a JSON body; don't add a `GET ?token=` form, since HTTP
  tracing and proxy logs record URLs.
- **Resend re-checks `canActorGrantRole`** against a role re-read under lock,
  because resending re-issues the invitation.
- **Record the audit entry in the write's own transaction:** call
  `record(entry, tx)` (`audit.service.ts`) with the write's `tx`
  (`audit-writes.test.ts`). Never put an address or a token in metadata; for
  an address record `hostnameDomain(email) ?? null`
  (`utilities/email.utilities.ts`). Metadata schemas are strict, so a new key
  fails until its schema lists it.
- **`audit_logs` is append-only.** Only `retention.service.ts` and
  `platform-purge.service.ts` may set
  `app.audit_purge`/`app.audit_purge_before`, and only
  `platform-purge.service.ts` sets `app.audit_redact`
  (`tests/unit/audit-purge-setting.test.ts`). The redact exception
  (migration 0019) lets one UPDATE through: nulling a purged user's
  `actor_user_id`, `ip` and `user_agent`, changing no other column. For that,
  `audit_logs_actor_user_check` only requires a `system` entry to have no
  actor id, so the database can't tell a redacted `user` entry from one
  written without an actor: always pass the actor. Its foreign keys are
  RESTRICT, so test cleanup calls `truncateAuditLogs()`
  (`tests/helpers/audit-log.ts`) before deleting a tenant or user. Don't add a
  `BEFORE TRUNCATE` trigger, or only a superuser can clean up.
- **Staff routes answer 404, and on every `/platform` route the role gate
  runs first:** `requirePlatformRole`, then `requireJsonContentType`, then
  `requireRecentAuth()` where it applies, then the limiter. A limiter or JSON
  gate first would put `RateLimit-*` headers or a 415 on the refused call and
  reveal the route; step-up first would answer a caller below the role 401
  `REAUTH_REQUIRED`. A new `/platform` route needs its row in
  `tests/integration/api/platform-route-gates.test.ts`, whose completeness
  check fails otherwise; a new sub-router needs its mount added there too.
  Keep `refusePlatformOptions` ahead of every route: without it Express
  answers OPTIONS with an `Allow` header listing the route's methods.
- **`repositories/platform-tenant.repository.ts`,
  `repositories/platform-stats.repository.ts`,
  `repositories/platform-user.repository.ts`,
  `repositories/platform-email.repository.ts` and
  `repositories/platform-onboarding.repository.ts` are imported only from
  `services/platform-*.service.ts`** (lint enforces it). "Your tenants" stays
  on `TenantRepository.listForUser`; don't merge the two paths.
- **The platform tenant's member rules differ from a customer tenant's.**
  Its members are the staff, and its member routes are how staff roles
  change. There an owner may demote or remove another owner
  (`canPlatformActorModifyTarget`); the last-owner guard counts active
  owners only (`countActiveOwners`); and a role change, a removal, a resend,
  or an invitation offering admin or owner needs step-up
  (`requireRecentAuthOnPlatformTenant`). Keep these to the platform tenant:
  on a customer tenant an owner acts only on their own ownership.
- **A tenant with no active owner is the one place an admin grants owner.**
  `POST /platform/tenants/:id/owner-invitation` (platform admin, step-up, a
  reason) goes through `createOwnerInvitation`, which skips
  `canActorGrantRole` because the route's gate authorizes it. Don't route
  any other invitation through it.
- **Auto-join grants `viewer` only.** Don't widen it: one compromised inbox on
  a `PLATFORM_EMAIL_DOMAINS` domain would get write access to every tenant.
  Don't run it before the timing-equalised credential check, which would leak
  whether an address is registered.

### How to scope your own model by tenant

1. Add a `tenantId` column:
   ```typescript
   tenantId: varchar('tenant_id', { length: 36 })
     .notNull()
     .references(() => tenantModel.id, { onDelete: 'cascade' })
   ```
2. In the controller, take the tenant from the principal and pass it down as
   an argument; the repository filters on it:
   ```typescript
   const { tenantId } = tenantPrincipal(request) // controllers/helpers.controller.ts
   // repository: .where(eq(projectModel.tenantId, tenantId))
   ```
3. Mount the route on the tenant router behind `resolveTenant()`, which reads
   the slug from `request.params.slug`:
   ```typescript
   router.get('/:slug/projects', resolveTenant(), projectController.list)
   ```
   A route without a `:slug` segment has no tenant to resolve: nest it under
   `/tenants/:slug/*` rather than inventing a second selector.

## Observability

- **`src/observability/tracing.ts` reads `process.env` directly and must not
  use `getEnv()`:** it loads via `--import` before env validation. What it
  does is in [ARCHITECTURE.md](ARCHITECTURE.md#observability).
- **Don't remove `tracing.ts`'s OTel ESM loader hook** (`register()`): without
  it the CommonJS pino imported from ESM is never patched.
- **After editing `otel-collector.yaml`, run `docker compose restart
otel-collector`.** It is bind-mounted, and `docker compose up -d` doesn't
  pick up the change.

## Git hooks and CI

- **A change is done when `pnpm lint`, `pnpm lint:docs`, `pnpm format:check`,
  `pnpm test:coverage` and `pnpm build` all exit 0.** See
  [CONTRIBUTING.md](CONTRIBUTING.md#before-you-open-a-pr).
- **Pre-commit's ~4.6 s is deliberate.** Don't drop type-aware lint to speed
  it up; `eslint --cache` doesn't help, since lint-staged passes only changed
  files. See [CONTRIBUTING.md](CONTRIBUTING.md#git-hooks-husky).
- **A test that hits the real database or Redis MUST live under
  `tests/integration/`, never `tests/unit/`.** Both hooks run unit tests with
  Docker down, and `vitest.unit.config.ts` excludes by path only. Check where
  a test's dependencies reach, not where its assertions live.
- **Hooks call `pnpm exec`, never `npx`:** `npx` on a machine without
  `node_modules` downloads the newest version of the tool.
- **A no-op `pnpm install` skips `prepare`,** so test that hooks install from
  a fresh clone.
- **Lift the TypeScript and Node holds in `renovate.json` deliberately, not by
  merging a Renovate PR,** and bump `engines.node` and
  `devEngines.runtime.version` by hand with them: Renovate leaves `>=` ranges
  alone. See [CONTRIBUTING.md](CONTRIBUTING.md#dependency-policy).
- **Keep `ci.yml`'s concurrency group keyed on `github.event_name`, not
  `github.workflow`:** when `deploy.yml` calls `ci.yml`, `github.workflow` is
  the caller's name. See [ARCHITECTURE.md](ARCHITECTURE.md#deploying).
- **If the release App key is revoked, fix it; don't switch `release.yml` to
  `GITHUB_TOKEN`,** whose PRs and tags start no workflow. See
  [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## Testing

- **No test file lives under `src/`.** Tests go in `tests/unit/` or
  `tests/integration/`, mirroring the `src/` path of their subject
  (`src/services/queue.service.ts` → `tests/unit/services/queue.service.test.ts`);
  support code lives in `tests/helpers/` and `tests/fixtures/`. Names end in
  `.test.ts`, never `.spec.`, never in a `__tests__/` folder.
- **HTTP tests use `request` from `tests/helpers/request`, never supertest
  directly. A hand-rolled test server calls `listen(0, '127.0.0.1')`:** a `::`
  bind can share a port another process holds on `127.0.0.1`.
- **The suite runs at `LOG_LEVEL=silent`.** Debug with
  `LOG_LEVEL=debug pnpm test <file>`. A test that asserts on the real logger's
  output pins its own level, as `tests/unit/services/logger.service.test.ts`
  does.
- **To change test parallelism, change `WORKER_COUNT`** in
  `tests/helpers/worker-database.ts`, which provisions one database per worker
  and which `vitest.config.ts` imports for `maxWorkers`. Don't add a separate
  `maxWorkers` override: a worker with no database fails as a bare connection
  error.

### Test timing rules

`tests/helpers/timing.ts` holds the only two real-time waits a test may use.
Lint rejects the sleep forms under `tests/` (`sleep()`, a `setTimeout`
promise, `timers/promises`, `.waitForTimeout`), and that file is the only
exemption.

1. Wait on a condition, never on a duration: `waitUntil(check, { message })`.
2. A deliberate wait is `settle(ms, reason)`. The reason names what can't be
   observed ("absence has no event", "poll interval", "injected latency to
   widen the race").
3. Wall-clock upper bounds only when the bound is the claim under test. Each
   carries a comment naming what it proves and either references a product
   constant by name or has at least 10x headroom over the measured p99.
4. No exact counts of process-wide resources. Count only what the test itself
   created.
5. Negative checks use a barrier event where one exists, and otherwise
   `settle` with a reason.
6. Never raise a timeout to fix a flake before its mechanism is known.

## Proving a security behaviour is real, without hand-editing `src/`

- **Never break a file under `src/` on disk to prove a test would catch the
  breakage,** not even for a minute: the broken state is a real vulnerability
  that another session's `git add -A` can commit and a security scanner
  reports as live.
- **Use `tests/helpers/mutate.ts` instead, always.** Both helpers mutate
  something held only in process memory for one callback and restore it in a
  `finally`.
  - `withMutatedMethod(target, methodName, implementation, run)` is the
    default. It swaps one method on a shared object (usually
    `SomeClass.prototype`), which reaches every instance, including a
    module-private singleton.
  - `withMutatedModule(dependencyPath, overrides, loadSubject, run)` only when
    there is no shared mutable object to reach, such as a function captured by
    value at another module's load time. `loadSubject` is a thunk whose body
    is a literal `import('...')`, never a path built from a variable. It
    resets the whole module cache, and `database.service.ts` opens a new
    pool each time it re-evaluates, so don't call it in a loop.
- **Red/green evidence comes from a committed demonstration** gated by
  `it.runIf(process.env.MUTATION_PROOF === '1')(...)`, run once with the
  variable and once without. See
  `tests/integration/services/token-reuse-mutation.test.ts`.
- **If the helpers can't reach what needs mutating, extend `mutate.ts`** with
  a third pattern; never fall back to editing `src/`.

## Verifying a claim

- **Before trusting a width, regex or prefix check, compute the thing it must
  reject and compare.** A 64-character column cannot "structurally" exclude a
  64-character hex token. Prefer a shape constraint (a `CHECK` on a pattern)
  to a width.
- **Run it; do not read it.** A `CHECK` constraint built with drizzle's `sql`
  template and bound values compiles and fails only when the migration runs.
  Prove an `@ts-expect-error` guards what it claims by removing it and
  watching the specific error appear.
- **Don't build a leak assertion on `JSON.stringify(err)`:** an `Error`'s
  `message` and `stack` are non-enumerable, so it prints `{}`. Use
  `util.inspect(err, { depth: null })`. A `DrizzleQueryError` is partly
  enumerable (`query` and `params` survive), so the same line can be
  load-bearing in one test and vacuous in the next: check, don't assume.
- **For a guard `a && b`, a test supplies the case where `a` is true and `b`
  is false;** otherwise `b` can be deleted with the suite green.
- **Don't assert a constant against itself, or `toStrictEqual` between two
  calls that both throw.**
- **A helper's JSDoc matches its body:** a helper documented as polling
  polls.

## Writing a plan for this repo

- **A task that says "implement" without naming the exact columns, types and
  signatures is not a task yet.** Compression falls on exactly the values
  that must not be omitted.
- **Dispatches ask implementers to argue with the brief, not comply with it.**

## Auth and tokens

- **`isPasswordValid`, not `verifyPassword`.** Answer
  `unicorn/consistent-boolean-name` by renaming, never with an `ignore` entry,
  and keep that name even where a spec says `verifyPassword`.
- **`verifyAccessToken` returns `{ ok: true; payload }` or
  `{ ok: false; reason: 'expired' | 'invalid' }`,** never throws.
  `'expired'` is only `jsonwebtoken`'s `TokenExpiredError`; every other
  rejection is `'invalid'`. Don't add a third reason from an error message.
- **Password change and reset lock the user row `FOR NO KEY UPDATE`,** write
  the hash and revoke the `user_tokens` rows in one transaction. Login
  compares outside any transaction, then locks `FOR SHARE`, re-reads the hash
  and issues the refresh token in one. Keep `lastLoggedInAt` and
  `autoJoinSafely` outside that transaction, so the user row is held
  `FOR SHARE` only for the re-read and the token insert. `autoJoinSafely`
  takes no explicit row lock (only the `FOR KEY SHARE` its inserts' foreign
  keys take) and runs its own transaction: a membership insert that does
  nothing if one exists, and an audit row. The Redis denylist is written
  after commit and never fails the request (`denySessionsAfterCommit`).
  Google sign-in, like login, issues its token under `FOR SHARE`, and both
  re-check `active` under the lock, so a deactivation or deletion that
  committed since the first read wins. The Google claim, logout, both kills
  and step-up (`markSessionReauthenticated`) take the user row
  `FOR NO KEY UPDATE`; rotation takes it `FOR SHARE`. The kills run after
  the rotation commits, never inside it. Step-up is password-only
  (`POST /auth/reauthenticate`, staff only); a wrong password is a 400,
  never a 401, because clients sign out on a 401. The full table is in
  [SECURITY.md](SECURITY.md#password-change-and-reset-against-a-concurrent-login).

## Code conventions

- **helmet is the first middleware** (`src/configs/helmet.config.ts`); don't
  mount routes above it.
- **In `src/`, `process.env` is read only where `eslint.config.mjs` exempts
  it:** `env.config.ts`, `tracing.ts`, `logger.service.ts` and `index.ts`.
  Everything else reads `getEnv()`.
- **No barrel files.** Import the module directly (`@/services/foo.service`),
  never through a re-exporting `index.ts`. See
  [ARCHITECTURE.md](ARCHITECTURE.md#no-barrel-files).
- **Comments.** Every exported function, class, interface and type alias has
  a JSDoc description (`jsdoc/require-jsdoc`; tests are exempt). Describe
  behaviour in prose; don't repeat the TypeScript types in `@param`/`@returns`.
  Every other comment is a file JSDoc (`/** @file … */`) or a one-line `//`
  why, with no history; `local/comment-style` checks the form.
- **Don't add a scoped disable for a type-aware rule** (`typescript-eslint`'s
  `recommendedTypeChecked`) without a comment on why the call site is safe.
  Scope any eslint disable as narrowly as the rule allows: a specific
  `replacements` key or line, never the whole rule.
- **When a layer-boundary lint rule refuses an import,** either the import is
  wrong or the [ARCHITECTURE.md](ARCHITECTURE.md#layers) Layers table and the
  zone config in `eslint.config.mjs` change in the same commit.
- **A route handler is a `BaseController` method through
  `this.handle(handler)`** (`src/controllers/base.controller.ts`), unless it
  has a documented, file-local reason not to (a redirect, an SSE stream).
- **Row locks default to `FOR NO KEY UPDATE`.** Pass `'update'`
  (`RowLockMode`, `src/types/lock-mode.ts`) only when the transaction deletes
  the locked row or changes a key column: `FOR UPDATE` blocks the
  `FOR KEY SHARE` every foreign-key insert takes. A transaction that locks
  several tenant row sets takes the owner rows first, then memberships by
  `user_id` ([ARCHITECTURE.md](ARCHITECTURE.md#layers)).
- **Don't import `tests/fixtures/lint-cycle/` or `tests/fixtures/lint-zones/`
  from real code, and don't "fix" them.** They are committed violations that
  `tests/unit/lint-gates.test.ts` lints to prove `import-x/no-cycle` (on a
  relative and an `@/` import) and each layer zone fire.
- **`tsconfig.json` and `tsconfig.typecheck.json` must not be merged.**
  `tsconfig.json` builds `src/` with `rootDir: ./src`;
  `tsconfig.typecheck.json` widens `include` to `tests/` and
  `drizzle.config.ts` for lint and type-checking. Widening the build config's
  `include` breaks the build with `TS6059`.
- **TypeScript is pinned `~6.0.3`.** `typescript-eslint@8.70.1` peers
  `typescript: >=4.8.4 <6.1.0`, and `pnpm lint` depends on its type-aware
  rules. Bump `typescript` only once a `typescript-eslint` release's peer
  range includes `^7.0.0`, and lift `renovate.json`'s `<6.1.0` rule with it.
- **Every authenticated write needs a limiter.** Mount
  `createRateLimiter(RATE_LIMITS.authenticatedWrite)` after `requireAuth` on a
  new `POST`/`PUT`/`PATCH`/`DELETE` route, or give the route its own spec.
  Build it once per router and reuse it on each write route, so the in-memory
  fallback keeps one budget. `tests/unit/routes/route-limiters.test.ts` fails
  otherwise; a hand-rolled `rateLimit()` doesn't count. Each entry in its
  allowlist, for a route that can't carry a limiter, needs a reason.
- **Bind a timestamp in raw `sql` as `${date.toISOString()}::timestamptz`.**
  A `Date` inside a `sql` template reaches postgres-js unserialised and the
  query fails; `lt(column, date)` is fine.
- **Free-text fields use `safeText`:** single-line by default,
  `{ multiline: true }` for prose.
