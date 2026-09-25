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
pnpm format:check    # prettier over the repo, minus .prettierignore
pnpm test:coverage   # vitest, gated at 80% lines/functions/branches/statements
pnpm build           # tsc + tsc-alias
```

All four must exit 0 — run `pnpm format` if `format:check` doesn't.
`pnpm lint` type-checks **once**, against `tsconfig.typecheck.json`, which
extends `tsconfig.json` and widens its `include` to also cover `tests/` and
`drizzle.config.ts` — a strict superset, so a second `tsc` against the build
config (which `pnpm lint` used to run first) could not catch anything this
one misses. Both config files still exist and must not be merged into one:
widening the **build** config's `include` to cover `tests/` produces
`TS6059` ("file is not under `rootDir`") instead of type-checking anything,
because `rootDir: ./src` and an `include` outside it are contradictory. See
[CLAUDE.md](CLAUDE.md).

## Git hooks (husky)

Hooks run automatically after `pnpm install` (the `prepare` script). Commit
normally — there is no reason to reach for `--no-verify` on this repo's own
history, and doing so on a routine commit defeats the point of the hooks
existing.

- **`pre-commit`** (~4.6s on a one-file change): checks the lockfile isn't
  stale, runs `lint-staged` (eslint --fix + prettier on staged files),
  regenerates `.env.example` if `env.config.ts` is staged, then runs
  `vitest run --changed HEAD` against `vitest.unit.config.ts`, which
  excludes `tests/integration/**` and skips the database setup, so it runs
  with Docker down. About 70% of the time is ESLint's type-aware cold start
  (building the TypeScript program). It is not worth removing; see CLAUDE.md
  for why. A hook that fails when Docker happens to be down gets disabled
  with `--no-verify` permanently, and then it protects nothing.
- **`commit-msg`**: runs `commitlint` against
  [Conventional Commits](https://www.conventionalcommits.org/). Use
  `pnpm commit` for an interactive prompt if you don't want to remember the
  format by hand.
- **`pre-push`**: runs `pnpm lint` (ESLint and typecheck) and
  `pnpm test:unit`, with no Docker needed. Integration tests and the
  coverage gate run in CI, which main requires.

## Commit messages

Conventional Commits (`type(scope): subject`), enforced by
`@commitlint/config-conventional` via the `commit-msg` hook. Common types:
`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`.

## Code conventions

- **No `process.env` outside `src/configs/env.config.ts`.** Read
  configuration through `getEnv()`. An eslint rule
  (`no-restricted-properties`) enforces this everywhere else in `src/`.
- **No barrel files.** Import the module you need directly
  (`@/services/foo.service`), never through a re-exporting `index.ts`. See
  [STRUCTURE.md](STRUCTURE.md).
- **Filenames carry a role suffix** in every governed directory
  (`*.service.ts`, `*.middleware.ts`, ...) — see STRUCTURE.md for the exact
  list. `pnpm lint` rejects a mismatch.
- **Every exported function, class, interface, and type alias needs a JSDoc
  description** (`jsdoc/require-jsdoc`, `publicOnly: true`). Describe
  behavior in prose; don't repeat the TypeScript types in `@param`/`@returns`
  — they're already the source of truth for that, and a duplicated type
  drifts. Test files (`*.test.ts`, `tests/**`) are exempt.
- **Type-aware lint rules are on** (`typescript-eslint`'s
  `recommendedTypeChecked`), specifically because they catch floating and
  misused promises — the dominant real-bug class in async Express code.
  Don't add a scoped disable for one of these without a comment explaining
  why this call site is actually safe.
- If an eslint rule genuinely doesn't apply to a specific identifier or
  file, scope the disable as narrowly as the rule allows (a specific
  `replacements` key, a specific line) rather than disabling the whole
  rule. A blanket disable in a boilerplate propagates into every project
  derived from it.

## Adding, renaming or removing an environment variable

These move together, or a gate below will catch the one you missed:

1. Add the field to `EnvSchema` in `src/configs/env.config.ts`, with a
   `.describe()`. That text becomes the variable's `.env.example` comment and
   its README row. When its default depends on `APP_ENV`, make the field
   optional and add a derivation helper beside `isCookieSecure`/`logFormat` in
   the same file; never repeat the rule at a call site.
2. Regenerate `.env.example` with `pnpm env:example`. The pre-commit hook does
   this when `env.config.ts` is staged, and CI fails if the committed file
   differs from what the schema generates.
3. Regenerate README's environment table from the schema, never by hand.
   `pnpm --silent env:table` prints it (`renderEnvTable()` in
   `src/scripts/generate-env-example.ts`). Paste its output over the table
   in README.md, then run `pnpm exec prettier --write README.md`.
   `tests/unit/readme-env-table.test.ts` compares the committed table with
   that output row for row, ignoring column padding, and fails on any
   difference.

4. If the tests need a value, add it to `.env.test`.
5. Mirror `.env.test` in `ci.yml`, in the `env:` block of the step named
   `Test with coverage gate`. CI compares keys and values in both
   directions: every `.env.test` line must appear there with the same
   value, and every entry there must be in `.env.test`. The only difference allowed is the port in
   `DATABASE_URL` and `REDIS_URL`, because CI's services publish the
   container-default ports.
6. Renaming or removing a variable: add the old name to `REMOVED_ENV_NAMES`
   (`src/configs/env-consistency.config.ts`), so that setting it refuses boot
   with a message naming the new one. Add a row to the release's upgrade notes
   in MIGRATIONS.md.

## What CI checks, beyond `pnpm lint`/`test:coverage`/`build`

- `pnpm format:check` — the whole repo (`prettier --check .`, minus
  `.prettierignore`) must already be Prettier-formatted; run `pnpm format`
  locally rather than let CI catch it. This used to be scoped to
  `src/**/*.{ts,json,md}` while being described here as repo-wide, so nothing
  formatted `tests/**` at all.
- `pnpm audit --prod --audit-level high` — fails on high or critical
  advisories in production dependencies.
- `.env.example` matches what `pnpm env:example` generates from the current
  schema (see step 2 above).
- The test step's `env:` block and `.env.test` mirror each other in both
  directions, keys and values (see step 5 above).
- A domain-leak grep over **every tracked file** (`git ls-files`, minus
  `.github/domain-terms.txt` itself) for the terms listed in
  [`.github/domain-terms.txt`](.github/domain-terms.txt). This _mechanism_ —
  fail CI if any term from a list appears in a tracked file — exists because
  this boilerplate was itself derived from an existing production codebase,
  and a gate is what made that derivation trustworthy instead of merely
  hoped-for. The _list_ shipped in `.github/domain-terms.txt` is a template:
  open the file to see its few obviously-fake placeholder entries — not this
  repo's own history. (Deliberately not repeated here: this document is
  itself a tracked file the gate scans, so spelling a placeholder out in
  prose would make this paragraph fail its own check.) **If you're adopting
  this boilerplate**,
  either replace the placeholders with the names, abbreviations, and
  internal schema/table identifiers your own project must never leak, or —
  if you have no such concern — delete `.github/domain-terms.txt` and the
  "Reject domain leakage" step in `.github/workflows/ci.yml` entirely; a
  present-but-irrelevant gate is worse than no gate, because it trains
  reviewers to ignore its output.
  It used to filter by file extension and skip `docs/`, which
  exempted `.env.example`, `.env.test`, `docker/postgres/init.sql`, the husky
  hooks, `CODEOWNERS` and the whole of `docs/` from the scan. Add a term by
  editing that file; nothing else needs to change. Because the gate reads the
  **index**, an unstaged file is invisible to it — stage before you rely on a
  local run.
  **The file must stay pattern-only — no `#` comments, no blank lines.** The
  gate invokes `grep -niEf .github/domain-terms.txt`, and `-f` treats every
  line of that file as its own extended-regex pattern with zero
  preprocessing: there is no comment stripping. A `#`-prefixed line is not
  skipped, it _is_ a pattern — a bare `#` alone matches every line
  containing a `#` character, which is several hundred lines across this
  repo's source, tests and YAML (verified). Worse, a comment containing an
  unbalanced `(` makes `grep -f` exit with a regex error instead of a
  match — which the gate's `|| true` swallows into an empty result, so a
  real leak elsewhere in the same run would pass silently instead of
  failing CI (also verified). A blank line is an empty pattern that matches
  every line of every file, which is why the gate's own preflight check
  refuses to run on one. Put any explanation of a term's purpose here in
  this document, or in a commit message — never as a line in the terms
  file itself.
- `gitleaks` (separate workflow, on every PR and every push to `main`) —
  secret scanning. There is also an optional local `pre-commit` hook for
  the same tool (`pre-commit install`), which is defense in depth, not the
  enforcement layer: a developer can skip it with `--no-verify`, but not
  the PR-level check.
- `pr-title` — the PR title must be a conventional commit; it becomes the
  squash commit release-please reads.

## Secrets

Never commit a real secret, even a test one that resembles a production
value. `.env`, `.env.local`, and any `.env.*.local` are git-ignored;
`.env.test` is committed on purpose — every value in it is a fixture, not a
credential. (There used to be a byte-identical `.env.test.example` beside it,
kept "in sync" by hand. Two files with identical content and no mechanism
keeping them equal is a drift source, not a safety net; `.env.test` is
committed and readable, so it is its own example.)

## Releases

Releases are automatic. On every push to `main`, `release-please` opens a
release pull request from the conventional commits since the last release, and
`release.yml` queues it with `--auto`, so it merges once required checks pass;
the next run tags `vX.Y.Z` and publishes the GitHub Release, and the tag push
makes `deploy.yml` add `:X.Y.Z`, `:X.Y` and `:X` to the image digest `main`
already built and tested — a release rebuilds nothing. Only
`feat`/`fix`/breaking commits cut a release — `chore`, `docs`, `ci` and the
like do not. This uses a GitHub App token (variable `RELEASE_APP_CLIENT_ID`,
secret `RELEASE_APP_PRIVATE_KEY`; Contents and Pull requests read/write): events
`GITHUB_TOKEN` creates start no workflow, so its PR would get no CI and its tag
no promotion. The version bump follows the commit types:

- `feat` commits become a minor version bump
- `fix` commits become a patch version bump
- `feat!` or `BREAKING CHANGE:` commits become a major version bump

A multi-commit PR merges via squash, so its PR title becomes the commit
`release-please` reads (a single-commit PR keeps that commit's own title
instead) — either way, PR titles must be conventional commits.

## Docs to update alongside a change

- Changing where a kind of file lives, or its naming rule -> update
  [STRUCTURE.md](STRUCTURE.md) and `eslint.config.mjs` together.
- Bumping a major dependency -> add a row to [MIGRATIONS.md](MIGRATIONS.md).
- Adding a non-obvious constraint a future contributor would otherwise
  rediscover by hitting it -> [CLAUDE.md](CLAUDE.md), not a code comment
  buried three files deep.
