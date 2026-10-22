# Express Boilerplate

A production-grade Express 5 API boilerplate: TypeScript, Drizzle ORM on
Postgres, Redis, a validated environment, a documented HTTP error contract,
OpenTelemetry traces and logs, and a git-hook and CI pipeline that enforces
all of it.

On top of that platform it ships sign-in by emailed link, with the account
created on the first click, optional Google sign-in, passkeys, a "confirm it's
you" step by emailed link or passkey for every signed-in user, JWT access tokens with rotating opaque refresh tokens, multi-tenancy
with roles and one-click invitations, an audit log, platform staff access,
in-app notifications over server-sent events, BullMQ jobs and a daily
data-retention purge. A staff directory, email delivery tracking, onboarding,
PostHog analytics, feature flags and a maintenance mode sit on the same base.
How the code is built is in [ARCHITECTURE.md](ARCHITECTURE.md); [SECURITY.md](SECURITY.md) lists the
defences and, under
[what it does not implement](SECURITY.md#what-this-boilerplate-does-not-implement),
what is left to you.

## Requirements

- Node.js >= 24 (pinned in [`.node-version`](.node-version)).
  `devEngines.runtime` in `package.json` makes `pnpm install` refuse an older
  Node.
- [pnpm](https://pnpm.io) 12.4.1, pinned by `packageManager` in
  `package.json`. Use pnpm only. Node 25 and later do not bundle Corepack, so
  install it first: `npm i -g corepack@0.36.0 && corepack enable`.
- Docker, for the local Postgres, Redis, OpenTelemetry, Tempo, Loki, Grafana
  and Mailpit stack ([Local infrastructure](ARCHITECTURE.md#local-infrastructure)).

## Quickstart

```bash
pnpm install
docker compose up -d --wait
cp .env.example .env    # then fill in the blank required values below
pnpm db:migrate
pnpm dev
```

`.env.example` already sets `APP_ENV=local` and `NODE_ENV=development`. For the
compose stack, the blank required values in `.env` are:

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
with a named list if a required variable is missing. The server listens on
`APP_PORT` (4040).

```bash
curl http://localhost:4040/health/ready   # {"status":"ready","checks":{...}}; 503 when a dependency is down
```

### Sign in

```bash
curl -X POST http://localhost:4040/api/v1/auth/link/request \
  -H 'Content-Type: application/json' \
  -d '{"email":"grace@example.com","app":"web"}'
```

The request answers `202` with the same body for every address, then mails a
sign-in link. Read it in Mailpit at <http://localhost:8025>, or take the token
from the newest message and verify it:

```bash
TOKEN=$(curl -s http://localhost:8025/api/v1/message/latest \
  | grep -oE 'token=[A-Za-z0-9_-]{43}' | head -1 | cut -d= -f2)

curl -X POST http://localhost:4040/api/v1/auth/link/verify \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"email\":\"grace@example.com\"}"
```

The first click for an address creates its account (`isNewUser: true`). Verify
answers `data.user` and `data.accessToken`, and sets the refresh-token cookie.
A link works once and expires in 15 minutes; send the first request again for
a new one. Send the token as `Authorization: Bearer <accessToken>` to reach an
authenticated route such as `GET /api/v1/profile`. Every `/api/v1/auth` route
refuses a non-JSON body with 415.

**Passkeys.** `PASSKEY_MODE` is `optional` by default: a signed-in person
creates a passkey (`POST /api/v1/auth/passkeys/registration/options`, then
`/registration/verify`) and signs in with it later
(`POST /api/v1/auth/passkeys/sign-in/options`, then `/sign-in/verify`). `off`
hides the passkey routes; `required` makes every account create a passkey
before anything else. `GET /api/v1/auth/passkeys/config` answers the mode.
`WEBAUTHN_RP_ID` defaults to the host of `WEB_URL`; set it to a parent domain
when `APEX_URL` sits on another subdomain. An IP address is refused as an RP ID. A browser has to run the ceremony,
so the curl flow above covers links only. Sensitive actions ask a signed-in
user to confirm it's them within 10 minutes: by emailed link
(`POST /api/v1/auth/step-up/link/request` with `{"app":"web"}`) or by passkey
(`/api/v1/auth/passkeys/step-up/options`). The rules are in
[SECURITY.md](SECURITY.md#passkeys). See
[ARCHITECTURE.md](ARCHITECTURE.md#request-path-auth-and-beyond) for the rest.

## Run everything with Docker

`docker-compose.yml` can also run this API, react-boilerplate and
apex-boilerplate together, through two compose profiles. Plain
`docker compose up -d --wait` is unchanged and starts only the infrastructure.

- **Sibling checkouts.** The frontends build from `../react-boilerplate` and
  `../apex-boilerplate`, next to this repo. Point elsewhere with `REACT_DIR`
  and `APEX_DIR`, for example
  `REACT_DIR=~/code/react-boilerplate docker compose --profile dev up`.
- **`.env` first.** The API containers read this repo's `.env`, so create it
  from `.env.example` as in the [Quickstart](#quickstart). Without it, any
  `--profile dev` or `--profile prod` command stops with "env file … not
  found". Compose overrides only what differs inside its network:
  `DATABASE_URL`, `REDIS_URL`, `SMTP_HOST`, `SMTP_PORT` and `APP_PORT`. Keep
  `WEB_URL=http://localhost:5173` and `APEX_URL=http://localhost:5174`.
  Tracing stays off unless `.env` sets `OTEL_EXPORTER_OTLP_ENDPOINT`, and from
  inside the network that has to be `http://otel-collector:4318`.

```bash
docker compose --profile dev up           # hot reload, source mounted
docker compose --profile prod up --build  # the real images, no hot reload
```

| Profile | Services                                                | API, React, Apex                         |
| ------- | ------------------------------------------------------- | ---------------------------------------- |
| `dev`   | `api-dev`, `react-dev`, `apex-dev`                      | `localhost:4040`, `:5173`, `:5174`       |
| `prod`  | `migrate`, `api`, `react`, `apex`, from each Dockerfile | the same ports; nginx serves the clients |

- **`dev`** runs each repo's source, bind-mounted, in the `node:24-alpine`
  image the `Dockerfile` pins, with `node_modules` in a named volume per repo
  so the container keeps Linux binaries. `api-dev` runs migrations, then
  `pnpm dev`; the frontends run Vite. Edits reload as they do on the host. The
  first run installs every dependency, which takes a minute or two; later runs
  reuse the volumes.
- **`prod`** builds the three images. `migrate` runs
  `node dist/database/migrate.js` once and `api` starts after it succeeds. The
  frontends run read-only with a tmpfs `/tmp` and proxy `/api` to `api`. The
  build skips the source-map upload, since no PostHog project is set.
- **One profile at a time.** Both publish 4040, 5173 and 5174 on `127.0.0.1`,
  as do the dev servers on the host: stop those first too.
- **Why the frontends share `api-dev`'s network.** Both Vite configs proxy
  `/api` to `http://localhost:4040`, so `react-dev` and `apex-dev` run with
  `network_mode: service:api-dev`, where `localhost:4040` is the API. That is
  why their ports are published on `api-dev`. If `api-dev` is recreated, run
  `docker compose --profile dev up -d` again so the frontends rejoin it.

Stop with `docker compose --profile dev down` (or `--profile prod`).
`down -v` also deletes the volumes: the `node_modules` volumes, Tempo's data
and the database, which is the same one a host `pnpm dev` uses.

## Environment variables

Every variable, with its default and what it does, is in the table in
[ARCHITECTURE.md](ARCHITECTURE.md#environment-variables). The table and
`.env.example` are both generated from the Zod schema in
`src/configs/env.config.ts`. A quick start needs only the keys above.

Optional keys have their own sections: `APEX_URL` in
[A second frontend: Apex](ARCHITECTURE.md#a-second-frontend-apex),
`RESEND_WEBHOOK_SECRET`, `MAIL_FROM` and `MAIL_FROM_TRANSACTIONAL` in
[Email tracking](#email-tracking), the `POSTHOG_*` keys in
[Analytics (PostHog)](#analytics-posthog), and `TRUST_PROXY` for any
deployment behind a proxy. `RATE_LIMIT_SCALE`, for end-to-end runs on
`APP_ENV=local` only, is in
[SECURITY.md](SECURITY.md#rate-limiting-one-store-prefix-per-limiter).
`CURSOR_SECRET` signs the list cursors; it is required on every `APP_ENV` but
`local` (see [Lists](#lists)).

## Available scripts

| Script                              | What it does                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | `tsx watch` on `src/index.ts`, loading `.env` and then `src/observability/tracing.ts` first.        |
| `pnpm build`                        | Removes `dist/`, runs `tsc` and `tsc-alias` on `tsconfig.build.json`, and copies the migrations.    |
| `pnpm start`                        | Runs the build, loading `.env` and `dist/observability/tracing.js` first.                           |
| `pnpm lint`                         | `vp check` (Oxlint, Oxfmt), the untyped ESLint, then `tsc --noEmit` (`tsconfig.json`).              |
| `pnpm lint:fix`                     | `vp check --fix`, then `eslint . --fix`.                                                            |
| `pnpm typecheck`                    | `tsc --noEmit` over `src/`, `tests/` and `drizzle.config.ts` (`tsconfig.json`).                     |
| `pnpm lint:docs`                    | History phrasing and broken links in docs; code citing a missing doc.                               |
| `pnpm knip`                         | Unused files, exports, types and dependencies (`knip.jsonc`).                                       |
| `pnpm format`                       | `vp fmt .` (Oxfmt) over the whole repo.                                                             |
| `pnpm format:check`                 | `vp fmt --check .`.                                                                                 |
| `pnpm env:example`                  | Regenerates `.env.example` from the Zod schema.                                                     |
| `pnpm env:table`                    | Prints ARCHITECTURE.md's environment table from the Zod schema.                                     |
| `pnpm db:migration:generate`        | `drizzle-kit generate`; see [DATABASE.md](DATABASE.md).                                             |
| `pnpm db:migrate`                   | Applies pending migrations against `DATABASE_URL`.                                                  |
| `pnpm db:migrate:prod`              | The same, as `node dist/database/migrate.js` from the build.                                        |
| `pnpm platform:grant -- <e> <role>` | Gives an address a role in the platform tenant, creating its account; see below.                    |
| `pnpm email:fire-event <id> <type>` | Signs and posts a fake provider event (local only); see [Email tracking](#email-tracking).          |
| `pnpm onboarding:reconcile`         | Re-derives tracked tenants' automatic onboarding steps; see [Onboarding](#onboarding).              |
| `pnpm analytics:backfill-groups`    | Queues every tenant's PostHog group properties; see [Analytics (PostHog)](#analytics-posthog).      |
| `pnpm flags:sync [-- --dry-run]`    | Creates registered feature flags missing from PostHog; see [Feature flags](#feature-flags).         |
| `pnpm test`                         | `vp test run`: both Vitest projects. Needs the compose stack.                                       |
| `pnpm test:unit`                    | The `unit` project: every test but `tests/integration/**`, no global setup; runs with Docker down.  |
| `pnpm test:integration`             | The `integration` project: `tests/integration/**`, with the per-worker databases. Needs the stack.  |
| `pnpm test:watch`                   | `vp test watch`.                                                                                    |
| `pnpm test:coverage`                | `vp test run --coverage`, gated at 80% on lines, functions, branches and statements.                |
| `pnpm gate`                         | The pre-push gate: lint, docs, knip, domain terms, coverage, build. Needs the compose stack.        |
| `pnpm push [args]`                  | Runs `pnpm gate`, then `git push --no-verify` with your arguments.                                  |
| `pnpm scrub:gate <mode>`            | The error scrubber's differential gate, run by hand at review time (`tests/helpers/scrub-gate.ts`). |
| `pnpm commit`                       | Interactive conventional-commit prompt (`cz`).                                                      |
| `pnpm prepare`                      | Installs the Vite+ git hooks (`vp config`); `pnpm install` runs it.                                 |

`pnpm platform:grant -- <email> <role>` gives the account at an address a role
(`owner` to `viewer`) in the platform tenant, audited as
`platform.member.granted`. An address with no account gets a verified one,
audited as `user.created`; an unverified account is claimed as a sign-in link
claims it: its federated links are removed, its sessions end and the
address is verified. Nobody can invite staff before a platform owner exists, so this is how
the first one is made.

The hooks, commit format and CI are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Lists

Every list endpoint takes `search`, `sort` (`-` for descending), `cursor`,
`direction` (`next` or `prev`), `limit` (1–100, 20 by default), `total=1`
and its own filters, comma lists for enum filters, and answers
`{ items, page: { nextCursor, prevCursor, hasNext, hasPrev, limit }, total? }`
in `data`. `total=1` adds a count capped at 1,000 (`{ count: 1000, capped: true }`,
shown as "1,000+"). A cursor is signed with `CURSOR_SECRET` and bound to the
request's sort, search and filters, and to its tenant, user or list; a cursor
that fails any check answers 400 `CURSOR_INVALID`, and the client starts again
from the first page. Set `CURSOR_SECRET` to the same 32+ character secret on
every replica (`openssl rand -hex 32`); on `APP_ENV=local` an unset one is
generated per process. Each endpoint's search columns, filters and sorts are in
[ARCHITECTURE.md](ARCHITECTURE.md#list-endpoints).

## Email tracking

Every outbound email is one `email_messages` row; its model and the sender
rule are in [ARCHITECTURE.md](ARCHITECTURE.md#email-tracking). This section is
the operator guide.

**Resend.** In the Resend dashboard, add a webhook for
`https://<api host>/api/v1/webhooks/email/resend` and subscribe it to
`email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.complained`, `email.opened`, `email.clicked`, `email.failed` and
`email.suppressed`. Put its signing secret (`whsec_…`) in
`RESEND_WEBHOOK_SECRET`; the adapter is enabled only while that is set, and
without it the route answers 404. Every other event type is acknowledged and
ignored. A permanent bounce and a complaint suppress the address; a transient
bounce is a delay and suppresses nothing. `email.suppressed` (Resend's own list
blocked the send) marks the message failed and adds no local suppression. The
webhook's limiters and signature check are in
[SECURITY.md](SECURITY.md#mail-at-rest). The rejected-request limiter counts a
request while it is in flight, so a burst of concurrent deliveries from one
provider IP past its budget ([SECURITY.md](SECURITY.md#mail-at-rest)) can be
throttled (providers retry, and the event id makes a retry exact). A wrong
`TRUST_PROXY` puts every caller in the proxy's single per-IP bucket.

**Two senders.** Link emails (sign-in, step-up, welcome and invitation mail)
go from `MAIL_FROM_TRANSACTIONAL`; the other mail goes from
`MAIL_FROM`. Give `MAIL_FROM_TRANSACTIONAL` its own subdomain (for example
`no-reply@auth.example.com`) and keep click tracking **off** for that domain
at the provider: tracked links are rewritten through the provider's
redirector, which would then see every token. Open and click rates count
`MAIL_FROM` mail only. Left unset it falls back to `MAIL_FROM`, and outside
`local` the boot check warns when both senders share a domain.

**Local.** `APP_ENV=local` (tests included) also enables a `fake` provider,
signed with `FAKE_EMAIL_WEBHOOK_SECRET` (a local default, not a credential).
`pnpm email:fire-event <messageId> <type> [hard|soft] [--origin <api origin>]`
signs and posts one event for a message id from Apex or
`GET /platform/emails`; `--origin` defaults to `APP_URL`.

### Suppression

A hard bounce or a complaint adds the address to `email_suppressions`. While
it is there, every mail to it, security notices included, is marked
`suppressed` and never sent, and the caller is told nothing, so a send still
reveals no account. Staff lift a suppression from Apex's Suppressions page
(`POST /platform/email-suppressions/:id/lift`: admin, with a reason, audited
as `email.suppression_lifted`); lifting one twice answers 409
`already_lifted`. Suppressions never expire, and a user purge keeps those of
the user's address: they belong to the mailbox, not the account.

### Staff reads, preview and resend

- `GET /platform/emails` lists messages newest first (searchable by recipient), and
  `GET /platform/emails/:id` returns one message's timeline: attempts,
  provider events, the address's active suppression and the resend chain.
- `GET /platform/emails/health?range=7d|30d` counts messages per UTC day and
  reports rates over the messages that left the server. Without a webhook
  every successful send stays `sent`, and every rate except the undelivered
  rate is `null` until a provider event arrives.
- `GET /platform/emails/:id/preview` re-renders the stored template with every
  token masked (`••••••`) and the inviter as "A teammate"; a preview variable
  the row does not hold as a string is masked too and sets `partial: true`. Apex
  shows it in a sandboxed `srcdoc` iframe under the page's CSP, so a remote
  image added to a template does not load in the preview.
- `POST /platform/emails/:id/resend` (admin, with a reason) never replays a
  mail. It runs the action that sent it, which issues a fresh token, and that
  action's role rules, errors and audit entry apply unchanged; `email.resent`
  records the reason beside it. A template with no resend action
  (`step_up_link`, `onboarding_reminder`, `maintenance_mode_changed`) is never
  resent, nor is a row without the ids its
  action needs (409 `not_resendable`); a suppressed recipient gets 409
  `recipient_suppressed`, and a template this build lacks or has retired
  (`email_verification`, `password_reset`, `registration_attempt`,
  `password_changed`, `account_setup`; their rows stay listable) gets 409
  `template_unavailable`. Every invitation resend needs a sign-in within the
  last 10 minutes (401 `REAUTH_REQUIRED`).

## Onboarding

Onboarding steps are an extension point, not product logic: the registry is
`ONBOARDING_STEPS` in `src/constants/onboarding.constants.ts`, and both apps
render what the API returns. Each step has a snake_case `key`, a `title` and
`description`, a `scope` (`tenant`, done once for the tenant, or `member`, done
by each person), a `completion` (`auto` on a trigger, or `manual`, ticked by
the customer) and `required`. A tenant is **complete** once every required
step is done, and **stuck** when it is not complete, not dismissed, and has
made no progress for `ONBOARDING_STUCK_AFTER_DAYS` (default 7) or more.

**Adding a step.** Add an entry to `ONBOARDING_STEPS`; the load-time check
refuses a duplicate or non-snake_case key and a trigger mapped to two steps of
one scope. An `auto` step completes from a value of `ONBOARDING_TRIGGERS` that
a subscriber in `onboarding.service.ts` maps from a `DomainEvent`. For a new
trigger, add the value to `ONBOARDING_TRIGGERS`, add the event to the
`DomainEvent` union if it is new, subscribe to it, and call `emitDomainEvent`
from the service that does the work, after its transaction commits. Product
code can also call `completeOnboardingStep` directly (a member step needs the
`userId`); it is the single writer and is idempotent.

**Tracking.** A tenant is tracked when `onboarding_tracked` is true, which the
tenant repository sets for every tenant it creates; the platform tenant is
never tracked. A tenant with it false shows as not tracked. A tenant that
staff create waits for its first owner to accept (`awaiting_owner`, never
stuck) before its clock starts. Actions staff take through platform access
never count as customer progress.

**Staff** (`platform-onboarding.service.ts`, under `/api/v1/platform`):
`GET /onboarding/funnel?range=7d|30d|90d` (default 30d) counts each step's
completions and the cohort by state; `GET /onboarding/tenants?state=` pages
active tracked tenants in one state (`stuck` by default) on the shared list
params, `search` matching the name and `sort` one of `progress`, `-started`,
`name`;
`GET /tenants/:id/onboarding` returns one tenant's steps, members, reminder
history and whether a reminder may go now;
`POST /tenants/:id/onboarding/steps/:key/complete` (admin, with a reason) marks
a step done. `POST /tenants/:id/onboarding/remind` (admin, with a reason) sends
one `onboarding_reminder` email to each active owner, and goes only when the
tenant is active, in progress or stuck, has an owner, and was not reminded in
the last 24 hours (409 `tenant_state_conflict`, `not_in_progress`, `no_owner` or
`reminded_recently`, whose `errors.retryAfter` says when the next may go). The
reminder's email rows and audit entry commit together and the sends queue after;
if queueing fails the audit entry stays, the email row is marked failed, and the
answer says `emailSent: false`.

**`pnpm onboarding:reconcile`.** Subscribers run after the request commits and
never fail it; one that fails only logs. The script re-completes the default
automatic tenant steps of every live, tracked, started customer tenant from
what members provably did, each stamped with the time it happened. It is best
effort: it reads the audit log, so entries pruned under
`RETENTION_AUDIT_LOGS_DAYS` (0 keeps them forever) leave no trace. It exits 1
when a step that should be done is not.

## Analytics (PostHog)

Analytics is off until `POSTHOG_PROJECT_KEY` is set: no outbox row is written,
no drain runs, and `/api/v1/collect/*` answers 503. With only
`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` set, the analytics Worker
still starts, to delete purged users from PostHog. Server events and the
browser share one PostHog project per environment. The pipeline and the proxy
are in [ARCHITECTURE.md](ARCHITECTURE.md#analytics); what
is and is not sent is in
[SECURITY.md](SECURITY.md#analytics-and-error-tracking-privacy).

**What the server sends.** Every audit action, named with `_` for `.`
(`invitation.created` becomes `invitation_created`), with snake_case metadata,
a free-text `reason` reduced to `has_reason`, and a tenant's `name` and `slug`
left out; a few product events; and each email tracking event as
`email_<type>`. No name, full address, reason or recipient is sent; invitation,
user and email audit events carry only the address's
`email_domain`. `$session_id` goes only on an event of the user whose browser
sent it. The rules live in `analytics-event-builder.service.ts` and
[SECURITY.md](SECURITY.md#server-events).

**Turning it on, once per environment:**

1. Create a PostHog project for the environment and enable group analytics
   with the group type `tenant` (index 0).
2. Set `POSTHOG_PROJECT_KEY`, and `POSTHOG_HOST` when the project is not on
   the US cloud (`https://eu.i.posthog.com` for the EU one). The assets host
   follows the ingest host's region; `POSTHOG_ASSETS_HOST` overrides it. Set
   the same key as the `POSTHOG_KEY` container env var of react and apex.
   Workers that run in separate pods need `POSTHOG_PROJECT_KEY` too: without
   it the drain does not run there, so rows accumulate and retention prunes
   them with only a `warn` log.
3. Deploy, then run `pnpm analytics:backfill-groups` once, so tenants that
   existed before carry their name, status and creation date. It queues one
   `$groupidentify` marker per tenant and exits 1 if a batch could not be
   queued; a second run is harmless.
4. If react runs with the container env `ANALYTICS_CONSENT_MODE=required`,
   enable "Cookieless server hash mode" in the project settings.
5. Set `TRUST_PROXY` to the number of proxies in front of this app, counting
   every hop (the frontend's nginx and the load balancer). The analytics proxy
   forwards `request.ip` to PostHog; with `TRUST_PROXY=false` behind a proxy
   that is the proxy's address, so GeoIP is wrong for everyone and, in
   cookieless mode, PostHog's hash merges different people. Boot warns when
   `POSTHOG_PROJECT_KEY` is set, `TRUST_PROXY` is false and `APP_ENV` is not
   `local`.

### The PostHog personal API key

`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` let express call
PostHog's private API: purged users are deleted from PostHog, and
`pnpm flags:sync` creates missing flags. Boot
warns when only one of them is set. They are independent of
`POSTHOG_PROJECT_KEY`. Staff read events, replays and error issues in
PostHog itself.

**Turning it on, once per environment:**

1. In PostHog, create a personal API key with only the scopes
   `person:write` and `group:read`, plus `feature_flag:read` and
   `feature_flag:write` for the flags, owned by a service account rather
   than a person.
2. Set `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` (the numeric id of
   the project `POSTHOG_PROJECT_KEY` reports to). The app host follows the
   ingest host's region (`https://us.posthog.com` or `https://eu.posthog.com`);
   set `POSTHOG_APP_HOST` for a self-hosted PostHog. Set them on the worker
   pods too: the PostHog deletion of purged users runs on the analytics
   Worker.
3. Optional: run `pnpm analytics:backfill-groups` once, so existing tenants'
   group properties converge. It needs `POSTHOG_PROJECT_KEY` too and fails
   without it.

### Error tracking

With `POSTHOG_PROJECT_KEY` set, unexpected 5xx answers, uncaught exceptions and
a BullMQ job's final failure reach PostHog Error Tracking;
`ERROR_TRACKING_ENABLED=false` turns sending off without touching the rest of
analytics. What is captured is in
[ARCHITECTURE.md](ARCHITECTURE.md#error-tracking). Express needs no sourcemap
upload: `node --enable-source-maps` rewrites stacks to the `.ts` lines.

**Finding an error from its `errorId`.** Every 5xx body that `errorHandler`
writes, except a maintenance refusal, carries an `errorId`, and so does its
`Unhandled server error` log line, so search the logs for it first. Error Tracking's UI does not search
by event uuid; run this in SQL insights (HogQL) instead, which also gives the
issue to open:

```sql
select uuid, timestamp, properties.$exception_issue_id, properties.http_route, properties.trace_id
from events
where event = '$exception' and uuid = '<errorId>'
```

An id that finds nothing names a log line only: the error was not reported (a
deliberate 5xx, or error tracking off or throttled) or PostHog has not ingested
it yet (allow about 15 s).

`GET /api/v1/platform/system/status` answers the release and the reporter's
sent and dropped counts.

**`/health` names the release.** It answers `{ status, uptime, release }`; why
that is public, and how a private fork drops it, is in
[SECURITY.md](SECURITY.md#error-tracking-what-reaches-posthog).

### Feature flags

Flags are declared in `src/constants/flags.constants.ts`, evaluated on the
server and served to react and apex; how they work is in
[ARCHITECTURE.md](ARCHITECTURE.md#feature-flags). They are off until both
`POSTHOG_PROJECT_KEY` and `POSTHOG_FEATURE_FLAGS_KEY` are set: until then every
flag answers its registry fallback, gated routes answer 404, and nothing is
fetched from PostHog. That is a valid steady state. Boot refuses
`POSTHOG_FEATURE_FLAGS_KEY` without `POSTHOG_PROJECT_KEY`.

**Turning them on, once per environment** (each environment has its own PostHog
project, and every registered flag must exist in each):

1. In the project's settings (Feature flags), generate the Feature Flags Secure
   API Key (it starts with `phs_`) and set it as `POSTHOG_FEATURE_FLAGS_KEY`,
   on the API and worker pods alike. It only reads flag definitions; it is a
   secret and never reaches a browser.
2. Give the personal API key (`POSTHOG_PERSONAL_API_KEY`) the scopes
   `feature_flag:read` and `feature_flag:write`, and make sure the project has
   the `tenant` group type.
3. Deploy, then run `pnpm flags:sync` with that environment's variables (start
   with `pnpm flags:sync -- --dry-run`). It creates every registered flag that
   is missing, inactive at a 0 % rollout and tagged `code-registry`, prints
   `drift <key>: <field>` for a flag whose kind, variants or scope differ, and
   exits 0 when clean or after creating, 2 on drift, 1 on a failure. It never
   edits or deletes a flag; fix drift in PostHog or in the registry.
4. Roll flags out in PostHog. Every API and worker process picks up a change
   within about a minute; browsers on their next refetch (a page load, a
   tenant switch, focus after 5 minutes, or every 10 minutes).
5. Check the Apex status card's Feature flags section and the `/flags` page: a
   `missing` flag needs `pnpm flags:sync`, an `unsupported` one uses a
   construct the server can't evaluate (the page names it), and every flag
   PostHog has that the registry lacks is listed for information.

Run `pnpm flags:sync` again in every environment whenever a release adds a
flag. To run an experiment on a flag, sync first, then create the experiment
in PostHog reusing the flag.

## Maintenance mode

A platform owner switches maintenance mode from Apex's Maintenance page; how it
works is in [ARCHITECTURE.md](ARCHITECTURE.md#maintenance-mode), and the
let-through list and the controls on changing it are in
[SECURITY.md](SECURITY.md#maintenance-mode).

Runbook:

1. **Confirm staff access before `full`.** In `full` only staff can sign in,
   so make sure whoever will switch it off can request a sign-in link on Apex,
   or use Google; auth mail is never paused.
2. **Expect invitations to wait.** In `read_only` and `full`,
   `/invitations/verify` and `/invitations/confirm` answer 503 (`READ_ONLY_MODE`
   or `MAINTENANCE_MODE`) for everyone, staff invitees included. An invitee
   joins after maintenance ends, with the same link while it is unexpired: the
   invitation lasts 3 days, its confirm link 15 minutes, and a new click on the
   invitation mails a new confirm link.
3. **Use `read_only` for data fixes where reads are safe.** Customers keep
   reading; their writes answer 503 `READ_ONLY_MODE`, and jobs keep running.
4. **Before database work, check "0 running" on every paused queue** on the
   Maintenance page. `full` pauses every queue but `auth-email`, which keeps
   sending sign-in, step-up, invitation, invitation confirm and passkey notice mail. Jobs already running finish
   first.
5. **Staff keep working.** Staff actions in Apex and staff sign-ins keep
   working and writing during maintenance.
6. **Switch off from Apex.** Leaving `full` resumes the paused queues; notices that
   were still queued go out then.
7. **Restart every replica after restoring the database during maintenance.**
   A replica ignores a row whose version is not above the one it holds, so a
   restore to an earlier version leaves each replica on the old mode until it
   restarts.
8. **Keep the clocks in sync (NTP) on the database and every replica.** The 10 s
   pause grace and the notice wait are measured from the time the database
   stamps on the change, on each replica's own clock, so skew shifts when the
   queues pause.
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
- **Pipeline.** A push to `main` runs CI, then builds and pushes the image to
  GHCR (`.github/workflows/deploy.yml`). The `deploy` job there is a
  placeholder: no deployment target is chosen, so wire your own. Release
  tagging and the ruleset on `main` are in
  [ARCHITECTURE.md](ARCHITECTURE.md#deploying) and
  [CONTRIBUTING.md](CONTRIBUTING.md#releases).
- **Environment.** The orchestrator supplies the environment; the image has no
  `.env`. Set `APP_ENV` and `NODE_ENV=production` for every deployment but
  local, and `TRUST_PROXY` behind a proxy.

## Make this yours

This is a template. Before the first real commit on a project generated from
it, change the things that still say "express-boilerplate":

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
is not the public-domain "Unlicense", and this repository being publicly
visible grants no right to use, copy, modify or distribute it.
