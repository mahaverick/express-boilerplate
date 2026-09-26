# Migrations

Upgrade notes for each breaking release of this repo, then every major
dependency bump taken during its rebuild, the breaking change it carried,
and what changed here because of it — so the same upgrade can be replayed
elsewhere with the reasoning intact instead of rediscovered. Also: every
supply-chain bypass currently sitting in `pnpm-workspace.yaml`, a generated
file nobody reads by default.

## Upgrading to 3.2.0

3.2.0 adds one migration, six optional variables and a third BullMQ queue.
It also makes several behaviours stricter. No variable is renamed or
becomes required. Read "Migration `0017`", "Stricter than 3.1.0" and "The
refresh cookie is renamed" before upgrading a database, a client or a proxy.

### Migration `0017`

`0017` is partly hand-written. drizzle generated the foreign-key change and
six indexes. The new body of the `audit_logs_immutable()` trigger function
was added by hand, marked `-- Hand-added` in the file.

- `user_tokens.replaced_by_id`'s self-referencing foreign key is dropped
  and re-added as `ON DELETE SET NULL`. When the retention purge deletes a
  row, the database nulls the pointer of the row that was rotated into it,
  so a whole rotation chain clears in one run.
- Indexes for the retention purge:
  - `user_tokens(replaced_by_id)`;
  - `user_tokens(expires_at)`;
  - `user_tokens(revoked_at)`, for rows revoked and never consumed;
  - `email_logs(created_at)`;
  - `notifications(read_at)`, for read rows;
  - `notifications(created_at)`, for unread rows.

  They build without `CONCURRENTLY`, because drizzle's migrator runs in a
  transaction.

- `audit_logs_immutable()` still refuses every UPDATE. A DELETE now passes
  only in a transaction that set `app.audit_purge` to `on` and
  `app.audit_purge_before` past the row's `occurred_at`, both
  transaction-local. With `RETENTION_AUDIT_LOGS_DAYS` at its default `0`,
  nothing sets them, so the table stays append-only. `TRUNCATE` is
  unaffected. The trigger that calls the function is unchanged.

While it runs, `0017` blocks every read and write on `user_tokens`, so
every login and refresh waits, and blocks writes to `email_logs` and
`notifications`. On a large database, see "Schema migrations on a live
database" below.

### New optional variables: data retention

A daily purge at 03:00 UTC, on the new `maintenance` queue, deletes rows
past their retention window. Each variable is a non-negative whole number
of days; `0`, or an empty value, turns that rule off.

