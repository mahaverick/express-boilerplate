# Database

Drizzle ORM on Postgres, via the `postgres` (postgres-js) driver. This
document covers the models directory, how migrations are generated and
applied, and the connection this repo actually has running — commands
below were run against it.

## Client

[`src/services/database.service.ts`](src/services/database.service.ts)
creates exactly one client for the process and exports two names from it:

- `sql` — the raw `postgres` client, for untyped SQL.
- `db` — the Drizzle instance wrapping it (`drizzle(sql)`). Prefer this for
  everything else; it's what a repository imports.

Also exported: `isDatabaseReachable()` (used by `/health/ready`) and
`closeDatabase()` (called during graceful shutdown; safe to call twice).
There is deliberately no second client anywhere — `postgres` pools
internally, so a second client means a second pool and a second connection
budget, which only shows up as "too many connections" under load.

## Models directory

`src/database/models/` holds two tables today, each a
`src/database/models/*.model.ts` file (the `*.model.ts` suffix is enforced
by `check-file` — see [STRUCTURE.md](STRUCTURE.md)):

- **`user.model.ts`** — the `users` table: `id` (a `uuidv7()` primary key —
  see "Postgres version" below), `email` (case-insensitively unique via a
  `lower(email)` index, not a plain unique constraint), a nullable
  `password_hash` (nullable because a federated-identity user, plan B4, has
  no password), `first_name`/`last_name`, `active`, `email_verified_at`,
  `last_logged_in_at`, and the `deleted_at`/`created_at`/`updated_at` trio
  every soft-deletable table carries.
- **`user-token.model.ts`** — the `user_tokens` table: one row per issued or
  rotated-to token, for any of three purposes (`purpose`: `'refresh'`,
  `'email_verification'`, or `'password_reset'`, enforced at the database
  level by `user_tokens_purpose_check`, not only by TypeScript's
  `$type<TokenPurpose>()`) — one table rather than three, since all of them
  share the same hashing, lookup, expiry, and revocation machinery.
  `session_id`/`session_started_at` are nullable and
  meaningful only for `'refresh'`: `session_id` groups every token descended
  from one login into a rotation "family"; `session_started_at` records when
  that family began and is copied forward unchanged by every rotation, which
  is what makes `SESSION_ABSOLUTE_TTL` an absolute ceiling rather than
  another sliding window. `token_hash` stores a SHA-256 digest of the raw
  token, never the token itself; `consumed_at` is set only by
  `UserTokenRepository.claimOnce`, distinguishing a row spent through its
  normal single-use path from one killed by an explicit revoke;
  `replaced_by_id` self-references the row a token was rotated into —
  forensic metadata for tracing a chain after the fact, read by nothing at
  runtime. See [SECURITY.md](SECURITY.md) for the security reasoning and
  [ARCHITECTURE.md](ARCHITECTURE.md) for how the repository layer sits on
  top of both models.

### `user_tokens` grows without bound, and nothing prunes it

**No plan currently owns a retention job for this table.** Stating that
plainly rather than leaving it implied, because the growth is not slow and
the table has no ceiling of its own:

Every rotation INSERTs a row and leaves the old one in place with
`revoked_at` set — rotation is append-only by design, since reuse detection
needs the revoked row to still be there to recognise a replay. With a
15-minute `ACCESS_TOKEN_TTL`, a client that stays logged in refreshes about
4 times an hour: roughly **96 rows per active user per day, ~2,900 per
month**, plus one per login. A modest 10,000-user deployment writes tens of
millions of rows a year, all of them dead within `REFRESH_TOKEN_TTL` and
none of them ever deleted. `SESSION_ABSOLUTE_TTL` bounds how long a session
lives, not how many rows it leaves behind.

What a retention job would do: delete rows that are both revoked and past
`REFRESH_TOKEN_TTL` (they can never be presented again, so reuse detection
has no use for them), on a schedule. `user_tokens.deleted_at` exists as the
seam for a soft-delete variant of that. It is deliberately **not built
here** — a scheduled job needs a scheduler, and this boilerplate has none:
BullMQ is listed in [MIGRATIONS.md](MIGRATIONS.md) as a dependency not yet
adopted. The natural home is whichever plan adopts a queue or scheduler
first; until one does, a downstream project running this at scale should
treat it as its own operational task (a cron'd `DELETE`, or a partitioned
table) rather than assume the boilerplate handles it.

`drizzle.config.ts`'s schema glob (`./src/database/models/*.model.ts`)
picks up a new model automatically — no config change needed to add one.

## Migrations directory

`src/database/migrations/` is **tracked**, and holds six generated
migrations today: `0000_tearful_crusher_hogan.sql` (creates `users`),
`0001_great_dragon_man.sql` (creates `user_tokens`, with its foreign keys
to `users` and to itself for `replaced_by_id`),
`0002_abandoned_tarantula.sql` (adds `user_tokens.session_started_at`),
`0003_regular_lockjaw.sql` (adds `user_tokens.purpose` and `.consumed_at`,
backfilling every existing row's `purpose` to `'refresh'` in the same
statement that adds the `NOT NULL` constraint, and makes `session_id`/
`session_started_at` nullable — see this file's own model description
above), `0004_organic_mauler.sql` (drops the `DEFAULT 'refresh'` migration
0003 gave `purpose` — that default was transient, needed only for 0003's
own backfill; dropping it is what makes omitting `purpose` a compile error
rather than a silent `'refresh'` assignment, see `user-token.model.ts`'s
comment on that column), and `0005_bitter_blob.sql` (widens `purpose` to
`varchar(32)` and adds `user_tokens_purpose_check`, a CHECK constraint
restricting it to the three `TokenPurpose` values at the database level —
`$type<TokenPurpose>()` is compile-time only, so this is what stops a raw
SQL insert from writing anything else), plus `meta/_journal.json` recording
all six in order. Everything under this directory is **generated**
by `drizzle-kit generate`; nothing here is hand-written, and nothing here
should be hand-edited.

