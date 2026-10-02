# Database

Drizzle ORM on Postgres, via the `postgres` (postgres-js) driver. This
document covers the client, the models and migrations directories, how
migrations are generated and applied (including on a database that already
holds data), and the test database.

## Client

[`src/services/database.service.ts`](src/services/database.service.ts)
creates exactly one client for the process and exports two names from it:

- `sql` — the raw `postgres` client, for untyped SQL.
- `db` — the Drizzle instance wrapping it (`drizzle(sql)`). Prefer this for
  everything else; it's what a repository imports.

Also exported: `isDatabaseReachable()` (used by `/health/ready`),
`closeDatabase()` (called during graceful shutdown; safe to call twice), and
`withTransaction()`. There is deliberately no second client anywhere —
`postgres` pools internally, so a second client means a second pool and a
second connection budget, which only shows up as "too many connections" under
load. The pool holds at most `DB_POOL_MAX` connections (default 10;
`.env.test` sets 2, because every vitest worker opens its own). Each
connection runs with `statement_timeout` = `DB_STATEMENT_TIMEOUT_MS` (default
30000). `0` sends none, leaving the server's own setting, and a
`statement_timeout` in `DATABASE_URL`'s query string overrides it.
`migrate.ts` and the test global setup open their own single-connection
clients and are not affected by either.

## Models directory

