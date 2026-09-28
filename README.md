# Express Boilerplate

A production-grade Express 5 API boilerplate: TypeScript, Drizzle ORM on
Postgres, Redis, a validated environment, a documented HTTP error contract,
OpenTelemetry traces and logs, and a git-hook and CI pipeline that enforces
all of it.

On top of that platform it ships email and password registration with email
verification, JWT access tokens with rotating opaque refresh tokens, forgot,
reset and change password, optional Google sign-in, multi-tenancy with roles
and invitations, an audit log, platform staff access, in-app notifications over
server-sent events, BullMQ jobs and a daily data-retention purge.
[SECURITY.md](SECURITY.md#what-this-boilerplate-does-not-implement) lists what
it does not implement.

## Requirements

- Node.js >= 24 (pinned in [`.nvmrc`](.nvmrc)). `devEngines.runtime` in
  `package.json` makes `pnpm install` refuse an older Node.
- [pnpm](https://pnpm.io) 12.4.1, pinned by `packageManager` in
  `package.json`. Use pnpm only. Node 25 and later do not bundle Corepack, so
  install it first: `npm i -g corepack@0.36.0 && corepack enable`.
- Docker, for the local Postgres, Redis, OpenTelemetry, Loki and Mailpit stack.

## Quickstart

```bash
pnpm install
docker compose up -d
cp .env.example .env    # then fill in the six blank required values below
pnpm db:migrate
pnpm dev
```

For the compose stack, the blank required values in `.env` are:

```bash
APP_URL=http://localhost:4040
WEB_URL=http://localhost:5173
DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate
REDIS_URL=redis://localhost:6380
JWT_ACCESS_SECRET=   # openssl rand -hex 32
SESSION_SECRET=      # openssl rand -hex 32
```

`.env` is loaded for you (see
[Configuration](ARCHITECTURE.md#configuration)), and `pnpm dev` fails fast
with a named list if a required variable is missing. Every variable is
described in [ARCHITECTURE.md](ARCHITECTURE.md#environment-variables).

```bash
curl http://localhost:4040/health/ready   # {"status":"ready","checks":{...}}
```

### Register and log in

```bash
curl -X POST http://localhost:4040/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"grace@example.com","password":"a very long passphrase"}'
```

Registration answers `202` with the same body whether or not the address is
free, and mails a verification link. Open Mailpit at <http://localhost:8025>,
copy the `token` from the link, and verify with the account's password:

```bash
curl -X POST http://localhost:4040/api/v1/auth/verify-email \
  -H 'Content-Type: application/json' \
  -d '{"token":"<token from the link>","password":"a very long passphrase"}'

curl -X POST http://localhost:4040/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"grace@example.com","password":"a very long passphrase"}'
```

Login answers `data.user` and `data.accessToken`, and sets the refresh-token
cookie. Send the token as `Authorization: Bearer <accessToken>` to reach an
authenticated route such as `GET /api/v1/profile`. Every `/api/v1/auth` route
refuses a non-JSON body with 415. See
[ARCHITECTURE.md](ARCHITECTURE.md#request-path-auth-and-beyond) for the rest.

## Available scripts

| Script                              | What it does                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`                          | `tsx watch`, loading `.env` and then `src/observability/tracing.ts` first.   |
| `pnpm build`                        | `tsc` and `tsc-alias` into `dist/`, with the migrations copied alongside.    |
| `pnpm start`                        | Runs the build, loading `.env` and `dist/observability/tracing.js` first.    |
| `pnpm lint`                         | `eslint .`, then `tsc` over `src/` and `tests/` (`tsconfig.typecheck.json`). |
| `pnpm lint:fix`                     | `eslint . --fix`.                                                            |
| `pnpm lint:docs`                    | History phrasing and broken links in docs; code citing a missing doc.        |
| `pnpm format` / `pnpm format:check` | Prettier over the whole repo.                                                |
| `pnpm test`                         | `vitest run`. Needs the compose stack.                                       |
| `pnpm test:watch`                   | `vitest watch`.                                                              |
| `pnpm test:unit`                    | Every test but `tests/integration/**`; runs with Docker down.                |
| `pnpm test:coverage`                | `vitest run --coverage`, gated at 80% on all four measures.                  |
| `pnpm env:example`                  | Regenerates `.env.example` from the Zod schema.                              |
| `pnpm env:table`                    | Prints ARCHITECTURE.md's environment table from the Zod schema.              |
| `pnpm db:migration:generate`        | `drizzle-kit generate`; see [DATABASE.md](DATABASE.md).                      |
| `pnpm db:migrate`                   | Applies pending migrations against `DATABASE_URL`.                           |
| `pnpm db:migrate:prod`              | The same, as `node dist/database/migrate.js`; run that in the prod image.    |
| `pnpm platform:grant -- <e> <role>` | Gives a platform-tenant role; see below.                                     |
| `pnpm commit`                       | Interactive conventional-commit prompt.                                      |

`pnpm platform:grant -- <email> <role>` gives an existing user with a verified
address a role (`owner` to `viewer`) in the platform tenant, audited as
`platform.member.granted`. Nobody can invite staff before a platform owner
exists, so this is how the first one is made.

## Make this yours

This is a template. Before the first real commit on a project generated from
it, change the things that still say "express-boilerplate":

- [ ] **`package.json`**: `name`, `description`, `author`, `license` and
      `version`.
- [ ] **`.github/CODEOWNERS`**: it names this repository's maintainer.
- [ ] **Repository URLs** in `package.json` and the docs, and this README.
- [ ] **`SECURITY.md`**: the reporting address, and the list of what is not
      implemented as you implement it.
- [ ] **`.github/domain-terms.txt`**: placeholder terms only. Replace them with
      your own never-commit vocabulary, or delete the file and its CI step in
      `.github/workflows/ci.yml`.
- [ ] **`LICENSE`**: a proprietary licence naming Mahaverick. Replace it with
      your own terms, and set `license` in `package.json` to match.

No gate enforces this list.

## Documentation index

| Doc                                | Owns                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| [README.md](README.md)             | Quick start, scripts, making the template yours, this index                  |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Boot, layers, directory rules, configuration and env vars, Docker, deploying |
| [DATABASE.md](DATABASE.md)         | Client, models, migrations, test database, live schema changes               |
| [SECURITY.md](SECURITY.md)         | Reporting, supported versions, what is and is not implemented                |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Hooks, commits, CI, releases, dependency policy, docs to update              |
| [CLAUDE.md](CLAUDE.md)             | Rules and gotchas for anyone changing the code                               |
| [AGENTS.md](AGENTS.md)             | Agent entry point, pointing at CLAUDE.md and this index                      |

## License

Proprietary, all rights reserved. See [`LICENSE`](LICENSE).

`package.json` declares `UNLICENSED`, npm's spelling for "not open source". It
is not the public-domain "Unlicense", and this repository being publicly
visible grants no right to use, copy, modify or distribute it.