| Variable                              | Default | Deletes                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RETENTION_TOKENS_DAYS`               | `7`     | `user_tokens` that many days past expiry, or past a revoke that never used them (logout, reuse, password change). A rotated-away token is kept until it expires, for reuse detection. A kept row whose successor is purged has its `replaced_by_id` set to NULL. |
| `RETENTION_INVITATIONS_DAYS`          | `30`    | `tenant_invitations` whose latest of expiry, acceptance and revocation is that old.                                                                                                                                                                              |
| `RETENTION_EMAIL_LOGS_DAYS`           | `90`    | `email_logs` created that long ago.                                                                                                                                                                                                                              |
| `RETENTION_NOTIFICATIONS_READ_DAYS`   | `90`    | Notifications read that long ago.                                                                                                                                                                                                                                |
| `RETENTION_NOTIFICATIONS_UNREAD_DAYS` | `365`   | Unread notifications created that long ago.                                                                                                                                                                                                                      |
| `RETENTION_AUDIT_LOGS_DAYS`           | `0`     | `audit_logs` rows that old. `0` keeps the audit log forever.                                                                                                                                                                                                     |

**The first run deletes the backlog.** On a deployment that has been
running, the first 03:00 run deletes every row already past its window, in
batches of 5,000, each its own short transaction. To keep a table's rows
until you're ready, set its variable to `0` before upgrading.

The purge runs where `WORKER_ENABLED=true`:

- **Scheduling.** The schedule is registered each time the worker
  supervisor starts a worker generation; boot is the first. It is one
  scheduler under `REDIS_KEY_PREFIX`, upserted idempotently, so any number
  of replicas still make one schedule. A failed registration logs `warn`
  (`Registering the retention schedule failed`) and is retried with the
  next generation. A new generation starts only when a worker connection
  gives up before its first ready, so a registration that fails while the
  Workers stay healthy waits for the next restart. Check for that line
  after the first deploy.
- **Logging.** Each rule logs one `info` line, `retention purge`, with the
  table and the count. The two notification rules report as
  `notifications.read` and `notifications.unread`.
- **Failure.** A failing rule logs `retention purge failed` and the others
  still run. The job then fails, and BullMQ retries it, 3 attempts in all,
  with exponential backoff from 60 seconds.

### A third queue

`maintenance` joins `email` and `notification` under `<prefix>:bull`. Its
worker starts wherever the other two do. It always runs one job at a time;
`WORKER_CONCURRENCY` doesn't apply to it.

### Failed jobs are scrubbed, and logged once

A job that won't be retried has every key ending in `Url` or `Token` in its
stored data replaced with `[redacted]`, and logs one `error` line, `job
failed permanently`. Earlier attempts now log at `warn`, not `error`, as
`Email job failed` and `Notification job failed` (the new maintenance
worker's are `Maintenance job failed`). If you alert on those messages at
`error`, alert on `job failed permanently` instead.

### Stricter than 3.1.0

- **Every authenticated write is rate-limited.**
  - Writes that had no limiter now share one: 60 a minute per user,
    prefix `rl:authenticated-write:`.
  - The limit answers `429` in the usual error envelope, with the message
    `Too many requests, please slow down`.
  - It covers the tenant `PATCH`, member `PATCH` and `DELETE`, invitation
    `DELETE` and settings `PATCH` routes, the four notification writes,
    and `PATCH /api/v1/profile`.
  - A client that bulk-edits must pace itself.
- **Free text rejects control and bidi characters.**
  - The fields: tenant `name`, `logo`, `website` and `description`, and
    `firstName` and `lastName` on register and profile.
  - They answer `400` for U+0000–U+001F, U+007F–U+009F, U+202A–U+202E and
    U+2066–U+2069.
  - `description` still accepts newlines and tabs, and stores `\r\n` as
    `\n`.
- **A login that races a password change or reset fails with `401`** when
  the hash changed after it was checked (SECURITY.md, "Password change and
  reset against a concurrent login").
- **A refresh that races a password change or reset** either has its new
  token revoked or answers `401`.

### The refresh cookie is renamed

With `COOKIE_SECURE` on, the refresh cookie is now:

- `__Host-refreshToken` at path `/`;
- or `__Secure-refreshToken` at path `/api/v1/auth`, when `COOKIE_DOMAIN`
  is set.

Local http keeps `refreshToken`. Nobody is logged out: refresh and logout
still accept the old `refreshToken` cookie, and clear it when they see it.
That fallback is removed at the next major release. Until then, a client,
proxy or WAF rule that names the cookie must accept both names. A
`__Host-` cookie is sent on every request to the API's origin, not only
under `/api/v1/auth`. On a secure deployment, setting or unsetting
`COOKIE_DOMAIN` later switches between the two prefixed names, which signs
every user in once. See SECURITY.md, "Cookies".

### Operations

- The image starts Node with `--enable-source-maps`, so logged stack traces
  point at the original `.ts` lines.
- `docker-compose.yml` publishes every port on `127.0.0.1` only. A browser
  or tool on another machine that used to reach the local stack (Grafana,
  Mailpit) no longer can.
- The logger drops a Postgres error's bound parameters wherever it is
  logged under a top-level key, including as another error's `cause`.
- A password change or reset whose session-denylist write fails still
  succeeds, as before, and now also logs one `error` line,
  `session denylist write failed after password change`, with the user id
  and the number of sessions not denied.

## Upgrading to 3.1.0

3.1.0 adds a migration, one optional variable, a script, new response
fields, and one stricter validation (see "One endpoint is stricter, not
just additive" below). Two upgrade preconditions, both under Migration
`0016` below: a live customer tenant already on the `platform` slug must be
renamed first, and a migrating role that doesn't own the database needs
`pg_trgm`'s `CREATE` privilege granted first.

### Migration `0016`

`0016` is partly hand-written: drizzle generated the table, column and index
statements, and four blocks were added by hand — `pg_trgm`, the slug guard,
the seed, and the append-only function and trigger — each marked
`-- Hand-added` in the file itself.

- Adds `tenants.is_platform` (default `false`), with a partial unique
  index (at most one platform tenant) and a CHECK that keeps that tenant
  active and undeleted.
- A hand-written guard stops the migration, before the seed insert runs, if
  a live customer tenant already holds the reserved slug `platform`:
  it raises its own exception naming the slug, rather than letting the seed
  fail on `tenants_slug_unique`. Rename that tenant before upgrading.
- Seeds the platform tenant (name `Platform`, slug `platform`) and its
  settings row, by hand. It starts with no members; run the bootstrap
  script below to make its first owner.
- Creates `audit_logs`. It's append-only (a trigger refuses UPDATE and
  DELETE for every role), and its foreign keys to `users` and `tenants` are
  `ON DELETE RESTRICT`. After this, a hard `DELETE` of a user or tenant with
  history fails. The code only ever soft-deletes both.
- Runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` (also hand-written) and
  builds two trigram indexes on `tenants` for staff search. `pg_trgm` needs
  `CREATE` on the database: the database's owner already has it, so the
  migration's own statement succeeds when the migrating role owns the
  database. When it doesn't, either run `CREATE EXTENSION pg_trgm;` yourself
  as a superuser before the migration, or
  `GRANT CREATE ON DATABASE <name> TO <migrating role>;` first. On a managed
  Postgres, check that `pg_trgm` is on the allow-list first.

