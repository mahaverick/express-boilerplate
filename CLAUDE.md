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
  load-bearing: GitHub Actions `services:` cannot remap container ports, so
  CI necessarily runs against 5432/6379, and a runtime assertion was
  guaranteed red on the first pull request. The invariant worth guarding
  belongs to the committed files.
- **The Redis client's `reconnectStrategy` is load-bearing, not
  decoration.** node-redis's default strategy retries a failed connection
  forever and never rejects `connect()` — so without an explicit strategy,
  `isRedisReachable()` (and therefore `GET /health/ready`) would hang
  indefinitely instead of reporting unreachable, the moment Redis goes
  down. `redis.service.ts` gives it a bounded strategy — a 5-second
  connect timeout, giving up after a few retries with an `Error` —
  specifically so that path fails fast. A dedicated test file
  (`redis-unreachable.service.test.ts`) pins this down by timing out, not
  by a mismatched assertion, if the strategy is ever removed.
- **`drizzle.config.ts` uses `getDatabaseUrl()`, not `getEnv()`.** Routing
  it through `getEnv()` would make every `drizzle-kit` invocation require
  JWT/session secrets that have nothing to do with writing a migration. See
  DATABASE.md.

## Git hooks and CI

- **Pre-commit takes ~4.6s, and that is a deliberate trade, not a
  regression to fix.** About 70% of it is ESLint's type-aware cold start —
  building the TypeScript program to run `typescript-eslint`'s
  `recommendedTypeChecked` rules. It is not removable without dropping
  type-aware linting, which is what catches floating and misused promises
  — the dominant real-bug class in async Express code. `eslint --cache`
  does **not** help here: `lint-staged` only ever passes the files you
  changed, so the cache never has a hit to give.
- **Pre-commit deliberately excludes `tests/integration/**`.** Those need
  the Docker compose stack up, and `vitest --changed HEAD` fans out along
  the import graph — editing a widely-imported file (a service, a response
  utility) pulls integration tests in even when Docker is down, which
  measured at 20s+ hung on a health probe before failing the commit
  outright. A hook that fails whenever Docker happens to be down gets
  disabled with `--no-verify` permanently and never comes back — which
  protects nothing. `pre-push` runs the full suite via `test:coverage`,
  where Docker being up is a fair expectation.
- **Hooks call `pnpm exec`, never `npx`.** `npx eslint` on a machine
  without `node_modules` populated yet silently downloads the newest
  ESLint and lints against a version this repo never tested against its
  own config.
- **A no-op `pnpm install` (already up to date) skips root lifecycle
  scripts entirely**, including `prepare`. You cannot verify that
  `"prepare": "husky"` actually installs hooks by re-running `pnpm install`
  in a checkout that's already installed — it proves nothing either way.
  Test it from a fresh clone.

## Code conventions

- **No module outside `src/configs/env.config.ts` may read
  `process.env`.** An eslint rule (`no-restricted-properties`) enforces
  this; `env.config.ts` is the one file explicitly exempted, because
  parsing `process.env` is its entire job.
- **`src/lint-fixtures/` is not application code.** It is a
  deliberately-circular pair of modules importing each other through the
  `@/` alias, so `tests/unit/lint-gates.test.ts` can prove
  `import-x/no-cycle` actually fires on _aliased_ imports. It has to live
  under `src/` because `tsconfig.json` maps `@/*` to `./src/*` and nothing
  else. It is excluded from the build (`tsconfig.json`), from `pnpm lint`
  (`eslint.config.mjs` `ignores`) and from coverage (`vitest.config.ts`).
  Do not import it, and do not "fix" the cycle.
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
