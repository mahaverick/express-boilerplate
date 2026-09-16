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

## Logging

- **`logger` from `@/services/logger.service`, not `console.*`.** An ESLint
  `no-restricted-properties` rule enforces this for `src/`. Two files are
  exempt: `logger.service.ts` (talks to Winston's console transport and uses
  `console.error` in the Slack transport's failure path to avoid re-entry) and
  `index.ts` (pre-boot error path where the logger is not available).
- **Request-id correlation is automatic.** The `requestContext` middleware
  wraps each request in an `AsyncLocalStorage` context. The logger reads from
  it on every call — callers never pass the id. Code outside a request (startup,
  Redis error handler) simply omits the field.
- **Caller file:line is automatic.** The logger parses `new Error().stack` on
  each call. The `[moduleName]` prefixes that some call sites used to include
  in their messages are redundant — the `source` field handles it.
- **Slack transport deduplicates by `${source}:${message}`.** The first
  occurrence sends immediately; duplicates within a 60-second window are
  suppressed. A summary is sent after the window expires if any were suppressed.

## Job queue

- **`addEmailJob()` from `@/jobs/email.job`, not `sendMail()` directly.**
  Email sending goes through a BullMQ queue. The existing helpers
  (`sendVerificationMail`, `sendRegistrationAttemptMail`,
  `resendVerificationMail`) enqueue internally — controllers call the
  same helpers with the same `.catch()` pattern they always did.
- **`WORKER_ENABLED` gates the in-process worker.** Default `true` (API +
  worker in one process). Set `false` for API-only pods; a separate worker
  deployment sets `true` and processes jobs from the shared Redis queue.
- **`QUEUE_PREFIX` isolates test queues.** Each vitest worker gets
  `bull:test-w${VITEST_POOL_ID}` — same mechanism as per-worker databases.
  Without it, a Worker in pool 1 processes pool 2's jobs.
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
  ordering `gracefulShutdown` uses.

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
  where Docker being up is a fair expectation. **The exclusion is by path
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

## Testing

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
    the private instance `token.utilities.ts` builds at module scope) — no
    module reloading involved.
  - `withMutatedModule(dependencyPath, overrides, loadSubject, run)` —
    only when the export has no shared mutable object to reach, e.g. a
    plain function captured BY VALUE at another module's load time
    (`loginRateLimitKey`, passed as `keyGenerator: loginRateLimitKey` inside
    `rate-limit.middleware.ts`'s factory). Uses `vi.doMock` +
    `vi.resetModules()`, then a fresh `import()` of the subject so its own
    imports resolve to the mutated dependency. `loadSubject` must be a
    thunk whose body is a literal `import('...')` written at the call site
    — never a path built from a variable — so the bundler can resolve this
    repo's `@/` alias and infer the subject's type without a cast. This
    variant is not free: `vi.resetModules()` discards the WHOLE worker
    module cache, so every module between the subject and the mutated
    dependency re-evaluates, including ones with real side effects —
    `database.service.ts` opens a fresh postgres pool every time it is
    re-evaluated, and nothing closes the previous one. A handful of calls
    proving one mutation is fine; don't call it in a loop.
- **Getting red/green evidence needs zero file edits.** Commit the
  demonstration once, gated behind an environment variable
  (`it.runIf(process.env.MUTATION_PROOF === '1')(...)`), reproducing the
  real test's own assertions against the mutated dependency. Running it
  twice — once with the variable set, once without — produces a red
  transcript and a green transcript with nothing changed on disk between
  them; see `tests/integration/utilities/token-reuse-mutation.test.ts` for
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
the secret, a logging library that does not exist here (there is no pino; the
convention is `console.error` plus `error.middleware.ts`'s `redactedForLog`), a
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
  (`src/utilities/token.utilities.ts`) rather than throwing on rejection.
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