### New optional variable

- `PLATFORM_EMAIL_DOMAINS`: a comma-separated list of lowercase domains.
  A **verified** address on one of them joins the platform tenant as
  `viewer`, at verification and on each sign-in. It's empty by default, so
  nobody joins. Only an exact domain matches, not its subdomains. See
  SECURITY.md, "Platform staff access and the audit log".

### Bootstrap the first platform owner

With `DATABASE_URL` pointing at the upgraded database:

    pnpm platform:grant -- owner@yourcompany.com owner

The user must already exist and be verified. The grant is audited as
`platform.member.granted`, with a system actor. From then on, that owner
manages staff through the platform tenant's own Members and Invitations
pages.

### API additions (all additive)

- `GET /api/v1/profile`, `PATCH /api/v1/profile`, and the `user` in `POST /api/v1/auth/login`'s response add `platformRole`.
- `GET /api/v1/tenants` rows add `isPlatform`.
- `GET /api/v1/tenants/:slug` adds `role` (effective), `access` and
  `isPlatform`.
- New: `GET /api/v1/platform/tenants`, `GET /api/v1/tenants/:slug/audit-log`
  and `GET /api/v1/platform/audit-log`.
- New limiter prefix `rl:platform-search:`. No existing prefix changed.

### One endpoint is stricter, not just additive

`POST /api/v1/tenants/:slug/invitations` rejects an address whose domain is
not a dotted hostname (a bad label, a label over 63 characters, a domain
over 253) with `400` and `errors.email` — the shape the audit log stores. This is not purely additive: a syntactically valid email address
whose domain isn't a real hostname is refused at invite time, rather than
accepted and only losing its domain when it reaches the audit trail.

### The audit log has no retention

Rows accumulate: every change, plus one row per staff user, tenant and
hour of staff access. Nothing prunes them. Removing rows takes `TRUNCATE`
privilege on the table — its owner has that by default, and so does any
role explicitly granted it, or a superuser.

## Upgrading to 3.0.0

### Renamed variables

Setting an old name now refuses boot, with a message naming the new one.

| Old                       | New                          | Notes                           |
| ------------------------- | ---------------------------- | ------------------------------- |
| `SMTP_USER`               | `SMTP_USERNAME`              |                                 |
| `SMTP_PASS`               | `SMTP_PASSWORD`              |                                 |
| `SMTP_CONNECTION_TIMEOUT` | `SMTP_CONNECTION_TIMEOUT_MS` | Default 10000 → 3000            |
| `SMTP_GREETING_TIMEOUT`   | `SMTP_GREETING_TIMEOUT_MS`   | Default 15000 → 5000            |
| `SMTP_SOCKET_TIMEOUT`     | `SMTP_SOCKET_TIMEOUT_MS`     | Default 20000 → 7000            |
| `QUEUE_PREFIX`            | `REDIS_KEY_PREFIX`           | Now covers every key; see below |

### Now required

- **`APP_ENV`** (`local`, `dev`, `qa` or `prod`), with no default. Boot
  fails without it. The Docker image does not set it, so the deployment
  must. A local `.env` needs `APP_ENV=local`.
- **`NODE_ENV`**, which has lost its `development` default. Outside
  `APP_ENV=local` it must be `production`. The Docker image already sets it.

### Boot checks that refuse a stale config

`index.ts` runs these before anything starts, and lists every failure in
one message. Outside local, boot refuses:

- `NODE_ENV` other than `production`;
- the SMTP defaults: `SMTP_HOST` `localhost` or `127.0.0.1`, `SMTP_PORT`
  1025, `MAIL_FROM` `no-reply@example.com`;
- SMTP timeouts that add up to more than `SHUTDOWN_TIMEOUT_MS` − 10000 (the
  5-second HTTP drain plus 5 seconds of headroom). On local this is a
  warning.

