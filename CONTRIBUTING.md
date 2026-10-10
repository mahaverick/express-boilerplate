# Contributing

## Setup

Follow the README Quickstart first. You need the compose stack up and a
working `.env` to run tests locally (`tests/integration/**` needs Postgres
and Redis). `tests/unit/**` needs neither, but only under `pnpm test:unit`:
`pnpm test`'s default config provisions the test databases in its
globalSetup before any test runs, so it needs the stack even for unit tests.

## Before you open a PR

Run what CI runs:

```bash
pnpm lint            # eslint + tsc --noEmit against tsconfig.typecheck.json
pnpm lint:docs       # history phrasing, broken links and anchors in the docs
pnpm format:check    # prettier over the repo, minus .prettierignore
pnpm knip            # unused files, exports, types and dependencies
pnpm test:coverage   # vitest, gated at 80% lines/functions/branches/statements
pnpm build           # tsc + tsc-alias
```

All six must exit 0; run `pnpm format` if `format:check` doesn't.
`pnpm lint` type-checks once, against `tsconfig.typecheck.json`, which extends
`tsconfig.json` and widens its `include` to `tests/` and `drizzle.config.ts`.
The two configs must stay separate: see [CLAUDE.md](CLAUDE.md#code-conventions).

Code conventions: see [CLAUDE.md](CLAUDE.md#code-conventions).

## Git hooks (husky)

Hooks install with `pnpm install` (the `prepare` script). Commit normally;
don't reach for `--no-verify` on a routine commit.

- **`pre-commit`** (~4.6 s on a one-file change): checks the lockfile isn't
  stale, runs `lint-staged` (eslint --fix and prettier on staged files), runs
  `vitest run --changed HEAD` against `vitest.unit.config.ts`, and regenerates
  `.env.example` when `env.config.ts` is staged. The unit config excludes
  `tests/integration/**` and skips the database setup, so the hook runs with
  Docker down: a hook that fails whenever Docker is down gets bypassed with
  `--no-verify` for good. About 70% of the time is ESLint's type-aware cold
  start (building the TypeScript program), which is what catches floating and
  misused promises; `eslint --cache` doesn't help, since lint-staged passes
  only the changed files.
- **`commit-msg`**: runs `commitlint` against
  [Conventional Commits](https://www.conventionalcommits.org/). `pnpm commit`
  gives an interactive prompt.
- **`pre-push`**: runs `pnpm lint` (ESLint and typecheck) and
  `pnpm test:unit`, with no Docker needed. Integration tests and the coverage
  gate run in CI, which `main` requires.

## Commit messages

Conventional Commits (`type(scope): subject`), enforced by
`@commitlint/config-conventional` via the `commit-msg` hook. Common types:
`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`.

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
   then run `pnpm exec prettier --write ARCHITECTURE.md`.
   `tests/unit/architecture-env-table.test.ts` compares the committed table
   with that output row for row, ignoring column padding.
4. If the tests need a value, add it to `.env.test`.
5. Mirror `.env.test` in `ci.yml`, in the `env:` block of the step named
   `Test with coverage gate`. CI compares keys and values in both directions;
   the only difference allowed is the port in `DATABASE_URL` and `REDIS_URL`,
   because CI's services publish the container-default ports.
6. Renaming or removing a variable is a breaking change: the schema ignores a
   name it does not declare, so an environment that still sets the old name
   boots without it. Mark the commit `feat!:` and name the old and new
   variables in its `BREAKING CHANGE:` footer.

## What CI checks, beyond `pnpm lint`/`test:coverage`/`build`

- `pnpm format:check`: the whole repo (`prettier --check .`, minus
  `.prettierignore`) must already be formatted. Run `pnpm format` locally
  rather than let CI catch it.
- `pnpm lint:docs`: no history phrasing in the markdown or in `#` comments of
  config files, no broken relative link or anchor, and no code citing a doc
  that doesn't exist.
- `pnpm knip`: no unused file, export, type or dependency. See
  [CLAUDE.md](CLAUDE.md#unused-code-knip) for answering a finding.
- `pnpm audit --prod --audit-level moderate`: fails on moderate, high or
  critical advisories in production dependencies.
- `pnpm audit --audit-level critical` over every dependency, dev tooling
  included: a non-blocking step (`continue-on-error`), so a critical advisory
  in tooling shows on the run without failing it.
- `.env.example` matches what `pnpm env:example` generates (step 2 above).
- The test step's `env:` block and `.env.test` mirror each other (step 5
  above).
- The `docker` job builds the production image and checks that it starts
  with `--enable-source-maps`.
- A domain-leak grep over every tracked file (`git ls-files`, minus
  `.github/domain-terms.txt` itself) for the terms listed in
  [`.github/domain-terms.txt`](.github/domain-terms.txt). The shipped list is
  a template of obviously fake placeholders. **If you're adopting this
  boilerplate**, replace them with the names, abbreviations and internal
  identifiers your project must never leak, or delete the file and the
  "Reject domain leakage" step in `.github/workflows/ci.yml`: a gate that
  checks nothing trains reviewers to ignore it. The gate reads the **index**,
  so stage a file before you rely on a local run.
  **The terms file stays pattern-only: no `#` comments, no blank lines.**
  `grep -f` treats every line as a pattern: a `#` line is a pattern, not a
  comment, an unbalanced `(` makes grep exit with an error that the gate's
  `|| true` turns into a silent pass, and a blank line matches everything.
  Explain a term in this document or a commit message instead.
- `gitleaks` (its own workflow, on every PR and every push to `main`): secret
  scanning. The optional local hook (`pre-commit install`, from
  `.pre-commit-config.yaml`) is defence in depth, not the enforcement layer.
- `pr-title`: the PR title must be a conventional commit; it becomes the
  squash commit release-please reads.

What happens after CI passes on `main` is in
[ARCHITECTURE.md](ARCHITECTURE.md#deploying).

## Secrets

Never commit a real secret, even a test one that resembles a production
value. `.env`, `.env.local` and any `.env.*.local` are git-ignored. `.env.test`
is committed on purpose: every value in it is a fixture, and it is its own
example, so don't add a copy beside it.

## Releases

Releases are automatic. On every push to `main`, `release-please` opens or
updates a release pull request from the conventional commits since the last
release, and `release.yml` queues it with `--auto`, so it merges once the
required checks pass. The next run tags `vX.Y.Z` and publishes the GitHub
Release, and the tag push makes `deploy.yml` add `:X.Y.Z`, `:X.Y` and `:X` to
the image digest `main` already built and tested; a release rebuilds nothing.
Only `feat`, `fix` and breaking commits cut a release:

- `feat` commits become a minor version bump
- `fix` commits become a patch version bump
- `feat!` or `BREAKING CHANGE:` commits become a major version bump

`release.yml` uses a GitHub App token (variable `RELEASE_APP_CLIENT_ID`,
secret `RELEASE_APP_PRIVATE_KEY`; Contents and Pull requests read/write),
because events `GITHUB_TOKEN` creates start no workflow: its PR would get no
CI and its tag no promotion.

Every PR merges via squash with the PR title as the commit subject, which is
what `release-please` reads, so PR titles must be conventional commits.

## Dependency policy

Renovate (the Renovate GitHub App must be installed on the repo) runs weekly,
before 6am on Monday, with related packages grouped and a 3-day minimum
release age; pnpm enforces the same 3 days on install (`minimumReleaseAge` in
`pnpm-workspace.yaml`). Lockfile maintenance runs monthly.

- Minor, patch and digest updates merge themselves once the required checks
  pass. Majors, and the pinned toolchain (`node`, `typescript`, the
  devcontainer image), wait for a human.
- Vulnerability fixes open immediately, outside the schedule and the
  release-age wait, labelled `security`. A fixed version younger than 3 days
  also needs an entry in `minimumReleaseAgeExclude`, or CI's frozen install
  refuses it; delete that entry once the version is 3 days old.
- GitHub Actions are pinned to commit SHAs, and Renovate keeps the pins
  current.
- TypeScript is held `<6.1.0` (see [CLAUDE.md](CLAUDE.md#code-conventions)),
  and every Node version pin (the docker `node` image, `.nvmrc`,
  `actions/setup-node`'s `node-version:`, the devcontainer's
  `mcr.microsoft.com/devcontainers/typescript-node` tag) is held `<25`. Lift
  these deliberately, not by merging a Renovate PR, and bump `package.json`'s
  `engines.node` and `devEngines.runtime.version` by hand alongside: Renovate
  doesn't touch those `>=` ranges.
- The Corepack version pinned in `Dockerfile`,
  `.devcontainer/devcontainer.json` and `README.md` is tracked by a
  `customManagers` regex entry in `renovate.json`, since no built-in manager
  sees a version inside a shell command or prose.

### Supply-chain bypasses in `pnpm-workspace.yaml`

Every bypass in `pnpm-workspace.yaml` has a line here, added in the same change
that adds it. The file's own comments carry the detail.

- **`allowBuilds.bcrypt`**: its install script runs `node-gyp-build`, which
  loads the prebuilt native binding or compiles one via `node-gyp`. bcrypt is a
  native addon and does not work without it.
- **`allowBuilds.esbuild`**: its postinstall checks the host platform's native
  binary and downloads it when the optional per-platform package is missing.
  Dev-only (via `tsx`, `vitest` and `drizzle-kit`).
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
  a prebuilt binary for the host platform. Dev-only.
- **`minimumReleaseAge: 4320`**: pnpm refuses any version published less than
  3 days (4320 minutes) ago, the window `renovate.json` also waits. A frozen
  install checks every lockfile entry against it. An exception goes under a
  `minimumReleaseAgeExclude` key, one `name@version` per entry, needed only
  until that version is 3 days old; delete the entry then, and the key itself
  once no exception remains.
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

## Docs to update alongside a change

- [README.md](README.md): a new script, requirement or quickstart step.
- [ARCHITECTURE.md](ARCHITECTURE.md): a change to boot, the request path,
  layers, configuration, observability, local infrastructure, Docker or
  deploying. Changing where a kind of file lives, or its naming rule: update
  ARCHITECTURE.md's [Directory rules](ARCHITECTURE.md#directory-rules) and
  `eslint.config.mjs` together.
- [DATABASE.md](DATABASE.md): a new table, migration convention or database
  command.
- [SECURITY.md](SECURITY.md): a change to what is or isn't implemented for
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
- [AGENTS.md](AGENTS.md): only when a doc is added, removed or renamed.
- Bumping a major dependency: say so in the PR description and title it
  `feat!`/`fix!` if it breaks consumers.
