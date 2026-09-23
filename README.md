# Express Boilerplate

A production-grade Express 5 API boilerplate: TypeScript, Drizzle ORM on
Postgres, Redis, a validated environment, a documented HTTP error contract,
and a git-hook + CI pipeline that enforces all of it.

This repository is a foundation, not a finished product. It ships the
platform plumbing (env validation, database/Redis clients, health checks,
error handling, the test harness, the lint gates) plus a working
authentication slice on top of it: registration, login, JWT access tokens
paired with rotating opaque refresh tokens, and an authenticated profile
endpoint, plus a CORS origin allowlist for a second frontend on a sibling
subdomain and `helmet` security headers. It does not ship email
verification delivery, sessions, MFA, OAuth, or tenancy — see
[ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md) for
exactly what is and is not here yet.

## Requirements

- Node.js >= 24 (pinned in [`.nvmrc`](.nvmrc); `engine-strict=true` in
  [`.npmrc`](.npmrc) refuses anything older)
- [pnpm](https://pnpm.io) 12.4.1 (pinned via `packageManager` in
  `package.json`; enable it with `corepack enable`)
- Docker, for the local Postgres/Redis/OpenTelemetry/Loki/Mailpit stack

## Quickstart

```bash
pnpm install
docker compose up -d
cp .env.example .env    # then fill in the required secrets — see below
pnpm db:migrate
pnpm dev
```

Then:

```bash
curl http://localhost:4040/health         # {"status":"ok","uptime":...}
curl http://localhost:4040/health/ready   # {"status":"ready","checks":{"database":true,"redis":true}}
```

### Register and log in

Verified directly against this repo, from the same running server:

```bash
curl -X POST http://localhost:4040/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"grace@example.com","password":"a very long passphrase"}'
```

```json
{
  "success": true,
  "message": "Registration successful.",
  "statusCode": 201,
  "data": {
    "id": "01a0a3af-3de4-78d8-96d3-5f970bb45414",
    "email": "grace@example.com",
    "firstName": null,
    "lastName": null,
    "createdAt": "2026-09-15T06:09:25.987Z"
  }
}
```

```bash
curl -X POST http://localhost:4040/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"grace@example.com","password":"a very long passphrase"}'
```

```json
{
  "success": true,
  "message": "Login successful.",
  "statusCode": 200,
  "data": {
    "user": {
      "id": "01a0a3af-3de4-78d8-96d3-5f970bb45414",
      "email": "grace@example.com",
      "firstName": null,
      "lastName": null,
      "createdAt": "2026-09-15T06:09:25.987Z"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs..."
  }
}
```

The `Content-Type: application/json` header above is required, not
decorative: every route under `/api/v1/auth` refuses a form-encoded body
with 415, which is what stops an attacker's page from auto-submitting a
cross-site form that logs a victim into the attacker's account — see
[SECURITY.md](SECURITY.md).

Login also sets an httpOnly `refreshToken` cookie, scoped to
`/api/v1/auth`. `data.accessToken` above is a JWT — send it as
`Authorization: Bearer <accessToken>` to reach an authenticated route, e.g.
`GET /api/v1/profile`. There is no `password` minimum beyond 8 characters
and no composition rule (uppercase/digit/symbol) — see
[SECURITY.md](SECURITY.md) for why. See ARCHITECTURE.md's "Request path:
auth and beyond" for how the rest of the auth routes
(`/api/v1/auth/refresh`, `/api/v1/auth/logout`) fit together.

