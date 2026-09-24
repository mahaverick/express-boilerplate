# Migrations

Every major dependency bump taken during this repo's rebuild, the breaking
change it carried, and what changed here because of it — so the same
upgrade can be replayed elsewhere with the reasoning intact instead of
rediscovered. Also: every supply-chain bypass currently sitting in
`pnpm-workspace.yaml`, a generated file nobody reads by default.

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
Postgres pool (`max: 2` in test mode) at module scope in every forked
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

## Supply-chain bypasses in `pnpm-workspace.yaml`

pnpm writes these bypasses into a generated file that nobody opens by
default — recorded here so a silent supply-chain decision doesn't stay
invisible for a year. **Rule: every future addition to
`pnpm-workspace.yaml` gets a line here too, in the same change that adds
it.**

Current contents, verbatim:

```yaml
allowBuilds:
  # bcrypt's "install" script runs node-gyp-build: fetches a prebuilt native
  # binding for the host platform, or compiles one from source via node-gyp
  # if no prebuild matches. Required for bcrypt to work at all — it is a
  # native addon, not a pure-JS package — and it is the password-hashing
  # library this plan's Task 2 adds. See MIGRATIONS.md.
  bcrypt: true
  esbuild: true
  # msgpackr-extract: transitive dependency of bullmq (via msgpackr, which
  # BullMQ uses to encode job data for Redis). Same profile as bcrypt/
  # unrs-resolver above — its install script only fetches a prebuilt native
  # binding for the host platform, or falls back to msgpackr's pure-JS
  # encoder when none matches; no arbitrary script.
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
  `node-gyp-build`: fetches a prebuilt native binding for the host platform,
  or compiles one from source via `node-gyp` if no prebuild matches. Native
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
  `bullmq` (via `msgpackr`). Its install script only fetches a prebuilt
  native binding for the host platform, and `msgpackr` falls back to its
  pure-JS encoder when none matches.
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
