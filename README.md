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

- Node.js >= 24 (pinned in [`.nvmrc`](.nvmrc); `devEngines.runtime` in
  `package.json` refuses anything older at `pnpm install` — verified
  empirically: under pnpm 12.4.1, `.npmrc`'s `engine-strict=true` does
  **not** enforce this, despite its name — `pnpm install` exits 0 against a
  Node version well outside `engines.node`. `engine-strict` only governs
  whether an installed dependency's own `engines` mismatch fails the
  install (pnpm docs: <https://pnpm.io/settings/cli#enginestrict>);
  `devEngines.runtime` with `onFail: "error"` is pnpm's own mechanism for
  enforcing the project's own runtime floor
  (<https://pnpm.io/package_json#devenginesruntime>). CI pins Node 24 in
  every workflow regardless.)
- [pnpm](https://pnpm.io) 12.4.1 (pinned via `packageManager` in
  `package.json`; install Corepack and enable it with `npm i -g corepack@0.36.0 && corepack enable` — Node 25+ no longer ships Corepack, so this works on Node 24 and 26 alike)
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

`.env` is loaded for you. `pnpm dev` and `pnpm start` pass
`--env-file-if-exists=.env` to Node, so `.env` is loaded before
`tracing.ts` starts. [`env.config.ts`](src/configs/env.config.ts) also
loads it with [`dotenv`](https://www.npmjs.com/package/dotenv), and only
that file validates it. There is nothing to export by hand; every
command above was run exactly as written, from a clean environment, to
verify this quickstart works end to end. (`.env` loading is skipped under
Vitest specifically — see [CLAUDE.md](CLAUDE.md) — so the test suite's own
environment, assembled by `tests/helpers/setup-global.ts`, is never mixed
with a developer's local `.env`.)

There is no `pnpm bootstrap` — it belongs to a later plan (seeding, admin
user creation). Don't run it; it doesn't exist yet.

## Environment variables

`.env.example` is **generated** from the Zod schema in
[`src/configs/env.config.ts`](src/configs/env.config.ts). Don't edit it by
hand; `pnpm env:example` regenerates it, and the pre-commit hook does so when
`env.config.ts` is staged. Required keys are blank, except `APP_ENV=local`
and `NODE_ENV=development`, which carry a working local value. Keys with a
default carry it. Optional keys with no default are commented out, including
`COOKIE_SECURE` and `LOG_FORMAT`, whose defaults come from `APP_ENV`.

The table is generated from the same schema: each row's text is that
variable's `.describe()`. To change a row, change the schema and regenerate
the table with `pnpm env:table` (see CONTRIBUTING.md).
`tests/unit/readme-env-table.test.ts` fails when the table differs from what
it prints.

| Variable                      | Required | Default                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_ENV`                     | **yes**  | —                      | Which deployment this is: local, dev, qa or prod. Required. COOKIE_SECURE and LOG_FORMAT default from it, and SMTP requires TLS everywhere but local.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NODE_ENV`                    | **yes**  | —                      | Node runtime mode: development, test or production. Required. Express reads it directly, and only production hides stack traces in its built-in error handler, so every APP_ENV but local must run production. test is for the test suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `APP_PORT`                    | no       | `4040`                 | Port the HTTP server listens on. Defaults to 4040.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `APP_URL`                     | **yes**  | —                      | Public origin of this API. Used to build the Google OAuth callback URL (passport.config.ts) — must match a redirect URI registered in Google Cloud Console exactly, including scheme and trailing slash. http://localhost:4040 locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `WEB_URL`                     | **yes**  | —                      | Public origin of the frontend. Email verification links are built from it — the link points at your frontend, which POSTs the token to this API. http://localhost:5173 locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DATABASE_URL`                | **yes**  | —                      | Postgres connection URL. The compose stack publishes Postgres on localhost:5433: postgres://boilerplate:boilerplate@localhost:5433/boilerplate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `REDIS_URL`                   | **yes**  | —                      | Redis connection URL. The compose stack publishes Redis on localhost:6380: redis://localhost:6380.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DB_POOL_MAX`                 | no       | `10`                   | Most open connections in the Postgres pool, per process. Defaults to 10. The test suite sets 2, so its parallel workers stay under Postgres's default 100 connections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DB_STATEMENT_TIMEOUT_MS`     | no       | `30000`                | Milliseconds a single SQL statement may run before Postgres cancels it (statement_timeout). Defaults to 30000 (30s). 0 sends no limit, leaving the server's own setting. A statement_timeout in DATABASE_URL's query string overrides it. PgBouncer, in every pool mode, refuses a startup parameter not listed in its ignore_startup_parameters, so behind it set 0 or list statement_timeout there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JWT_ACCESS_SECRET`           | **yes**  | —                      | Signs and verifies access tokens (token.utilities.ts). Any 32+ character string works; use `openssl rand -hex 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SESSION_SECRET`              | **yes**  | —                      | Signs the express-session cookie used during the Google OAuth round-trip (passport.config.ts). Any 32+ character string works; use `openssl rand -hex 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GOOGLE_CLIENT_ID`            | no       | —                      | Google OAuth 2.0 client ID. When absent, Google login is disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GOOGLE_CLIENT_SECRET`        | no       | —                      | Google OAuth 2.0 client secret. Required when GOOGLE_CLIENT_ID is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ACCESS_TOKEN_TTL`            | no       | `15m`                  | Access token lifetime, as an ms()-parseable duration string (e.g. "15m"). Defaults to 15m.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `REFRESH_TOKEN_TTL`           | no       | `30d`                  | Refresh token lifetime, as an ms()-parseable duration string (e.g. "30d"). Defaults to 30d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SESSION_ABSOLUTE_TTL`        | no       | `30d`                  | Hard ceiling on one login session, measured from the login itself and never reset by rotation, as an ms()-parseable duration string (e.g. "30d"). Past it, refreshing fails and the user signs in again. Defaults to 30d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EMAIL_VERIFICATION_TTL`      | no       | `24h`                  | How long an email-verification link stays valid. Defaulted to 24h; a link the user finds the next morning should still work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PASSWORD_RESET_TTL`          | no       | `1h`                   | How long a password-reset link stays valid. Defaulted to 1h — shorter than EMAIL_VERIFICATION_TTL, because redeeming it grants immediate account takeover rather than merely proving mailbox ownership.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `INVITATION_TTL`              | no       | `7d`                   | How long a tenant invitation link stays valid, as an ms()-parseable duration string (e.g. "7d"). Resending an invitation issues a new link with a fresh lifetime. Defaults to 7d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `TRUST_PROXY`                 | no       | `false`                | How much of X-Forwarded-For to believe. "false" (default) trusts none: correct when clients reach this app directly, WRONG behind a proxy, where every IP-keyed rate limiter then shares one bucket for the whole deployment. Behind a proxy set the NUMBER of proxies in front of this app (e.g. "1"), or a comma-separated list of trusted proxy addresses/subnets or presets ("loopback", "linklocal", "uniquelocal"). Never "true" — it is refused, because it lets any client spoof its own IP and bypass the limiters.                                                                                                                                                                                                                                                                                                                                                   |
| `COOKIE_SECURE`               | no       | —                      | Whether the refresh-token and OAuth session cookies carry the Secure attribute ("true" or "false"). Defaults from APP_ENV: false on local, true elsewhere. With Secure on behind a TLS-terminating proxy, TRUST_PROXY must be set, or the OAuth session cookie is never sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `COOKIE_DOMAIN`               | no       | —                      | Domain attribute for the refresh-token and OAuth session cookies, e.g. "example.com" to share them with subdomains. Unset means host-only cookies, the narrowest scope. Boot refuses a value that APP_URL's host is not within, since browsers would reject the cookies. Setting it on a deployment with live sessions heals itself: every response that sets or clears the refresh cookie also clears the host-only one. Changing or unsetting it leaves the old domain's refresh cookie in browsers. The API reads the most recently created refreshToken cookie, which is the current one, so the old one is ignored and expires within REFRESH_TOKEN_TTL. Reverting to an earlier value is the exception: the browser keeps that cookie's original creation time, so the other scope's cookie reads as newer and refresh fails until the user logs in again or it expires. |
| `CORS_ALLOWED_ORIGINS`        | no       | —                      | Extra browser origins allowed to call this API, comma-separated (e.g. "https://admin.example.com,https://shop.example.com"). WEB_URL is ALWAYS allowed and does not need listing here, and same-origin requests send no Origin header at all. Leave empty for a single-frontend deployment. Never a wildcard: this API sends credentials, and the CORS spec forbids "*" with credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no       | —                      | Absent means tracing is disabled; the SDK is never started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `OTEL_SERVICE_NAME`           | no       | `express-boilerplate`  | Service name reported in OTEL traces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `LOG_LEVEL`                   | no       | `info`                 | Console log level: error, warn, info or debug. silent disables logging entirely (the test suite uses it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LOG_FORMAT`                  | no       | —                      | Console log format: json or pretty. Defaults from APP_ENV: pretty on local, json elsewhere. pretty needs the pino-pretty devDependency; without it the logger writes json.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SLACK_WEBHOOK_URL`           | no       | —                      | Slack Incoming Webhook URL for log alerting. When unset, no Slack transport is registered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SLACK_LOG_LEVEL`             | no       | `error`                | Minimum log level that triggers a Slack notification. Defaults to error; set to warn if you want Slack alerts for warnings too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `WORKER_ENABLED`              | no       | `true`                 | Whether the BullMQ workers (email + notification) start in-process alongside the HTTP server. Set to false for API-only pods behind a load balancer; a separate worker deployment sets this to true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `WORKER_CONCURRENCY`          | no       | `5`                    | Jobs each BullMQ worker (email, notification) processes at once, per process. Defaults to 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `REDIS_KEY_PREFIX`            | no       | `express-boilerplate`  | Namespace for every Redis key and channel this app uses: BullMQ queues (`<prefix>:bull`), rate-limit counters (`<prefix>:rl`), the session denylist (`<prefix>:denylist`), OAuth sessions (`<prefix>:sess`) and the notification channel (`<prefix>:notifications`). Lowercase letters, digits, ":", "_" and "-", with no trailing colon. Give each app or environment sharing one Redis its own value; changing it abandons every existing key.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SSE_HEARTBEAT_INTERVAL_MS`   | no       | `30000`                | Milliseconds between `:ping` heartbeat comments on an open notification SSE stream (notification-stream.controller.ts). Defaults to 30000 (30s).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SSE_MAX_STREAMS_PER_USER`    | no       | `5`                    | Most notification SSE streams one user may hold open at once, per process. A request over the cap gets 429 too_many_streams. Defaults to 5 (several tabs and devices).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SMTP_HOST`                   | no       | `localhost`            | SMTP server host. Defaults to localhost, where the compose Mailpit service listens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SMTP_PORT`                   | no       | `1025`                 | SMTP server port. Defaults to 1025 — Mailpit's SMTP port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SMTP_USERNAME`               | no       | —                      | SMTP username. Absent means no authentication is attempted, which is correct for Mailpit and wrong for most real providers. Set it together with SMTP_PASSWORD: boot refuses one without the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SMTP_PASSWORD`               | no       | —                      | SMTP password. Set it together with SMTP_USERNAME: boot refuses one without the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MAIL_FROM`                   | no       | `no-reply@example.com` | The From address on every outbound email. Mailpit accepts any value; a real provider may require this to be a verified sender.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `APP_NAME`                    | no       | `Express Boilerplate`  | Product name in outbound email copy and notification text: verification, password reset, password changed and invitation messages (auth.controller.ts, verification-mail.utilities.ts, tenant-invitation.service.ts). Defaults to "Express Boilerplate".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SMTP_CONNECTION_TIMEOUT_MS`  | no       | `3000`                 | Milliseconds to wait for each SMTP connection attempt to establish before failing. Also the timeout for the first try of each DNS query; the resolver doubles it on each retry, and the OS-lookup fallback has no timeout. A host that resolves to several addresses can take it once per address. Boot checks that it plus SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS and the 5s HTTP drain stays at least 5s under SHUTDOWN_TIMEOUT_MS; that assumes one address and is a sanity check, not a per-send deadline. nodemailer's own defaults are 2 minutes to connect and 30 seconds per DNS query.                                                                                                                                                                                                                                                                      |
| `SMTP_GREETING_TIMEOUT_MS`    | no       | `5000`                 | Milliseconds to wait for the SMTP server's greeting after connecting. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 30 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SMTP_SOCKET_TIMEOUT_MS`      | no       | `7000`                 | Milliseconds of inactivity before an open SMTP connection is closed. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 10 minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SHUTDOWN_TIMEOUT_MS`         | no       | `25000`                | Milliseconds graceful shutdown may take before the process exits with code 1 anyway. Defaults to 25000, under Kubernetes' default 30s termination grace period.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### `APP_ENV` and `NODE_ENV`

`APP_ENV` names the deployment: `local`, `dev`, `qa` or `prod`. It has no
default, and boot fails without it. A `.env` copied from an older
`.env.example` needs `APP_ENV=local` added. The Docker image sets
`NODE_ENV=production` but not `APP_ENV`, so the deployment must supply it.

`NODE_ENV` is what Express itself reads; it must be `production` in every
environment except `local`.

|                                                                                           | `local`  | `dev`, `qa`, `prod` |
| ----------------------------------------------------------------------------------------- | -------- | ------------------- |
| `COOKIE_SECURE` when unset                                                                | `false`  | `true`              |
| `LOG_FORMAT` when unset                                                                   | `pretty` | `json`              |
| SMTP must upgrade to TLS                                                                  | no       | yes                 |
| `NODE_ENV` other than `production`                                                        | allowed  | refused at boot     |
| `SMTP_HOST` `localhost`/`127.0.0.1`, `SMTP_PORT` 1025, `MAIL_FROM` `no-reply@example.com` | allowed  | refused at boot     |
| SMTP timeouts summing to more than `SHUTDOWN_TIMEOUT_MS` − 10000                          | warning  | refused at boot     |
| Trace attribute `deployment.environment.name`                                             | `local`  | the `APP_ENV` value |

The 10000 is the 5-second HTTP drain that runs before the in-flight send is
awaited, plus 5 seconds of headroom for closing the database, Redis and queues and
flushing traces. The timeouts bound each connection attempt, the greeting
and socket inactivity, and the first try of each DNS query. They are not a
per-send deadline: the resolver doubles the DNS timeout on each retry, the
OS-lookup fallback has no timeout, and a host that resolves to several
addresses can take the connection timeout once per address. The check
assumes one address and no DNS delay, so it is a sanity check.

Everywhere:

- setting only one of `SMTP_USERNAME` and `SMTP_PASSWORD` is refused;
- a `COOKIE_DOMAIN` that `APP_URL`'s host is neither equal to nor a
  subdomain of is refused, because browsers reject every auth cookie it
  would set;
- a renamed variable's old name is refused, with a message naming the new
  one (see MIGRATIONS.md);
- `COOKIE_SECURE` resolving to `true` while `GOOGLE_CLIENT_ID` is set and
  `TRUST_PROXY=false` logs a warning (see SECURITY.md).

### Secrets

`JWT_ACCESS_SECRET` signs access tokens. `SESSION_SECRET` signs the session
cookie of the Google OAuth round-trip. Both are read. Generate each with
`openssl rand -hex 32`, even in development.

There is no `JWT_REFRESH_SECRET`: refresh tokens are opaque random strings,
not JWTs, so nothing ever signs one with a secret — see
[SECURITY.md](SECURITY.md).

### Invalid configuration fails before anything starts

Unsetting or malforming any variable fails fast with a named list, not a
stack trace. Dropping `JWT_ACCESS_SECRET` prints

```
Invalid environment:
✖ Invalid input: expected string, received undefined
  → at JWT_ACCESS_SECRET
```

and exits 1 before any socket opens. After the schema parses, `index.ts`
runs `assertEnvConsistent`
([`src/configs/env-consistency.config.ts`](src/configs/env-consistency.config.ts)),
which refuses the combinations above. It lists every problem in one
message, each naming the variable and the fix, and exits 1.

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

| Script                              | What it does                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`                          | Runs the app with `tsx watch`, `--import`-ing `src/observability/tracing.ts` first (no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set — see CLAUDE.md). Loads `.env` before tracing starts — see Quickstart. |
| `pnpm build`                        | `tsc` then `tsc-alias --resolve-full-paths` into `dist/`.                                                                                                                                                    |
| `pnpm start`                        | Runs the built app: `node --env-file-if-exists=.env --import ./dist/observability/tracing.js dist/index.js`.                                                                                                 |
| `pnpm lint`                         | `eslint .` then `tsc -p tsconfig.typecheck.json --noEmit` — that config is a strict superset of `tsconfig.json`'s `include`, so it covers `src/` and `tests/` in one pass.                                   |
| `pnpm lint:fix`                     | `eslint . --fix`.                                                                                                                                                                                            |
| `pnpm format` / `pnpm format:check` | Prettier over the whole repo (`.` minus `.prettierignore`), `tests/` included.                                                                                                                               |
| `pnpm test`                         | `vitest run`.                                                                                                                                                                                                |
| `pnpm test:watch`                   | `vitest watch`.                                                                                                                                                                                              |
| `pnpm test:unit`                    | Every test except `tests/integration/**`, with no database setup, so it runs with Docker down. The git hooks run this config.                                                                                |
| `pnpm test:coverage`                | `vitest run --coverage`, gated at 80% lines/functions/branches/statements.                                                                                                                                   |
| `pnpm env:example`                  | Regenerates `.env.example` from the Zod schema.                                                                                                                                                              |
| `pnpm env:table`                    | Prints README's environment table from the Zod schema.                                                                                                                                                       |
| `pnpm db:migration:generate`        | `drizzle-kit generate` — writes a new migration from the model files. See [DATABASE.md](DATABASE.md).                                                                                                        |
| `pnpm db:migrate`                   | Applies pending migrations (`tsx src/database/migrate.ts`) against `DATABASE_URL`. See [DATABASE.md](DATABASE.md).                                                                                           |
| `pnpm db:migrate:prod`              | Same as `pnpm db:migrate`, against the built output (`node dist/database/migrate.js`) — what the production image and CI run.                                                                                |
| `pnpm commit`                       | Interactive conventional-commit prompt (`commitizen` + `@commitlint/cz-commitlint`).                                                                                                                         |

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

## Deploying

A push to `main` runs [`deploy.yml`](.github/workflows/deploy.yml), which
calls `ci.yml` as a gate and, once it passes, builds and pushes
`ghcr.io/<repo>:sha-<commit>` and `:main` to GHCR with an SBOM and build
provenance attestation. The `deploy` job itself is a placeholder — no
deployment target has been chosen yet. A manual `workflow_dispatch` from
another branch only pushes the sha-tagged image — the `:main` tag and the
`deploy` job both run only from `main`. Releases are automatic: every `feat`
or `fix` merge is released as `vX.Y.Z` once the release PR's checks pass,
and the digest `main` already built gains `:X.Y.Z`, `:X.Y` and `:X` tags —
nothing is rebuilt (see
[CONTRIBUTING.md](CONTRIBUTING.md#releases) — it needs a release GitHub App).

Four things need doing by hand, once, before any of this is live:

- **Install the [Renovate GitHub App](https://github.com/apps/renovate)**
  on this repository. `renovate.json` is inert without it — nothing
  schedules or opens Renovate PRs until the app is installed.
- **Create and install a release GitHub App** on this repository, with
  Contents and Pull requests read/write. Set its client ID as the repo
  variable `RELEASE_APP_CLIENT_ID` and its private key as the secret
  `RELEASE_APP_PRIVATE_KEY`; `release.yml` fails without them.
- **Set the merge rules** (Settings → General, then Settings → Rules).
  Enable "Allow auto-merge"; allow squash merging only, with the commit
  title set to the PR title and the commit message left blank; and add a
  ruleset on `main` requiring the checks `lint`, `test`, `docker`,
  `gitleaks` and `pr-title`. Without the ruleset, `release.yml`'s fallback
  merges the release PR without waiting for CI; without the blank squash
  message, each squash body would carry the branch's commit list, which
  release-please reads as extra conventional commits.
- **Add protection rules to the `production` GitHub Environment**
  (Settings → Environments → `production`) — at minimum, required
  reviewers — before replacing the placeholder `deploy` step with a real
  deployment target. Until then, anything merged to `main` would deploy
  unreviewed the moment that step does something real.

## License

Proprietary — all rights reserved. See [`LICENSE`](LICENSE).

`package.json` declares `UNLICENSED`, which is npm's spelling for "not open
source". It is not the same thing as the public-domain "Unlicense", and this
repository being publicly visible grants no right to use, copy, modify or
distribute it. If you are starting a project from this template, replace
`LICENSE` and the `license` field with your own terms — see the "Make this
yours" checklist above.