Everywhere, boot refuses any old name from the table above, setting
only one of `SMTP_USERNAME`/`SMTP_PASSWORD`, which used to be a warning, and
a `COOKIE_DOMAIN` that `APP_URL`'s host is neither equal to nor a subdomain
of, since browsers would reject every auth cookie.
Boot warns when `COOKIE_SECURE` resolves to `true` and `GOOGLE_CLIENT_ID` is
set while `TRUST_PROXY=false`, because the OAuth session cookie is then
never sent behind a TLS-terminating proxy.

### New, with defaults

These are new, and nothing needs setting unless you want a different
value, except `DB_STATEMENT_TIMEOUT_MS` (below):

- `COOKIE_SECURE` (from `APP_ENV`);
- `COOKIE_DOMAIN` (unset: host-only);
- `LOG_FORMAT` (from `APP_ENV`);
- `DB_POOL_MAX` (10);
- `DB_STATEMENT_TIMEOUT_MS` (30000);
- `WORKER_CONCURRENCY` (5);
- `SHUTDOWN_TIMEOUT_MS` (25000).

`DB_STATEMENT_TIMEOUT_MS` changes behaviour at upgrade. 3.0 sends
`statement_timeout=30000` on every pooled connection; 2.0 sent none.

- Behind PgBouncer, add `statement_timeout` to `ignore_startup_parameters`,
  or set `DB_STATEMENT_TIMEOUT_MS=0`. Otherwise PgBouncer refuses every
  connection.
- A statement that runs longer than 30s is now cancelled. Set
  `DB_STATEMENT_TIMEOUT_MS=0` to keep the 2.0 behaviour.

`COOKIE_SECURE` now defaults to `true` everywhere except `local`, and SMTP
requires TLS everywhere except `local`. Before 3.0, both followed
`NODE_ENV === 'production'`, and 3.0 requires `NODE_ENV=production`
outside `local`. A `dev` or `qa` environment served without TLS must set
`COOKIE_SECURE=false`: browsers drop a Secure cookie set over plain HTTP, so
login stops working. SMTP there must also offer STARTTLS.

The trace resource attribute `deployment.environment.name` used to be
`NODE_ENV` (`production`, `development`). It is now the `APP_ENV` value
(`local`, `dev`, `qa`, `prod`). Update dashboards and alerts that filter on
it.

Setting `COOKIE_DOMAIN` at upgrade, where users hold host-only refresh
cookies, heals itself: every response that sets or clears the refresh
cookie also clears the host-only one. Changing or unsetting it later leaves
the old domain's refresh cookie in browsers. The API reads the most recently
created `refreshToken` cookie, which is the current one, so the old one is
ignored and expires within `REFRESH_TOKEN_TTL`. Reverting to an earlier
value is the exception: the browser keeps that cookie's original creation
time, so the other scope's cookie reads as newer and refresh fails until the
user logs in again or it expires.

### Redis state under the old prefixes is abandoned

Every key moves under `REDIS_KEY_PREFIX` (default `express-boilerplate`).
No prefix value maps the old keys onto the new ones: BullMQ's `bull:*`
becomes `<prefix>:bull:*`, and the other keyspaces had no prefix at all. At
deploy, the new code stops seeing:

- **Queued jobs** (`bull:*`), including delayed retries. Before deploying,
  stop traffic to the API (or scale API-only pods to zero) and let the
  workers drain both queues (`email`, `notification`) to zero waiting,
  delayed, active and prioritized jobs. Otherwise accept that those emails
  and notifications are never sent.
- **Session-denylist entries** (`denylist:session:*`) written during the
  last `ACCESS_TOKEN_TTL`. An access token revoked in that window is honoured
  again until it expires. To avoid this, deploy at least `ACCESS_TOKEN_TTL`
  after the last forced logout you care about.
- **Rate-limit counters** (`rl:*`). Every budget resets once.
- **In-flight Google sign-ins** (`sess:*`). A user mid-way through the
  consent screen gets a failed callback and signs in again.

During a rolling deploy, old and new pods also use different keys until
the old pods are gone:

- live notifications go out on different channels (`bull:notifications`
  and `<prefix>:notifications`), so a stream open on one side misses those
  published by the other;
- the session denylists differ, so a logout on one side is not honoured by
  the other: its access tokens still work there until they expire;
- the rate-limit counters differ, so each budget is effectively doubled.

The denylist, rate-limit and session keys expire on their own, so they
need no cleanup. The old BullMQ keys do not expire. Once the drained queues
are confirmed empty, delete them, never with FLUSHDB. Choose a
`REDIS_KEY_PREFIX` different from the old `QUEUE_PREFIX` value; if they
match, skip this step rather than reason about the shared namespace. Set
`OLD` to the old `QUEUE_PREFIX` value (`bull` if you never set it):

