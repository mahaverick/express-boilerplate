# Architecture

How the pieces of this boilerplate fit together. What it does not build is
listed in [SECURITY.md](SECURITY.md#what-this-boilerplate-does-not-implement).

## Boot sequence: `index.ts` -> `server.ts` -> `app.ts`

The app is split into three files:

```
src/index.ts    entrypoint — validates the environment, then boots
src/server.ts   owns the listening socket and the shutdown sequence
src/app.ts      builds the Express app — no listen, no side effects
```

`createApp()` in `app.ts` returns a plain, unstarted `Express` instance, so
tests import it without binding a port.

**`index.ts`** first calls `getEnv()` and `assertEnvConsistent` inside a
`try/catch`. If the environment is invalid, it prints the named list of what
is wrong and exits 1, before anything else runs. Only then does it
`import('@/server')` **dynamically**. A static import would be evaluated before
`main()`'s `try/catch` ran, and `@/server` transitively imports
`database.service.ts`, which calls `getEnv()` at module scope: an invalid
environment would surface as a stack trace from inside a dependency instead of
the named list.

`boot()` then starts the server and routes `SIGTERM`, `SIGINT`, an unhandled
rejection, an uncaught exception and a server `error` event through one
shutdown handler (`createShutdownHandler`, `lifecycle.service.ts`). It runs
`gracefulShutdown` once and exits 1 if that takes longer than
`SHUTDOWN_TIMEOUT_MS`.

With `WORKER_ENABLED`, `index.ts` then starts the Workers through
`startWorkers()` (`worker-supervisor.service.ts`): email, notification and
maintenance, and analytics when `POSTHOG_PROJECT_KEY` is set. Each time the
supervisor starts a worker generation (boot is the first) it also registers
the daily retention schedule (`ensureRetentionSchedule`,
`src/jobs/maintenance.job.ts`) and, with analytics on, the analytics drain
schedule (`ensureAnalyticsDrainSchedule`, `src/jobs/analytics.job.ts`). A
failed registration logs a `warn` and is retried with the next generation. A new
generation starts only when a worker connection gives up before its first
ready, so a registration that fails while the Workers stay healthy waits
for the next restart. The scheduler is stored in Redis, so one registered
earlier keeps running meanwhile.

**`server.ts`** exports `startServer(port?)` and `gracefulShutdown(server, workers?)`.
`startServer` takes the port as a parameter so tests can bind an ephemeral
port (`startServer(0)`): `getEnv()` is memoised, so a test cannot change
`APP_PORT` after import. `gracefulShutdown` runs in this order:

1. readiness starts answering 503 (`markShuttingDown`), and open SSE streams
   are ended, since they would hold the socket open;
2. the socket closes and drains; connections still open after
   `SERVER_DRAIN_TIMEOUT_MS` (5 s) are force-closed;
3. the Workers close, finishing their current job, while the database and
   Redis are still up;
4. the database, Redis, queue and notification-subscriber clients close;
5. OpenTelemetry flushes and shuts down, last, so no span from the steps
   above is dropped.

**`app.ts`** wires, in order: `x-powered-by` off, `trust proxy` from
`TRUST_PROXY`, `helmet`, `cors`, `requestId`, `requestContext`, the email
webhook router (`/api/v1/webhooks/email`) and the analytics proxy
(`/api/v1/collect`, behind its own limiter), both ahead of the JSON (1 MB)
and urlencoded (100 KB) body parsers, which would consume or refuse their
bodies, then `GET /health`,
`GET /health/ready`, the versioned API router (`createApiRouter()` at
`/api/v1`), a 404 catch-all, then `errorHandler`. Express matches in
registration order, and the error handler must be last to see errors from
everything before it.

## Request path: auth and beyond

`createApiRouter()` (`src/routes/index.routes.ts`) mounts one router per
feature under `/api/v1`: `auth`, `profile`, `notifications`, `tenants`,
`invitations` and `platform`. A new feature router is one more `router.use(...)`
line there, never a change to `app.ts`. The one exception is
`POST /api/v1/webhooks/email/:provider` (`src/routes/email-webhook.routes.ts`),
which `app.ts` mounts after `requestContext` and before the global
`express.json`: a provider's signature covers the exact body bytes, so the
route reads them with its own `express.raw` (256kb). It is public (the
signature authenticates it); an unknown or disabled provider gets the
unknown-route 404 before any limiter runs, and a bad signature gets 401
`INVALID_SIGNATURE`. Two limiters guard it: `emailWebhookRejected` (60 a minute
per IP, counting only responses of 400 or above) and `emailWebhook` (3000 a
minute per provider, counting only accepted requests), so forged traffic
cannot spend the budget a provider's real events need. See
[Email tracking](#email-tracking).

Every authenticated OPTIONS that reaches the platform router gets the
unknown-route 404 (`refusePlatformOptions`), so Express's automatic `Allow`
answer never lists a staff route's methods. `cors` has already answered an
allowed-origin preflight, and `requireAuth` refuses an OPTIONS without a
bearer token; staff routes serve no cross-origin preflight of their own. The
router serves staff reads to any platform role: `GET /platform/tenants` (with
`state` and back-paging), `GET /platform/tenants/:id` (any lifecycle state),
`GET /platform/users` (with `status=deleted` for soft-deleted users), `GET
/platform/users/:id` (a soft-deleted user too), `GET /platform/stats`, and
message tracking: `GET /platform/emails`, `/platform/emails/health`,
`/platform/emails/:id` and its `/preview`, `GET
/platform/email-suppressions`, and onboarding: `GET
/platform/onboarding/funnel`, `/platform/onboarding/tenants` and `GET
/platform/tenants/:id/onboarding`.
Platform admins also get `GET /platform/audit-log` (filterable by `tenantId`,
`targetId`, actor, action and access) and every create, update and soft
action: create a tenant and invite its owner, re-invite an owner, suspend,
reactivate and archive a tenant, create and edit users, deactivate,
reactivate, sign out and soft-delete users, send set-password or
verification mail, resend a token email through the action that sent it,
lift an email suppression, mark a tenant's onboarding step complete and
send its owners an onboarding reminder. Platform owners also get the two hard deletes, `POST
/platform/users/:id/purge` and `POST /platform/tenants/:id/purge`, and may act
on other staff owners. Each route names its own `requirePlatformRole`, which
answers 404 below it. Deactivate, delete, both purges, suspend, archive and
the owner re-invitation also need a sign-in within the last 10 minutes
(`requireRecentAuth`, 401 `REAUTH_REQUIRED`), and so does an email resend of
a platform-tenant invitation, which the service decides per message with the
same predicate (`isRecentAuth`, `src/utilities/recent-auth.utilities.ts`);
`POST /auth/reauthenticate`
(staff only, password only) renews it. A staff sign-out, deactivation or
delete revokes every token the user holds, whatever its purpose, so an
unredeemed verification or set-password link dies with the sessions. Staff
work inside an active tenant (edit, members, invitations, settings) goes
through the ordinary `/tenants/:slug/*` routes with the platform role. On the
platform tenant those member routes are how staff roles change, with step-up
on a role change, a removal, an invitation offering admin or owner, and a
resend, and a last-owner guard that counts active owners only. Every
successful `/platform` write that the role gate admitted logs one `Staff
write` line (`logStaffWrites`, `platform.middleware.ts`: method, path, status,
actor id, and the target's type and id when the path names one; never the
body); the audit log is the record.

**Open auth routes.** `register`, `login`, `verify-email`,
`resend-verification`, `forgot-password`, `reset-password`, `refresh` and
`logout` need no access token. The auth router refuses any body that is not
`application/json` with 415 (`requireJsonContentType`). `register`,
`reset-password` and `change-password` **hash** a password; `login`,
`verify-email` and `change-password` **compare** one. All of them go through
`src/utilities/password.utilities.ts`, never bcrypt directly. `login` mints an
access token (`signAccessToken`) and a refresh token (`issueRefreshToken`), set
as an httpOnly cookie. [SECURITY.md](SECURITY.md) explains both token types,
password hashing, user-enumeration resistance and rate limiting.

**Authenticated routes** sit behind `requireAuth`
(`src/middlewares/auth.middleware.ts`). The profile, notification, tenant and
platform routers mount it once with `router.use(requireAuth)`, so a route added
later inherits the gate. `change-password`, `reauthenticate`, `providers` and
`POST /invitations/accept` mount it per route. `requireAuth` verifies the
bearer access token (`verifyAccessToken`), refuses a token whose session is on
the Redis denylist (`isSessionDenied`), then reloads the user by id. The reload
costs one database read per authenticated request; in exchange, a disabled or
deleted account is refused on its next request instead of when its token
expires.

**`POST /api/v1/auth/refresh`** and **`POST /api/v1/auth/logout`** need no
access token, since it has often expired by the time either is called. Both
read the refresh-token cookie off the raw `Cookie` header. There is no
`cookie-parser`: the names are known in advance (`refreshCookieSpec`, plus the
legacy `refreshToken`; see SECURITY.md, "Cookies").

**The repository layer** (`src/repositories/`) is a thin layer over
`src/database/models/`. `BaseRepository` owns soft-delete filtering,
`updatedAt` maintenance and the unique-violation-to-409 translation.
`UserRepository`, `UserTokenRepository` and `TenantRepository` extend it, each
supplying the four queries it cannot express generically (`selectOne`,
`insertOne`, `updateOne`, `markDeleted`). Every public method it defines takes
a final optional `executor: DbExecutor = db` parameter, so a caller can run it
inside its own transaction. The other repositories do not extend it, because
their tables have no soft-delete concept for its policy to apply to:
`email_logs`, `email_events` and `audit_logs` are append-only outside the
retention purge and the staff purge, `email_messages` changes only its status
and `email_suppressions` only its lift,
`platform-tenant.repository.ts`, `platform-user.repository.ts` and
`platform-email.repository.ts` are read-only cross-tenant searches and detail
reads, `platform-stats.repository.ts` holds the read-only Overview
aggregates, and the rest (auth providers,
notifications, notification preferences, tenant settings, invitations,
memberships) have no `deletedAt` column. See [DATABASE.md](DATABASE.md) for
the models.

## Email verification and password recovery wiring

`users.email_verified_at` (`src/database/models/user.model.ts`) gates login,
and `markEmailVerified` (`verification.service.ts`) is its only writer. It
never moves an earlier timestamp. `profile.validators.ts` leaves `email` out of
the profile-update allow-list, because changing an address there would carry a
verified flag to an address nobody verified.

- `POST /api/v1/auth/register` answers the same `202` whether or not the
  address is free. For a new account it issues an `email_verification` token
  (`user_tokens`, through `issueToken`) and enqueues a `verify_email`
  notification; the worker mails a link to `WEB_URL/verify-email?token=…`.
  For a taken address it mails a registration-attempt notice instead.
- `POST /api/v1/auth/verify-email` (`verification.controller.ts`) takes the
  token **and** the account's password, and a wrong password spends the token
  like a right one. SECURITY.md, "Email verification", explains why.
- `POST /api/v1/auth/resend-verification` revokes an unverified user's live
  verification tokens and mails a new link. The response is identical for an
  unknown, an unverified and a verified address.
- `POST /api/v1/auth/login` refuses an account whose `email_verified_at` is
  null through the same guard, and the same `401`, as a wrong password.
- `POST /api/v1/auth/forgot-password` answers the same `202` for every address,
  replying before the lookup. For an existing account it issues a
  `password_reset` token and mails a link to `WEB_URL/reset-password?token=…`.
- `POST /api/v1/auth/reset-password` claims that token, stores the new hash
  under the user-row lock and revokes every session. On a never-verified account it
  also sets `email_verified_at`, since the reset proves the same mailbox
  control, and deletes any federated sign-in linked to it.
- `POST /api/v1/auth/change-password` (behind `requireAuth`) checks the current
  password and revokes every other session, or every session when the access
  token carries no session id.
- A Google sign-in marks the address verified too (`google-auth.service.ts`).

Each route carries its own rate limiters; SECURITY.md, "Rate limiting", lists
them. The mail goes through the notification and email workers (see CLAUDE.md,
"Notifications"), and locally lands in Mailpit (`docker-compose.yml`). Rows
created without `email_verified_at` cannot log in; SECURITY.md, "Email
verification", covers backfilling them.

## Layers

| Layer        | Directory           | Job                                                                                             | May import                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| routes       | `src/routes/`       | Wire middleware to controller methods.                                                          | controllers, middlewares, configs, constants                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| middlewares  | `src/middlewares/`  | Cross-cutting request handling (auth, tenant resolution, rate limits, errors).                  | services (`resolveTenant` reads the platform role through `platform.service` and writes its staff-access entry through `audit.service`; `requirePlatformRole` reads `platform.service`; `logStaffWrites` logs through `logger.service`), repositories (read-only lookups in `resolveTenant`/`requireAuth`), policies, presenters (e.g. `auth.middleware.ts` builds `request.user` via `toAuthenticatedUser`, `src/presenters/user.presenter.ts`), errors, configs, utilities, constants |
| configs      | `src/configs/`      | Env and library configuration.                                                                  | services, utilities, constants                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| presenters   | `src/presenters/`   | Pure mappers from a database row to its wire shape.                                             | types from `database/models` and `types/`, and constants (e.g. `AuthProvider`)                                                                                                                                                                                                                                                                                                                                                                                                          |
| controllers  | `src/controllers/`  | Parse and validate input, call service methods, shape the response.                             | services, presenters, validators, errors, configs, utilities/response.utilities, constants, types, and `database/models` types via `import type` only                                                                                                                                                                                                                                                                                                                                   |
| services     | `src/services/`     | Business rules, transactions, authorization, side effects.                                      | repositories, policies, other services, workers, jobs, templates, errors, utilities, configs, constants, types, `database/models`, `database.service`, validator types (`import type`, for a validated-input shape a service signature needs)                                                                                                                                                                                                                                           |
| policies     | `src/policies/`     | Pure, boolean-returning authorization functions. Never throw.                                   | constants and types only                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| repositories | `src/repositories/` | Queries only.                                                                                   | models, `database.service`, errors, constants                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| errors       | `src/errors/`       | Error classes and Postgres error handling (`HttpError`, `isUniqueViolation`, `redactedForLog`). | nothing under `src/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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
`database/models` for types only (`import type`), never a value. An eighth,
core `no-restricted-imports` over `src/**` with
`src/services/platform-*.service.ts` ignored, keeps
`repositories/platform-tenant.repository.ts` (every customer tenant, for
staff search), `repositories/platform-stats.repository.ts` (staff Overview
aggregates), `repositories/platform-user.repository.ts` (every user, for
the staff directory), `repositories/platform-email.repository.ts` (every
email) and `repositories/platform-onboarding.repository.ts` (every tenant's
onboarding) out of every other module, so "your tenants" can never be
served from it. `tests/unit/lint-gates.test.ts` proves each of the eight
fires, against a committed violating fixture under
`tests/fixtures/lint-zones/`. `import-x/no-restricted-paths` is a
blocklist, not an allowlist, so a "may import" cell above with no zone
naming it (most of middlewares' own imports, services importing validator
types, presenters importing constants) is unrestricted by lint: the table
states the intended shape, and only the eight rules above enforce it. When
one of them refuses an import, either the import is wrong or the table and the
zone config change together.

Every route handler is a `BaseController` (`src/controllers/base.controller.ts`)
method, an arrow-function class field. Nearly all are built through
`this.handle(handler)`, which forwards a thrown or rejected error to `next()`
and never sends a response itself. Once `response.headersSent`, it also logs a
`warn` (without the error object, so it can never bypass `redactedForLog`)
before calling `next(error)`; `errorHandler` (`error.middleware.ts`) then logs
the error redacted and destroys the socket rather than attempting a second
write. The two exceptions are `handleGoogleCallback` (`auth.controller.ts`),
which redirects every failure to the frontend instead of answering JSON, and
`streamNotifications` (`notification-stream.controller.ts`), an SSE stream.
Both still call a service, so they are exceptions to `handle()`, not to the
layering above. Each controller file exports one singleton instance
(`export const tenantController = new TenantController()`), which its routes
file imports.

**Lock order**, binding for every transaction that locks more than one row
set:

1. the user row, for password writes, login and Google sign-in (both
   `FOR SHARE`), refresh rotation, logout, the refresh kills, step-up and
   the Google account claim (`lockById`, `user.repository.ts`), none of
   which goes on to lock a membership or tenant row. Staff writes are the
   one place the user row comes later: they lock owner rows and platform
   memberships first, then the actor's user row `FOR SHARE`
   (`assertStillPlatformRole`, `platform.service.ts`) and, for a user
   action, the target's (`lockStaffPair`, `platform-user.service.ts`).
   Staff tenant transitions and the owner re-invitation then lock the
   tenant row (step 5), after the actor's user row. No cycle follows:
   no transaction that starts on the user row locks anything below it in
   this list, and nothing that holds a tenant row goes on to lock a user
   row (`updateTenant`, the transitions, the owner re-invitation and the
   tenant purge lock no user row after it);
2. the tenant's owner rows (`lockOwners`, ordered by `id`);
3. memberships, ordered by `user_id` (`lockMemberships`);
4. only when the actor has no membership in the tenant, the actor's
   platform-tenant membership, `FOR SHARE` (`lockTenantAccess`,
   `tenant-access.service.ts`, via `lockPlatformRole`,
   `user-membership.repository.ts`);
5. the row a tenant or settings update writes (`lockById`,
   `tenant.repository.ts`; `lockByTenantId`,
   `tenant-settings.repository.ts`).

A transaction that takes these out of order can deadlock against one that
follows it. The order is written into the JSDoc of `lockOwners`,
`lockMemberships` and `lockPlatformRole` (`user-membership.repository.ts`), of
`lockTenantAccess` (`tenant-access.service.ts`), and of `lockById` and
`lockByTenantId`. Postgres cannot enforce an application-level lock order, so
only that convention and a deadlock regression test
(`tests/integration/services/tenant-membership.service.test.ts`) hold it.

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

**Platform access.** These services carry it. Their callers stay in the
layers above.

| Service                          | Job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant-access.service.ts`       | `lockTenantAccess(actor, tenantId, otherUserIds, mode, tx)`: locks owners, memberships and, when the actor has no membership, the platform membership, in that order (step 4 above), returning the actor's access and the locked memberships. `resolveActorAccess(actor, tenantId, tx)` wraps it for a caller with no other memberships to lock. Membership wins; the platform tenant is members-only.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `platform.service.ts`            | `getPlatformMembership` (one indexed read, no cache), `assertStillPlatformRole` (the actor's platform role re-read under lock inside a staff write, 404 below the route's role, 401 for an account gone or inactive), `autoJoin` (viewer only, verified addresses on `PLATFORM_EMAIL_DOMAINS`), `bootstrapGrant` (the `platform:grant` script only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `platform-tenant.service.ts`     | `searchAll` (state filter, keyset both ways), `getTenantDetail`, `createTenant` (no members, owner invited in the same transaction), `reissueOwnerInvitation`, `suspendTenant`/`reactivateTenant`/`archiveTenant` (one conditional UPDATE each, `transitionLifecycle`; archive also revokes pending invitations). The only importer of `platform-tenant.repository.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `platform-user.service.ts`       | The staff user directory and user actions: search, detail, create with a set-password mail, edit, password-setup, resend-verification, deactivate, reactivate, sign-out, soft delete. State changes re-read the actor's platform role and the target under lock (`lockStaffPair`); the two mail actions check rank without a lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `platform-purge.service.ts`      | `purgeUser` and `purgeTenant`, the only hard deletes. With `retention.service.ts`, the only code that names the audit trigger's settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `platform-stats.service.ts`      | `getPlatformStats`: totals and zero-filled per-UTC-day sign-up and email series for the staff Overview. The only importer of `platform-stats.repository.ts`. `emails[]` (deprecated) counts send attempts: `email_logs` has one row per attempt, so a mail retried and then sent adds both a failed and a sent row. `emailMessages[]` counts messages (`email_messages`) by current status in five disjoint groups. `totals.stuckTenants` comes from `countStuckTenants` (`platform-onboarding.service.ts`).                                                                                                                                                                                                                                                                                                                                       |
| `platform-email.service.ts`      | Message tracking for staff: search, detail, masked preview, health, the suppression list and lift, and resend, which delegates to resend-verification, password-setup or the invitation resend with their own gates and audit and adds `email.resent`. `canResendFor` computes the list's `canResend` hint with the same predicates (`canStaffMailTarget`, `canActorGrantRole`). The only importer of `platform-email.repository.ts`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `platform-onboarding.service.ts` | Staff onboarding: the funnel, the per-state tenant list, one tenant's onboarding with reminder history, `countStuckTenants` for the Overview, marking a tenant step complete through `completeOnboardingStep`, and the reminder (one `onboarding_reminder` per active owner; the owners' `email_messages` rows and the `onboarding.reminder_sent` audit entry are written in one transaction holding the tenant row's lock, which makes the 24-hour limit, read from the latest such entry, race-safe; the jobs are enqueued after commit, and a queue failure leaves the entry and a `failed` row and answers `emailSent: false`), both audited in the tenant; `reconcileOnboarding` for `pnpm onboarding:reconcile`. Progress is derived in SQL by `platform-onboarding.repository.ts`, its only importer, with `deriveOnboardingState`'s rules. |
| `tenant-invitation.service.ts`   | Besides member invitations, `createOwnerInvitation`/`sendOwnerInvitation`: the staff-only owner invitation for a tenant with no active owner, which skips `canActorGrantRole` (the route's platform-admin gate authorizes it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `audit.service.ts`               | `record(entry, tx)`, in the caller's transaction, with strict per-action metadata; `recordPlatformAccess` (hourly, deduplicated in Redis); `listForTenant` and `listPlatformWide` (keyset; the platform read also filters by `tenantId` and `targetId`, served by `audit_logs_target_occurred_idx`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`platform-user.service.ts` and `platform-purge.service.ts` are the only
importers of `platform-user.repository.ts`.

## Extending Apex

Apex is a template: a product adds its own fields, states and staff actions.
Each recipe below lists every place that must change together.

- **A user or tenant field staff can see.** Add the column (model +
  `pnpm db:migration:generate`), select it in `platform-user.repository.ts`
  (`recordSelection`) or `platform-tenant.repository.ts` (`searchAll`,
  `findDetail`), and mirror it in apex's `src/types/api.types.ts`. If staff
  may edit a user field, add it to `updatePlatformUserSchema`
  (`platform.validators.ts`, strict); a tenant field is edited through
  `PATCH /tenants/:slug` (`updateTenantSchema`, `tenant.validators.ts`).
  Either way, list it in `changed` in the `user.updated` / `tenant.updated`
  audit metadata (field names only, never values).
- **A tenant lifecycle state.** Add it to `TENANT_LIFECYCLE_STATES` (the
  model's CHECK reads it; generate the migration that changes the CHECK),
  decide what `statesFor` (`platform.constants.ts`) lists by default, give it
  a transition in `platform-tenant.service.ts` (`transition` with its `from`
  states, which calls `transitionLifecycle`) and an audit action, and decide
  whether `resolveTenant` and invitations treat it like `suspended`.
- **A staff action.** A POST under `/platform/users/:id/<verb>` or
  `/platform/tenants/:id/<verb>`: `requirePlatformRole(<least role>)`,
  `requireJsonContentType`, `requireRecentAuth()` when it is destructive,
  then the shared `writeLimiter`. Body `reasonBodySchema` (or a strict schema
  that includes `reason`). In the service: one transaction that re-reads the
  actor's platform role under lock (`assertStillPlatformRole`, or
  `lockStaffPair` for a user target), applies `canPlatformActorModifyTarget`
  to a staff target, writes, and records an `AUDIT_ACTIONS` entry with
  `{ reason }`. Add its row to
  `tests/integration/api/platform-route-gates.test.ts` (the completeness
  check fails until you do) and mirror the action in apex's
  `src/constants/audit-actions.ts`.
- **An onboarding step.** Add it to `ONBOARDING_STEPS`
  (`src/constants/onboarding.constants.ts`); the staff funnel, list and
  tenant tab, the customer checklist and both apps pick it up with no other
  change. An `auto` step needs a trigger that some service emits after
  commit, or a direct `completeOnboardingStep` call. See
  [Onboarding in README.md](README.md#onboarding).
- **An email template.** Add the template module with its variables and
  its `…_TEMPLATE_META` (sender class, `previewVariables`, `resendAction`),
  add its key to `EMAIL_TEMPLATE_KEYS` and `MailMessage`, and give
  `buildPreviewMessage` (`platform-email.service.ts`) a case that masks its
  token links (a `…Link` variable, which carries no token, is stored and
  shown as sent, as in `onboarding_reminder`). A mail that carries a token must be `transactional` (the type
  enforces it) and needs a `resendAction` that re-issues the token, or
  `null` if it must never be resent. Mirror the key and its label in apex's
  `EMAIL_TEMPLATES`.

## Directory rules

Where new code goes, and what it must be named. `eslint-plugin-check-file` in
[`eslint.config.mjs`](eslint.config.mjs) enforces the filename rules below, and
`pnpm lint` fails on a misnamed file in a governed directory. This section
mirrors that config by hand; when they disagree, the config is right and this
section is stale.

### Governed directories (filename suffix enforced)

Every file in a governed directory carries its role as a filename suffix.

| Directory              | Required suffix   | Example                      |
| ---------------------- | ----------------- | ---------------------------- |
| `src/controllers/`     | `*.controller.ts` | `tenant.controller.ts`       |
| `src/repositories/`    | `*.repository.ts` | `user.repository.ts`         |
| `src/services/`        | `*.service.ts`    | `database.service.ts`        |
| `src/policies/`        | `*.policy.ts`     | `tenant.policy.ts`           |
| `src/presenters/`      | `*.presenter.ts`  | `user.presenter.ts`          |
| `src/validators/`      | `*.validators.ts` | `auth.validators.ts`         |
| `src/routes/`          | `*.routes.ts`     | `auth.routes.ts`             |
| `src/middlewares/`     | `*.middleware.ts` | `error.middleware.ts`        |
| `src/database/models/` | `*.model.ts`      | `user.model.ts`              |
| `src/utilities/`       | `*.utilities.ts`  | `response.utilities.ts`      |
| `src/constants/`       | `*.constants.ts`  | `global.constants.ts`        |
| `src/configs/`         | `*.config.ts`     | `env.config.ts`              |
| `src/jobs/`            | `*.job.ts`        | `email.job.ts`               |
| `src/workers/`         | `*.worker.ts`     | `email.worker.ts`            |
| `src/templates/`       | `*.template.ts`   | `password-reset.template.ts` |

The suffix is usually the **singular** of the directory's role (`controller`,
`service`, `model`, `config`, ...), but `src/validators/`, `src/utilities/`,
`src/constants/` and `src/routes/` keep the **plural** (`.validators`,
`.utilities`, `.constants`, `.routes`). Test files are exempt: the suffix rule is off under
`tests/`, and no test file lives under `src/`.

### Directories with no filename rule

- `src/errors/`: error classes and Postgres error handling, `http-error.ts`
  (`HttpError`) and `postgres-errors.ts` (`isUniqueViolation`, `redactedForLog`).
- `src/types/`: ambient type augmentation (`express.d.ts` extending
  `Express.Request`) and small cross-cutting types with no other home, such as
  `actor.ts` and `lock-mode.ts`.
- `src/scripts/`: standalone tools run through `tsx` from a `package.json`
  script, never imported by the app (`generate-env-example.ts`,
  `platform-grant.ts`). They live under `src/` so `tsconfig.json`'s `include`
  and the type-aware lint rules see them.
- `src/database/`: `migrate.ts`, the migration runner behind `pnpm db:migrate`,
  beside `models/` and `migrations/`.
- `src/database/migrations/`: generated by `drizzle-kit generate` and
  **committed**; CI and deployments replay them and never regenerate them.
  Don't hand-edit a file here except as a documented exception, and don't
  git-ignore the directory; see [DATABASE.md](DATABASE.md).
- `src/observability/`: `tracing.ts`, the OpenTelemetry bootstrap loaded
  through `--import` before the app. It is a single fixed-name entrypoint, so
  `check-file` is off here. See [Observability](#observability).
- `scripts/` (repo root): repo tooling outside `src/`. `lint-docs.mjs`
  (`pnpm lint:docs`), `comment-style.mjs` (the `local/comment-style` ESLint
  rule), `history-patterns.mjs` (shared by both) and their `.d.mts` types.
  `eslint.config.mjs` and the tests import them; the app never does. They are
  linted without type information.

### Root files

`src/app.ts`, `src/server.ts` and `src/index.ts` sit directly under `src/` and
name the three stages of the [boot sequence](#boot-sequence-indexts---serverts---appts)
rather than a role a suffix could encode. There is only one of each.

### Folder naming

Every folder under `src/` must be `kebab-case`
(`check-file/folder-naming-convention`).

### No barrel files

There is no `index.ts` re-export file anywhere in `src/`, and none should be
added. Import the module directly:

```ts
import { getEnv } from '@/configs/env.config'
```

not through a barrel:

```ts
import { getEnv } from '@/configs'
```

A barrel fails `check-file/filename-naming-convention` in every governed
directory (an `index.ts` under `src/services/` cannot end in `.service`). It
also hides real edges from `import-x/no-cycle`: a cycle routed through a
barrel is invisible to that rule.

### Adding a new governed directory

A new top-level concern under `src/` gets its naming rule in
`check-file/filename-naming-convention` in `eslint.config.mjs` **and** a row in
[Governed directories](#governed-directories-filename-suffix-enforced), in the
same change.

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

`.env` is loaded twice over, on purpose. `pnpm dev` and `pnpm start` pass
`--env-file-if-exists=.env` to Node, so the values reach `tracing.ts`, which
loads before any app module. `env.config.ts` also loads `.env` with `dotenv`,
which never overrides a key that is already set, so it only fills keys Node
left unset; `tsx` scripts such as `pnpm db:migrate` rely on it. It is skipped
under Vitest, whose environment `tests/helpers/setup-global.ts` assembles. The
Docker image's `CMD` passes no env file: the image has no `.env`, and the
orchestrator supplies the environment.

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

| Variable                              | Required | Default                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                             | **yes**  | —                          | Which deployment this is: local, dev, qa or prod. Required. COOKIE_SECURE and LOG_FORMAT default from it, and SMTP requires TLS everywhere but local.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NODE_ENV`                            | **yes**  | —                          | Node runtime mode: development, test or production. Required. Express reads it directly, and only production hides stack traces in its built-in error handler, so every APP_ENV but local must run production. test is for the test suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `APP_PORT`                            | no       | `4040`                     | Port the HTTP server listens on. Defaults to 4040.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `APP_URL`                             | **yes**  | —                          | Public origin of this API. Used to build the Google OAuth callback URL (passport.config.ts) — must match a redirect URI registered in Google Cloud Console exactly, including scheme and trailing slash. http://localhost:4040 locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `WEB_URL`                             | **yes**  | —                          | Public origin of the frontend, with no query or fragment. Email verification links are built from it — the link points at your frontend, which POSTs the token to this API. http://localhost:5173 locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `APEX_URL`                            | no       | —                          | Public origin of the Apex staff dashboard, e.g. https://admin.example.com, with no query or fragment. When set, platform-tenant invitation links, and the verification, password-reset and Google sign-in flows started with app "apex", point here instead of WEB_URL. Unset sends every link to WEB_URL. Google sign-in from a host other than APP_URL also needs COOKIE_DOMAIN covering both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DATABASE_URL`                        | **yes**  | —                          | Postgres connection URL. The compose stack publishes Postgres on localhost:5433: postgres://boilerplate:boilerplate@localhost:5433/boilerplate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `REDIS_URL`                           | **yes**  | —                          | Redis connection URL. The compose stack publishes Redis on localhost:6380: redis://localhost:6380.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DB_POOL_MAX`                         | no       | `10`                       | Most open connections in the Postgres pool, per process. Defaults to 10. The test suite sets 2, so its parallel workers stay under Postgres's default 100 connections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DB_STATEMENT_TIMEOUT_MS`             | no       | `30000`                    | Milliseconds a single SQL statement may run before Postgres cancels it (statement_timeout). Defaults to 30000 (30s). 0 sends no limit, leaving the server's own setting. A statement_timeout in DATABASE_URL's query string overrides it. PgBouncer, in every pool mode, refuses a startup parameter not listed in its ignore_startup_parameters, so behind it set 0 or list statement_timeout there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JWT_ACCESS_SECRET`                   | **yes**  | —                          | Signs and verifies access tokens (session.service.ts). Any 32+ character string works; use `openssl rand -hex 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SESSION_SECRET`                      | **yes**  | —                          | Signs the express-session cookie used during the Google OAuth round-trip (passport.config.ts). Any 32+ character string works; use `openssl rand -hex 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GOOGLE_CLIENT_ID`                    | no       | —                          | Google OAuth 2.0 client ID. When absent, Google login is disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GOOGLE_CLIENT_SECRET`                | no       | —                          | Google OAuth 2.0 client secret. Required when GOOGLE_CLIENT_ID is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ACCESS_TOKEN_TTL`                    | no       | `15m`                      | Access token lifetime, as an ms()-parseable duration string (e.g. "15m"). Defaults to 15m.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `REFRESH_TOKEN_TTL`                   | no       | `30d`                      | Refresh token lifetime, as an ms()-parseable duration string (e.g. "30d"). Defaults to 30d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SESSION_ABSOLUTE_TTL`                | no       | `30d`                      | Hard ceiling on one login session, measured from the login itself and never reset by rotation, as an ms()-parseable duration string (e.g. "30d"). Past it, refreshing fails and the user signs in again. Defaults to 30d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EMAIL_VERIFICATION_TTL`              | no       | `24h`                      | How long an email-verification link stays valid. Defaulted to 24h; a link the user finds the next morning should still work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PASSWORD_RESET_TTL`                  | no       | `1h`                       | How long a password-reset link stays valid. Defaulted to 1h — shorter than EMAIL_VERIFICATION_TTL, because redeeming it grants immediate account takeover rather than merely proving mailbox ownership.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ACCOUNT_SETUP_TTL`                   | no       | `24h`                      | How long the set-password link mailed to a staff-created account stays valid. Defaulted to 24h: the recipient did not ask for the mail, so it must last until the next working day; the link is single-use either way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `INVITATION_TTL`                      | no       | `7d`                       | How long a tenant invitation link stays valid, as an ms()-parseable duration string (e.g. "7d"). Resending an invitation issues a new link with a fresh lifetime. Defaults to 7d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `TRUST_PROXY`                         | no       | `false`                    | How much of X-Forwarded-For to believe. "false" (default) trusts none: correct when clients reach this app directly, WRONG behind a proxy, where every IP-keyed rate limiter then shares one bucket for the whole deployment. Behind a proxy set the NUMBER of proxies in front of this app (e.g. "1"), or a comma-separated list of trusted proxy addresses/subnets or presets ("loopback", "linklocal", "uniquelocal"). Never "true" — it is refused, because it lets any client spoof its own IP and bypass the limiters.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `COOKIE_SECURE`                       | no       | —                          | Whether the refresh-token and OAuth session cookies carry the Secure attribute ("true" or "false"). Defaults from APP_ENV: false on local, true elsewhere. With Secure on behind a TLS-terminating proxy, TRUST_PROXY must be set, or the OAuth session cookie is never sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `COOKIE_DOMAIN`                       | no       | —                          | Domain attribute for the refresh-token and OAuth session cookies, e.g. "example.com" to share them with subdomains. Unset means host-only cookies, the narrowest scope. Boot refuses a value that APP_URL's host is not within, since browsers would reject the cookies. With COOKIE_SECURE on, the refresh cookie is __Secure-refreshToken when this is set and __Host-refreshToken (Path=/) when it is not, so setting or unsetting it on a live deployment signs users in again once. With COOKIE_SECURE on, an unprefixed refreshToken cookie is also read, then cleared in its host-only form and under this domain; that fallback is removed in the next major version. Within one name the API reads the most recently created cookie. Reverting to an earlier value is the exception: the browser keeps that cookie's original creation time, so the other scope's cookie reads as newer and refresh fails until the user logs in again or it expires. |
| `CORS_ALLOWED_ORIGINS`                | no       | —                          | Extra browser origins allowed to call this API, comma-separated (e.g. "https://admin.example.com,https://shop.example.com"). WEB_URL is ALWAYS allowed and does not need listing here, and same-origin requests send no Origin header at all. Leave empty for a single-frontend deployment. Never a wildcard: this API sends credentials, and the CORS spec forbids "*" with credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PLATFORM_EMAIL_DOMAINS`              | no       | —                          | Comma-separated email domains, e.g. "example.com,example.org". A user whose verified address is on one of them joins the platform tenant as viewer, when the address is verified and at every sign-in. Viewer can see every tenant and change nothing; a higher platform role needs an explicit grant (pnpm platform:grant, or an invitation to the platform tenant). Only the exact domain after the last "@" matches, never a subdomain. Empty means nobody joins automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | no       | —                          | Absent means tracing is disabled; the SDK is never started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `OTEL_SERVICE_NAME`                   | no       | `express-boilerplate`      | Service name reported in OTEL traces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `LOG_LEVEL`                           | no       | `info`                     | Console log level: error, warn, info or debug. silent disables logging entirely (the test suite uses it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LOG_FORMAT`                          | no       | —                          | Console log format: json or pretty. Defaults from APP_ENV: pretty on local, json elsewhere. pretty needs the pino-pretty devDependency; without it the logger writes json.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SLACK_WEBHOOK_URL`                   | no       | —                          | Slack Incoming Webhook URL for log alerting. When unset, no Slack transport is registered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SLACK_LOG_LEVEL`                     | no       | `error`                    | Minimum log level that triggers a Slack notification. Defaults to error; set to warn if you want Slack alerts for warnings too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `WORKER_ENABLED`                      | no       | `true`                     | Whether the BullMQ workers (email, notification and maintenance, plus analytics when POSTHOG_PROJECT_KEY is set) start in-process alongside the HTTP server. Set to false for API-only pods behind a load balancer; a separate worker deployment sets this to true. The daily retention purge and the analytics drain run only where this is true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `WORKER_CONCURRENCY`                  | no       | `5`                        | Jobs the email and notification workers each process at once, per process. Defaults to 5. The maintenance and analytics workers always run one job at a time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `RETENTION_TOKENS_DAYS`               | no       | `7`                        | Days to keep a user_tokens row once it has expired, or once it was revoked without ever being used (logout, reuse, password change). A token rotated away is kept until it expires, because reuse detection needs it. 0 never purges; at most 36500. Defaults to 7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RETENTION_INVITATIONS_DAYS`          | no       | `30`                       | Days to keep a tenant invitation after the latest of its expiry, acceptance and revocation. 0 never purges; at most 36500. Defaults to 30.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RETENTION_EMAIL_LOGS_DAYS`           | no       | `90`                       | Days to keep email tracking rows: each email message with its send attempts (email_logs) and provider events, dated by the message's creation; an attempt row with no message is dated by its own. Suppressions never expire. 0 never purges; at most 36500. Defaults to 90.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RETENTION_NOTIFICATIONS_READ_DAYS`   | no       | `90`                       | Days to keep a notification after it was read. 0 never purges; at most 36500. Defaults to 90.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `RETENTION_NOTIFICATIONS_UNREAD_DAYS` | no       | `365`                      | Days to keep a notification nobody read, counted from when it was created. 0 never purges; at most 36500. Defaults to 365.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RETENTION_AUDIT_LOGS_DAYS`           | no       | `0`                        | Days to keep an audit_logs row. Defaults to 0, which keeps the audit log forever. Set a number of days, at most 36500, only where your compliance rules allow deleting audit history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ONBOARDING_STUCK_AFTER_DAYS`         | no       | `7`                        | Days without onboarding progress after which a tracked tenant that is not complete or dismissed counts as stuck in the staff funnel and lists. At least 1, at most 36500. Defaults to 7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POSTHOG_PROJECT_KEY`                 | no       | —                          | PostHog project API key (phc_…) of the project this environment reports to. Unset disables analytics entirely: no events are recorded, none are sent, and /api/v1/collect answers 503. Use one project per environment, shared with the frontends.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POSTHOG_HOST`                        | no       | `https://us.i.posthog.com` | PostHog ingest host that server events are sent to and /api/v1/collect forwards to, with no trailing path. Defaults to https://us.i.posthog.com; an EU project uses https://eu.i.posthog.com.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POSTHOG_ASSETS_HOST`                 | no       | —                          | PostHog assets host that /api/v1/collect/static and /api/v1/collect/array forward to. Unset derives it from POSTHOG_HOST: https://eu-assets.i.posthog.com for an eu. host, otherwise https://us-assets.i.posthog.com. Tests point it at a fake.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ANALYTICS_OUTBOX_RETENTION_DAYS`     | no       | `7`                        | Days an analytics event may wait in the outbox, while PostHog is unreachable or refuses it, before it is dropped unsent with a warning. At least 1, at most 365. Defaults to 7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ANALYTICS_DRAIN_INTERVAL_MS`         | no       | `5000`                     | Milliseconds between analytics outbox drains, each of which sends one batch to PostHog. At least 1000, at most 600000. Defaults to 5000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ANALYTICS_DRAIN_BATCH_SIZE`          | no       | `500`                      | Most analytics events one drain claims and sends in one PostHog batch. At least 1, at most 1000. Defaults to 500.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POSTHOG_PERSONAL_API_KEY`            | no       | —                          | PostHog personal API key (phx_…) that the staff timelines read events with and user purges delete PostHog persons with. Give it only the scopes query:read, person:write and group:read, and create it on a service account rather than a person. Set it together with POSTHOG_PROJECT_ID; without both, the timelines answer "not configured" and queued person deletions wait.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POSTHOG_PROJECT_ID`                  | no       | —                          | Numeric id of the PostHog project that POSTHOG_PERSONAL_API_KEY reads from and deletes in: the project POSTHOG_PROJECT_KEY reports to. Set it together with POSTHOG_PERSONAL_API_KEY.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POSTHOG_APP_HOST`                    | no       | —                          | PostHog app origin that the timeline queries and person deletions call and that staff deep links open, with no trailing path. Unset derives it from POSTHOG_HOST: https://eu.posthog.com for an eu. host, otherwise https://us.posthog.com. Set it for a self-hosted PostHog. Tests point it at a fake.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `TIMELINE_QUERY_BUDGET_PER_HOUR`      | no       | `1200`                     | Most PostHog queries the staff timelines make in any rolling hour, counted in Redis across every replica; a cached page spends none. PostHog allows 2400 query calls an hour for the whole organization, its own UI included. At least 1, at most 100000. Defaults to 1200.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TIMELINE_REQUESTS_PER_MINUTE`        | no       | `20`                       | Timeline requests one staff user may make a minute, cached or not, before the API answers 429. At least 1, at most 1000. Defaults to 20.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `REDIS_KEY_PREFIX`                    | no       | `express-boilerplate`      | Namespace for every Redis key and channel this app uses: BullMQ queues (`<prefix>:bull`), rate-limit counters (`<prefix>:rl`), the session denylist (`<prefix>:denylist`), OAuth sessions (`<prefix>:sess`), the platform-access audit dedupe (`<prefix>:audit`) and the notification channel (`<prefix>:notifications`). Lowercase letters, digits, ":", "_" and "-", with no trailing colon. Give each app or environment sharing one Redis its own value; changing it abandons every existing key.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SSE_HEARTBEAT_INTERVAL_MS`           | no       | `30000`                    | Milliseconds between `:ping` heartbeat comments on an open notification SSE stream (notification-stream.controller.ts). Defaults to 30000 (30s).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SSE_MAX_STREAMS_PER_USER`            | no       | `5`                        | Most notification SSE streams one user may hold open at once, per process. A request over the cap gets 429 too_many_streams. Defaults to 5 (several tabs and devices).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SMTP_HOST`                           | no       | `127.0.0.1`                | SMTP server host. Defaults to 127.0.0.1, where the compose Mailpit service listens; an IP literal skips a DNS lookup on every send.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SMTP_PORT`                           | no       | `1025`                     | SMTP server port. Defaults to 1025 — Mailpit's SMTP port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SMTP_USERNAME`                       | no       | —                          | SMTP username. Absent means no authentication is attempted, which is correct for Mailpit and wrong for most real providers. Set it together with SMTP_PASSWORD: boot refuses one without the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SMTP_PASSWORD`                       | no       | —                          | SMTP password. Set it together with SMTP_USERNAME: boot refuses one without the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MAIL_FROM`                           | no       | `no-reply@example.com`     | The From address of the general sender: every email whose links carry no token (password changed, registration attempt, onboarding reminder), and token emails too while MAIL_FROM_TRANSACTIONAL is unset. Mailpit accepts any value; a real provider may require this to be a verified sender.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MAIL_FROM_TRANSACTIONAL`             | no       | —                          | The From address of the transactional sender: every email whose link carries a token (email verification, password reset, account setup, tenant invitation). Put it on a domain whose provider click tracking is off, since a tracked link is rewritten through the provider, token included. Unset uses MAIL_FROM; outside APP_ENV=local, boot warns when the two share a domain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `APP_NAME`                            | no       | `Express Boilerplate`      | Product name in outbound email copy and notification text: verification, password reset, password changed, invitation and onboarding reminder messages (auth.service.ts, verification.service.ts, tenant-invitation.service.ts, platform-onboarding.service.ts). Defaults to "Express Boilerplate".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RESEND_WEBHOOK_SECRET`               | no       | —                          | Signing secret of the Resend webhook endpoint (Resend dashboard, Webhooks, the endpoint's signing secret: whsec_ followed by base64). Enables POST /api/v1/webhooks/email/resend, which verifies each event's Svix signature with it; absent, that route answers 404. Subscribe the endpoint to the email.* events: delivered, delivery_delayed, bounced, complained, opened, clicked, failed and suppressed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `FAKE_EMAIL_WEBHOOK_SECRET`           | no       | `fake-webhook`             | Signs local fake email webhook events (`pnpm email:fire-event`), as an HMAC-SHA256 hex digest in the x-fake-signature header. Read only when APP_ENV is local, the one environment that serves POST /api/v1/webhooks/email/fake. Defaults to "fake-webhook"; not a credential.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SMTP_CONNECTION_TIMEOUT_MS`          | no       | `3000`                     | Milliseconds to wait for each SMTP connection attempt to establish before failing. Also the timeout for the first try of each DNS query; the resolver doubles it on each retry, and the OS-lookup fallback has no timeout. A host that resolves to several addresses can take it once per address. Boot checks that it plus SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS and the 5s HTTP drain stays at least 5s under SHUTDOWN_TIMEOUT_MS; that assumes one address and is a sanity check, not a per-send deadline. nodemailer's own defaults are 2 minutes to connect and 30 seconds per DNS query.                                                                                                                                                                                                                                                                                                                                                      |
| `SMTP_GREETING_TIMEOUT_MS`            | no       | `5000`                     | Milliseconds to wait for the SMTP server's greeting after connecting. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 30 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SMTP_SOCKET_TIMEOUT_MS`              | no       | `7000`                     | Milliseconds of inactivity before an open SMTP connection is closed. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 10 minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SHUTDOWN_TIMEOUT_MS`                 | no       | `25000`                    | Milliseconds graceful shutdown may take before the process exits with code 1 anyway. Defaults to 25000, under Kubernetes' default 30s termination grace period.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

#### `APP_ENV` and `NODE_ENV`

`APP_ENV` names the deployment: `local`, `dev`, `qa` or `prod`. It has no
default, and boot fails without it. The Docker image sets
`NODE_ENV=production` but not `APP_ENV`, so the deployment must supply it.

`NODE_ENV` is what Express itself reads; it must be `production` in every
environment except `local`.

|                                                                                                                        | `local`  | `dev`, `qa`, `prod` |
| ---------------------------------------------------------------------------------------------------------------------- | -------- | ------------------- |
| `COOKIE_SECURE` when unset                                                                                             | `false`  | `true`              |
| `LOG_FORMAT` when unset                                                                                                | `pretty` | `json`              |
| SMTP must upgrade to TLS                                                                                               | no       | yes                 |
| `NODE_ENV` other than `production`                                                                                     | allowed  | refused at boot     |
| `SMTP_HOST` `localhost`/`127.0.0.1`, `SMTP_PORT` 1025, `MAIL_FROM` or `MAIL_FROM_TRANSACTIONAL` `no-reply@example.com` | allowed  | refused at boot     |
| `MAIL_FROM_TRANSACTIONAL` unset or on `MAIL_FROM`'s domain                                                             | allowed  | warning             |
| SMTP timeouts summing to more than `SHUTDOWN_TIMEOUT_MS` − 10000                                                       | warning  | refused at boot     |
| Trace attribute `deployment.environment.name`                                                                          | `local`  | the `APP_ENV` value |

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
  one;
- `COOKIE_SECURE` resolving to `true` while `GOOGLE_CLIENT_ID` is set and
  `TRUST_PROXY=false` logs a warning (see SECURITY.md).

#### Secrets

`JWT_ACCESS_SECRET` signs access tokens. `SESSION_SECRET` signs the session
cookie of the Google OAuth round-trip. Generate each with
`openssl rand -hex 32`, even in development.

There is no refresh-token secret: refresh tokens are opaque random strings,
not JWTs, so nothing signs one (see [SECURITY.md](SECURITY.md)).

#### Invalid configuration fails before anything starts

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

### A second frontend: Apex

`APEX_URL` (optional) names the Apex staff dashboard. Links and redirects pick
a frontend with `frontendUrl(app)` (`verification.service.ts`), where `app` is
`'web'` or `'apex'`, never a URL. It returns `APEX_URL` for `'apex'` when that
is set, and `WEB_URL` otherwise, so leaving `APEX_URL` unset sends every link
to `WEB_URL`.

- Invitations to the platform tenant always link to Apex; every other
  invitation links to `WEB_URL` (`tenant-invitation.service.ts`).
- `register`, `resend-verification` and `forgot-password` take an optional
  `app` (default `'web'`) that picks the frontend of the verification or
  reset link. The "address already registered" mail carries no link, so it
  has no `app`.
- Staff mail about a user (the set-password mail of `POST /platform/users`,
  password-setup and resend-verification) takes no `app`: the server links
  a staff target to Apex and anyone else to `WEB_URL`, so a newly created
  user, who holds no platform role, gets a web link.
- `GET /auth/google?app=apex` stores the choice in the OAuth session
  (`rememberOAuthApp`), and the callback redirects to that frontend
  (`oauthAppOf`, `src/controllers/helpers.controller.ts`).

`APEX_URL` is not in the CORS allow-list (`isAllowedOrigin` grants `WEB_URL`
and `CORS_ALLOWED_ORIGINS`), so an Apex that calls this API directly from its
own origin must be listed in `CORS_ALLOWED_ORIGINS`; one that proxies `/api`
through its own host needs no entry. Google calls back to `APP_URL` only, so
when Google sign-in is on (`GOOGLE_CLIENT_ID`) and the Apex host differs from
`APP_URL`'s, `COOKIE_DOMAIN` must cover both; boot refuses otherwise
(`apexCookieDomainProblem`, `env-consistency.config.ts`).

## Email tracking

Every outbound email is one `email_messages` row, written when the mail is
queued: the recipient, the template, the user, tenant and invitation it is
about, the frontend its link opens (`link_app`), the sender class, its
`Message-ID`, and the template's non-secret `previewVariables`. Never a
rendered body, a link or a token. Each send attempt stays an append-only
`email_logs` row pointing at its message, and each provider event an
`email_events` row. A status only moves to a higher rank
(`EMAIL_STATUS_RANK`, `src/constants/email.constants.ts`), so a fast
`delivered` event is never overwritten by the worker's `sent`; `opened` and
`clicked` never change it. `RETENTION_EMAIL_LOGS_DAYS` purges messages,
their attempts and their events together; suppressions never expire.

Token emails (verification, password reset, account setup, invitations)
always go from `MAIL_FROM_TRANSACTIONAL`, and the two security notices from
`MAIL_FROM`; no caller picks the sender. Keep click tracking **off** at the
provider for the transactional sender's domain: a tracked link is rewritten
through the provider's redirector, which would then see every token. Left
unset, `MAIL_FROM_TRANSACTIONAL` falls back to `MAIL_FROM`, and outside
`local` the boot check warns when both senders share a domain.

The operator guide (the Resend webhook and its secret, the two senders, the
suppression list, the staff preview and resend, and `pnpm email:fire-event`
for local) is [Email tracking in README.md](README.md#email-tracking).

## Analytics

Server events reach PostHog through a transactional outbox, and browser
events through a proxy; no request ever calls PostHog.

```
request ── service transaction ── audit insert ── savepoint: analytics_outbox insert
        ├─ after commit: product domain event ─── analytics_outbox insert (pool)
        └─ email webhook transaction ─────────── savepoint: analytics_outbox insert

analytics Worker, every ANALYTICS_DRAIN_INTERVAL_MS, concurrency 1
  claimBatch: one autocommit UPDATE … FOR UPDATE SKIP LOCKED, 60 s lease
  (connection released) ── POST <POSTHOG_HOST>/batch/ (10 s timeout)
  ack: delete · retry (no answer, 429, 5xx, 401/403/404/405/407/408): keep, lease and backoff
  rejected (400, 413, 415, 422, other 4xx): bisect; a row refused alone counts a rejection, dropped at 3;
  a batch and both its halves rejected: each half's first row sent alone; both refused:
  endpoint fault, rows kept, one error; either accepted: settle those rows, bisect the rest

browser posthog-js ── /api/v1/collect/* ── analytics-proxy limiter ── stream ── ingest or assets host
```

- **Writes** go only through `enqueueAnalytics` and, for an audit entry,
  `enqueueAuditAnalytics` (`src/services/analytics/analytics-outbox.service.ts`):
  a savepoint inside a transaction, a plain insert on the pool, a `warn` and
  nothing more on failure. The audit hook in `writeEntry` (`audit.service.ts`)
  covers every audited action; product events come from domain-event
  subscribers (`analytics-forwarder.service.ts`); email events from
  `processEmailWebhook`. The builder (`analytics-event-builder.service.ts`)
  holds every PII rule.
- **The drain** (`drainAnalyticsOutbox`,
  `src/services/analytics/analytics-drain.service.ts`) claims in one
  statement, so its connection is back in the pool before the HTTP call:
  a hanging PostHog never holds one. The lease and `SKIP LOCKED` keep two
  replicas' drains apart. Retryable failures only grow `attempts`, which sets
  the backoff (`least(2^attempts × 5 s, 600 s)` after the lease); during an
  outage of any length only the retention rule (`analytics_outbox`,
  `ANALYTICS_OUTBOX_RETENTION_DAYS`) removes rows. A rejected batch is split
  in halves until the refused row is alone. When both of its halves are
  rejected as well, the first row of each half is sent alone: if PostHog
  refuses both it is refusing everything, so no row is counted, the rows are
  kept and the drain logs one `error` with the status; if it accepts either,
  each lone row is settled by its answer and the rest of each half is split
  as usual, so a refused row in each half does not hold back the others. The
  first retryable answer ends the drain, so an outage costs one timeout per
  tick. The endpoint-level
  4xx answers (401, 403, 404, 405, 407, 408) are retryable, never a
  rejection, so a wrong key or host drops nothing; the drain logs one `error`
  per tick naming `POSTHOG_PROJECT_KEY` and `POSTHOG_HOST`.
- **At least once.** A row is deleted after PostHog acknowledged
  it, so a crash between the two resends it with the same `uuid` (the row
  id), `timestamp`, `event` and `distinct_id`. PostHog deduplicates on `uuid`
  eventually and without a guarantee (ClickHouse merges), so a consumer that
  needs exactness dedupes by `uuid`.
- **The proxy** (`src/routes/analytics-proxy.routes.ts`) sends `/static/*`
  and `/array/*` to the assets host and everything else to the ingest host,
  streaming bodies untouched. It removes `Cookie` and `Authorization`, so the
  refresh cookie (`Path=/`) never reaches PostHog, and overwrites
  `X-Forwarded-For` (`request.ip`), `-Host`, `-Proto` and `-Port`. It strips
  PostHog's `Set-Cookie` and `Access-Control-*` response headers, and answers
  504 when PostHog stays silent for 30 s. Without `POSTHOG_PROJECT_KEY` it answers
  503 `service_unavailable`.
- **Groups.** A tenant's `name`, `status` and `created_at` reach PostHog only
  as `$groupidentify` properties: from the audit hook when a tenant is
  created, updated or changes state, and from `pnpm analytics:backfill-groups` for
  tenants that existed before.

The operator steps are in [Analytics (PostHog) in README.md](README.md#analytics-posthog).

## Health checks

Two endpoints, deliberately different depths:

- **`GET /health`** is shallow: it never touches the database or Redis. If
  it depended on either, a transient blip in a dependency would make an
  orchestrator restart an otherwise-healthy process, turning a slow query
  into an outage.
- **`GET /health/ready`** is deep: it checks `isDatabaseReachable()`,
  `isRedisReachable()` and `isQueueReachable()` in parallel and answers 503
  with `"status":"not-ready"` if any is down. It also answers 503 with
  `"status":"shutting-down"` once graceful shutdown has begun. A failing
  readiness probe only removes the instance from load-balancer rotation; it
  restarts nothing.

Neither path is traced.

## Data layer

- **Postgres**: [`src/services/database.service.ts`](src/services/database.service.ts)
  creates exactly one `postgres` client (and one Drizzle instance wrapping
  it) per process, at module scope. A second client would mean a second
  connection pool and double the configured connection budget, a bug that
  only shows up under load. The pool holds up to `DB_POOL_MAX` connections
  (`databaseClientOptions`, `database.config.ts`), with prepared statements
  off and `DB_STATEMENT_TIMEOUT_MS` sent as each connection's
  `statement_timeout`. The test suite opens one pool per Vitest worker, so
  its connection count is `maxWorkers` × `DB_POOL_MAX`: 8 workers
  (`WORKER_COUNT`, `tests/helpers/worker-database.ts`) × 2 (`.env.test`) = 16,
  under Postgres's default 100.
- **Redis**: [`src/services/redis.service.ts`](src/services/redis.service.ts)
  connects lazily, on first use. An eager connection at import time would
  make every unit test that transitively imports a repository open a real
  socket, and fail on a machine with no Redis. It tracks a `closed` flag:
  node-redis has no "permanently closed" state of its own (unlike Postgres,
  where `sql.end()` makes every later query reject), so without the flag a
  readiness probe after shutdown would reopen the socket the shutdown had just
  closed.
- **Queues**: [`src/services/queue.service.ts`](src/services/queue.service.ts)
  owns BullMQ's queues and the two `ioredis` connections they run over (BullMQ
  needs `ioredis`, which cannot share node-redis's connection). The Workers'
  connection keeps the offline queue, which Workers need to ride out an
  outage; the producers' connection turns it off, so an enqueue during an
  outage rejects at once instead of holding its HTTP caller.

**Through a Redis outage.** Before a client's first `ready`, every Redis
client gives up after a few retries, so `isRedisReachable()`,
`isQueueReachable()` and `GET /health/ready` report unreachable instead of
hanging at boot. After `ready`, every client retries forever with backoff
(capped at 5 s), so an outage never leaves a dead client behind. While a client
reconnects nothing waits for Redis: node-redis runs with
`disableOfflineQueue`, a producer enqueue rejects, `isQueueReachable` reports
false for a queue connection in any post-ready status but `ready`, and
`closeQueue` disconnects instead of queueing a `QUIT`. A queue connection that
gives up before its first `ready` is replaced on next use, and the producer's
queues with it. Workers on it never recover by themselves: BullMQ does not
re-initialise a connection whose init failed, and when that failure is not one
BullMQ counts as a connection error (ECONNREFUSED, or "Connection is closed."),
such as ECONNRESET, its fetch loop retries with no delay and starves the event
loop. So `startWorkers()` (`worker-supervisor.service.ts`) closes them inside
that connection's `'end'` event, before they can spin, and starts new ones on a
fresh connection. If starting them throws, it closes any it started. At boot it
rethrows, so the process exits 1. On a restart it cannot throw from inside
`'end'`, so `isQueueReachable()` reports false until the next pre-ready
reconnect restarts them or the process restarts.

All three expose `is*Reachable()` and `close*()`, and each `close*()` is safe to
call twice.

## Errors and the response envelope

Every JSON response, success or error, uses the same envelope, defined
once in [`src/utilities/response.utilities.ts`](src/utilities/response.utilities.ts):

```json
{ "success": true, "message": "Success", "statusCode": 200, "data": {} }
{ "success": false, "message": "Not found", "statusCode": 404, "requestId": "…" }
{ "success": false, "message": "Access token expired", "statusCode": 401, "code": "ACCESS_TOKEN_EXPIRED", "requestId": "…" }
```

An error response optionally carries `code`: a single, stable,
machine-readable token a client branches on (e.g. `ACCESS_TOKEN_EXPIRED`
from `requireAuth`, `RATE_LIMITED` from every rate limiter; see
[SECURITY.md](SECURITY.md)), independent of `errors` (field-level
validation detail, shaped by whatever validator produced it). They are
separate fields so that a client parsing `errors` for field errors never gets
a different shape when `code` is also present.

`HttpError` (in [`src/errors/http-error.ts`](src/errors/http-error.ts)) is the
exception type any handler can throw or forward to `next()` to produce a
specific status code. `errorHandler` is the terminal middleware. On a 5xx it
masks the message (`"Internal server error"`) but **logs the original error**,
redacted (`redactedForLog`,
[`src/errors/postgres-errors.ts`](src/errors/postgres-errors.ts)), so an
operator has something to search. A 4xx is never logged. A foreign error that
carries a 4xx `status` (such as the body parser's 400 for malformed JSON or 413
for an oversized body) keeps that status, and its message is shown only when
the error marks it `expose`; any other status becomes 500.

`errorHandler` takes four parameters and is registered last, because
Express identifies error-handling middleware by arity: a handler with
fewer than four parameters is treated as ordinary middleware that
never sees an error. The unused fourth parameter is named `_next`.

Every success with no payload uses `messageResponse(response, message, status?)`
([`src/utilities/response.utilities.ts`](src/utilities/response.utilities.ts)),
which always sends `data: null`, never a bare `{}` and never an omitted `data`.

The envelope (`{ success, message, statusCode, code?, errors? }`) is not RFC
9457 `problem+json`, the more modern standard. Switching would change what
every client parses on every response.

## Request correlation

[`src/middlewares/request-id.middleware.ts`](src/middlewares/request-id.middleware.ts)
runs after `helmet` and `cors`, and is the first middleware that can produce or
observe a request id; `cors` answers and ends an allowed preflight before it.
It honours a caller-supplied `X-Request-Id` header, validated against a UUID
pattern before being echoed back (reflecting an arbitrary header into a
response is how log injection starts), or generates one. `errorResponse()`
reads the id back off the response object.

`requestContext` (`request-context.middleware.ts`) then opens an
`AsyncLocalStorage` store (`request-context.service.ts`) for the request, and
`resolveTenant` adds the tenant to it. The logger's pino `mixin` reads that
store on every call, so each line logged during a request carries `requestId`,
and `tenantId` once the tenant is resolved; callers never pass them. Code
outside a request simply omits them. `mixinMergeStrategy`
(`logger.service.ts`) makes the mixin's fields win over a caller-supplied field
of the same name, so log meta cannot spoof `requestId`, `tenantId`, `traceId`
or `spanId`.

## Observability

**Tracing.** [`src/observability/tracing.ts`](src/observability/tracing.ts)
loads through Node's `--import`, before `index.ts`, so its instrumentations
patch HTTP, Express, `ioredis` and pino before the app imports them. It runs
before environment validation, so it reads `process.env` directly and cannot
use `getEnv()` or the app's logger. When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset
it is a complete no-op: no SDK, no ESM loader hook, no spans. When set, it
starts a `NodeSDK` that exports traces and logs over OTLP HTTP, reporting
`service.name` (`OTEL_SERVICE_NAME`) and `deployment.environment.name` from
`APP_ENV` (omitted when unset). It registers OTel's ESM loader hook, without
which pino, a CommonJS module imported from ESM, is never patched.

What gets spans:

- incoming HTTP and Express routing, except `/health`, `/health/ready` and
  everything under `/api/v1/collect/` (the PostHog proxy, one request per
  browser event batch or replay chunk);
- BullMQ's Redis traffic, through `IORedisInstrumentation`. It patches
  `ioredis` only; `redis.service.ts` uses node-redis, which no installed
  instrumentation covers, so its calls (health checks, rate limits, the
  denylist) get no spans;
- not Postgres: the app uses postgres.js, and
  `@opentelemetry/instrumentation-pg` only instruments `pg`, so database calls
  appear as gaps in a trace.

**Logs.** `logger.service.ts` builds one lazily-created pino logger. Each
record carries `level` as a label, an ISO `timestamp`, `message`, and `source`,
the caller's `file:line`, parsed from a stack trace on each call. The
correlation fields come from the mixin described under
[Request correlation](#request-correlation), plus `traceId` and `spanId` while
a span is active. An Error-valued field is serialised as
`{ name, message, stack }` and redacted with `redactedForLog` when it, or its
`cause` chain up to five deep, carries a database query. The format is
`LOG_FORMAT` when set, else `pretty` on `APP_ENV=local` and `json` elsewhere.
`pretty` needs the `pino-pretty` devDependency; without it, as in the
production image, the logger writes JSON.

`PinoInstrumentation` sends every record to the collector as an OTel log record
(log correlation off, since the mixin already writes `traceId`/`spanId`); the
collector forwards logs to Loki and traces to Tempo. In Grafana a log line links
to its trace, and a trace to its logs.

**Slack.** With `SLACK_WEBHOOK_URL` set, records at or above `SLACK_LOG_LEVEL`
also go to Slack. The destination deduplicates by `${source}:${message}`: the
first occurrence sends at once, repeats within 60 seconds are counted, and one
summary is sent when the window closes if any were suppressed.

## Local infrastructure

`docker-compose.yml` runs the stack the app needs to boot locally; the app
itself runs on the host.

| Service        | Host port                        | Notes                                                                        |
| -------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| Postgres 18    | 5433                             | User, password and database `boilerplate`; also provisions the test database |
| Redis          | 6380                             |                                                                              |
| OTel Collector | 4318 (OTLP HTTP), 13133 (health) | Forwards traces to Tempo and logs to Loki                                    |
| Tempo          | 3200                             | Trace storage                                                                |
| Loki           | none                             | Log storage; query it through Grafana                                        |
| Grafana        | 3100                             | Anonymous admin; Tempo (default) and Loki pre-provisioned as data sources    |
| Mailpit        | 1025 (SMTP), 8025 (web UI)       | Local SMTP sink; the app's SMTP defaults point here                          |

Every published port binds `127.0.0.1` only, so no other machine on the
network can reach Postgres with its fixed development password, Redis with no
password, Grafana with anonymous admin, or Mailpit.

**Postgres is pinned to major version 18** because the migrations use
`uuidv7()` as a column default, which is built into Postgres from 18; on 17 or
older a migration fails with `function uuidv7() does not exist`.

**Host ports 5433 and 6380 are deliberate.** A native Postgres or Redis on the
default 5432/6379 wins `localhost` connections over Docker's wildcard bind.
Postgres then fails loudly (wrong role), but Redis fails silently: any Redis
answers `PING`, so a dev server or the test suite would appear to work against
a personal, unrelated instance. Container-internal ports stay 5432/6379, so
container-to-container URLs (`postgres://…@postgres:5432/…`) are unaffected.
`tests/unit/connection-target.test.ts` reads `docker-compose.yml` and
`.env.test` off disk and asserts they agree on the non-default ports. It checks
the committed files, not `getEnv()` at runtime, because CI's `services:`
publish the default ports and CI runs against 5432/6379.

The collector's health-check extension answers on `:13133`, but its image has
no shell, `curl` or `wget`, so it carries no Docker `healthcheck`.

## Docker

`Dockerfile` is a four-stage build (`base` -> `deps` -> `build` -> `runner`):

- `base` installs Corepack and creates the non-root user (uid 10001).
- `deps` installs with `--frozen-lockfile`, in a layer cached independently of
  application code. `pnpm-workspace.yaml` and `.npmrc` are copied with the
  lockfile, since pnpm reads its build allow-list and release-age settings
  from them at install time.
- `build` runs `pnpm build`, then `pnpm prune --prod --ignore-scripts`.
  `pnpm install --prod` alone unlinks dev dependencies from `node_modules` but
  leaves them in the pnpm virtual store; `prune` removes them, so neither the
  TypeScript compiler nor `drizzle-kit` ships in the image.
- `runner` sets `NODE_ENV=production`, copies only `node_modules`, `dist/` and
  `package.json`, runs as uid 10001, and declares `HEALTHCHECK NONE`: the
  orchestrator owns liveness and readiness through `/health` and
  `/health/ready`, and a second health signal could disagree with them under
  load. Its `CMD` is
  `node --enable-source-maps --import ./dist/observability/tracing.js dist/index.js`:
  tracing loads before the app, and a logged stack trace names the original
  `.ts` line.

To run the image against the compose stack:

```bash
docker build -t express-boilerplate .
docker run --rm -p 4040:4040 --env-file .env \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL=postgres://boilerplate:boilerplate@host.docker.internal:5433/boilerplate \
  -e REDIS_URL=redis://host.docker.internal:6380 \
  express-boilerplate
```

The `-e` overrides matter: `.env` says `localhost`, which inside the container
is the container itself. `host.docker.internal` reaches the host's published
compose ports. Without the overrides, `/health` still answers 200 (it touches
no dependency) and `/health/ready` answers 503 within a few seconds, since
every Redis client gives up quickly before its first `ready`.

## Deploying

A push to `main` runs [`deploy.yml`](.github/workflows/deploy.yml). It calls
`ci.yml` as a gate (`workflow_call`) and, once that passes, builds and pushes
`ghcr.io/<repo>:sha-<commit>` and `:main` to GHCR with an SBOM and build
provenance attestation, then runs the `deploy` job, bound to the `production`
environment. That job is a placeholder: no deployment target is chosen. A
manual `workflow_dispatch` from another branch builds and pushes only the
sha-tagged image; the `:main` tag and the `deploy` job run only from `main`.
A `vX.Y.Z` release tag builds nothing: its `promote` job adds `:X.Y.Z`, `:X.Y`
and `:X` to the digest `main` already built (see
[CONTRIBUTING.md](CONTRIBUTING.md#releases)).

The image needs the environment described under
[Configuration](#configuration), including `APP_ENV`. Its `CMD` starts only the
app; run migrations from the same image with `node dist/database/migrate.js`,
the command `pnpm db:migrate:prod` runs.
`WORKER_ENABLED` (default `true`) runs the API and the BullMQ Workers in one
process. To split them, set it to `false` on API-only pods and `true` on a
separate worker deployment that shares the Redis queues. `WORKER_CONCURRENCY`
(default 5) sets the email and notification Workers' concurrency; the
maintenance and analytics Workers always run one job at a time, and the daily
retention purge and the analytics drain run only where Workers run.

One-time repository setup before any of this is live:

- **Renovate**: install the Renovate GitHub App; see
  [CONTRIBUTING.md](CONTRIBUTING.md#dependency-policy).
- **Releases**: create and install the release GitHub App; see
  [CONTRIBUTING.md](CONTRIBUTING.md#releases). `release.yml` fails without it.
- **Merge rules** (Settings → General, then Settings → Rules): enable "Allow
  auto-merge"; allow squash merging only, with the commit title set to the PR
  title and the commit message left blank; and add a ruleset on `main`
  requiring the checks `lint`, `test`, `docker`, `gitleaks` and `pr-title`.
  Without the ruleset, `release.yml`'s fallback merges the release PR without
  waiting for CI; without the blank squash message, each squash body carries
  the branch's commit list, which release-please reads as extra conventional
  commits.
- **The `production` environment** (Settings → Environments): add protection
  rules, at minimum required reviewers, before replacing the placeholder
  `deploy` step with a real target. Without them, anything merged to `main`
  deploys unreviewed.