Tables are defined in `src/database/models/*.model.ts` files, a closely
related pair sometimes sharing one file; see `src/database/models/` for the
full set. The `*.model.ts` suffix is enforced
by `check-file` (see [ARCHITECTURE.md](ARCHITECTURE.md#directory-rules)). The
two tables authentication rests on:

- **`user.model.ts`** — the `users` table: `id` (a `uuidv7()` primary key —
  see "Postgres version" below), `email` (unique case-insensitively among
  rows that are not soft-deleted, via a partial `lower(email)` index, not a
  plain unique constraint), a nullable `password_hash` (null for a user who
  signs in only with Google), `first_name`/`last_name`, `active`,
  `email_verified_at`, `last_logged_in_at`, and the
  `deleted_at`/`created_at`/`updated_at` trio every soft-deletable table
  carries.
- **`user-token.model.ts`** — the `user_tokens` table: one row per issued or
  rotated-to token, for any of three purposes (`purpose`: `'refresh'`,
  `'email_verification'`, or `'password_reset'`, enforced at the database
  level by `user_tokens_purpose_check`, not only by TypeScript's
  `$type<TokenPurpose>()`) — one table rather than three, since all of them
  share the same hashing, lookup, expiry, and revocation machinery.
  `session_id`/`session_started_at` are nullable and meaningful only for
  `'refresh'`: `session_id` groups every token descended from one login into
  a rotation "family"; `session_started_at` records when that family began
  and is copied forward unchanged by every rotation, which is what makes
  `SESSION_ABSOLUTE_TTL` an absolute ceiling rather than another sliding
  window. `token_hash` stores a SHA-256 digest of the raw token, never the
  token itself; `consumed_at` is set only by `UserTokenRepository.claimOnce`,
  distinguishing a row spent through its normal single-use path from one
  killed by an explicit revoke; `replaced_by_id` self-references the row a
  token was rotated into — forensic metadata for tracing a chain after the
  fact, read by no application code. Its foreign key is `ON DELETE SET NULL`,
  so when the retention purge deletes a row's successor, the database nulls
  the pointer; a chain read back later may have gaps. See
  [SECURITY.md](SECURITY.md) for the security reasoning and
  [ARCHITECTURE.md](ARCHITECTURE.md) for how the repository layer sits on top
  of the models.

### `user_tokens` retention

Every rotation inserts a row and leaves the old one in place, revoked and
consumed. Rotation is append-only by design: reuse detection needs the old
row to recognise a replay. With a 15-minute `ACCESS_TOKEN_TTL`, a client that
stays logged in refreshes about 4 times an hour: roughly **96 rows per active
user per day, ~2,900 per month**, plus one per login.

The daily retention purge (`src/services/retention.service.ts`) bounds that.
A row is deleted once `RETENTION_TOKENS_DAYS` (default 7) days have passed
since its `expires_at`, or since a revoke that never consumed it (logout,
reuse, a password change): `expires_at < cutoff OR (revoked_at < cutoff AND
consumed_at IS NULL)`. A rotated-away row carries `consumed_at`, so it is kept
until it expires: until then, a client could present it, and reuse detection
must still recognise it. A whole rotation chain goes in one run:
`replaced_by_id` is `ON DELETE SET NULL`, so a kept row that pointed at a
purged one has that pointer nulled. Deletes run in batches of 5,000, each its
own transaction. `RETENTION_TOKENS_DAYS=0` turns the rule off. Migration
`0017` adds the indexes the predicate uses. `user_tokens.deleted_at` is not
used by the purge, which deletes soft-deleted rows by the same rule.

`drizzle.config.ts`'s schema glob (`./src/database/models/*.model.ts`) picks
up a new model automatically — no config change needed to add one.

## Migrations directory

`src/database/migrations/` is **tracked**: one SQL file per migration, and
`meta/_journal.json` records every migration in order. Everything under this
directory is **generated** by `drizzle-kit generate`, except the hand-added
statements in five migrations, each called out by a comment in its file:

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
  (reusing the attempt's id, recipient, template, status and `created_at`)
  and points each attempt at it, and moves the `audit_logs` target-type
  CHECK swap after that backfill.

Don't hand-edit a migration otherwise, except as "Schema migrations on a live
database" below describes, and only before that database has applied it.

Generated does not mean disposable. Migrations are the ordered, immutable
record of how the schema reached its current state — `pnpm db:migrate`
replays them in journal order against a database that may be several
migrations behind, and CI and the production image cannot regenerate them
(`generate` diffs against the models, not against a live database). **They
must be committed.** Don't add this directory to `.gitignore`.

`.prettierignore` excludes this directory: Prettier and `drizzle-kit` would
otherwise each rewrite `meta/_journal.json` and the generated SQL into their
own layout on every run.

## `drizzle.config.ts` and why it only needs `DATABASE_URL`

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

It calls `getDatabaseUrl()`, not `getEnv()`. `getEnv()` validates the
_entire_ environment schema — JWT secrets, session secret, all of it —
because every one of those is required for the app to boot. Generating or
checking a migration has nothing to do with any of that, so routing it
through `getEnv()` would be a false dependency: every `drizzle-kit`
invocation, including in CI, would need application secrets that are
irrelevant to writing SQL. `getDatabaseUrl()` re-slices the same schema
(`EnvSchema.pick({ DATABASE_URL: true })`), so the validation rule for
`DATABASE_URL` itself stays single-sourced between the two entry points.
`drizzle-kit check` runs with **only** `DATABASE_URL` set.

## Commands

All three read `DATABASE_URL` from `process.env`. With a `.env` in place (see
the README Quickstart), `env.config.ts` loads it automatically, so the inline
`DATABASE_URL=...` prefix below is only needed if you don't have one.

**Generate a migration** from the model files, via `pnpm
db:migration:generate` (`drizzle-kit generate`):

```bash
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm db:migration:generate
```

It writes the new SQL migration under `src/database/migrations/` and updates
`meta/_journal.json`, or prints `No schema changes, nothing to migrate` when
the models already match. It does not touch the database; that is the next
command's job.

**Apply pending migrations**, via `pnpm db:migrate` (`src/database/migrate.ts`,
run with `tsx`):

```bash
pnpm db:migrate
```

`migrate.ts` opens its own short-lived connection from `getDatabaseUrl()`
(the same `DATABASE_URL`-only slice `drizzle.config.ts` uses), not
`database.service.ts`'s long-lived pool, and closes it when done. Drizzle's
migrator applies every pending migration inside **one** transaction, so a
batch either lands whole or not at all — and every lock a migration takes is
held until the whole batch commits (see "Schema migrations on a live
database" below). Against a database that is already up to date it exits 0
and prints nothing (`migrate.ts` silences Postgres's "already exists,
skipping" notices).
`pnpm db:migrate:prod` runs the same logic against the built output
(`node dist/database/migrate.js`); `pnpm build` copies the migrations into
`dist/`, and the production image, which has no `drizzle-kit`, migrates this
way. `.github/workflows/ci.yml` runs `pnpm db:migrate` before the test suite,
so CI never tests against a schema its own migrations haven't produced.

**Check migration/schema consistency** (useful in CI, before `generate`):

```bash
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm exec drizzle-kit check
```

## Schema migrations on a live database

`pnpm db:migrate` applies every pending migration in one transaction, so a
lock any statement takes is held until the whole batch commits. On an empty
or small database that is brief. On one that already holds a lot of data,
some migrations below block reads or writes for as long as their index builds
take; for those, build the indexes by hand first with
`CREATE INDEX CONCURRENTLY`. **Run each `CONCURRENTLY` statement on its own,
outside any transaction** — Postgres refuses `CONCURRENTLY` inside one, and
`psql` running a file with `-1`/`--single-transaction` wraps it in one. A
failed `CONCURRENTLY` build leaves an INVALID index that `IF NOT EXISTS`
would then skip: check `pg_index.indisvalid` for it, and if it is false, drop
it (`DROP INDEX CONCURRENTLY`) and build it again. Once the indexes exist, edit
the not-yet-applied migration file as described so it does not build them a
second time under the lock, then run `pnpm db:migrate`.

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
  A tenants table is usually small enough that this is brief. On a large one,
  run each of these on its own, outside any transaction:

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
  retention purge, a user purge and stats on `email_logs` all wait for the
  whole backfill (the copy into `email_messages`, the update, the foreign
  key's validation and the index build). The CHECK swap at the end takes the
  same lock on `audit_logs` and validates every audit row. Apply it in a
  quiet window. `email_logs` is bounded by `RETENTION_EMAIL_LOGS_DAYS`, so
  letting retention prune first shortens the backfill.

- **`0021` holds `tenants` briefly.** Its four `ADD COLUMN`s are
  metadata-only (the one default is a constant, so no row is rewritten),
  but each takes an `ACCESS EXCLUSIVE` lock on `tenants` for the rest of the
  migration's transaction, which also validates the new
  `onboarding_dismissed_by` foreign key and the `tenants_platform_untracked`
  CHECK by scanning `tenants` once. `onboarding_completions` is new and
  empty, so its indexes build instantly. Every request that resolves a
  tenant waits for that scan; on a large `tenants` table apply it in a quiet
  window.

## Test database

`docker/postgres/init.sql` runs once, automatically, the first time the
`postgres` container starts against an empty volume
(`docker-entrypoint-initdb.d` convention — it never re-runs against an
existing volume). It creates a second role and database:

```sql
CREATE ROLE test LOGIN PASSWORD 'test' CREATEDB;
CREATE DATABASE boilerplate_test OWNER test;
```

`.env.test`'s `DATABASE_URL` points at `boilerplate_test` — dev data (the
`boilerplate` database, owned by the `boilerplate` role from
`docker-compose.yml`) and test data never share a database. The test global
setup derives one database per vitest worker from that URL
(`boilerplate_test_w1`, `_w2`, …; `tests/helpers/worker-database.ts`),
creates and migrates them, which is what the role's `CREATEDB` is for. If the
test role or database is ever missing (e.g. after `docker compose down -v`),
it comes back the next time `docker compose up -d` creates a fresh volume.

## Postgres version

Pinned to major version **18** in `docker-compose.yml`. Migrations use
`uuidv7()` as a column default, which is built into Postgres from 18 onward;
on 17 or older, a migration referencing it aborts with `function uuidv7()
does not exist` unless an extension is installed. Don't downgrade the image
tag without checking this.

## Coverage

`vitest.config.ts`'s coverage `exclude` list carries `**/migrations/**` and
`**/seeders/**`. Generated SQL, and seed data if a project adds a `seeders/`
directory, are not unit-testable source and would otherwise sit in the
coverage report as permanently uncovered lines, dragging the gate down.