```bash
OLD=bull
for queue in email notification; do
  redis-cli -u "$REDIS_URL" --scan --pattern "$OLD:$queue:*" \
    | xargs -r -n 500 redis-cli -u "$REDIS_URL" del
done
```

These patterns name only the two old queues, so they leave anything else on
that Redis under `$OLD:` alone. They cannot match a 3.0 key either:
`redisKey()` puts every new key under `REDIS_KEY_PREFIX` + `:`, and BullMQ's
under `<prefix>:bull:`, so a new queue key is `<prefix>:bull:email:…`. The
exceptions are a new prefix that itself starts with `$OLD:email` or
`$OLD:notification`, and an old prefix ending in `:bull` whose front equals
the new prefix (old `myapp:bull`, new `myapp`); in either case skip this
step.

If you delete the expiring keys early anyway, use the bare patterns
`rl:*`, `denylist:session:*` and `sess:*` only on a Redis this app has to
itself: on a shared Redis they also match other apps' keys (`sess:` is
connect-redis's default prefix). On a Redis of its own they match no 3.0
key as long as `REDIS_KEY_PREFIX` itself does not start with `rl`,
`denylist` or `sess`: every 3.0 key starts with that prefix, and the prefix
can never be empty.

If you had set `QUEUE_PREFIX`, the old notification channel above was
`<QUEUE_PREFIX>:notifications`, not `bull:notifications`.

## Majors taken

### TypeScript 6 -> 7 — **NOT ADOPTED (NO-GO)**

Pinned `typescript: ~6.0.3`, not the `7.0.2` this plan otherwise targeted.

A pre-implementation spike
(`docs/superpowers/notes/2026-09-14-typescript-7-spike.md`) found exactly
one hard blocker, entirely outside TypeScript itself:
`typescript-eslint@8.70.0`'s peer range is `typescript: >=4.8.4 <6.1.0` —
it excludes all of 7.x. Checked against both the `latest` tag and the
`canary` pre-release (`8.70.1-alpha.0` as of the spike date) — same range on
both. Since `pnpm lint` depends on `typescript-eslint`'s type-aware rules,
this alone was sufficient for NO-GO regardless of anything else.

TypeScript 7.0.2 itself is **not** the problem. The spike confirmed the
full `tsc -> tsc-alias -> node` pipeline works under it, with one
two-line tsconfig change the compiler names in its own error text: drop
`baseUrl`, express `paths` as `{ "@/*": ["./src/*"] }`. This repo's
`tsconfig.json` already uses exactly that shape — `moduleResolution:
Bundler`, no `baseUrl`, `paths: { "@/*": ["./src/*"] }` — adopted from the
codebase this boilerplate derives from rather than the plan's original
`NodeNext` setting, because `NodeNext` forces an explicit `.js` extension
on every internal import (2,997 of which are extensionless `@/foo` imports
in that reference codebase); `tsc-alias --resolve-full-paths` adds the
extension back at emit time regardless. So no further tsconfig migration
is needed on the TypeScript-7 front specifically.

**Unblock condition:** a `typescript-eslint` release whose peer range
includes `^7.0.0`. When one ships: bump `typescript`, confirm the tsconfig
is still in the `./src/*`-paths / no-`baseUrl` shape above, and re-run the
spike's command table to confirm GO before merging.

### Vitest -> 5.0.0

