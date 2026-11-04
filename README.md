# Express Boilerplate

An Express 5 API boilerplate for production use, written in TypeScript. This
README is for developers who clone it: it says what the API ships, how to run
it locally, and how to operate each feature.

The platform layer has:

- Drizzle ORM (object-relational mapper) on Postgres, and Redis.
- An environment that is validated at boot.
- A documented HTTP error contract.
- OpenTelemetry traces and logs.
- Git hooks and a continuous integration (CI) pipeline that enforce all of it.

The product features on top of it are:

- Sign-in by emailed link, which creates the account on the first click.
- Optional Google sign-in, and passkeys.
- A "Confirm it's you" step, by emailed link or passkey, for every signed-in
  user.
- JSON Web Token (JWT) access tokens with rotating opaque refresh tokens.
- Multi-tenancy, with roles and emailed invitations.
- An audit log and platform staff access.
- In-app notifications over server-sent events (SSE).
- BullMQ jobs and a daily data-retention purge.
- A staff directory, email delivery tracking, onboarding, PostHog analytics,
  feature flags and a maintenance mode.

How the code is built is in [ARCHITECTURE.md](ARCHITECTURE.md).
[SECURITY.md](SECURITY.md) lists the defences, and under
[what it does not implement](SECURITY.md#what-this-boilerplate-does-not-implement)
it lists what is left to you.

## Requirements

You need three tools before the Quickstart.

- **Node.js >= 26**, pinned in [`.node-version`](.node-version).
  `devEngines.runtime` in `package.json` makes `pnpm install` refuse an older
  Node.
- **[pnpm](https://pnpm.io) 12.16.1**, pinned by `packageManager` in
  `package.json`. Use pnpm only. Node 25 and later do not bundle Corepack, so
  install it first: `npm i -g corepack@0.36.0 && corepack enable`.
- **Docker**, for the local Postgres, Redis, OpenTelemetry, Tempo, Loki,
  Grafana and Mailpit stack
  ([Local infrastructure](ARCHITECTURE.md#local-infrastructure)).

## Quickstart

These steps run the API on your machine, with Postgres, Redis and Mailpit in
Docker. To run the frontends in Docker too, follow these steps first, then
[Run everything with Docker](#run-everything-with-docker).

```bash
pnpm install
docker compose up -d --wait
cp .env.example .env    # then fill in the blank required values below
pnpm db:migrate
pnpm dev
```

1. `pnpm install` installs the dependencies and the git hooks.
2. `docker compose up -d --wait` starts the infrastructure only, and returns
   once each service is healthy.
3. `cp .env.example .env` creates your `.env`. `.env.example` already sets
   `APP_ENV=local` and `NODE_ENV=development`. Fill in the 6 blank required
   values:

   ```bash
   APP_URL=http://localhost:4040
   WEB_URL=http://localhost:5173
   DATABASE_URL=postgres://boilerplate:boilerplate@localhost:5433/boilerplate
   REDIS_URL=redis://localhost:6380
   JWT_ACCESS_SECRET=   # openssl rand -hex 32
   SESSION_SECRET=      # openssl rand -hex 32
   ```

   The two secrets take any string of 32 or more characters; run
   `openssl rand -hex 32` once for each. If you run the Apex staff dashboard
   (apex-boilerplate) as well, also uncomment `APEX_URL` and set it to
   `http://localhost:5174`.

4. `pnpm db:migrate` applies the migrations to the compose Postgres.
5. `pnpm dev` starts the API on `APP_PORT` (4040), with hot reload.

The app loads `.env` for you (see
[Configuration](ARCHITECTURE.md#configuration)). `pnpm dev` stops at boot and
names each required variable that is missing.

Check that the API is up:

```bash
curl http://localhost:4040/health/ready   # {"status":"ready","checks":{...}}; 503 when a dependency is down
```

| Local service                                                          | Address                 |
| ---------------------------------------------------------------------- | ----------------------- |
| API                                                                    | <http://localhost:4040> |
| Mailpit (web inbox for all mail)                                       | <http://localhost:8025> |
| Mailpit SMTP (Simple Mail Transfer Protocol), where the API sends mail | `127.0.0.1:1025`        |
| Grafana (traces and logs, once `OTEL_EXPORTER_OTLP_ENDPOINT` is set)   | <http://localhost:3100> |
| Postgres                                                               | `localhost:5433`        |
| Redis                                                                  | `localhost:6380`        |

### Sign in

Locally, no mail leaves your machine: the API sends every email, sign-in links
included, to Mailpit. Open the inbox at <http://localhost:8025>.

1. Request a sign-in link:

   ```bash
   curl -X POST http://localhost:4040/api/v1/auth/link/request \
     -H 'Content-Type: application/json' \
     -d '{"email":"grace@example.com","app":"web"}'
   ```

   The API answers `202` with the same body for every address, then mails the
   link.

2. Open the link from Mailpit, or take the token from the newest message and
   verify it:

   ```bash
   TOKEN=$(curl -s http://localhost:8025/api/v1/message/latest \
     | grep -oE 'token=[A-Za-z0-9_-]{43}' | head -1 | cut -d= -f2)

   curl -X POST http://localhost:4040/api/v1/auth/link/verify \
     -H 'Content-Type: application/json' \
     -d "{\"token\":\"$TOKEN\",\"email\":\"grace@example.com\"}"
   ```

3. Verify answers `data.user` and `data.accessToken`, and sets the
   refresh-token cookie. The first click for an address creates its account
   (`isNewUser: true`).
4. Send `Authorization: Bearer <accessToken>` to reach an authenticated route
   such as `GET /api/v1/profile`.

A link works once and expires after 15 minutes; repeat step 1 for a new one.
Every `/api/v1/auth` route refuses a non-JSON body with 415.

**Passkeys.** `PASSKEY_MODE` sets whether users sign in with passkeys:

| `PASSKEY_MODE`       | Effect                                                          |
| -------------------- | --------------------------------------------------------------- |
| `optional` (default) | A signed-in person may create a passkey and sign in with it.    |
| `off`                | The passkey routes are hidden.                                  |
| `required`           | Every account creates a passkey before it can do anything else. |

- Create a passkey with `POST /api/v1/auth/passkeys/registration/options`, then
  `/registration/verify`.
- Sign in with it through `POST /api/v1/auth/passkeys/sign-in/options`, then
  `/sign-in/verify`.
- `GET /api/v1/auth/passkeys/config` answers the mode.

`WEBAUTHN_RP_ID`, the relying party ID (RP ID) a passkey is bound to, defaults
to the host of `WEB_URL`. Set it to a parent domain when `APEX_URL` sits on
another subdomain. The API refuses an IP address as an RP ID. A browser has to
run the passkey ceremony, so the curl flow above covers links only.

Sensitive actions ask a signed-in user to confirm it's them within 10 minutes.
They confirm by emailed link (`POST /api/v1/auth/step-up/link/request` with
`{"app":"web"}`) or by passkey (`/api/v1/auth/passkeys/step-up/options`). The
rules are in [SECURITY.md](SECURITY.md#passkeys), and the rest of the request
path is in [ARCHITECTURE.md](ARCHITECTURE.md#request-path-auth-and-beyond).

## Run everything with Docker

`docker-compose.yml` can also run this API, react-boilerplate and
apex-boilerplate together, through two compose profiles. Plain
`docker compose up -d --wait` starts only the infrastructure.

1. **Check out the frontends beside this repo.** The frontends build from
   `../react-boilerplate` and `../apex-boilerplate`. Point elsewhere with
   `REACT_DIR` and `APEX_DIR`, for example
   `REACT_DIR=~/code/react-boilerplate docker compose --profile dev up`.
2. **Create `.env` first**, from `.env.example`, with the 6 values in the
   [Quickstart](#quickstart). The API containers read this repo's `.env`.
   Without it, any `--profile dev` or `--profile prod` command stops with
   "env file … not found".
3. **Set the frontend origins in `.env`.** Keep `WEB_URL=http://localhost:5173`,
   and uncomment `APEX_URL` and set it to `http://localhost:5174`. The API
   builds Apex sign-in links from `APEX_URL`.
4. **Stop anything on ports 4040, 5173 and 5174**, such as a host `pnpm dev`
   or a frontend dev server.
5. **Start one profile:**

   ```bash
   docker compose --profile dev up           # hot reload, source mounted
   docker compose --profile prod up --build  # the real images, no hot reload
   ```

6. **Sign in.** Open the React app at <http://localhost:5173> or Apex at
   <http://localhost:5174> and request a sign-in link. The link arrives in
   Mailpit at <http://localhost:8025>.

Compose overrides only what differs inside its network: `DATABASE_URL`,
`REDIS_URL`, `SMTP_HOST`, `SMTP_PORT` and `APP_PORT`. Every other value comes
from your `.env`. Tracing stays off unless `.env` sets
`OTEL_EXPORTER_OTLP_ENDPOINT`, and from inside the network that has to be
`http://otel-collector:4318`.

| Profile | Services                                                | API, React, Apex                         |
| ------- | ------------------------------------------------------- | ---------------------------------------- |
| `dev`   | `api-dev`, `react-dev`, `apex-dev`                      | `localhost:4040`, `:5173`, `:5174`       |
| `prod`  | `migrate`, `api`, `react`, `apex`, from each Dockerfile | the same ports; nginx serves the clients |

- **`dev`** runs each repo's source, bind-mounted, in the `node:26-alpine`
  image the `Dockerfile` pins. Each repo's `node_modules` sits in its own named
  volume, so the container keeps Linux binaries. `api-dev` runs migrations,
  then `pnpm dev`; the frontends run Vite. Edits reload as they do on the
  host. The first run installs every dependency, which takes 1 to 2 minutes;
  later runs reuse the volumes.
- **`prod`** builds the three images. `migrate` runs
  `node dist/database/migrate.js` once, and `api` starts after it succeeds.
  The frontends run read-only with a tmpfs `/tmp` and proxy `/api` to `api`.
  The build skips the source-map upload, since no PostHog project is set.
- **One profile at a time.** Both profiles publish 4040, 5173 and 5174 on
  `127.0.0.1`, as do the dev servers on the host.
- **Why the frontends share `api-dev`'s network.** Both Vite configs proxy
  `/api` to `http://localhost:4040`. So `react-dev` and `apex-dev` run with
  `network_mode: service:api-dev`, where `localhost:4040` is the API, and their
  ports are published on `api-dev`. If `api-dev` is recreated, run
  `docker compose --profile dev up -d` again so the frontends rejoin it.

Stop with `docker compose --profile dev down` (or `--profile prod`).
`down -v` also deletes the volumes: the `node_modules` volumes, Tempo's data
and the database. That database is the same one a host `pnpm dev` uses.

## Environment variables

Every variable, with its default and what it does, is in the table in
[ARCHITECTURE.md](ARCHITECTURE.md#environment-variables). The table and
`.env.example` are both generated from the Zod schema in
`src/configs/env.config.ts`. The Quickstart needs only the 6 values above.

These optional variables have their own sections:

| Variable                                                                    | Section                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `APEX_URL`                                                                  | [A second frontend: Apex](ARCHITECTURE.md#a-second-frontend-apex)     |
| `RESEND_WEBHOOK_SECRET`, `MAIL_FROM`, `MAIL_FROM_TRANSACTIONAL`             | [Email tracking](#email-tracking)                                     |
| `POSTHOG_*`                                                                 | [Analytics (PostHog)](#analytics-posthog)                             |
| `RATE_LIMIT_SCALE` (end-to-end runs on `APP_ENV=local` only)                | [SECURITY.md](SECURITY.md#rate-limiting-one-store-prefix-per-limiter) |
| `CURSOR_SECRET` (signs list cursors)                                        | [Lists](#lists); required on every `APP_ENV` but `local`              |
| `TRUST_PROXY`                                                               | Set it for any deployment behind a proxy ([Deploy](#deploy))          |
| `MINIMUM_APP_VERSION_*`, `WEBAUTHN_ANDROID_ORIGINS`, `WEBAUTHN_IOS_ENABLED` | [Native apps](#native-apps)                                           |
| `ACCOUNT_DELETION_DAYS`                                                     | [Account deletion](#account-deletion)                                 |

## Native apps

The iOS and Android apps call the same routes as the web app. An app sends
`X-Client: native`, keeps its refresh token in the response body and sends it
back in the body of `POST /api/v1/auth/refresh`. It sets no cookie. It may send
`X-Device-Name` when it signs in, so the user sees which device holds each
session in `GET /api/v1/auth/sessions`. The rules are in
[SECURITY.md](SECURITY.md#native-clients), and the request path is in
[ARCHITECTURE.md](ARCHITECTURE.md#native-clients).

| Variable                      | Effect                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `MINIMUM_APP_VERSION_IOS`     | The oldest iOS version the app should allow, as `1.2.3`. The server publishes it; the app enforces it. Unset means no minimum. |
| `MINIMUM_APP_VERSION_ANDROID` | The same for Android.                                                                                                          |
| `WEBAUTHN_ANDROID_ORIGINS`    | Comma-separated Android passkey origins, each `android:apk-key-hash:` and 43 base64url characters. Unset means none.           |
| `WEBAUTHN_IOS_ENABLED`        | `true` lets the iOS app use passkeys. Boot refuses it when `WEBAUTHN_RP_ID` is set to anything but the host of `WEB_URL`.      |

**The minimum app version.** `GET /api/v1/status/client-settings` answers
`minimumAppVersion` as `{ "ios": "1.2.3" | null, "android": "1.2.3" | null }`.
The response is cacheable for 300 seconds (`Cache-Control: public,
max-age=300`). So a new minimum reaches devices within 5 minutes. The server
only publishes the value and refuses no request for it. The app compares its
own version and asks the user to update.

**The Android signing hash.** Android binds a passkey ceremony to the key that
signed the app, and sends it as the origin `android:apk-key-hash:<hash>`. The
hash is the SHA-256 digest of the signing certificate, base64url encoded with
no padding. Each environment lists only its own keys:

| Environment           | Where the hash comes from                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Production            | The Play App Signing key, on the App signing page of the Play Console                                           |
| Play internal testing | The same Play App Signing key                                                                                   |
| EAS preview builds    | The preview keystore: run `eas credentials` and read its SHA-256 fingerprint                                    |
| Local debug builds    | The debug key: `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android` |

Production holds only the Play App Signing key. Never list the upload key, the
EAS preview keystore or a debug key there: anyone who holds one could sign an
app that passes the passkey origin check. The upload key signs what you send to
Google, and users never install an app signed with it.

To turn a fingerprint into the hash, drop the colons, decode the hex and
encode it as base64url:

```sh
echo "AA:BB:…:99" | tr -d ':' | xxd -r -p | openssl base64 -A | tr '+/' '-_' | tr -d '='
```

## Account deletion

A signed-in customer asks to delete their account with
`POST /api/v1/account/deletion-request`, after confirming it's them. The
answer carries `dueAt`: the request time plus `ACCOUNT_DELETION_DAYS` days
(default 30, at most 30). They get a receipt email. Platform admins get an alert,
and a daily job at 04:00 UTC alerts them about requests due within 5 days.

Staff complete a request with `DELETE /api/v1/platform/users/:id` in Apex. That
marks it completed and emails the customer. It does not cancel a paid
subscription, so cancel one first. The rules are in
[SECURITY.md](SECURITY.md#account-deletion).

## Available scripts

| Script                              | What it does                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | `tsx watch` on `src/index.ts`, loading `.env` and then `src/observability/tracing.ts` first.                      |
| `pnpm build`                        | Removes `dist/`, runs `tsc` and `tsc-alias` on `tsconfig.build.json`, and copies the migrations.                  |
| `pnpm start`                        | Runs the build, loading `.env` and `dist/observability/tracing.js` first.                                         |
| `pnpm lint`                         | `vp check` (Oxlint, Oxfmt), the untyped ESLint, then `tsc --noEmit` (`tsconfig.json`).                            |
| `pnpm lint:fix`                     | `vp check --fix`, then `eslint . --fix`.                                                                          |
| `pnpm typecheck`                    | `tsc --noEmit` over `src/`, `tests/` and `drizzle.config.ts` (`tsconfig.json`).                                   |
| `pnpm lint:docs`                    | History phrasing and broken links in docs; code citing a missing doc.                                             |
| `pnpm knip`                         | Unused files, exports, types and dependencies (`knip.jsonc`).                                                     |
| `pnpm format`                       | `vp fmt .` (Oxfmt) over the whole repo.                                                                           |
| `pnpm format:check`                 | `vp fmt --check .`.                                                                                               |
| `pnpm env:example`                  | Regenerates `.env.example` from the Zod schema.                                                                   |
| `pnpm env:table`                    | Prints ARCHITECTURE.md's environment table from the Zod schema.                                                   |
| `pnpm db:migration:generate`        | `drizzle-kit generate`; see [DATABASE.md](DATABASE.md).                                                           |
| `pnpm db:migrate`                   | Applies pending migrations against `DATABASE_URL`.                                                                |
| `pnpm db:migrate:prod`              | The same, as `node dist/database/migrate.js` from the build.                                                      |
| `pnpm platform:grant -- <e> <role>` | Gives an address a role in the platform tenant, creating its account; see below.                                  |
| `pnpm email:fire-event <id> <type>` | Signs and posts a fake provider event (local only); see [Email tracking](#email-tracking).                        |
| `pnpm onboarding:reconcile`         | Re-derives tracked tenants' automatic onboarding steps; see [Onboarding](#onboarding).                            |
| `pnpm analytics:backfill-groups`    | Queues every tenant's PostHog group properties; see [Analytics (PostHog)](#analytics-posthog).                    |
| `pnpm flags:sync [-- --dry-run]`    | Creates registered feature flags missing from PostHog; see [Feature flags](#feature-flags).                       |
| `pnpm billing:seed`                 | Creates 13 workspaces, one per billing state (local only); see [Billing dev seed](#billing-dev-seed).             |
| `pnpm billing:time-travel -- …`     | Moves one workspace's billing dates back (local only); see [Billing dev seed](#billing-dev-seed).                 |
| `pnpm billing:tax-reconcile`        | Dry-runs the tax documents owed; `--apply` queues them; see [Tax documents](#tax-documents-dry-run-and-backfill). |
| `pnpm test`                         | `vp test run`: both Vitest projects. Needs the compose stack.                                                     |
| `pnpm test:unit`                    | The `unit` project: every test but `tests/integration/**`, no global setup; runs with Docker down.                |
| `pnpm test:integration`             | The `integration` project: `tests/integration/**`, with the per-worker databases. Needs the stack.                |
| `pnpm test:watch`                   | `vp test watch`.                                                                                                  |
| `pnpm test:coverage`                | `vp test run --coverage`, gated at 80% on lines, functions, branches and statements.                              |
| `pnpm gate`                         | The pre-push gate: lint, docs, knip, domain terms, coverage, build. Needs the compose stack.                      |
| `pnpm push [args]`                  | Runs `pnpm gate`, then `git push --no-verify` with your arguments.                                                |
| `pnpm scrub:gate <mode>`            | The error scrubber's differential gate, run by hand at review time (`tests/helpers/scrub-gate.ts`).               |
| `pnpm commit`                       | Interactive conventional-commit prompt (`cz`).                                                                    |
| `pnpm prepare`                      | Installs the Vite+ git hooks (`vp config`); `pnpm install` runs it.                                               |

**The first platform owner.** Nobody can invite staff before a platform owner
exists, so `pnpm platform:grant -- <email> <role>` makes the first one. It
gives the account at an address a role (`owner` to `viewer`) in the platform
tenant, audited as `platform.member.granted`.

- An address with no account gets a verified one, audited as `user.created`.
- An unverified account is claimed the way a sign-in link claims it: its
  federated links are removed, its sessions end and the address is verified.

The hooks, commit format and CI are in [CONTRIBUTING.md](CONTRIBUTING.md).

### Billing dev seed

`pnpm billing:seed` creates local workspaces in every billing state, so you can
see each screen without a payment provider. It runs only on `APP_ENV=local`
with `BILLING_FAKE_PROVIDER=true`, and refuses anything else.

It creates 13 workspaces with `billing-*` slugs. All are owned by
`billing-owner@example.test`, with members `billing-member-1@example.test` to
`billing-member-4@example.test`. Sign in as any of them with a link from
Mailpit.

| Slug                         | State                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| `billing-trial-10-days`      | Trialing, 10 days left                                                    |
| `billing-trial-1-day`        | Trialing, 1 day left                                                      |
| `billing-trial-ended`        | Free after its trial ended 2 days ago                                     |
| `billing-free-under-limit`   | Free, 2 of 3 members                                                      |
| `billing-free-over-limit`    | Free with 5 members, after a paid plan was cancelled                      |
| `billing-active-monthly`     | Paid monthly; staff see a refunded duplicate subscription alert           |
| `billing-yearly-cancelling`  | Paid yearly, cancelling at the period end                                 |
| `billing-past-due-pending`   | Past due: the renewal failed and the provider is retrying                 |
| `billing-past-due-halted`    | Past due: the provider halted it, about 2 days of grace left              |
| `billing-customer-cancelled` | Paid until the period end: the payer cancelled from their bank or UPI app |
| `billing-interval-switch`    | Paid monthly, switching to yearly at the period end                       |
| `billing-free-grant`         | Free with 4 members on a 10-member grant that ends in 3 days              |
| `billing-upgrade-request`    | Free and full, with a member's open upgrade request                       |

UPI is India's Unified Payments Interface.

- Paid workspaces get subscriptions on the fake provider in the matching
  status, so a sync keeps each one where the seed put it.
- The seed writes rows directly and sends no email, notification or analytics
  event.
- It prints each slug, id and state.
- Run it again to put every workspace back. It keeps their ids, restores each
  one's name and makes a suspended one active again. It resets their billing,
  members, grants, requests, alerts and history, and ends the fake
  subscriptions it replaces.

**Time travel.** `pnpm billing:time-travel -- --tenant <slug> --days <n>`
(local only) moves one workspace's dates back `n` days. It moves:

- the trial start and end, period end, past-due, halt and pause dates;
- the period end its renewal reminder was sent for;
- its state history, so the win-back emails count from the moved move to Free;
- its fake subscriptions' dates.

It then queues a sync of the workspace and one billing run. A running worker
(`pnpm dev`) takes them within seconds, so a trial moved past its end goes to
Free.

- The fake never charges a subscription by itself. After a scheduled switch
  hands over, the new subscription stays unpaid on the fake.
- The other reminder and notice stamps do not move. One already sent stays
  sent; one not yet sent goes out on the next run once its time has come.
- It refuses a workspace on a real provider, so a real subscription's dates
  never move.

### Tax documents: dry run and backfill

With `BILLING_GST_REGISTERED=true`, the billing worker issues a numbered tax
invoice for each paid charge and a credit note for each processed refund. GST
is India's Goods and Services Tax. A sync, a `refund.processed` webhook and two
daily steps queue the work. `pnpm billing:tax-reconcile` shows what is owed and
queues it on demand:

- `pnpm billing:tax-reconcile` is a dry run. It reads the payment provider and
  prints one line per workspace with a tracked subscription. Each line counts
  invoices, credit notes, held charges, late invoices (paid over 30 days
  before issue) and refunds larger than what is left to credit. It writes and
  queues nothing.
- `pnpm billing:tax-reconcile -- --apply` queues one `tax-reconcile` job per
  workspace with work. The billing worker (`pnpm dev`) issues the documents.
- `-- --tenant <slug>` limits either mode to one workspace.

It exits 1 when registration or payments are off. Set
`BILLING_GST_EFFECTIVE_FROM` on or after the day you deploy: earlier charges of
refunded duplicate subscriptions are not tracked
([ARCHITECTURE.md](ARCHITECTURE.md#billing)).

**Preview before go-live.** Run the dry run before you turn registration on
for the server. Set `BILLING_GST_REGISTERED=true` and the seller variables in
the command's own environment only, for example
`BILLING_GST_REGISTERED=true BILLING_SELLER_GSTIN=… BILLING_GST_EFFECTIVE_FROM=… pnpm billing:tax-reconcile`.
GSTIN is the seller's GST Identification Number. The dry run reads and prints
counts only, so the server issues nothing until you change its environment.

**Backfill.** On the first daily run after `BILLING_GST_EFFECTIVE_FROM` gets a
different value, the scheduler queues a run for every workspace that tracks a
subscription, then marks that date done. If the step fails part way, the
next daily run queues them all again. To recover at once, or after deleting
the marker, run `pnpm billing:tax-reconcile -- --apply`. Queueing twice is
safe:

- it issues nothing twice, since each issue re-checks its payment or refund;
- it raises each alert once, since alerts are deduplicated by their text.

**Manual credit notes.** Staff issue one in Apex for a lost dispute. Its
reason prints on the customer's credit note, so it takes one line of English
letters, digits and common punctuation.

## Lists

Every list endpoint takes the same query parameters and answers the same
shape.

| Parameter   | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| `search`    | Free-text search                                          |
| `sort`      | Sort key; prefix `-` for descending                       |
| `cursor`    | The page cursor from the previous answer                  |
| `direction` | `next` or `prev`                                          |
| `limit`     | 1 to 100 rows, 20 by default                              |
| `total=1`   | Adds a count, capped at 1,000                             |
| filters     | The endpoint's own filters; enum filters take comma lists |

The answer's `data` is
`{ items, page: { nextCursor, prevCursor, hasNext, hasPrev, limit }, total? }`.
A capped count is `{ count: 1000, capped: true }`, shown as "1,000+".

`CURSOR_SECRET` signs every cursor. A cursor is bound to the request's sort,
search and filters, and to its tenant, user or list. A cursor that fails any
check answers 400 `CURSOR_INVALID`, and the client starts again from the first
page. Set `CURSOR_SECRET` to the same secret of 32 or more characters on every
replica (`openssl rand -hex 32`). On `APP_ENV=local`, each process generates
its own when it is unset. Each endpoint's search columns, filters and sorts
are in [ARCHITECTURE.md](ARCHITECTURE.md#list-endpoints).

## Email tracking

This section is the operator guide to outbound email. Every outbound email is
one `email_messages` row; its model and the sender rule are in
[ARCHITECTURE.md](ARCHITECTURE.md#email-tracking).

**Resend.** Resend is the email provider whose delivery webhook the API
reads. To track delivery:

1. In the Resend dashboard, add a webhook for
   `https://<api host>/api/v1/webhooks/email/resend`.
2. Subscribe it to `email.delivered`, `email.delivery_delayed`,
   `email.bounced`, `email.complained`, `email.opened`, `email.clicked`,
   `email.failed` and `email.suppressed`.
3. Put its signing secret (`whsec_…`) in `RESEND_WEBHOOK_SECRET`. The adapter
   is on only while that is set; without it the route answers 404.

How the API handles each event:

- It acknowledges and ignores every other event type.
- A permanent bounce and a complaint suppress the address. A transient bounce
  is a delay and suppresses nothing.
- `email.suppressed` means Resend's own list blocked the send. It marks the
  message failed and adds no local suppression.

The webhook's limiters and signature check are in
[SECURITY.md](SECURITY.md#mail-at-rest). The rejected-request limiter counts a
request while it is in flight. So a burst of concurrent deliveries from one
provider IP past its budget can be throttled; providers retry, and the event
id makes a retry exact. A wrong `TRUST_PROXY` puts every caller in the proxy's
single per-IP bucket.

**Two senders.** Link emails (sign-in, step-up, welcome and invitation mail)
go from `MAIL_FROM_TRANSACTIONAL`; all other mail goes from `MAIL_FROM`.

- Give `MAIL_FROM_TRANSACTIONAL` its own subdomain, for example
  `no-reply@auth.example.com`.
- Keep click tracking **off** for that domain at the provider. The provider
  rewrites tracked links through its redirector, which would then see every
  token.
- Open and click rates count `MAIL_FROM` mail only.
- Left unset, `MAIL_FROM_TRANSACTIONAL` falls back to `MAIL_FROM`. Outside
  `local`, the boot check warns when both senders share a domain.

**Local.** `APP_ENV=local` (tests included) also enables a `fake` provider,
signed with `FAKE_EMAIL_WEBHOOK_SECRET` (a local default, not a credential).
`pnpm email:fire-event <messageId> <type> [hard|soft] [--origin <api origin>]`
signs and posts one event for a message id from Apex or
`GET /platform/emails`. `--origin` defaults to `APP_URL`.

### Suppression

A hard bounce or a complaint adds the address to `email_suppressions`. While
the address is there, every mail to it is marked `suppressed` and never sent,
security notices included. The caller is told nothing, so a send still reveals
no account.

- Staff lift a suppression from Apex's Suppressions page
  (`POST /platform/email-suppressions/:id/lift`). It needs the admin role and a
  reason, and is audited as `email.suppression_lifted`.
- Lifting one twice answers 409 `already_lifted`.
- Suppressions never expire. A user purge keeps those of the user's address:
  they belong to the mailbox, not the account.

### Staff reads, preview and resend

- `GET /platform/emails` lists messages newest first, searchable by recipient.
- `GET /platform/emails/:id` returns one message's timeline: attempts,
  provider events, the address's active suppression and the resend chain. Its
  404 (`email_not_found`) carries `details.retentionDays`, the server's
  `RETENTION_EMAIL_LOGS_DAYS` (0 when messages are never purged), so Apex
  states the real retention.
- `GET /platform/emails/health?range=7d|30d` counts messages per UTC
  (Coordinated Universal Time) day. It reports rates over the messages that
  left the server. Without a webhook, every successful send stays `sent`, and
  every rate except the undelivered rate is `null` until a provider event
  arrives.
- `GET /platform/emails/:id/preview` re-renders the stored template with every
  token masked (`••••••`) and the inviter as "A teammate". A preview variable
  the row does not hold as a string is masked too, and sets `partial: true`.
  Apex shows the preview in a sandboxed `srcdoc` iframe under the page's
  Content Security Policy (CSP), so a remote image added to a template does
  not load there.
- `POST /platform/emails/:id/resend` (admin, with a reason) never replays a
  mail. It runs the action that sent it, which issues a fresh token. That
  action's role rules, errors and audit entry apply unchanged, and
  `email.resent` records the reason beside it.

A resend answers 409 in these cases:

| Case                                                                                                                                                                       | Code                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A template with no resend action (`step_up_link`, `onboarding_reminder`, `maintenance_mode_changed`), or a row without the ids its action needs                            | `not_resendable`       |
| A suppressed recipient                                                                                                                                                     | `recipient_suppressed` |
| A template this build lacks or has retired (`email_verification`, `password_reset`, `registration_attempt`, `password_changed`, `account_setup`; their rows stay listable) | `template_unavailable` |

Every invitation resend also needs a sign-in within the last 10 minutes (401
`REAUTH_REQUIRED`).

## Onboarding

Onboarding steps are an extension point, not product logic. The registry is
`ONBOARDING_STEPS` in `src/constants/onboarding.constants.ts`, and both apps
render what the API returns. Each step has:

- a snake_case `key`, a `title` and a `description`;
- a `scope`: `tenant` (done once for the tenant) or `member` (done by each
  person);
- a `completion`: `auto` (on a trigger) or `manual` (ticked by the customer);
- `required`.

A tenant is **complete** once every required step is done. It is **stuck**
when it is not complete, not dismissed, and has made no progress for
`ONBOARDING_STUCK_AFTER_DAYS` (default 7) or more days.

**Adding a step.** Add an entry to `ONBOARDING_STEPS`. The load-time check
refuses a duplicate or non-snake_case key, and a trigger mapped to two steps
of one scope. An `auto` step completes from a value of `ONBOARDING_TRIGGERS`
that a subscriber in `onboarding.service.ts` maps from a `DomainEvent`. For a
trigger that does not exist yet:

1. Add the value to `ONBOARDING_TRIGGERS`.
2. Add the event to the `DomainEvent` union if it is not there.
3. Subscribe to it.
4. Call `emitDomainEvent` from the service that does the work, after its
   transaction commits.

Product code can also call `completeOnboardingStep` directly; a member step
needs the `userId`. It is the single writer and is idempotent.

**Tracking.** A tenant is tracked when `onboarding_tracked` is true. The tenant
repository sets it for every tenant it creates; the platform tenant is never
tracked. A tenant with it false shows as not tracked. A tenant that staff
create waits for its first owner to accept (`awaiting_owner`, never stuck)
before its clock starts. Actions staff take through platform access never
count as customer progress.

**Staff** (`platform-onboarding.service.ts`, under `/api/v1/platform`):

- `GET /onboarding/funnel?range=7d|30d|90d` (default 30d) counts each step's
  completions and the cohort by state. It also answers `stuckAfterDays`, the
  server's `ONBOARDING_STUCK_AFTER_DAYS`, so Apex states the real threshold.
  `GET /stats` sends it too, beside `totals.stuckTenants`.
- `GET /onboarding/tenants?state=` pages active tracked tenants in one state
  (`stuck` by default) on the shared list parameters. `search` matches the
  name, and `sort` is one of `progress`, `-started`, `name`.
- `GET /tenants/:id/onboarding` returns one tenant's steps, members, reminder
  history and whether a reminder may go now.
- `POST /tenants/:id/onboarding/steps/:key/complete` (admin, with a reason)
  marks a step done.
- `POST /tenants/:id/onboarding/remind` (admin, with a reason) sends one
  `onboarding_reminder` email to each active owner.

A reminder goes only when the tenant is active, in progress or stuck, has an
owner, and was not reminded in the last 24 hours. Otherwise it answers 409
`tenant_state_conflict`, `not_in_progress`, `no_owner` or `reminded_recently`;
the last carries `errors.retryAfter`, which says when the next may go. The
reminder's email rows and audit entry commit together, and the sends queue
after. If queueing fails, the audit entry stays, the email row is marked
failed, and the answer says `emailSent: false`.

**`pnpm onboarding:reconcile`.** Subscribers run after the request commits and
never fail it; one that fails only logs. The script repairs what a failed
subscriber missed. It re-completes the default automatic tenant steps of every
live, tracked, started customer tenant, from what members provably did, each
stamped with the time it happened. It is best effort: it reads the audit log,
so entries pruned under `RETENTION_AUDIT_LOGS_DAYS` (0 keeps them forever)
leave no trace. It exits 1 when a step that should be done is not.

## Analytics (PostHog)

Analytics is off until `POSTHOG_PROJECT_KEY` is set: no outbox row is written,
no drain runs, and `/api/v1/collect/*` answers 503. With only
`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` set, the analytics Worker
still starts, to delete purged users from PostHog. Server events and the
browser share one PostHog project per environment. The pipeline and the proxy
are in [ARCHITECTURE.md](ARCHITECTURE.md#analytics); what is and is not sent
is in [SECURITY.md](SECURITY.md#analytics-and-error-tracking-privacy).

**What the server sends.**

- Every audit action, named with `_` for `.` (`invitation.created` becomes
  `invitation_created`), with snake_case metadata. A free-text `reason` is
  reduced to `has_reason`, and a tenant's `name` and `slug` are left out.
- A small set of product events.
- Each email tracking event, as `email_<type>`.

No name, full address, reason or recipient is sent. Invitation, user and email
audit events carry only the address's `email_domain`. `$session_id` goes only
on an event of the user whose browser sent it. The rules live in
`analytics-event-builder.service.ts` and
[SECURITY.md](SECURITY.md#server-events).

**Turning it on, once per environment:**

1. Create a PostHog project for the environment, and enable group analytics
   with the group type `tenant` (index 0).
2. Set `POSTHOG_PROJECT_KEY`. Set `POSTHOG_HOST` too when the project is not
   on the US cloud (`https://eu.i.posthog.com` for the EU one). The assets host
   follows the ingest host's region; `POSTHOG_ASSETS_HOST` overrides it.
   - Set the same key as the `POSTHOG_KEY` container env var of react and
     apex.
   - Workers that run in separate pods need `POSTHOG_PROJECT_KEY` too. Without
     it the drain does not run there, so rows accumulate and retention prunes
     them with only a `warn` log.
3. Deploy, then run `pnpm analytics:backfill-groups` once, so tenants created
   before analytics was on carry their name, status, creation date and plan
   properties. It queues one `$groupidentify` marker per tenant, and exits 1
   if a batch could not be queued. A second run is harmless.
4. If react runs with the container env `ANALYTICS_CONSENT_MODE=required`,
   enable "Cookieless server hash mode" in the project settings.
5. Set `TRUST_PROXY` to the number of proxies in front of this app, counting
   every hop (the frontend's nginx and the load balancer). The analytics proxy
   forwards `request.ip` to PostHog. With `TRUST_PROXY=false` behind a proxy,
   that is the proxy's address: GeoIP is wrong for everyone, and in cookieless
   mode PostHog's hash merges different people. Boot warns when
   `POSTHOG_PROJECT_KEY` is set, `TRUST_PROXY` is false and `APP_ENV` is not
   `local`.

### The PostHog personal API key

`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` let express call
PostHog's private API for two jobs: deleting purged users from PostHog, and
`pnpm flags:sync` creating missing flags. Boot warns when only one of them is
set. They are independent of `POSTHOG_PROJECT_KEY`. Staff read events, replays
and error issues in PostHog itself.

**Turning it on, once per environment:**

1. In PostHog, create a personal API key owned by a service account rather
   than a person. Give it only the scopes `person:write` and `group:read`, plus
   `feature_flag:read` and `feature_flag:write` for the flags.
2. Set `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` (the numeric id of
   the project `POSTHOG_PROJECT_KEY` reports to). Set them on the worker pods
   too: the PostHog deletion of purged users runs on the analytics Worker. The
   app host follows the ingest host's region (`https://us.posthog.com` or
   `https://eu.posthog.com`); set `POSTHOG_APP_HOST` for a self-hosted PostHog.
3. Optional: run `pnpm analytics:backfill-groups` once, so existing tenants'
   group properties converge. It needs `POSTHOG_PROJECT_KEY` too and fails
   without it.

### Error tracking

With `POSTHOG_PROJECT_KEY` set, three kinds of failure reach PostHog Error
Tracking: unexpected 5xx answers, uncaught exceptions, and a BullMQ job's
final failure. `ERROR_TRACKING_ENABLED=false` turns sending off without
touching the rest of analytics. What is captured is in
[ARCHITECTURE.md](ARCHITECTURE.md#error-tracking). Express needs no sourcemap
upload: `node --enable-source-maps` rewrites stacks to the `.ts` lines.

**Finding an error from its `errorId`.** Every 5xx body that `errorHandler`
writes carries an `errorId`, except a maintenance refusal. Its
`Unhandled server error` log line carries the same id.

1. Search the logs for the id first.
2. Error Tracking's UI does not search by event uuid. Run this in SQL insights
   (HogQL, PostHog's SQL dialect) instead; it also gives the issue to open:

   ```sql
   select uuid, timestamp, properties.$exception_issue_id, properties.http_route, properties.trace_id
   from events
   where event = '$exception' and uuid = '<errorId>'
   ```

An id that finds nothing names a log line only. Either the error was not
reported (a deliberate 5xx, or error tracking off or throttled), or PostHog
has not ingested it yet (allow about 15 s).

`GET /api/v1/platform/system/status` answers the release and the reporter's
sent and dropped counts.

**`/health` names the release.** It answers `{ status, uptime, release }`. Why
that is public, and how a private fork drops it, is in
[SECURITY.md](SECURITY.md#error-tracking-what-reaches-posthog).

### Feature flags

Flags are declared in `src/constants/flags.constants.ts`, evaluated on the
server and served to react and apex; how they work is in
[ARCHITECTURE.md](ARCHITECTURE.md#feature-flags).

Flags are off until both `POSTHOG_PROJECT_KEY` and `POSTHOG_FEATURE_FLAGS_KEY`
are set. Until then every flag answers its registry fallback, gated routes
answer 404, and nothing is fetched from PostHog. That is a valid steady state.
Boot refuses `POSTHOG_FEATURE_FLAGS_KEY` without `POSTHOG_PROJECT_KEY`.

**Turning them on, once per environment.** Each environment has its own
PostHog project, and every registered flag must exist in each.

1. In the project's settings (Feature flags), generate the Feature Flags Secure
   API Key (it starts with `phs_`). Set it as `POSTHOG_FEATURE_FLAGS_KEY` on
   the API and worker pods alike. It only reads flag definitions; it is a
   secret and never reaches a browser.
2. Give the personal API key (`POSTHOG_PERSONAL_API_KEY`) the scopes
   `feature_flag:read` and `feature_flag:write`, and make sure the project has
   the `tenant` group type.
3. Deploy, then run `pnpm flags:sync` with that environment's variables. Start
   with `pnpm flags:sync -- --dry-run`.
   - It creates every registered flag that is missing, inactive at a 0 %
     rollout and tagged `code-registry`.
   - It prints `drift <key>: <field>` for a flag whose kind, variants or scope
     differ.
   - It exits 0 when clean or after creating, 2 on drift, and 1 on a failure.
   - It never edits or deletes a flag; fix drift in PostHog or in the
     registry.
4. Roll flags out in PostHog. Every API and worker process picks up a change
   within about 1 minute. Browsers pick it up on their next refetch: a page
   load, a tenant switch, focus after 5 minutes, or every 10 minutes.
5. Check the Apex status card's Feature flags section and the `/flags` page:
   - a `missing` flag needs `pnpm flags:sync`;
   - an `unsupported` flag uses a construct the server can't evaluate, and the
     page names it;
   - every flag PostHog has that the registry lacks is listed for
     information.

Run `pnpm flags:sync` again in every environment whenever a release adds a
flag. To run an experiment on a flag, sync first, then create the experiment
in PostHog reusing the flag.

## Maintenance mode

A platform owner switches maintenance mode from Apex's Maintenance page. How it
works is in [ARCHITECTURE.md](ARCHITECTURE.md#maintenance-mode). The
let-through list and the controls on changing it are in
[SECURITY.md](SECURITY.md#maintenance-mode).

Runbook:

1. **Confirm staff access before `full`.** In `full` only staff can sign in.
   Make sure whoever will switch it off can request a sign-in link on Apex, or
   use Google; auth mail is never paused.
2. **Expect invitations to wait.** In `read_only` and `full`,
   `/invitations/verify` and `/invitations/confirm` answer 503 (`READ_ONLY_MODE`
   or `MAINTENANCE_MODE`) for everyone, staff invitees included. An invitee
   joins after maintenance ends, with the same link while it is unexpired. The
   invitation lasts 3 days and its confirm link 15 minutes; a fresh click on
   the invitation mails a fresh confirm link.
3. **Use `read_only` for data fixes where reads are safe.** Customers keep
   reading; their writes answer 503 `READ_ONLY_MODE`, and jobs keep running.
4. **Before database work, check "0 running" on every paused queue** on the
   Maintenance page. `full` pauses every queue but `auth-email`, which keeps
   sending sign-in, step-up, invitation, invitation confirm and passkey notice
   mail. Jobs already running finish first.
5. **Staff keep working.** Staff actions in Apex and staff sign-ins keep
   working and writing during maintenance.
6. **Switch off from Apex.** Leaving `full` resumes the paused queues; notices
   that were still queued go out then.
7. **Restart every replica after restoring the database during maintenance.**
   A replica ignores a row whose version is not above the one it holds. So a
   restore to an earlier version leaves each replica on the old mode until it
   restarts.
8. **Keep the clocks in sync, with the Network Time Protocol (NTP), on the
   database and every replica.** The 10 s pause grace and the notice wait are
   measured from the time the database stamps on the change, on each replica's
   own clock. Clock skew shifts when the queues pause.
9. **Failed notice jobs keep personal data.** A notice job that fails keeps the
   actor's name and the reason in its Redis job data until it is removed; the
   windows are in [SECURITY.md](SECURITY.md#mail-at-rest).

## Deploy

- **Image.** The `Dockerfile` builds a non-root production image that starts
  only the app. Run migrations from the same image with
  `node dist/database/migrate.js`, which reads only `DATABASE_URL`. The stages
  and the local `docker run` recipe are in
  [ARCHITECTURE.md](ARCHITECTURE.md#docker), and the probes in
  [Health checks](ARCHITECTURE.md#health-checks).
- **Pipeline.** A push to `main` runs CI, then builds the image and pushes it
  to the GitHub Container Registry (GHCR), in `.github/workflows/deploy.yml`.
  The `deploy` job there is a placeholder: no deployment target is chosen, so
  wire your own. Release tagging and the ruleset on `main` are in
  [ARCHITECTURE.md](ARCHITECTURE.md#deploying) and
  [CONTRIBUTING.md](CONTRIBUTING.md#releases).
- **Environment.** The orchestrator supplies the environment; the image has no
  `.env`. Set `APP_ENV` and `NODE_ENV=production` for every deployment but
  local, and `TRUST_PROXY` behind a proxy.

## Make this yours

This is a template. Before the first real commit on a project generated from
it, change the 5 things that still say "express-boilerplate":

- [ ] **`package.json`**: `name`, `description`, `author`, `license` and
      `version`.
- [ ] **`.github/CODEOWNERS`**: it names this repository's maintainer.
- [ ] **`SECURITY.md`**: the reporting section, and the list of what is not
      implemented as you implement it.
- [ ] **`.github/domain-terms.txt`**: see
      [CONTRIBUTING.md](CONTRIBUTING.md#ci) for what to put in it.
- [ ] **`LICENSE`**: a proprietary licence naming Mahaverick. Replace it with
      your own terms, and set `license` in `package.json` to match.

No gate enforces this list.

## Documentation index

| Doc                                | Owns                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| [README.md](README.md)             | Quick start, scripts, operator guides, deploy summary, making the template yours, this index   |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Boot, layers, directory rules, mechanisms, configuration and the env var table, Docker, deploy |
| [DATABASE.md](DATABASE.md)         | Client, models, migrations, test database, live schema changes                                 |
| [SECURITY.md](SECURITY.md)         | Threat model, defences, what is and is not implemented, reporting                              |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Hooks, commits, CI, releases, dependency policy, extending the Apex API, docs to update        |
| [CLAUDE.md](CLAUDE.md)             | Rules and gotchas for anyone changing the code                                                 |
| [AGENTS.md](AGENTS.md)             | Agent entry point, pointing at CLAUDE.md and this index                                        |

## License

Proprietary, all rights reserved. See [`LICENSE`](LICENSE).

`package.json` declares `UNLICENSED`, npm's spelling for "not open source". It
is not the public-domain "Unlicense". This repository being publicly visible
grants no right to use, copy, modify or distribute it.
