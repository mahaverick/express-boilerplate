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

`src/database/models/` **does not exist yet.** This plan wires the
database client and the migration tooling; it does not port any schema.
When a later plan adds tables, each one is a `src/database/models/*.model.ts`
file (the `*.model.ts` suffix is enforced by `check-file` — see
[STRUCTURE.md](STRUCTURE.md)), and `drizzle.config.ts`'s schema glob
(`./src/database/models/*.model.ts`) picks it up automatically — no config
change needed to add a model.

## Migrations directory

`src/database/migrations/` is **tracked**, and holds one file today:
`meta/_journal.json` (`{"version":"7","dialect":"postgresql","entries":[]}`)
— an empty journal, committed so the directory exists on a fresh clone.
Everything under this directory is **generated** by `drizzle-kit generate`;
nothing here is hand-written, and nothing here should be hand-edited.

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

**Generate a migration** from the model files:

```bash
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm exec drizzle-kit generate
```

Run today, before any model file exists, this fails — honestly reproduced:

```
Error  No schema files found for path config ['./src/database/models/*.model.ts']
```

That is expected until a later plan adds the first `*.model.ts` file. Once
one exists, this command writes the SQL migration under
`src/database/migrations/` and updates `meta/_journal.json`.

**Apply pending migrations**:

```bash
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm exec drizzle-kit migrate
```

Verified against the current (empty) migration set:

```
[✓] migrations applied successfully!
```

**Check migration/schema consistency** (useful in CI, before `generate`):

```bash
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate pnpm exec drizzle-kit check
```

There is no `pnpm db:migrate` package.json script and no
`src/database/migrate.ts` runner yet — run `drizzle-kit migrate` directly as
shown above. The Dockerfile's build-stage comment ("Migrations run via
`dist/database/migrate.js`") describes the intended shape of a later plan,
not a file that exists today; treat it as a forward reference, not a
working command.

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