`test.poolOptions.forks.maxForks` — traced to have been removed as of
Vitest 4, so it is already gone by the 5.0.0 installed here — is replaced
by a top-level `test.maxWorkers`. `vitest.config.ts` uses
`maxWorkers: 8` — pinned rather than left to the default
(`availableParallelism() - 1`) because `database.service.ts` opens a real
Postgres pool (`DB_POOL_MAX=2` in `.env.test`) at module scope in every forked
worker, so the connection ceiling is `workers x pool.max`; left unpinned,
that ceiling tracks whichever machine happens to run the suite. Verified
directly against the installed package (both a runtime warning —
`poolOptions ... All previous poolOptions are now top-level options` — and
the package's own type declarations) rather than assumed from
documentation, because the first attempt to configure this via
`poolOptions` was silently ignored.

### pnpm -> 12.4.1

Two breaking changes landed here:

- **A minimum-release-age supply-chain gate.** pnpm 12 refuses to install a
  dependency version published too recently, as a defense against a
  just-published or compromised release. Pinning "latest" across the board
  at the start of this plan necessarily landed on packages fresh enough to
  trip it — see "Supply-chain bypasses" below for the current list.
- **A failed root lifecycle script retries on every subsequent
  install/exec.** Early in this plan, `"prepare": "husky"` failed because
  `husky` wasn't a dependency yet, and pnpm kept retrying that failed
  script on every later `pnpm install`/`pnpm exec` until `husky` actually
  landed and `"prepare"` was restored to its real form. A related trap:
  **a no-op install (already up to date) skips root lifecycle scripts
  entirely**, so verifying `"prepare": "husky"` actually re-installs hooks
  cannot be done by re-running `pnpm install` in an already-installed
  checkout — it proves nothing. Use a fresh clone, as this repo's own
  verification does.

### eslint-plugin-unicorn -> 74.0.0

No breaking API change consumed directly, but several of its rules shaped
code in ways worth knowing before "fixing" them:

- `unicorn/name-replacements` is scoped off for exactly two identifiers —
  `env` (in `env.config.ts`) and `db` (in `database.service.ts`) — each
  with an inline comment explaining why that specific abbreviation is the
  canonical spelling for its concept, not laziness. Every other
  abbreviation the rule catches (`req`, `res`, `err`, `ctx`, ...) stays
  enforced, including as plain identifiers, not just filenames. Proven both
  ways: `env.config.ts` lints clean while a variable named `err` (including
  inside a compound like `useErr`) is still rejected by the same rule.
- `unicorn/no-top-level-assignment-in-function` is why
  `redis.service.ts` mutates a property on a module-level object
  (`state.client = ...`) instead of reassigning a top-level `let` — a
  reassignment the rule forbids, but mutating a property on an object the
  module still holds by reference is not a reassignment and is unaffected.
  `env.config.ts`'s `getEnv` memoisation cache lives inside an IIFE's
  closure for the same reason.
- `unicorn/no-process-exit` only allows `process.exit()` inside a
  `process.on`/`process.once` callback. This is why the graceful-shutdown
  backstop timer lives in `index.ts`'s signal handler rather than inside
  `gracefulShutdown()` in `server.ts` — the relocation also makes
  `gracefulShutdown()` fully unit-testable, since it can now resolve
  without ever touching `process.exit`.

### Removed, not carried forward

- **`express-async-handler`** — Express 5's router forwards a rejected
  promise to `next(error)` on its own; the wrapper this package provided is
  redundant on Express 5 and is not a dependency here.
- **`drizzle-zod`** — not carried into this plan; dropped from the
  dependency set this boilerplate derives from.

### Not yet taken (owned by a later or separate plan)

These majors are named in this plan's own constraints as bumps to make,
but nothing in this repository consumes any of them yet — there is no
BullMQ, nodemailer, jsdom, or `@tanstack/react-table` dependency in
`package.json` today, so there is no breaking change to record against
code that doesn't exist. Listed here as a placeholder so the next plan that
introduces one of these doesn't have to rediscover that it's expected to
add a real row:

- **BullMQ 5 -> 6** — queue/worker infrastructure; not introduced by this
  plan.
- **nodemailer 9 -> 10** — email sending; not introduced by this plan.
- **jsdom 29 -> 30** (frontend) — this repository has no frontend package.
- **`@tanstack/react-table` 8 -> 9** (frontend) — same.

## Schema migrations on a live database

- **`0013` blocks every read and write on `notifications` until the migration batch commits.** Its `ADD COLUMN` takes an `ACCESS EXCLUSIVE` lock, and drizzle's migrator applies all pending migrations in one transaction, so that lock is held while the generated `CREATE UNIQUE INDEX` (no `CONCURRENTLY`) builds and until the whole batch commits. On a large existing table, run this by hand before `pnpm db:migrate`:
  ```sql
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key varchar(128);
  CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS notifications_dedupe_key_unique ON notifications (dedupe_key);
  ```
  Then add `IF NOT EXISTS` to both statements in the not-yet-applied `0013` file, or the migration fails on the existing column or index. A failed `CONCURRENTLY` build leaves an INVALID index that `IF NOT EXISTS` would skip: check `pg_index.indisvalid` for it, or drop it and build again.
- **`0014` blocks every read and write on `users` until the new index is built.** It runs `DROP INDEX "users_email_unique"` first, and drizzle's migrator applies all pending migrations in one transaction, so the `ACCESS EXCLUSIVE` lock from that drop is held while the replacement builds; every login waits. On a large table, first build the replacement by hand before `pnpm db:migrate`, as a statement on its own and outside any transaction (`CONCURRENTLY` cannot run inside one):
  ```sql
  CREATE UNIQUE INDEX CONCURRENTLY users_email_unique_live ON users USING btree (lower(email)) WHERE deleted_at IS NULL;
  ```
  A failed `CONCURRENTLY` build leaves an INVALID index: check `pg_index.indisvalid` for `users_email_unique_live`, and if it is false, `DROP INDEX CONCURRENTLY users_email_unique_live` and build again. Once it is valid, swap the names in one short transaction (the drop takes the same lock, but only for a moment):
  ```sql
  BEGIN;
  DROP INDEX users_email_unique;
  ALTER INDEX users_email_unique_live RENAME TO users_email_unique;
  COMMIT;
  ```
  Then edit the not-yet-applied `0014` file: delete its `DROP INDEX "users_email_unique";--> statement-breakpoint` line, and change the remaining statement to `CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ...`. Without that edit, `pnpm db:migrate` drops the index you just built and rebuilds it under the lock. With it, the migration only records `0014` as applied.
- **`0015` creates the new `tenant_invitations` table and needs no manual step.** Its three `FOREIGN KEY` constraints take a `SHARE ROW EXCLUSIVE` lock on `users` and `tenants`, which blocks writes to them (not reads) until the migration batch commits. That is brief, but the lock waits for any open transaction that has written to either table, and new writes queue behind it meanwhile, so apply it when no long write transaction is running.
- **`0016` blocks every read and write on `tenants` until the migration batch commits.** Its `ALTER TABLE tenants` takes an `ACCESS EXCLUSIVE` lock, and drizzle's migrator applies all pending migrations in one transaction. So that lock is held while the two trigram indexes build (no `CONCURRENTLY`), and every tenant-scoped request waits. A tenants table is usually small enough that this is brief. On a large one, build the indexes by hand first, each as a statement on its own and outside any transaction:
  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenants_name_trgm_idx ON tenants USING gin (lower(name) gin_trgm_ops) WHERE deleted_at IS NULL;
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenants_slug_trgm_idx ON tenants USING gin (slug gin_trgm_ops) WHERE deleted_at IS NULL;
  ```
  Then add `IF NOT EXISTS` to both `CREATE INDEX` statements in the not-yet-applied `0016` file. A failed `CONCURRENTLY` build leaves an INVALID index: check `pg_index.indisvalid`, and drop and rebuild it if it's false.
- **`0017` blocks every read and write on `user_tokens` until the migration batch commits, and writes to `email_logs` and `notifications` while their indexes build.** Its first statement drops `user_tokens`' `replaced_by_id` foreign key, which takes an `ACCESS EXCLUSIVE` lock, and drizzle's migrator applies all pending migrations in one transaction. So every login and refresh waits while the re-added foreign key validates every `user_tokens` row and all six indexes build (no `CONCURRENTLY`); each `CREATE INDEX` also holds a `SHARE` lock on its table, which blocks inserts, updates and deletes. No purge has pruned `user_tokens` before this release, so it may be large. On a large database, build the indexes by hand first, each as a statement on its own and outside any transaction:
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS user_tokens_replaced_by_id_idx ON user_tokens (replaced_by_id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS user_tokens_expires_at_idx ON user_tokens (expires_at);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS user_tokens_revoked_unconsumed_idx ON user_tokens (revoked_at) WHERE revoked_at IS NOT NULL AND consumed_at IS NULL;
  CREATE INDEX CONCURRENTLY IF NOT EXISTS email_logs_created_at_idx ON email_logs (created_at);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_read_at_idx ON notifications (read_at) WHERE read_at IS NOT NULL;
  CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_unread_created_idx ON notifications (created_at) WHERE read_at IS NULL;
  ```
  Then add `IF NOT EXISTS` to the six `CREATE INDEX` statements in the not-yet-applied `0017` file. A failed `CONCURRENTLY` build leaves an INVALID index: check `pg_index.indisvalid`, and drop and rebuild it if it's false. That leaves the foreign key's validation scan under the `ACCESS EXCLUSIVE` lock, so apply the migration in a quiet window. The hand-added function replacement takes only a brief lock and needs no manual step.

## Supply-chain bypasses in `pnpm-workspace.yaml`

pnpm writes these bypasses into a generated file that nobody opens by
default — recorded here so a silent supply-chain decision doesn't stay
invisible for a year. **Rule: every future addition to
`pnpm-workspace.yaml` gets a line here too, in the same change that adds
it.** Renovate adds `# Renovate security update:` entries to
`minimumReleaseAgeExclude` itself; they need no line here and can be deleted
once the version is 3 days old.

Current contents, verbatim:

```yaml
allowBuilds:
  # bcrypt's "install" script runs node-gyp-build: it tests the prebuilt
  # native binding bundled in the package's prebuilds/ for the host
  # platform, or compiles one from source via node-gyp if that fails.
  # Required for bcrypt to work at all — it is a native addon, not a
  # pure-JS package — and it is the password-hashing library this plan's
  # Task 2 adds. See MIGRATIONS.md.
  bcrypt: true
  esbuild: true
  # msgpackr-extract: transitive dependency of bullmq (via msgpackr, which
  # BullMQ uses to encode job data for Redis). Its install script
  # (node-gyp-build-optional-packages) tests the prebuilt binding from an
  # optional per-platform package, or compiles one from source via node-gyp
  # if that fails. If no binding loads, msgpackr falls back to its pure-JS
  # encoder at runtime.
  msgpackr-extract: true
  # protobufjs: transitive dependency of @opentelemetry/exporter-trace-otlp-http
  # (via @opentelemetry/otlp-transformer). Its postinstall only reads
  # package.json files to print a stderr warning if a *dependent* pins an
  # incompatible version scheme for protobufjs itself — verified by reading
  # scripts/postinstall.js; no network access, no compilation, no arbitrary
  # code.
  protobufjs: true
  # unrs-resolver: native binary that eslint-plugin-import-x depends on
  # directly for module/TS-path resolution. Its postinstall only fetches a
  # prebuilt binary for the host platform; no arbitrary script.
  unrs-resolver: true
# Minutes (3 days). Matches renovate.json; the excludes below are exceptions to it.
minimumReleaseAge: 4320
minimumReleaseAgeExclude:
  - dotenv@18.0.3
  - supertest@7.3.0
```

Line-by-line:

- **`allowBuilds.bcrypt: true`** — `bcrypt`'s `install` script runs
  `node-gyp-build`: it tests the prebuilt native binding bundled in the
  package's `prebuilds/` for the host platform, or compiles one from source
  via `node-gyp` if that fails. Native
  addon, not pure JS — the build step is required for the package to work
  at all, not optional tooling. Added centrally, ahead of Tasks 2/3/4/7, to
  keep every later task's `pnpm add` from racing another task's over
  `package.json`/`pnpm-lock.yaml`; added but not yet imported or used by
  any module — that's Task 2.
- **`allowBuilds.esbuild: true`** — `esbuild` ships a native binary fetched
  by its own postinstall script; pnpm 12 blocks arbitrary postinstall
  scripts by default, and this is the explicit allow for that one. It's a
  transitive build tool (pulled in by `tsx`/`vitest`/`tsc-alias`'s
  toolchain), dev-only.
- **`allowBuilds.unrs-resolver: true`** — a direct dependency of
  `eslint-plugin-import-x`, used for `@/*`-alias and TypeScript-path
  resolution (this is what makes `import-x/no-cycle` actually see aliased
  imports — see the comment above `import-x/resolver-next` in
  `eslint.config.mjs`). Its postinstall only fetches a prebuilt binary for
  the host platform, not arbitrary script execution. Dev-only; never
  reaches the runtime image.
- **`allowBuilds.msgpackr-extract: true`** — transitive dependency of
  `bullmq` (via `msgpackr`). Its install script
  (`node-gyp-build-optional-packages`) tests the prebuilt binding from an
  optional per-platform package, or compiles one from source via `node-gyp`
  if that fails. If no binding loads, `msgpackr` falls back to its pure-JS
  encoder at runtime.
- **`allowBuilds.protobufjs: true`** — transitive dependency of
  `@opentelemetry/exporter-trace-otlp-http`. Its postinstall only reads
  `package.json` files to print a version-scheme warning; no network
  access, no compilation.
- **`minimumReleaseAge: 4320`** — pnpm refuses to install any version
  published less than 3 days (4320 minutes) ago, the same window
  `renovate.json` waits before proposing an update. A frozen install
  (`pnpm install --frozen-lockfile`) checks every lockfile entry against
  it, so a lockfile holding a younger version fails the install until that
  version ages or is listed below.
- **`minimumReleaseAgeExclude: [dotenv@18.0.3, supertest@7.3.0]`** —
  both were published on 2026-09-22, less than 3 days before the release-age
  gate above was set, and the lockfile already held them. Each entry is
  needed only until its version is 3 days old; delete it after that, as
  the earlier `zod` and `eslint-plugin-jsdoc` entries were.

If this list has grown since the paragraph above was written, the file
itself is still the source of truth — this document may be behind it by
one entry until the change that added it also updates this file, per the
rule above.
