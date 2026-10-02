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
Staff directory: tenant and user search, detail, create, lifecycle, account
actions and owner-only purge under `/api/v1/platform`, role-gated per route,
audited with a reason, destructive actions behind a recent password
sign-in.
Message tracking: a delivery timeline per email fed by provider webhooks
(Resend, and a fake one for local), deliverability health, masked
previews, resend through the flow that sent the mail, and an automatic
suppression list; see [Email tracking](#email-tracking).
Onboarding: a code-defined steps registry with per-tenant and per-member
progress, a customer checklist API, and a staff funnel, stuck-tenant list,
reminders and manual completion; see [Onboarding](#onboarding).
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

`APEX_URL` is optional: set it to the origin of the Apex staff dashboard so
platform-tenant invitations and `app: "apex"` verification, reset and Google
sign-in links open there instead of at `WEB_URL`. See
[A second frontend: Apex](ARCHITECTURE.md#a-second-frontend-apex).

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

| Script                              | What it does                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm dev`                          | `tsx watch`, loading `.env` and then `src/observability/tracing.ts` first.                 |
| `pnpm build`                        | `tsc` and `tsc-alias` into `dist/`, with the migrations copied alongside.                  |
| `pnpm start`                        | Runs the build, loading `.env` and `dist/observability/tracing.js` first.                  |
| `pnpm lint`                         | `eslint .`, then `tsc` over `src/` and `tests/` (`tsconfig.typecheck.json`).               |
| `pnpm lint:fix`                     | `eslint . --fix`.                                                                          |
| `pnpm lint:docs`                    | History phrasing and broken links in docs; code citing a missing doc.                      |
| `pnpm format` / `pnpm format:check` | Prettier over the whole repo.                                                              |
| `pnpm test`                         | `vitest run`. Needs the compose stack.                                                     |
| `pnpm test:watch`                   | `vitest watch`.                                                                            |
| `pnpm test:unit`                    | Every test but `tests/integration/**`; runs with Docker down.                              |
| `pnpm test:coverage`                | `vitest run --coverage`, gated at 80% on all four measures.                                |
| `pnpm env:example`                  | Regenerates `.env.example` from the Zod schema.                                            |
| `pnpm env:table`                    | Prints ARCHITECTURE.md's environment table from the Zod schema.                            |
| `pnpm db:migration:generate`        | `drizzle-kit generate`; see [DATABASE.md](DATABASE.md).                                    |
| `pnpm db:migrate`                   | Applies pending migrations against `DATABASE_URL`.                                         |
| `pnpm db:migrate:prod`              | The same, as `node dist/database/migrate.js`; run that in the prod image.                  |
| `pnpm platform:grant -- <e> <role>` | Gives a platform-tenant role; see below.                                                   |
| `pnpm email:fire-event <id> <type>` | Signs and posts a fake provider event (local only); see [Email tracking](#email-tracking). |
| `pnpm onboarding:reconcile`         | Re-derives tracked tenants' automatic onboarding steps; see [Onboarding](#onboarding).     |
| `pnpm commit`                       | Interactive conventional-commit prompt.                                                    |

`pnpm platform:grant -- <email> <role>` gives an existing user with a verified
address a role (`owner` to `viewer`) in the platform tenant, audited as
`platform.member.granted`. Nobody can invite staff before a platform owner
exists, so this is how the first one is made.

## Email tracking

Every outbound email is one `email_messages` row, written when the mail is
queued: the recipient, the template, the user, tenant and invitation it is
about, the frontend its link opens (`link_app`), the sender class, its
`Message-ID`, and the template's non-secret `previewVariables`. Never a
rendered body, a link or a token. Each send attempt stays an append-only
`email_logs` row pointing at its message, and each provider event an
`email_events` row. A status only moves to a higher rank
(`EMAIL_STATUS_RANK`, `src/constants/email.constants.ts`), so a fast
`delivered` event is never overwritten by the worker's `sent`; `opened` and
`clicked` never change it. `RETENTION_EMAIL_LOGS_DAYS` purges messages,
their attempts and their events together; suppressions never expire.

### Provider webhooks

`POST /api/v1/webhooks/email/:provider` takes delivery events. `app.ts`
mounts its router after `requestContext` and before the global
`express.json`, with a raw body parser (256 kB) on that router only, so the
signature is checked over the exact bytes the provider sent. It takes no
access token and no CSRF token. An unknown or unconfigured
provider gets the generic 404 before any limiter runs. Two limiters follow:
`RATE_LIMITS.emailWebhook` allows 3000 accepted requests a minute per
provider, not per IP, so a bounce storm is not throttled into retries, and
`RATE_LIMITS.emailWebhookRejected` allows 60 failed requests a minute per IP,
so forged traffic cannot spend a provider's budget. A bad signature gets 401
`INVALID_SIGNATURE`.
Each request logs one `email webhook processed` line with its counts
(received, duplicate, unmatched, ignored, processed, and per event type). A
repeated event is stored once, so a provider's retry changes nothing.

**Resend.** In the Resend dashboard, add a webhook for
`https://<api host>/api/v1/webhooks/email/resend` and subscribe it to
`email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.complained`, `email.opened`, `email.clicked`, `email.failed` and
`email.suppressed`. Put its signing secret (`whsec_…`) in
`RESEND_WEBHOOK_SECRET`; the adapter is enabled only while that is set.
Every other event type is acknowledged and ignored. A permanent bounce and
a complaint suppress the address; a transient bounce is a delay and
suppresses nothing. `email.suppressed` (Resend's own list blocked the send)
marks the message failed and adds no local suppression.

**Two senders.** Token emails (verification, password reset, account setup,
invitations) always go from `MAIL_FROM_TRANSACTIONAL`; the two security
notices go from `MAIL_FROM`. No caller picks the sender. Give
`MAIL_FROM_TRANSACTIONAL` its own subdomain (for example
`no-reply@auth.example.com`) and keep click tracking **off** for that domain
at the provider: tracked links are rewritten through the provider's
redirector, which would then see every token. Open and click rates count
`MAIL_FROM` mail only. Left unset it falls back to `MAIL_FROM`, and outside
`local` the boot check warns when both senders share a domain.

**Rollout order.** Deploy the workers before, or with, the API. A job the
API enqueues at this version and an older worker picks up is sent untracked:
its row stays `queued`, it goes from the general sender, and no suppression
check runs. That lasts only for the deploy window.

**Webhook limiter caveat.** `emailWebhookRejected` counts a request while it
is in flight and refunds it only when it finishes under 400, so more than 60
concurrent deliveries from one provider IP can be throttled. Providers retry,
and the `svix-id` dedupe makes a retry exact. A wrong `TRUST_PROXY` (every
caller seen as the proxy's IP) would put all webhook traffic in one per-IP
bucket.

**Resending an invitation from staff.** A resend through
`/platform/emails/:id/resend` spends the staff write limiter (`platformWrite`,
30 a minute per staff user), not the member route's `invite-tenant-member`
budget. Every resend is admin-only, audited with a reason, and rotates the
token.

**Local.** `APP_ENV=local` (tests included) also enables a `fake` provider,
signed with `FAKE_EMAIL_WEBHOOK_SECRET` (a local default, not a
credential). `pnpm email:fire-event <messageId> <type> [hard|soft] [--origin
<api origin>]` signs and posts one event for a message id from Apex or
`GET /platform/emails`; `--origin` defaults to the local API.

### Suppression

A hard bounce or a complaint adds the address to `email_suppressions`.
While it is there, every mail to it, security notices included, is marked
`suppressed` and never sent, and the caller is told nothing, so a send
still reveals no account. Staff lift a suppression from Apex's Suppressions
page (`POST /platform/email-suppressions/:id/lift`: admin, with a reason,
audited as `email.suppression_lifted`); lifting one twice answers 409
`already_lifted`. A user purge keeps the suppressions of their address: they
belong to the mailbox, not the account.

### Staff reads, preview and resend

`GET /platform/emails` searches messages newest first (recipient text,
status, template, user, tenant, and `from`/`to` UTC days, both inclusive),
and `GET /platform/emails/:id` returns one message's timeline: attempts,
provider events, the address's active suppression and the resend chain
(`resentFromId`, `resentAsIds`). `GET /platform/emails/health?range=7d|30d`
counts messages per UTC day in five disjoint groups (delivered; sent, which
includes deferred; undelivered, which is bounced or failed; complained;
suppressed) and reports rates over the messages that left the server.
Without a webhook every successful send stays `sent`, and every rate except
the undelivered rate is `null` until a provider event arrives.

`GET /platform/emails/:id/preview` re-renders the stored template: every
link keeps its page and frontend with the token shown as `••••••`, the
inviter reads "A teammate" (the name is never stored), and a stored
variable a row lacks (a legacy row) is masked, with `partial: true`; the
masked token and the inviter's placeholder alone never make it partial. Apex shows the HTML in a sandboxed
`srcdoc` iframe, which inherits the page's CSP (`img-src 'self' data:`).
The templates use inline styles only; a remote image added to one would not
load in the preview.

`POST /platform/emails/:id/resend` (admin, with a reason) never replays a
mail. It runs the action that sent it, which issues a fresh token:
resend-verification for a verification mail, password-setup for account
setup and password reset (sending whichever applies to the user now), and
the invitation resend for an invitation. That action's role rules, errors
and audit entry apply unchanged, and `email.resent` records the reason
beside it. The two security notices, `password_changed` and
`registration_attempt`, are never resent, nor is a row without the ids its
action needs (409 `not_resendable`); a suppressed recipient gets 409
`recipient_suppressed` and a template this build no longer has 409
`template_unavailable`. An invitation to a tenant that is not active gets
the member routes' 404, and one to the platform tenant needs a sign-in
within the last 10 minutes (401 `REAUTH_REQUIRED`), as the member route
does.

## Onboarding

Onboarding steps are an extension point, not product logic: the registry is
`ONBOARDING_STEPS` in `src/constants/onboarding.constants.ts`, served to both
apps (neither keeps its own copy). Each step has a snake_case `key`, a
`title` and `description`, a `scope` (`tenant`, done once for the tenant, or
`member`, done by each person), a `completion` (`auto` on a trigger, or
`manual`, ticked by the customer) and `required`. Steps display in registry
order and complete in any order. A tenant is **complete** once every
required step is done (a member step counts once any active owner has done
it), and **stuck** when it is not complete, not dismissed, and has made no
progress for `ONBOARDING_STUCK_AFTER_DAYS` (default 7) or more. An owner can
dismiss the checklist and bring it back.

**Adding a step.** Add an entry to `ONBOARDING_STEPS`; the load-time check
refuses a duplicate or non-snake_case key and a trigger mapped to two steps
of one scope. An `auto` step, of either scope, completes from its trigger: a
value of `ONBOARDING_TRIGGERS` that a subscriber in `onboarding.service.ts`
maps from a `DomainEvent` (`teammate_joined`, for one, comes from the
`invitation_accepted` event), and a member step completes for the event's
subject user. For a new trigger, add the value to `ONBOARDING_TRIGGERS`,
add the event to the `DomainEvent` union if it is new, subscribe to it, and
call `emitDomainEvent` from the service that does the work, after its
transaction commits. Product code can also call `completeOnboardingStep`
directly (a member step needs the `userId`). `completeOnboardingStep` is the
single writer and is idempotent. Mirror nothing in the apps: both render
what `GET /tenants/:slug/onboarding` and the staff endpoints return.

**Only tenants created after this release are tracked.** Existing tenants
have `onboarding_tracked = false` and show as not tracked. A tenant staff
create waits for its first owner to accept (`awaiting_owner`, never stuck)
before its clock starts. Actions staff take through platform access (an
`access: 'platform'` request on a customer route) never count as customer
progress.

**Staff.** `GET /platform/onboarding/funnel?range=7d|30d|90d` (default 30d)
counts, over the active tracked tenants whose onboarding started in the
range, each step's completions and how many of them staff made, and the
cohort by state. `GET /platform/onboarding/tenants?state=` lists the active
tracked tenants in one state (`stuck` by default, longest stuck first; the
others newest first; `awaiting_owner` included) with cursor paging, and
`GET /platform/tenants/:id/onboarding` returns one tenant's onboarding in
any lifecycle state: each step with who completed it (staff completions
with their reason), each member step's per-member status, the reminder
history, and whether a reminder may go now. `GET /platform/stats` counts
stuck tenants in `totals.stuckTenants`. Platform admins may mark a tenant
step complete (`POST /platform/tenants/:id/onboarding/steps/:key/complete`,
with a reason) and send a reminder (`POST
/platform/tenants/:id/onboarding/remind`, with a reason): one
`onboarding_reminder` email to each active owner, tracked like every other
email, at most one per tenant per 24 hours (409 `reminded_recently` with
`errors.retryAfter`). Both are refused on a suspended or archived tenant
(409 `tenant_state_conflict`) and audited in the tenant itself with platform
access, so the customer's Activity tab shows them. The reminder writes the
owners' email rows and its audit entry in one transaction and queues the
sends after it commits; if queueing fails, the audit entry stays, the
affected email row is marked failed, and the response says `emailSent:
false`.

**`pnpm onboarding:reconcile`.** Subscribers run after the request commits
and never fail it; one that fails only logs. The reconcile script
re-completes the default automatic tenant steps of every live, tracked,
started customer tenant (one still `awaiting_owner` is skipped) from what
members provably did, each stamped with the time it happened:
`configure_settings` from the earliest settings save audited with member
access, `invite_teammate` from the earliest teammate invitation audited with
member access (both since the clock started), and `teammate_joined` from the
second member's join (its `invitation.accepted` entry, else its membership's
`created_at`), or the clock's start when that came later. Settings saves and
invitations by staff through platform access are never credited. It is best
effort: it reads the audit log, so entries pruned under
`RETENTION_AUDIT_LOGS_DAYS` (0, the default, keeps them forever) leave no
trace, and a restored old event leaves a stuck tenant stuck.

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

| Doc                                | Owns                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| [README.md](README.md)             | Quick start, scripts, email tracking setup, onboarding, making the template yours, this index |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Boot, layers, directory rules, configuration and env vars, Docker, deploying                  |
| [DATABASE.md](DATABASE.md)         | Client, models, migrations, test database, live schema changes                                |
| [SECURITY.md](SECURITY.md)         | Reporting, supported versions, what is and is not implemented                                 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Hooks, commits, CI, releases, dependency policy, docs to update                               |
| [CLAUDE.md](CLAUDE.md)             | Rules and gotchas for anyone changing the code                                                |
| [AGENTS.md](AGENTS.md)             | Agent entry point, pointing at CLAUDE.md and this index                                       |

## License

Proprietary, all rights reserved. See [`LICENSE`](LICENSE).

`package.json` declares `UNLICENSED`, npm's spelling for "not open source". It
is not the public-domain "Unlicense", and this repository being publicly
visible grants no right to use, copy, modify or distribute it.