`pnpm dev` (`tsx watch src/index.ts`) and `pnpm start` (`node
dist/index.js`) load `.env` for you via
[`dotenv`](https://www.npmjs.com/package/dotenv), inside
[`env.config.ts`](src/configs/env.config.ts) — the one module allowed to
touch `process.env` at all. There is nothing to export by hand; every
command above was run exactly as written, from a clean environment, to
verify this quickstart works end to end. (`.env` loading is skipped under
Vitest specifically — see [CLAUDE.md](CLAUDE.md) — so the test suite's own
environment, assembled by `tests/helpers/setup-global.ts`, is never mixed
with a developer's local `.env`.)

There is no `pnpm bootstrap` — it belongs to a later plan (seeding, admin
user creation). Don't run it; it doesn't exist yet.

## Environment variables

`.env.example` is **generated** from the Zod schema in
[`src/configs/env.config.ts`](src/configs/env.config.ts) — never hand-edit
it. Regenerate it with `pnpm env:example` after changing the schema (the
pre-commit hook does this automatically when `env.config.ts` is staged).

An optional key with no default (currently only
`OTEL_EXPORTER_OTLP_ENDPOINT`) is emitted **commented out** in
`.env.example`, so a reader can tell "no value needed" from "fill this in."
Required keys are emitted blank.

| Variable                      | Required                   | Notes                                                                                                                                                                                     |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | no (default `development`) | `development` \| `test` \| `production`                                                                                                                                                   |
| `APP_PORT`                    | no (default `4040`)        |                                                                                                                                                                                           |
| `APP_URL`                     | **yes** (placeholder)      | Public origin of this API. `http://localhost:4040` locally. **Nothing reads it yet.**                                                                                                     |
| `WEB_URL`                     | **yes**                    | Public origin of the frontend. `http://localhost:5173` locally. Read by the email-verification link builder and — always allowed in the CORS origin allowlist — by `origin.utilities.ts`. |
| `CORS_ALLOWED_ORIGINS`        | no                         | Extra browser origins allowed to call this API, comma-separated. `WEB_URL` is always allowed without listing it here.                                                                     |
| `DATABASE_URL`                | **yes**                    | `postgres://boilerplate:boilerplate@localhost:5433/boilerplate` against the compose stack.                                                                                                |
| `REDIS_URL`                   | **yes**                    | `redis://localhost:6380` against the compose stack.                                                                                                                                       |
| `JWT_ACCESS_SECRET`           | **yes**                    | 32+ characters. Signs and verifies access tokens.                                                                                                                                         |
| `SESSION_SECRET`              | **yes** (placeholder)      | 32+ characters. **Nothing reads it yet.**                                                                                                                                                 |
| `ACCESS_TOKEN_TTL`            | no (default `15m`)         | An `ms()`-parseable duration string, e.g. `15m` or `900000`.                                                                                                                              |
| `REFRESH_TOKEN_TTL`           | no (default `30d`)         | An `ms()`-parseable duration string, e.g. `30d` or `2592000000`.                                                                                                                          |
| `SESSION_ABSOLUTE_TTL`        | no (default `30d`)         | Hard ceiling on one login session, never reset by rotation. An `ms()`-parseable duration string.                                                                                          |
| `TRUST_PROXY`                 | no (default `false`)       | **Set this behind a proxy** — see [SECURITY.md](SECURITY.md). `1` for one hop, or an address list. `true` is refused.                                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no                         | Absent means tracing is disabled — the SDK is never started.                                                                                                                              |
| `LOG_LEVEL`                   | no (default `info`)        | `error` \| `warn` \| `info` \| `debug`                                                                                                                                                    |

There is no `JWT_REFRESH_SECRET`: refresh tokens are opaque random strings,
not JWTs, so nothing ever signs one with a secret — see
[SECURITY.md](SECURITY.md). A field that can never be read isn't a
placeholder; it was removed from the schema rather than kept as one.

### The remaining placeholders

`APP_URL` and `SESSION_SECRET` remain required by the schema (see
[SECURITY.md](SECURITY.md) for what reads them). `WEB_URL` is no longer a
placeholder: it is read by the email-verification link builder and by the
CORS origin allowlist (see the table above and SECURITY.md's "CORS"
section).

So **any 32-character string will do for now**: `SESSION_SECRET=` followed
by 32 arbitrary characters boots the app exactly as well as a
cryptographically generated one, because nothing signs anything with it yet.
`.env.example` says so. `JWT_ACCESS_SECRET` is no longer one of these — it
is live, and `openssl rand -hex 32` is the right way to generate it even in
development, not just before shipping.

They stay required rather than optional deliberately: a project that later
adds the feature they reserve should get a named, fail-fast error at boot
for a missing secret instead of discovering at runtime that it signed
something with `undefined`.

When you do ship the feature a placeholder reserves, generate a real
secret — `openssl rand -hex 32` — and rotate whatever placeholder was there.

**Unsetting or malforming any required variable fails fast with a named
list, not a stack trace** — verified directly against this repo: dropping
`JWT_ACCESS_SECRET` prints

```
Invalid environment:
✖ Invalid input: expected string, received undefined
  → at JWT_ACCESS_SECRET
```

and exits 1, before any socket opens or any dependency (database, Redis) is
touched.

### Why the compose stack uses ports 5433 and 6380

`docker-compose.yml` publishes Postgres on host port **5433** and Redis on
**6380**, not their defaults. This is deliberate, not a typo: the two most
commonly installed local services are a native Postgres and a native Redis,
and both default to 5432/6379. On a machine running either, connecting to
`localhost:5432`/`localhost:6379` can silently hit your own Homebrew (or
system) instance instead of the compose stack. Postgres fails loudly in that
case (`role "boilerplate" does not exist`), but **Redis fails silently** —
any Redis instance answers `PING`, so the app would appear to work while
writing into an unrelated database. Container-internal ports stay
5432/6379, so a container-to-container URL like `postgres://…@postgres:5432/…`
is unaffected. See the header comment in
[`docker-compose.yml`](docker-compose.yml) and
[ARCHITECTURE.md](ARCHITECTURE.md) for the full reasoning.

## Available scripts

| Script                              | What it does                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Runs the app with `tsx watch`, `--import`-ing `src/observability/tracing.ts` first (no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set — see CLAUDE.md). Loads `.env` itself via `dotenv` — nothing to export by hand, see Quickstart. |
| `pnpm build`                        | `tsc` then `tsc-alias --resolve-full-paths` into `dist/`.                                                                                                                                                                             |
| `pnpm start`                        | Runs the built app: `node --import ./dist/observability/tracing.js dist/index.js`.                                                                                                                                                    |
| `pnpm lint`                         | `eslint .` then `tsc -p tsconfig.typecheck.json --noEmit` — that config is a strict superset of `tsconfig.json`'s `include`, so it covers `src/` and `tests/` in one pass.                                                            |
| `pnpm lint:fix`                     | `eslint . --fix`.                                                                                                                                                                                                                     |
| `pnpm format` / `pnpm format:check` | Prettier over the whole repo (`.` minus `.prettierignore`), `tests/` included.                                                                                                                                                        |
| `pnpm test`                         | `vitest run`.                                                                                                                                                                                                                         |
| `pnpm test:watch`                   | `vitest watch`.                                                                                                                                                                                                                       |
| `pnpm test:coverage`                | `vitest run --coverage`, gated at 80% lines/functions/branches/statements.                                                                                                                                                            |
| `pnpm env:example`                  | Regenerates `.env.example` from the Zod schema.                                                                                                                                                                                       |
| `pnpm db:migration:generate`        | `drizzle-kit generate` — writes a new migration from the model files. See [DATABASE.md](DATABASE.md).                                                                                                                                 |
| `pnpm db:migrate`                   | Applies pending migrations (`tsx src/database/migrate.ts`) against `DATABASE_URL`. See [DATABASE.md](DATABASE.md).                                                                                                                    |
| `pnpm db:migrate:prod`              | Same as `pnpm db:migrate`, against the built output (`node dist/database/migrate.js`) — what the production image and CI run.                                                                                                         |
| `pnpm commit`                       | Interactive conventional-commit prompt (`commitizen` + `@commitlint/cz-commitlint`).                                                                                                                                                  |

Verified together from a clean clone: `pnpm install && pnpm lint && pnpm
format:check && pnpm test:coverage && pnpm build` all exit 0.

## Project structure

See [STRUCTURE.md](STRUCTURE.md) for the full directory-by-directory guide —
it lists the exact filename suffix each directory requires (enforced by
`eslint-plugin-check-file`, not just convention).

## Database

See [DATABASE.md](DATABASE.md) for the models directory, how migrations are
generated and applied, and why `drizzle.config.ts` only ever needs
`DATABASE_URL`.

## Make this yours

This is a template. Before the first real commit on a project generated from
it, change the things that still say "express-boilerplate":

- [ ] **`package.json`** — `name`, `description`, `author`, `license`, and
      `version` (start at `0.1.0`, not `1.0.0`, unless you mean it).
- [ ] **`.github/CODEOWNERS`** — it names this repository's maintainer, so
      every PR in your fork would request a review from someone who has never
      heard of it.
- [ ] **Repository URLs** — the `repository`/`bugs`/`homepage` fields if you
      add them, plus any absolute link in the docs that points back here.
- [ ] **`README.md`** — this file. The Quickstart, the Docker image name
      (`docker build -t express-boilerplate .`) and this checklist itself.
- [ ] **`SECURITY.md`** — the reporting address, and the "not implemented"
      table once you start implementing those rows.
- [ ] **`.github/domain-terms.txt`** — ships with placeholder terms only;
      the gate that scans for them is generic and worth keeping. Replace
      the placeholders with your own never-commit vocabulary, or delete the
      file and the gate's CI step in `.github/workflows/ci.yml` if you have
      none.
- [ ] **`LICENSE`** — this repository ships a proprietary licence naming
      Mahaverick as the copyright holder. Replace it with your own terms and
      holder, and set `license` in `package.json` to match.

Nothing above is enforced by a gate; it is a five-minute pass that stops a
new project quietly carrying someone else's identity in its metadata.

## Documentation index

| Doc                                | Covers                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit together, what's deliberately not built yet                     |
| [STRUCTURE.md](STRUCTURE.md)       | Where new code goes, directory by directory                                        |
| [DATABASE.md](DATABASE.md)         | Models, migrations, the drizzle-kit workflow                                       |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branch/commit/PR workflow and every gate it has to pass                            |
| [MIGRATIONS.md](MIGRATIONS.md)     | Every major dependency bump taken here (and the ones deliberately deferred)        |
| [CLAUDE.md](CLAUDE.md)             | Gotchas and non-derivable context for anyone (human or agent) working in this repo |
| [AGENTS.md](AGENTS.md)             | Agent-facing entry point; conventions and doc index                                |
| [SECURITY.md](SECURITY.md)         | Security-relevant design decisions and how to report a vulnerability               |

## Docker

```bash
docker build -t express-boilerplate .
docker run --rm -p 4040:4040 --env-file .env \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL=postgres://boilerplate:boilerplate@host.docker.internal:5433/boilerplate \
  -e REDIS_URL=redis://host.docker.internal:6380 \
  express-boilerplate
```

The `-e` overrides matter: `.env`'s `DATABASE_URL`/`REDIS_URL` say
`localhost`, which is correct for `pnpm dev` running on your host but means
"this container" once the app runs inside one — `localhost:5433` from
inside the container has nothing listening on it, since the compose stack
is a sibling container, not this one. `host.docker.internal` is Docker's
DNS name for "the host machine" and reaches the compose stack's published
ports correctly; verified directly, both endpoints return 200 with the
overrides above. Without them (plain `--env-file .env`), `/health` still
returns 200 (it touches neither dependency) and `/health/ready` now fails
fast with 503 in well under a second — `redis.service.ts`'s Redis client
carries a bounded `reconnectStrategy` (`connectTimeout: 5000`, gives up
after a few attempts) specifically so an unreachable Redis is reported
promptly instead of hanging the request indefinitely.

The image itself is multi-stage: the final stage carries only production
dependencies and `dist/`, runs as a non-root user (uid 10001), and has no
shell, `curl`, or TypeScript compiler in it (`pnpm prune --prod
--ignore-scripts`, not `pnpm install --prod`, is what actually removes them
from the pnpm virtual store — verified: no `typescript` under
`/app/node_modules` in the built image). See the comments in
[`Dockerfile`](Dockerfile) for why each stage exists.

## License

Proprietary — all rights reserved. See [`LICENSE`](LICENSE).

`package.json` declares `UNLICENSED`, which is npm's spelling for "not open
source". It is not the same thing as the public-domain "Unlicense", and this
repository being publicly visible grants no right to use, copy, modify or
distribute it. If you are starting a project from this template, replace
`LICENSE` and the `license` field with your own terms — see the "Make this
yours" checklist above.
