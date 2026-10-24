# Contributing

## Setup

Follow the [README](README.md) quick start first. Running tests locally needs
the compose stack up: `tests/integration/**` needs Postgres and Redis. The suite
loads `.env.test.local` and then `.env.test`, never `.env`. To run against an
isolated Mailpit, set `MAILPIT_URL` (its HTTP API, default
`http://localhost:8025`) and `SMTP_PORT` there or in the shell. `tests/unit/**`
needs neither, but only under `pnpm test:unit`; `pnpm test`'s globalSetup
provisions the test databases before any test runs, so it needs the stack even
for unit tests ([DATABASE.md](DATABASE.md#the-test-database)).

## Before you open a PR

Run what CI runs:

```bash
pnpm lint            # vp check (Oxlint + Oxfmt), the untyped ESLint, tsc --noEmit
pnpm lint:docs       # history phrasing, broken links and anchors in the docs
pnpm knip            # unused files, exports, types and dependencies
pnpm test:coverage   # vitest, gated at 80% lines/functions/branches/statements
pnpm build           # tsc + tsc-alias against tsconfig.build.json
```

All five must exit 0, or run `pnpm gate`, which runs them all. `pnpm lint`
fails on unformatted files; `pnpm format` fixes them.
Oxlint runs every lint rule it can; ESLint runs only the rules Oxlint can't
yet, listed with their reasons in [docs/lint-deferred.md](docs/lint-deferred.md).
`pnpm lint` type-checks once, against `tsconfig.json`, which extends
`tsconfig.build.json` and widens its `include` to `tests/` and
`drizzle.config.ts`; `pnpm typecheck` runs that step alone.
The two configs stay separate: see [CLAUDE.md](CLAUDE.md#code-conventions),
which also holds the code conventions.

## Tooling

[Vite+](https://viteplus.dev) (`vite-plus`, pinned exactly in `package.json`)
runs the toolchain through `vp`; the `pnpm` scripts wrap it.

- **Lint:** Oxlint (type-aware, through `oxlint-tsgolint`) with its rules in
  `vite.config.ts`. The leftover ESLint in `eslint.config.mjs` runs only what
  Oxlint can't yet ([docs/lint-deferred.md](docs/lint-deferred.md)). `tsc
  --noEmit` stays the type checker.
- **Format:** Oxfmt (`pnpm format`, `pnpm format:check`). In VS Code, install
  the Oxc extension (`oxc.oxc-vscode`); the devcontainer does.
- **Tests:** `vp test` runs Vitest with the `unit` and `integration` projects.
- **Hooks and push:** see [Git hooks](#git-hooks-vite). `pnpm gate` runs the
  full local gate; `pnpm push` runs it, then pushes.
- **Existing clone:** run `git config --unset core.hooksPath && pnpm prepare`
  once ([Existing clones](#existing-clones)).

## Git hooks (Vite+)

Hooks live in `.vite-hooks/` and install with `pnpm install` (the `prepare`
script runs `vp config`). Commit normally; do not reach for `--no-verify` on a
routine commit.

- **`pre-commit`** checks that the lockfile is not stale, runs `vp staged`
  (the `staged` block in `vite.config.ts`: `vp check --fix` and `eslint --fix`
  on staged `src/` and `tests/` TypeScript, `vp fmt` on staged JSON, JSONC and
  Markdown), runs `vp test run --changed HEAD` on the `unit` project, and
  regenerates and stages `.env.example` when `env.config.ts` is staged. The
  `unit` project excludes `tests/integration/**` and skips the database setup,
  so this hook runs with Docker down. Oxlint runs type-aware here
  (it catches floating and misused promises); ESLint runs untyped. Keep both in
  the hook.
- **`commit-msg`** runs `commitlint` ([Commits](#commits)). `pnpm commit` opens
  an interactive prompt.
- **`pre-push`** runs `pnpm gate` (`scripts/pre-push-gate.sh`), which mirrors
  CI's `lint` and `test` jobs minus the audits: `pnpm lint`, `pnpm lint:docs`,
  `pnpm knip`, the domain-terms check, `pnpm test:coverage` (unit and
  integration), `pnpm build`, and a check that `.env.example` is current. It
  needs the compose stack (`docker compose up -d postgres redis mailpit`) and
  checks it first, so a stopped stack fails in about 2 s.

**Push with `pnpm push`.** It takes `git push`'s arguments
(`pnpm push origin HEAD`), runs the gate, and pushes only when the gate
passes, with `--no-verify` so the gate does not run twice. A long pre-push
hook can outlast the SSH connection and drop the push, and `git push` then
reports a misleading exit code; `pnpm push` opens the connection only after
the gate.

### Existing clones

A clone made while the hooks were husky's keeps `core.hooksPath=.husky/_`.
`vp config` leaves a set `core.hooksPath` alone, so no hook runs, and
`pnpm install` prints a warning. Fix it once:

```bash
git config --unset core.hooksPath && pnpm prepare
```

`pnpm install` alone skips `prepare` when the dependencies are up to date.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`type(scope): subject`), enforced by `@commitlint/config-conventional` in the
`commit-msg` hook. `commitlint.config.js` turns the body line-length rule off,
so a long `BREAKING CHANGE:` footer passes. Common types: `feat`, `fix`,
`docs`, `chore`, `refactor`, `test`, `ci`.

**The squash title is the commit.** Every PR merges by squash with the PR title
as the commit subject, and release-please reads that commit to decide the next
version. The `pr-title` workflow runs commitlint over the title, so a PR title
must be a conventional commit too.

**A breaking change puts its migration text in the PR body, inside a commit
override block.** The repository's squash-merge setting (a GitHub setting to
confirm, not something in the repo files) commits the PR title and drops the PR
description, so a `BREAKING CHANGE:` footer written in the description never
reaches the commit, and the release notes carry the `!` but no migration text.
release-please reads the merged PR's body, not only the commit, and uses the
text between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE` in place of the
squash commit's message. Nothing in this repository parses the block: it is a
release-please behaviour, reached through `release.yml` and
`release-please-config.json`. Write the full conventional message inside it:

```text
BEGIN_COMMIT_OVERRIDE
feat!: rename OLD_NAME to NEW_NAME

BREAKING CHANGE: set NEW_NAME to the value of OLD_NAME; the old name is
ignored.
END_COMMIT_OVERRIDE
```

Keep the `!` in the PR title as well, so the major bump does not depend on the
block. The release PR queues itself for auto-merge once the squash lands
([Releases](#releases)), so check its notes for the migration text right after
the merge.

## Adding, renaming or removing an environment variable

These move together, or a gate below catches the one you missed:

1. Add the field to `EnvSchema` in `src/configs/env.config.ts`, with a
   `.describe()`. That text becomes the variable's `.env.example` comment and
   its row in ARCHITECTURE.md's environment table. When its default depends
   on `APP_ENV`, make the field optional and add a derivation helper beside
   `isCookieSecure`/`logFormat` in the same file; never repeat the rule at a
   call site.
2. Regenerate `.env.example` with `pnpm env:example`. The pre-commit hook does
   this when `env.config.ts` is staged, and CI fails if the committed file
   differs from what the schema generates. Never edit it by hand.
3. Regenerate the environment table in
   [ARCHITECTURE.md](ARCHITECTURE.md#environment-variables) from the schema,
   never by hand. `pnpm --silent env:table` prints it (`renderEnvTable()` in
   `src/scripts/generate-env-example.ts`). Paste its output over the table,
   then run `pnpm exec vp fmt ARCHITECTURE.md`.
   `tests/unit/architecture-env-table.test.ts` compares the committed table
   with that output row for row, ignoring column padding.
4. If the tests need a value, add it to `.env.test`.
5. Mirror `.env.test` in `ci.yml`, in the `env:` block of the step named
   `Test with coverage gate`. CI compares keys and values in both directions;
   the only difference allowed is the port in `DATABASE_URL` and `REDIS_URL`,
   because CI's services publish the container-default ports.
6. Renaming or removing a variable is a breaking change: the schema ignores a
   name it does not declare, so an environment that still sets the old name
   boots without it. Mark the PR `feat!:` and name the old and new variables in
   the override block's `BREAKING CHANGE:` footer ([Commits](#commits)).

## CI

`ci.yml` runs on every pull request, on `workflow_dispatch`, and as the gate
`deploy.yml` calls before it builds an image. It has four kinds of job: `lint`, four `test-shard` jobs, `test` and `docker`. The ruleset
that makes them required, and what runs after they pass on `main`, are in
[ARCHITECTURE.md](ARCHITECTURE.md#deploying).

**`lint`** needs no services:

- `pnpm lint` (`vp check`: Oxlint and Oxfmt over the whole repo minus the
  ignore patterns, then the untyped ESLint and `tsc --noEmit`), `pnpm lint:docs` (no history phrasing in the Markdown or
  in `#` comments of config files, no broken relative link or anchor, no code
  citing an upper-case `.md` file the repo root lacks) and `pnpm knip` (answer a
  finding as [CLAUDE.md](CLAUDE.md#unused-code-knip) describes).
- A domain-leak grep over every tracked file (`git ls-files`, minus
  `.github/domain-terms.txt` itself) for the terms in
  [`.github/domain-terms.txt`](.github/domain-terms.txt). The shipped list is a
  template of obviously fake placeholders. **If you adopt this boilerplate,**
  replace them with the names, abbreviations and internal identifiers your
  project must never leak, or delete the file and the "Reject domain leakage"
  step in `.github/workflows/ci.yml`: a gate that checks nothing trains
  reviewers to ignore it. The gate reads the index, so stage a file before you
  rely on a local run. **The terms file stays pattern-only, with no `#` comments
  and no blank lines.** `grep -f` treats every line as a pattern: a `#` line is
  a pattern, not a comment; an unbalanced `(` makes grep exit with an error that
  the gate's `|| true` turns into a silent pass; and a blank line matches
  everything. The step refuses to run on a blank line. Explain a term in this
  document or a commit message instead.

**`test-shard`** runs four times in parallel, each with its own Postgres 18,
Redis and Mailpit services:

- `pnpm db:migrate` against the service database.
- One quarter of the suite (`vp test run --coverage --shard=n/4`), with the
  coverage thresholds off. Each shard uploads its result as a `blob-n` artifact.
  Open the failed shard's log for test output.

**`test`** needs all four shards. It fails if any shard failed or was cancelled.
It runs no tests itself:

- It downloads the four blobs, fails if one is missing, then merges them
  (`vp test --merge-reports --coverage`) and enforces the 80% gate on lines,
  functions, branches and statements over the whole suite.
- A step that compares the `Test with coverage gate` step's `env:` block in
  `test-shard` with `.env.test` in both directions (step 5 above).
- `pnpm build`.
- `pnpm audit --prod --audit-level moderate`, which fails on a moderate, high
  or critical advisory in production dependencies.
- `pnpm audit --audit-level critical` over every dependency, dev tooling
  included, as a non-blocking step (`continue-on-error`): a critical advisory
  in tooling shows on the run without failing it.
- A check that `.env.example` matches what `pnpm env:example` generates (step 2
  above).

**`docker`** builds the production image without pushing it and runs it; what
it checks is in [ARCHITECTURE.md](ARCHITECTURE.md#deploying).

Two more workflows run beside it:

- `gitleaks` scans for secrets on every PR and every push to `main`. The
  optional local hook (`pre-commit install`, from `.pre-commit-config.yaml`) is
  defence in depth, not the enforcement layer.
- `pr-title` lints the PR title ([Commits](#commits)).

## Secrets

Never commit a real secret, even a test one that resembles a production value.
`.env`, `.env.local` and every `.env.*.local` are git-ignored.
`.env.test` is committed on purpose: every value in it is a fixture, and it is
its own example, so do not add a copy beside it.

## Releases

Releases are automatic. On every push to `main`, `release.yml` runs
release-please (`release-please-config.json` and
`.release-please-manifest.json`; the `node` release type, tags without a
component), which opens or updates a release pull request from the conventional
commits since the last release. The workflow then queues that PR with
`gh pr merge --auto --squash`, falling back to a direct squash merge when
`--auto` is refused, so it merges once the required checks pass. The next run
tags `vX.Y.Z` and publishes the GitHub Release, and the tag push makes
`deploy.yml` add `:X.Y.Z`, `:X.Y` and `:X` to the image digest `main` already
built and tested; a release rebuilds nothing. Only `feat`, `fix` and breaking
commits cut a release:

- `feat` commits become a minor version bump.
- `fix` commits become a patch version bump.
- `feat!` or `BREAKING CHANGE:` commits become a major version bump.

`release.yml` uses a GitHub App token (variable `RELEASE_APP_CLIENT_ID`, secret
`RELEASE_APP_PRIVATE_KEY`; Contents and Pull requests read/write), because
events `GITHUB_TOKEN` creates start no workflow: its PR would get no CI and its
tag no promotion.

Every PR merges by squash with the PR title as the commit subject; the
repository's squash setting drops the PR description, as under
[Commits](#commits). A PR that needs release notes
beyond its title uses the override block under [Commits](#commits).

## Dependency policy

Renovate (the Renovate GitHub App must be installed on the repo) runs weekly,
before 6am on Monday, with related packages grouped (dev tooling, OpenTelemetry,
`@types/*`) and a 3-day minimum release age; pnpm enforces the same 3 days on
install (`minimumReleaseAge` in `pnpm-workspace.yaml`). Lockfile maintenance
runs monthly, before 6am on the first day.

- Minor, patch and digest updates merge themselves once the required checks
  pass. Majors, and the pinned toolchain (`node`, `typescript`, the
  devcontainer image), wait for a human.
- Vulnerability fixes open immediately, outside the schedule and the
  release-age wait, labelled `security`. A fixed version younger than 3 days
  waits: there is no exclude list, and a frozen install refuses a younger
  version. Merge once it is 3 days old.
- GitHub Actions are pinned to commit SHAs, and Renovate keeps the pins
  current.
- TypeScript is held `<6.1.0` (see [CLAUDE.md](CLAUDE.md#versions)), and every
  Node version pin (the docker `node` image, `.node-version`, `actions/setup-node`'s
  `node-version:` in `pr-title.yml`, the devcontainer's `mcr.microsoft.com/devcontainers/typescript-node`
  tag) is held `<25`. Lift these deliberately, not by merging a Renovate PR, and
  bump `package.json`'s `engines.node` and `devEngines.runtime.version` by hand
  alongside: Renovate does not touch those `>=` ranges.
- The Corepack version pinned in `Dockerfile`, `.devcontainer/devcontainer.json`
  and `README.md` is tracked by a `customManagers` regex entry in
  `renovate.json`, since no built-in manager sees a version inside a shell
  command or prose.

### Supply-chain bypasses in `pnpm-workspace.yaml`

Every bypass in `pnpm-workspace.yaml` has a line here, added in the same change
that adds it. The file's own comments carry the detail.

- **`allowBuilds.esbuild`**: its postinstall checks the host platform's native
  binary and downloads it when the optional per-platform package is missing.
- **`allowBuilds.msgpackr-extract`**: a transitive dependency of `bullmq` (via
  `msgpackr`). Its install script loads a prebuilt binding from an optional
  per-platform package or compiles one via `node-gyp`; without a binding,
  `msgpackr` falls back to its pure-JS encoder.
- **`allowBuilds.protobufjs`**: a transitive dependency of
  `@opentelemetry/sdk-node` (via its OTLP gRPC exporters). Its postinstall
  only reads `package.json` files to print a version-scheme warning: no
  network access, no compilation.
- **`allowBuilds.unrs-resolver`**: the resolver `eslint-plugin-import-x` uses
  for `@/*` alias and TypeScript-path resolution. Its postinstall only fetches
  a prebuilt binary for the host platform.
- **`minimumReleaseAge: 4320`**: pnpm refuses any version published less than
  3 days (4320 minutes) ago, the window `renovate.json` also waits. A frozen
  install checks every lockfile entry against it. This repo keeps no
  `minimumReleaseAgeExclude` list: wait out the 3 days.
- **`overrides`**: patched versions of transitive dependencies whose parents
  have not taken them yet, one entry per advisory line: `ip-address` (via
  `express-rate-limit`, the only production one), `source-map-js`,
  `brace-expansion` (both major lines), `fast-uri`, and the `esbuild` that
  `drizzle-kit`'s legacy `@esbuild-kit` loader pins. Remove an entry once
  `pnpm why <name>` shows every parent resolving a patched version on its own.
- **`auditConfig.ignoreGhsas: GHSA-vfj7-8cjw-p6xm`**: `braces` <=3.0.3 can
  exhaust the stack on deeply nested brace patterns, and no patched version
  exists yet. It is reached only through `http-proxy-middleware` >
  `micromatch`, which runs only for a glob `pathFilter`. The `/collect` proxy
  sets none, and `braces` parses patterns, never request paths. Remove the
  entry once `braces` ships a fix.

## Extending the Apex API

The places that change together when a product extends what staff see and do
in Apex. The rules behind them are in
[ARCHITECTURE.md](ARCHITECTURE.md#extending-apex). Paths that begin with
`apex-boilerplate/` or `react-boilerplate/` are in those sibling repositories.

- **A user or tenant field staff can see.** Add the column (model, then
  `pnpm db:migration:generate`), select it in
  `src/repositories/platform-user.repository.ts` (`recordSelection`) or
  `src/repositories/platform-tenant.repository.ts` (`platformTenantList`,
  `findDetail`), and mirror it in `apex-boilerplate/src/types/api.types.ts`. A
  user field staff may edit joins `updatePlatformUserSchema`
  (`src/validators/platform.validators.ts`); a tenant field is edited through
  `PATCH /tenants/:slug` (`updateTenantSchema`,
  `src/validators/tenant.validators.ts`). List it by name in the
  `user.updated` or `tenant.updated` audit metadata.
- **A tenant lifecycle state.** Add it to `TENANT_LIFECYCLE_STATES`
  (`src/constants/tenant.constants.ts`), decide whether
  `platformTenantListSchema`'s `state` default
  (`src/validators/platform.validators.ts`) lists it, give it
  a transition in `src/services/platform-tenant.service.ts` and an audit action,
  and decide whether `resolveTenant` and invitations treat it like
  `suspended`.
- **A list staff or users page through.** One `defineList` in the repository
  (`bound` when the rows depend on a path tenant or the caller), one
  `listParamsSchema` in the validator, an index per sort in the model and the
  migration, an `EXPLAIN` row in `list-indexes.test.ts` and a
  `describeListContract` block. The steps are under
  [List endpoints](ARCHITECTURE.md#list-endpoints).
- **A staff action.** A POST under `/platform/users/:id/<verb>` or
  `/platform/tenants/:id/<verb>` with `requirePlatformRole(<least role>)`,
  `requireJsonContentType`, `requireRecentAuth()` when it is destructive, then
  the shared write limiter, and a body with `reason` (`reasonBodySchema`). The
  service runs one transaction that re-reads the actor's role under lock,
  writes, and records an `AUDIT_ACTIONS` entry. The route-gates row and the
  audit-action mirror it needs are under
  [Extending Apex](ARCHITECTURE.md#extending-apex).
- **An onboarding step.** Add it to `ONBOARDING_STEPS`
  (`src/constants/onboarding.constants.ts`). An `auto` step needs a
  domain-event trigger or a direct `completeOnboardingStep` call.
- **An email template.** Add the template module with its `…_TEMPLATE_META`
  (sender class, `previewVariables`, `resendAction`), add its key to
  `EMAIL_TEMPLATE_KEYS` (`src/utilities/email-template.utilities.ts`) and
  `MailMessage` (`src/services/mailer.service.ts`), give
  `buildPreviewMessage` (`src/services/platform-email.service.ts`) a case that
  masks its token links, and mirror the key in
  `apex-boilerplate/src/constants/email.constants.ts`.
- **A feature flag.** Add an entry to `FLAGS`
  (`src/constants/flags.constants.ts`), read it with `isEnabled` or
  `variantOf` or gate a route with `requireFlag(key)`, mirror a client flag in
  `react-boilerplate/src/observability/flags/flag-keys.ts` or
  `apex-boilerplate/src/observability/flags/flag-keys.ts`, then run
  `pnpm flags:sync` in every environment ([README.md](README.md#feature-flags)).

## Adding a plan-gated feature

How a product feature or limit comes to depend on the workspace's plan. The
rules behind it are under [Billing](ARCHITECTURE.md#billing).

1. **Registry entry.** Add the key to `ENTITLEMENTS`
   (`src/constants/entitlements.constants.ts`): `kind` `feature` or `limit`,
   a `label` and a `description` people read, and `defaults` for Free and
   Paid (`null` is a limit with no cap). A limit also takes `unit`, the name
   of one counted thing (`{ one: 'project', other: 'projects' }`), which the
   limit copy uses, and may take `softAt` for its warning (0.8 by default).
2. **Enforce it in express.** A feature gates its route with
   `requireFeature(key)` (`src/middlewares/entitlement.middleware.ts`) after
   `resolveTenant()`; it answers 402 `PLAN_FEATURE_REQUIRED`. A limit needs a
   counter in `LIMIT_COUNTERS` (`src/services/billing/entitlements.service.ts`;
   the build fails until it has one), and every write that adds to it calls
   `assertWithinLimit(tenantId, key, adding, tx)` under a lock that keeps the
   count from changing before the write commits, as the members limit does
   with `lockSeats`; it answers 402 `PLAN_LIMIT_REACHED` with `details`.
   Never gate in the client only.
3. **Show it in react.** Wrap the screen or control in react-boilerplate's
   `FeatureGate`, which reads the workspace's entitlements and shows the
   locked state with an upgrade or request-upgrade action instead of hiding
   the feature. Treat a 402 from the API as that locked state, not as an
   error.
4. **Seed values.** Existing plans read the registry `defaults` for a key they
   don't store, so nothing changes until staff save a value in Apex's plan
   editor. To give a running environment other values, set them there; to
   show the gated and ungated states locally, run `pnpm billing:seed`, whose
   Free and Paid workspaces then cover both.

## Docs to update alongside a change

- [README.md](README.md): a new script, requirement or quick-start step.
- [ARCHITECTURE.md](ARCHITECTURE.md): a change to boot, the request path,
  layers, configuration, observability, local infrastructure, Docker or
  deploying. Changing where a kind of file lives, or its naming rule: update
  ARCHITECTURE.md's [Directory rules](ARCHITECTURE.md#directory-rules) and
  `eslint.config.mjs` together.
- [DATABASE.md](DATABASE.md): a new table, migration convention or database
  command.
- [SECURITY.md](SECURITY.md): a change to what is or is not implemented for
  authentication, sessions, cookies, rate limits or headers. Adding, removing
  or renaming a rate limiter: update the `RATE_LIMITS` table
  (`src/constants/rate-limit.constants.ts`) and its key-stability test
  (`tests/unit/constants/rate-limit.constants.test.ts`) together, since the
  `name` field is a live Redis key prefix and changing it resets that
  limiter's counters on the next deploy.
- CONTRIBUTING.md (this file): a change to the workflow, hooks or CI. A new
  bypass in `pnpm-workspace.yaml`: its line under
  [Supply-chain bypasses](#supply-chain-bypasses-in-pnpm-workspaceyaml).
- [CLAUDE.md](CLAUDE.md): a non-obvious constraint a future contributor would
  otherwise rediscover by hitting it, rather than a code comment buried three
  files deep.
- [README.md](README.md#documentation-index)'s documentation index: when a doc
  is added, removed or renamed. AGENTS.md links to the index and changes only
  if CLAUDE.md or README.md is renamed.
- Bumping a major dependency: say so in the PR description and title it
  `feat!`/`fix!` if it breaks consumers.
