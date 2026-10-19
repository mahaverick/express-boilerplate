# Database

Drizzle ORM on Postgres, through the `postgres` (postgres-js) driver. This
document covers the client's exports, the tables, how migrations are generated
and applied (including on a database that already holds data), the test
database and the batch-delete query shape. How the client sits in the process,
and the retention and analytics jobs that delete rows, are in
[ARCHITECTURE.md](ARCHITECTURE.md#data-layer).

## The client and pool

`src/services/database.service.ts` creates the process's one client and exports:

- `sql`, the raw `postgres` client, for untyped SQL.
- `db`, the Drizzle instance over it. Repositories import this.
- `isDatabaseReachable()`, which `/health/ready` calls.
- `closeDatabase()`, which graceful shutdown calls; it is safe to call twice.
- `withTransaction(fn, executor)`, `DbTransaction` and `DbExecutor`. A
  repository method takes an optional `DbExecutor` last parameter, defaulting
  to `db`, so a service can compose several calls in one transaction.

Why there is one client, and the pool options `DB_POOL_MAX`,
`DB_STATEMENT_TIMEOUT_MS` and prepared statements off, are in
[ARCHITECTURE.md](ARCHITECTURE.md#data-layer); the defaults are in its
[environment table](ARCHITECTURE.md#environment-variables). Two options are
fixed in `src/configs/database.config.ts`: an idle connection closes after 20
seconds, and a connect attempt gives up after 10.

### Postgres 18

`docker-compose.yml` and CI pin Postgres to major version 18. Migrations and
models use `uuidv7()` as a column default, which Postgres builds in from 18.
On 17 or older a migration aborts with `function uuidv7() does not exist`
unless an extension is installed. Do not lower the image tag without checking
this.

## Models and tables

`src/database/models/*.model.ts` defines the tables, a closely related pair
sometimes sharing one file. The `*.model.ts` suffix is enforced by `check-file`
([ARCHITECTURE.md](ARCHITECTURE.md#directory-rules)). A model file under that
glob is picked up by `drizzle.config.ts` with no config change.

| Table                      | Model file                        | Holds                                                                                                                                           |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                    | `user.model.ts`                   | Accounts; see below.                                                                                                                            |
| `user_tokens`              | `user-token.model.ts`             | Refresh, email-verification and password-reset tokens and emailed sign-in and step-up links, as hashes; see below.                              |
| `auth_providers`           | `auth-provider.model.ts`          | One row per sign-in method a user has (`'email'` for a password, `'google'` for a linked account).                                              |
| `tenants`                  | `tenant.model.ts`                 | Tenants, with lifecycle state, the platform flag and onboarding tracking.                                                                       |
| `tenant_settings`          | `tenant.model.ts`                 | The one-to-one settings row, written with its tenant in one transaction.                                                                        |
| `user_memberships`         | `user-membership.model.ts`        | One row per (user, tenant) pair, with the user's role in it.                                                                                    |
| `tenant_invitations`       | `tenant-invitation.model.ts`      | Offers of a role in a tenant to an email address; only the token's SHA-256 hash is stored.                                                      |
| `audit_logs`               | `audit-log.model.ts`              | The append-only audit trail, guarded by the `audit_logs_immutable` trigger ([SECURITY.md](SECURITY.md#the-audit-log)).                          |
| `email_messages`           | `email-message.model.ts`          | One row per logical email; no column holds a rendered body or a token.                                                                          |
| `email_logs`               | `email-log.model.ts`              | One row per send attempt, pointing at its message through `message_id`.                                                                         |
| `email_events`             | `email-event.model.ts`            | Provider events (delivered, bounced, opened, …) matched to a message.                                                                           |
| `email_suppressions`       | `email-suppression.model.ts`      | Addresses that hard-bounced or complained, which no email may be sent to. Lifting one keeps the row as history; retention never deletes one.    |
| `notifications`            | `notification.model.ts`           | In-app notification history.                                                                                                                    |
| `notification_preferences` | `notification.model.ts`           | Per-user, per-type channel opt-outs.                                                                                                            |
| `onboarding_completions`   | `onboarding-completion.model.ts`  | One append-only row per completed onboarding step, per tenant or per member.                                                                    |
| `maintenance_mode_state`   | `maintenance-mode-state.model.ts` | The single row holding the platform's maintenance mode. A CHECK pins `id` to 1; migration 0024 inserts the row; no code inserts or deletes one. |
| `analytics_outbox`         | `analytics-outbox.model.ts`       | Server analytics events waiting to reach PostHog. It holds ids and no PII, and has no foreign key.                                              |
| `analytics_deletions`      | `analytics-deletion.model.ts`     | Purged users whose PostHog data is still to be deleted; see below.                                                                              |

Drizzle's own bookkeeping table is separate from these.

### `users`

`id` is a `uuidv7()` primary key. `email` is unique case-insensitively among
rows that are not soft-deleted, through a partial `lower(email)` index
(`users_email_unique`), not a plain unique constraint, so a soft-deleted user's
address can register again. `password_hash` is null for a user who signs in
only with Google. The rest: `first_name`, `last_name`, `active`,
`email_verified_at`, `last_logged_in_at`, `analytics_opt_out` (the user turned
off browser analytics; server events ignore it) and the
`deleted_at`/`created_at`/`updated_at` trio every soft-deletable table carries.

### `user_tokens`

One table holds every token purpose (`purpose`: `'refresh'`,
`'email_verification'`, `'password_reset'`, `'sign_in_link'`,
`'step_up_link'`), since they share hashing, lookup, expiry and revocation.
The `user_tokens_purpose_check` constraint enforces the list in the database,
not only through TypeScript's `$type<TokenPurpose>()`.

- `token_hash` is a SHA-256 digest of the raw token, never the token.
- `session_id`, `session_started_at` and `authenticated_at` are meaningful only
  for `'refresh'`, except that `session_id` is meaningful on a
  `'step_up_link'` too (see Emailed links). `session_id` groups every token
  descended from one login into a rotation family. `session_started_at` is
  copied forward unchanged by every rotation, which makes
  `SESSION_ABSOLUTE_TTL` an absolute ceiling. `authenticated_at` is when the
  session last proved who its user is, and is the source of the access
  token's `auth_time`.
- `consumed_at` is set only by `UserTokenRepository.claimOnce`, so it
  separates a row spent through its single-use path from one revoked unused.
- `replaced_by_id` points at the row a token rotated into. Nothing reads it; it
  is forensic metadata. Its foreign key is `ON DELETE SET NULL`, so a chain
  read back after the retention purge can have gaps.
- `deleted_at` exists only to satisfy `SoftDeletableTableConfig`. No path sets
  it, and the retention purge ignores it.

#### Emailed links

The two link purposes are the links a mail carries to sign someone in or to
confirm a step-up, 32 random bytes each, stored as a SHA-256 hash. They use
three columns no other purpose fills: `email` (the address, lowercased), `app`
(`'web'` or `'apex'`, the frontend the link opens; verify reads it from the
row, never from the request; `user_tokens_app_check`) and `redirect` (a
same-origin path checked by `redirectPathSchema`). `user_tokens_shape_check`
holds each purpose's shape:

- `refresh`, `email_verification` and `password_reset` rows name a user and
  none of the three link columns.
- A `sign_in_link` row names an address and an app, and never a `user_id` or
  `session_id`. The click looks the account up by address, so a link can be
  mailed to an address with no account yet, and a soft-deleted user's address
  reaches a fresh account rather than the deleted one. `user_id` is nullable
  for this purpose alone.
- A `step_up_link` row names the user, the `session_id` it elevates, an
  address and an app, and no `redirect`. Its claim matches the user and the
  session as well as the hash, so another session of the same user neither
  honours nor spends it, and a sign-out (`revokeAllForSession`) revokes it with
  the session's chain.

A link row shares `session_id` with its session's refresh rows, so every
reader that gives a session's rows refresh meaning is scoped to
`purpose = 'refresh'`: `isSessionKilled` (a superseded or claimed link would
otherwise read as a kill marker and end the session), `findRefreshByHash` (the
rotation and sign-out lookups), `liveSessionIdsExcept` and
`markSessionAuthenticated`.

Issuing a link revokes the live links it supersedes (every `sign_in_link` of
the address, through `user_tokens_live_email_idx`, or every `step_up_link` of
the session) and inserts the new row in one transaction, under a
transaction-scoped advisory lock on the address or the session taken first, so
at most one of each stays live. The claim is `claimOnce`, which checks no
expiry; the caller judges `expires_at` on the claimed row, so an expired link is
spent by its one presentation. A `sign_in_link` row has no user, so a user
purge deletes the purged address's links itself (`deleteForEmail`), up to the
deletion and only while no live account holds the address, and the user-wide
revocations never reach one: a sign-out of the other sessions, a staff
sign-out and a deactivation revoke the address's live links in their own
transaction (`revokeSignInLinksOf`), and a verify re-checks the account under
its row lock. The retention rule
below covers link rows as it covers the rest.

Rotation is append-only, because reuse detection needs the old row to
recognise a replay. With a 15-minute `ACCESS_TOKEN_TTL`, a client that stays
signed in adds about 96 rows a day. The retention purge deletes a row once
`RETENTION_TOKENS_DAYS` days have passed since its `expires_at`, or since a
revoke that never consumed it (logout, reuse, a password change):
`expires_at < cutoff or (revoked_at < cutoff and consumed_at is null)`. A
rotated-away row carries `consumed_at`, so it stays until it expires. The
indexes on `expires_at` and on the revoked-unconsumed partial predicate serve
that query. The schedule, batch size and failure handling are in
[ARCHITECTURE.md](ARCHITECTURE.md#retention).

### `analytics_deletions`

One row per purged user (`distinct_id`, the user's id, is the primary key),
with `not_before`, `attempts`, `last_error` (an HTTP status or an error class
such as `http_500` or `timeout`, never a response body) and `created_at`. The
`analytics_deletions_due_idx` index on `not_before` serves the claim. Like
`analytics_outbox` it holds an id and no PII and has no foreign key, because
the user row is gone once the purge commits. No retention rule prunes it: a row
PostHog keeps refusing stays. What writes, claims and deletes the rows is under
[Purges and what stays in PostHog](ARCHITECTURE.md#analytics).

## Migrations

`src/database/migrations/` is tracked: one SQL file per migration, and
`meta/_journal.json` records them in order. `drizzle-kit generate` writes
everything in it, except the hand-added statements in these migrations, each
marked by a comment in its file (0024's has none):

- `0010` backfills an `'email'` `auth_providers` row for every user with a
  password.
- `0016` creates the `pg_trgm` extension, refuses to run while a live tenant
  holds the reserved `platform` slug, seeds the platform tenant and its
  settings row, and adds the trigger that makes `audit_logs` append-only.
- `0017` replaces that trigger's function so the retention purge can delete
  audit rows.
- `0019` replaces it again so a staff user purge can null a purged user's
  actor columns (`actor_user_id`, `ip`, `user_agent`) and nothing else.
- `0020` backfills one `email_messages` row per existing `email_logs` row
  (reusing the attempt's id, recipient, template, status and `created_at`),
  points each attempt at it, and moves the `audit_logs` target-type CHECK swap
  after that backfill.
- `0024` inserts the single `maintenance_mode_state` row (mode `off`,
  version 0).

Do not hand-edit a migration otherwise, except as
[Schema migrations on a live database](#schema-migrations-on-a-live-database)
describes, and only before that database has applied it.

Generated does not mean disposable. The migrations are the ordered, immutable
record of how the schema reached its current state. `pnpm db:migrate` replays
them in journal order against a database that may be several migrations
behind, and CI and the production image cannot regenerate them (`generate`
diffs the models, not a live database). They must be committed; do not add the
directory to `.gitignore`. `.prettierignore` excludes it, because Prettier and
`drizzle-kit` would otherwise each rewrite `meta/_journal.json` and the SQL
into their own layout on every run, and `vitest.config.ts` excludes
`**/migrations/**` and `src/database/models/**` from coverage.

### `drizzle.config.ts` and why it only needs `DATABASE_URL`

```ts
export default defineConfig({
  schema: './src/database/models/*.model.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: getDatabaseUrl() },
  strict: true,
  verbose: true,
})
```

It calls `getDatabaseUrl()`, not `getEnv()`. `getEnv()` validates the whole
environment schema (JWT secrets, session secret, everything the app needs to
boot), and generating or checking a migration needs none of it. Routing the
config through `getEnv()` would make every `drizzle-kit` run, CI included, need
application secrets that have nothing to do with writing SQL.
`getDatabaseUrl()` re-slices the same schema (`EnvSchema.pick({ DATABASE_URL:
true })`), so the rule for `DATABASE_URL` stays single-sourced.
`drizzle-kit check` runs with only `DATABASE_URL` set.

### Commands

All three read `DATABASE_URL` from `process.env`. With a `.env` in place (see
the [README](README.md) quick start), `env.config.ts` loads it, so the inline
`DATABASE_URL=...` below is needed only without one.

**Generate a migration** from the model files with `pnpm
db:migration:generate` (`drizzle-kit generate`):

```bash
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm db:migration:generate
```

It writes the SQL under `src/database/migrations/` and updates
`meta/_journal.json`, or prints `No schema changes, nothing to migrate` when
the models already match. It does not touch the database.

**Apply pending migrations** with `pnpm db:migrate` (`src/database/migrate.ts`,
run through `tsx`). `runMigrations()` opens its own single-connection client
from `getDatabaseUrl()`, not the long-lived pool, and closes it when done.
Drizzle's migrator applies every pending migration in one transaction, so a
batch lands whole or not at all, and every lock a migration takes is held until
the whole batch commits. Against an up-to-date database it exits 0 and prints
nothing, because `migrate.ts` drops Postgres's "already exists, skipping"
notices. `pnpm db:migrate:prod` runs the same logic from the built output
(`node dist/database/migrate.js`): `pnpm build` copies the migrations into
`dist/`, and the production image, which has no `drizzle-kit`, migrates this
way. CI runs `pnpm db:migrate` before the tests.

**Check migration and schema consistency:**

```bash
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm exec drizzle-kit check
```

### Schema migrations on a live database

`pnpm db:migrate` applies every pending migration in one transaction, so a
lock any statement takes is held until the whole batch commits. On an empty or
small database that is brief. On a database that already holds a lot of data,
some migrations below block reads or writes for as long as their index builds
or validation scans take. For the ones that offer a manual step, build the
indexes by hand first with `CREATE INDEX CONCURRENTLY`. **Run each
`CONCURRENTLY` statement on its own, outside any transaction:** Postgres
refuses `CONCURRENTLY` inside one, and `psql` running a file with
`-1`/`--single-transaction` wraps it in one. A failed `CONCURRENTLY` build
leaves an INVALID index that `IF NOT EXISTS` would then skip; check
`pg_index.indisvalid`, and if it is false, `DROP INDEX CONCURRENTLY` it and
build it again. Once the indexes exist, edit the not-yet-applied migration file
as described so it does not build them a second time under the lock, then run
`pnpm db:migrate`.

- **`0013` blocks every read and write on `notifications` until the batch
  commits.** Its `ADD COLUMN` takes an `ACCESS EXCLUSIVE` lock, held while the
  generated `CREATE UNIQUE INDEX` builds. On a large table, first add the
  column:

  ```sql
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key varchar(128);
  ```

  then, as a separate statement outside any transaction, build the index:

  ```sql
  CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS notifications_dedupe_key_unique ON notifications (dedupe_key);
  ```

  Then add `IF NOT EXISTS` to both statements in the `0013` file, or the
  migration fails on the existing column or index.

- **`0014` blocks every read and write on `users` until the new index is
  built.** It runs `DROP INDEX "users_email_unique"` first, and the
  `ACCESS EXCLUSIVE` lock from that drop is held while the replacement
  builds; every login waits. On a large table, build the replacement under a
  temporary name, on its own and outside any transaction:

  ```sql
  CREATE UNIQUE INDEX CONCURRENTLY users_email_unique_live ON users USING btree (lower(email)) WHERE deleted_at IS NULL;
  ```

  Once it is valid, swap the names in one short transaction (the drop takes
  the same lock, but only for a moment):

  ```sql
  BEGIN;
  DROP INDEX users_email_unique;
  ALTER INDEX users_email_unique_live RENAME TO users_email_unique;
  COMMIT;
  ```

  Then edit the `0014` file: delete its
  `DROP INDEX "users_email_unique";--> statement-breakpoint` line, and change
  the remaining statement to `CREATE UNIQUE INDEX IF NOT EXISTS
"users_email_unique" ...`. Without that edit, `pnpm db:migrate` drops the
  index you just built and rebuilds it under the lock. With it, the migration
  only records `0014` as applied.

- **`0015` creates the `tenant_invitations` table and needs no manual step.**
  Its three `FOREIGN KEY` constraints take a `SHARE ROW EXCLUSIVE` lock on
  `users` and `tenants`, which blocks writes to them (not reads) until the
  batch commits. That is brief, but the lock waits for any open transaction
  that has written to either table, and new writes queue behind it
  meanwhile, so apply it when no long write transaction is running.

- **`0016` blocks every read and write on `tenants` until the batch
  commits.** Its `ALTER TABLE tenants` takes an `ACCESS EXCLUSIVE` lock, held
  while the two trigram indexes build, and every tenant-scoped request waits.
  The new `audit_logs` foreign keys also take `SHARE ROW EXCLUSIVE` on `users`,
  so writes to users wait too. A tenants table is usually small enough that
  this is brief. On a large one, run each of these on its own, outside any
  transaction:

  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  ```

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenants_name_trgm_idx ON tenants USING gin (lower(name) gin_trgm_ops) WHERE deleted_at IS NULL;
  ```

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenants_slug_trgm_idx ON tenants USING gin (slug gin_trgm_ops) WHERE deleted_at IS NULL;
  ```

  Then add `IF NOT EXISTS` to both trigram `CREATE INDEX` statements in the
  `0016` file.

- **`0017` blocks every read and write on `user_tokens` until the batch
  commits, and writes to `email_logs` and `notifications` while their indexes
  build.** Its first statement drops `user_tokens`' `replaced_by_id` foreign
  key, which takes an `ACCESS EXCLUSIVE` lock. Every login and refresh then
  waits while the re-added foreign key validates every `user_tokens` row and
  all six indexes build; each `CREATE INDEX` also holds a `SHARE` lock on its
  table, which blocks inserts, updates and deletes. A `user_tokens` table the
  retention purge has never run against may be large. On a large database,
  run each of these on its own, outside any transaction:

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS user_tokens_replaced_by_id_idx ON user_tokens (replaced_by_id);
  ```

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS user_tokens_expires_at_idx ON user_tokens (expires_at);
  ```

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS user_tokens_revoked_unconsumed_idx ON user_tokens (revoked_at) WHERE revoked_at IS NOT NULL AND consumed_at IS NULL;
  ```

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS email_logs_created_at_idx ON email_logs (created_at);
  ```

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_read_at_idx ON notifications (read_at) WHERE read_at IS NOT NULL;
  ```

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_unread_created_idx ON notifications (created_at) WHERE read_at IS NULL;
  ```

  Then add `IF NOT EXISTS` to the six `CREATE INDEX` statements in the `0017`
  file. That leaves the foreign key's validation scan under the
  `ACCESS EXCLUSIVE` lock, so apply the migration in a quiet window. The
  hand-added function replacement takes only a brief lock and needs no manual
  step.

- **`0018` holds `user_tokens` briefly.** Its nullable `ADD COLUMN` is
  metadata-only, but it takes an `ACCESS EXCLUSIVE` lock on `user_tokens` until
  the batch commits, so every login and refresh waits for the batch.

- **`0019` blocks every read and write on `audit_logs`, and writes to
  `email_logs`, until the batch commits.** Its first statement drops
  `audit_logs_actor_user_check`, which takes an `ACCESS EXCLUSIVE` lock on
  `audit_logs`, held while both indexes build and while the re-added CHECK
  validates every audit row. Every audited write (tenant, member,
  invitation and staff changes, and the hourly staff-access entries) waits
  meanwhile. The `email_logs` index build holds a `SHARE` lock on that
  table, which blocks mail-log writes. On a large database, build the two
  indexes by hand first, each on its own, outside any transaction; the
  `0019` file creates them with `IF NOT EXISTS`, so the migration then skips
  them and needs no edit:

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_target_occurred_idx ON audit_logs (target_id, occurred_at, id);
  ```

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS email_logs_recipient_lower_idx ON email_logs (lower(recipient));
  ```

  The CHECK's validation scan still runs under the `ACCESS EXCLUSIVE` lock
  (adding it `NOT VALID` and validating it later in the same batch would
  gain nothing, since the batch is one transaction), so apply the migration
  in a quiet window. The hand-added function replacement takes only a brief
  lock.

- **`0020` blocks reads and writes on `email_logs` until its transaction
  commits, and on `audit_logs` while its target-type CHECK is swapped.**
  `ALTER TABLE email_logs ADD COLUMN` takes an `ACCESS EXCLUSIVE` lock that
  the migration's transaction holds to the end, so mail recording, the
  retention purge and a user purge all wait for the whole backfill (the copy
  into `email_messages`, the update, the foreign key's validation and the
  index build). The CHECK swap at the end takes the same lock on
  `audit_logs` and validates every audit row. Apply it in a quiet window.
  `email_logs` is bounded by `RETENTION_EMAIL_LOGS_DAYS`, so letting
  retention prune first shortens the backfill.

- **`0021` holds `tenants` briefly.** Its four `ADD COLUMN`s are
  metadata-only (the one default is a constant, so no row is rewritten),
  but each takes an `ACCESS EXCLUSIVE` lock on `tenants` for the rest of the
  migration's transaction, which also validates the
  `onboarding_dismissed_by` foreign key and the `tenants_platform_untracked`
  CHECK by scanning `tenants` once. `onboarding_completions` is empty, so its
  indexes build instantly. Every request that resolves a tenant waits for
  that scan; on a large `tenants` table apply it in a quiet window. Its three
  foreign keys to `users` (`onboarding_dismissed_by`, and
  `onboarding_completions.user_id` and `completed_by`) also take
  `SHARE ROW EXCLUSIVE` on `users` until the transaction commits, so every
  write to a user row (login's `last_logged_in_at` update, a registration, a
  profile change) waits for the migration too; reads, including `FOR SHARE`
  and `FOR NO KEY UPDATE` locks, do not.

- **`0022` holds `users` briefly.** Its `ADD COLUMN analytics_opt_out` is
  metadata-only (the default is a constant, so no row is rewritten), but it
  takes an `ACCESS EXCLUSIVE` lock on `users` until the migration's
  transaction commits, so every request that reads a user waits for it.
  `analytics_outbox` is empty and has no foreign key, so its index builds
  instantly.

- **`0023` locks nothing that exists.** It creates `analytics_deletions`, empty
  and with no foreign key, and its `not_before` index, so it applies
  instantly on any database.

- **`0024` blocks every read and write on `audit_logs`, and writes to `users`,
  until the batch commits.**
  It creates `maintenance_mode_state` (empty, so instant) and inserts its one
  row. Swapping `audit_logs_target_type_check` drops the constraint, which takes
  an `ACCESS EXCLUSIVE` lock on `audit_logs`, and re-adds it, which scans every
  audit row while the lock is held; every audited write waits.
  `maintenance_mode_state`'s foreign key (`changed_by`) to `users` takes
  `SHARE ROW EXCLUSIVE` on `users`, so writes to a user row wait; reads do not.
  There is no manual step, because the batch is one transaction and the
  validation scan runs under the lock whatever order the statements take. Apply
  it in a quiet window.

- **`0025` holds `tenant_invitations` briefly.** Its nullable `ADD COLUMN
last_sent_at` is metadata-only, but it takes an `ACCESS EXCLUSIVE` lock on
  `tenant_invitations` until the batch commits, so invitation reads and writes
  wait for the batch.

- **`0026` blocks every read and write on `tenants`, `email_messages` and
  `user_memberships`, and every write to `users`, `email_suppressions` and
  `tenant_invitations`, until the batch commits.** Its first statements drop
  one redundant index each on `email_messages` and `user_memberships` and the
  two tenant trigram indexes. Each `DROP INDEX` takes an `ACCESS EXCLUSIVE`
  lock on its table, held to the end of the batch while every other index
  builds, so every tenant-scoped request waits; each `CREATE INDEX` takes a
  `SHARE` lock, which blocks writes to its table the
  same way. The trigram indexes are rebuilt without their `deleted_at`
  predicate, and the two dropped indexes are prefixes of new ones
  (`email_messages_created_at_idx` of `email_messages_created_sort_idx`,
  `user_memberships_tenant_id_idx` of the tenant sort indexes). On large
  tables, run each of these on its own, outside any transaction. First build
  the new indexes, the full trigram pair under temporary names:

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenants_name_sort_idx ON tenants (lower(name), id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenants_created_sort_idx ON tenants (created_at, id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenants_name_trgm_idx_full ON tenants USING gin (lower(name) gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenants_slug_trgm_idx_full ON tenants USING gin (slug gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS users_email_sort_idx ON users (lower(email), id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS users_created_sort_idx ON users (created_at, id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS users_last_logged_in_sort_idx ON users (coalesce(last_logged_in_at, '-infinity'::timestamptz), id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS users_email_trgm_idx ON users USING gin (lower(email) gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS users_first_name_trgm_idx ON users USING gin (lower(first_name) gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS users_last_name_trgm_idx ON users USING gin (lower(last_name) gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS email_messages_created_sort_idx ON email_messages (created_at, id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS email_messages_recipient_trgm_idx ON email_messages USING gin (lower(recipient) gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS email_suppressions_created_sort_idx ON email_suppressions (created_at, id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS email_suppressions_address_sort_idx ON email_suppressions (address, id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS email_suppressions_address_trgm_idx ON email_suppressions USING gin (address gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS user_memberships_tenant_joined_sort_idx ON user_memberships (tenant_id, created_at, id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS user_memberships_user_joined_sort_idx ON user_memberships (user_id, created_at, tenant_id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenant_invitations_tenant_created_sort_idx ON tenant_invitations (tenant_id, created_at, id);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS tenant_invitations_tenant_email_sort_idx ON tenant_invitations (tenant_id, lower(email), id);
  ```

  `user_memberships_tenant_role_sort_idx` is the `CREATE INDEX` line for it
  in `0026_list_indexes.sql`, run with `CONCURRENTLY IF NOT EXISTS` added.
  Once every index is valid, swap the trigram names in one short transaction
  (each drop takes its lock only for a moment), then drop the two redundant
  indexes:

  ```sql
  BEGIN;
  DROP INDEX tenants_name_trgm_idx;
  ALTER INDEX tenants_name_trgm_idx_full RENAME TO tenants_name_trgm_idx;
  DROP INDEX tenants_slug_trgm_idx;
  ALTER INDEX tenants_slug_trgm_idx_full RENAME TO tenants_slug_trgm_idx;
  COMMIT;
  ```

  ```sql
  DROP INDEX CONCURRENTLY IF EXISTS email_messages_created_at_idx;
  DROP INDEX CONCURRENTLY IF EXISTS user_memberships_tenant_id_idx;
  ```

  Then edit the `0026` file: delete its four `DROP INDEX` lines and add
  `IF NOT EXISTS` to every `CREATE INDEX`. Without that edit,
  `pnpm db:migrate` fails on the first `DROP INDEX` of an index you already
  dropped, and on each `CREATE INDEX` of one you built, so the batch rolls back
  and the deploy stops. With it, the migration only records `0026` as applied.

- **`0027` blocks writes to `users` until its one index is built.** It adds
  `users_full_name_trgm_idx`, which the platform users search uses to match a
  full name. A plain `CREATE INDEX` takes a `SHARE` lock, so reads continue but
  writes wait. On a large table, build it first outside any transaction, then
  let `pnpm db:migrate` record `0027`; edit the `0027` file to add
  `IF NOT EXISTS` first, or the migration fails on the existing name:

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS users_full_name_trgm_idx ON users USING gin (lower(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) gin_trgm_ops);
  ```

- **`0028` blocks every read and write on `user_tokens` until the batch
  commits.** Its `ALTER TABLE`s take an `ACCESS EXCLUSIVE` lock, held while
  `user_tokens_shape_check`, `user_tokens_app_check` and the re-added
  `user_tokens_purpose_check` scan every row, and while
  `user_tokens_live_email_idx` builds, which scans the table too although it
  holds no row yet. Every refresh reads that table, so on a large one
  run the retention purge first to shorten the scans, and apply `0028` in a
  quiet window.

## The test database

`docker/postgres/init.sql` runs once, the first time the `postgres` container
starts against an empty volume (the `docker-entrypoint-initdb.d` convention; it
never re-runs against an existing one). It creates a second role and database:

```sql
CREATE ROLE test LOGIN PASSWORD 'test' CREATEDB;
CREATE DATABASE boilerplate_test OWNER test;
```

`.env.test`'s `DATABASE_URL` points at `boilerplate_test`, so dev data (the
`boilerplate` database) and test data never share a database. If the role or
database goes missing, for example after `docker compose down -v`, the next
`docker compose up -d` against a fresh volume recreates them. In CI the
Postgres service is created with `test` as its bootstrap superuser and
`boilerplate_test` as its database, because a `services:` block cannot mount
`init.sql`.

**Global setup** (`tests/helpers/global-setup.ts`, vitest's `globalSetup`)
runs once in the main process, before any worker starts:

1. It loads `.env.test` and derives `WORKER_COUNT` (8, from
   `tests/helpers/worker-database.ts`) database URLs from `DATABASE_URL` by
   suffixing the name: `boilerplate_test_w1` to `boilerplate_test_w8`.
2. It creates each with `CREATE DATABASE`, ignoring `42P04`
   (`duplicate_database`) from an earlier run against the same volume. The
   role's `CREATEDB` is what permits this.
3. It migrates all eight in parallel with `runMigrations(url)`.
4. It deletes leftover rate-limit counters from the test workers' Redis
   prefixes (`SCAN`, never `FLUSHDB`).

**Isolation.** `tests/helpers/setup-global.ts`, a `setupFiles` entry that runs
in every forked worker for every test file, calls `useWorkerDatabase()`. That
rewrites `process.env.DATABASE_URL` to the worker's own database, by
`VITEST_POOL_ID`, before any `src/` module reads it, and keeps the untouched
base URL under `TEST_DATABASE_BASE_URL` so a second call cannot suffix the name
twice. `maxWorkers` in `vitest.config.ts` is `WORKER_COUNT`, so each worker has
a database to itself and two workers cannot race a unique constraint on the
same row. The migrator lives in `globalSetup` and not in `setupFiles`, which
would run it again for every file. `.env.test` sets `DB_POOL_MAX=2`, so the
eight workers hold at most 16 connections.

`vitest.unit.config.ts`, which the git hooks use, sets no `globalSetup` and
excludes `tests/integration/**`, so it runs with Docker down.

## Batch deletes and claims

Every batch that deletes or claims rows with a limit selects the ids in a
locking subquery and compares with `= any(array(...))`:

```ts
const batch = tx
  .select({ id: model.id })
  .from(model)
  .where(...)
  .orderBy(stableKey)
  .limit(limit)
  .for('update', { skipLocked: true })
await tx.delete(model).where(sql`${model.id} = any(array(${batch}))`)
```

Each site orders by a stable key (the id, or the time column and then the id)
so batches take the oldest rows first.

The shape bounds the batch. With `id in (select ... limit n for update skip
locked)` the planner may choose a nested loop and rescan the subquery for every
outer row. Each rescan skips the rows the statement has already locked or
updated and takes the next ones, so the statement affects more than `n` rows.
The planner picks that plan when the table's statistics say it is nearly
empty. `= any(array(...))` evaluates the subquery once, into an array, whatever
the plan.

`FOR UPDATE SKIP LOCKED` makes a batch skip a row a request holds, so a batch
can come back short while matching rows remain; the next run takes them. The
retention loop stops on a short batch
([ARCHITECTURE.md](ARCHITECTURE.md#retention)).

The shape is used in the retention deletes of `user_tokens`,
`tenant_invitations`, `email_events`, `email_logs`, `email_messages`,
`notifications` (read and unread), `audit_logs` and `analytics_outbox`
(`deleteOlderThan`), and in the two claims, `AnalyticsOutboxRepository.claimBatch`
and `AnalyticsDeletionRepository.claimDue`. Write any new limited delete or
claim the same way. `tests/integration/repositories/retention-batch-bound.test.ts`
forces the nested-loop plan and asserts that each retention delete removes at
most its limit.