Generated does not mean disposable. Migrations are the ordered, immutable
record of how the schema got to its current state — `drizzle-kit migrate`
replays them in journal order against a database that may be several
versions behind, and CI and the production image have no way to regenerate
them (they have no developer, and `generate` diffs against the models, not
against a live database). **They must be committed.** An earlier revision of
this repository carried `src/database/migrations/*` in `.gitignore`, so
`drizzle-kit generate` wrote SQL that git silently refused to track and the
directory did not exist on a fresh clone at all. That line is gone; do not
reintroduce it.

`.prettierignore` excludes this directory: Prettier and `drizzle-kit` would
otherwise each rewrite `meta/_journal.json` into their own layout on every
run.

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
`DATABASE_URL` itself stays single-sourced between the two entry points —
there is exactly one place that decides what a valid `DATABASE_URL` looks
like.

Verified directly against this repo, with **only** `DATABASE_URL` set (no
`JWT_*`, no `SESSION_SECRET`, no `APP_URL`/`WEB_URL`):

```
$ DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm exec drizzle-kit check
Everything's fine 🐶🔥
```

## Commands

All three read `DATABASE_URL` from `process.env`. With a `.env` in place
(see the README Quickstart), `env.config.ts` loads it automatically, so the
inline `DATABASE_URL=...` prefix below is only needed if you don't have one
— drop it once `.env` exists.

**Generate a migration** from the model files, via `pnpm
db:migration:generate` (`drizzle-kit generate`):

```bash
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm db:migration:generate
```

Verified against this repo's current, up-to-date model set (both models
already have a matching migration, so there is nothing new to write):

```
2 tables
user_tokens 11 columns 3 indexes 2 fks
users 11 columns 1 indexes 0 fks

No schema changes, nothing to migrate 😴
```

Changing a model file and rerunning this command writes the new SQL
migration under `src/database/migrations/` and updates `meta/_journal.json`
— it does not touch the database itself; that is the next command's job.

**Apply pending migrations**, via `pnpm db:migrate`
(`src/database/migrate.ts`, run directly with `tsx`):

```bash
pnpm db:migrate
```

`migrate.ts` opens its own short-lived connection from `getDatabaseUrl()`
(the same `DATABASE_URL`-only slice `drizzle.config.ts` uses — see below),
not `database.service.ts`'s long-lived pool, and closes it when done. Run
against a database that is already at the latest migration (the common
case in local development), Postgres itself reports there is nothing new to
apply — verified directly against this repo's dev database:

```
$ pnpm db:migrate

> express-boilerplate@0.1.0 db:migrate
> tsx src/database/migrate.ts

{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "drizzle" already exists, skipping',
  file: 'schemacmds.c',
  line: '132',
  routine: 'CreateSchemaCommand'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "__drizzle_migrations" already exists, skipping',
  file: 'parse_utilcmd.c',
  line: '208',
  routine: 'transformCreateStmt'
}
```

Those two `NOTICE`s (not errors — the command exits 0) are Postgres
reporting that drizzle's own bookkeeping schema/table already exist from a
prior run; a genuinely first-ever run against an empty database prints
neither and exits 0 silently. `pnpm db:migrate:prod` runs the identical
logic against the built output (`node dist/database/migrate.js`) — this is
exactly what `Dockerfile`'s build-stage comment refers to, and what
`.github/workflows/ci.yml`'s "Run migrations" step runs (as `pnpm
db:migrate`) before the test suite, so CI never tests against a schema its
own migrations haven't produced.

**Check migration/schema consistency** (useful in CI, before `generate`):

```bash
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm exec drizzle-kit check
```

Verified against this repo:

```
Everything's fine 🐶🔥
```

## Test database

`docker/postgres/init.sql` runs once, automatically, the first time the
`postgres` container starts against an empty volume
(`docker-entrypoint-initdb.d` convention — it never re-runs against an
existing volume). It creates a second role and database:

```sql
CREATE ROLE test LOGIN PASSWORD 'test';
CREATE DATABASE boilerplate_test OWNER test;
```

`.env.test`'s `DATABASE_URL` points at `boilerplate_test` — dev data (the
`boilerplate` database, owned by the `boilerplate` role from
`docker-compose.yml`) and test data never share a database. If the test
role/database is ever missing (e.g. after `docker compose down -v`), it
comes back the next time `docker compose up -d` creates a fresh volume.

## Postgres version

Pinned to major version **18** in `docker-compose.yml`. Migrations may use
`uuidv7()` as a column default, which is built into Postgres from 18
onward; on 17 or older, a migration referencing it aborts with `function
uuidv7() does not exist` unless an extension is installed. Don't downgrade
the image tag without checking this.

## Coverage

`vitest.config.ts`'s coverage `exclude` list carries `**/migrations/**` and
`**/seeders/**` — generated SQL and (eventually) seed data are not unit-testable
source and would otherwise sit in the coverage report as permanently
uncovered lines, dragging the gate down for a directory nothing should ever
write tests against.
