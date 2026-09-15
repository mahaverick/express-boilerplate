# AGENTS.md

Express 5 API boilerplate: TypeScript, Drizzle ORM on Postgres, Redis, a
validated environment, and a documented HTTP error contract. This file is
the agent-facing entry point; it indexes the other docs and states the
conventions an agent should not have to rediscover by reading every file.

## Docs

- [`README.md`](README.md) — quickstart, environment variables, available
  scripts.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit together, and
  what's deliberately not built yet.
- [`STRUCTURE.md`](STRUCTURE.md) — where a new file goes, directory by
  directory, and its required filename suffix.
- [`DATABASE.md`](DATABASE.md) — the models directory, migrations, the
  `drizzle-kit` workflow.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch/commit/PR workflow and every
  gate a change has to pass.
- [`MIGRATIONS.md`](MIGRATIONS.md) — every major dependency bump taken
  here, the ones deliberately deferred, and the current supply-chain
  bypass list.
- [`CLAUDE.md`](CLAUDE.md) — gotchas and non-derivable context. Read this
  before touching environment parsing, the git hooks, or the TypeScript
  config — each has a reason that isn't visible from the code alone.
- [`SECURITY.md`](SECURITY.md) — security-relevant design decisions (CSRF,
  password hashing, CSP, secret scanning) and how to report a
  vulnerability.

Don't duplicate the content of those files here — extend this file only
with conventions that don't belong in any of them.

## Conventions

- Use `pnpm` only. `packageManager` is pinned in `package.json`, and
  `engine-strict=true` in `.npmrc` rejects a mismatched Node/pnpm.
- Node >= 24 (`.nvmrc`).
- No barrel files. Import a module directly (`@/services/foo.service`), not
  through a re-exporting `index.ts`. See STRUCTURE.md.
- Configuration comes from `getEnv()`
  (`@/configs/env.config`), never `process.env` directly, anywhere outside
  that one file. An eslint rule enforces this; it will fail `pnpm lint`,
  not just look wrong in review.
- Every governed directory under `src/` requires a specific filename
  suffix (`*.service.ts`, `*.middleware.ts`, ...) — see STRUCTURE.md for
  the full table before creating a new file.
- Every exported function, class, interface, and type alias needs a JSDoc
  description. `pnpm lint` fails on a missing one (`jsdoc/require-jsdoc`).

## Verification

Before treating a change as done, run what CI runs:

```bash
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm build
```

All four must exit 0 (`pnpm format` fixes a `format:check` failure). `pnpm
dev` reads `.env` automatically (via `dotenv`, inside `env.config.ts`) —
copy `.env.example` to `.env` and fill in the required secrets first, and
`pnpm dev` will fail fast with a named list if any are still missing.

## Gotchas

See [CLAUDE.md](CLAUDE.md) — not duplicated here.
