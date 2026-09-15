# express-boilerplate — Modernization Design

Date: 2026-09-14
Status: Approved (design); implementation plan pending
Companion spec: `react-boilerplate/docs/superpowers/specs/2026-09-14-modernization-design.md`

## 1. Problem

`express-boilerplate` was last touched on 2025-01-06 (9 commits). It is a
snapshot of an Express stack that the author has since moved away from in every
production repo. The divergence is not a set of missing features — it is a
stack generation:

|                    | express-boilerplate (today)      | the reference repo `core` (today)                     |
| ------------------ | -------------------------------- | ----------------------------------------------------- |
| Runtime            | Express 4, CommonJS              | Express 5, ESM, Node >=22                             |
| Package manager    | yarn                             | pnpm                                                  |
| Test runner        | Jest (2 test files)              | Vitest + supertest (624 test files)                   |
| Lint               | ESLint 8, legacy `.eslintrc.cjs` | ESLint 10, flat config                                |
| Validation         | Zod 3 + drizzle-zod              | Zod 4 (drizzle-zod dropped)                           |
| ORM                | Drizzle 0.33                     | Drizzle 0.45                                          |
| Runner             | ts-node                          | tsx                                                   |
| Middlewares        | 3                                | 17                                                    |
| Background work    | none                             | BullMQ + Redis, 23 jobs                               |
| Observability      | winston only                     | OpenTelemetry traces/metrics/logs + winston + PostHog |
| CI / Docker / docs | none                             | 3 workflows, multi-stage Dockerfile, 6 doc files      |

A boilerplate that contradicts what its author actually builds with is worse
than no boilerplate: it teaches a pattern that will be migrated away from on
day two.

### 1.1 Measured before-state

Recorded on 2026-09-14 against the repo as it stands, so "we improved it" is a
claim with a baseline behind it. Node v24.17.0, `npm install` (there is no
`yarn` on the machine; `yarn.lock` is stale infrastructure):

| Step            | Result                               |
| --------------- | ------------------------------------ |
| `npm install`   | passes                               |
| `npm run build` | passes                               |
| `npm test`      | **fails** — 1 of 2 suites cannot run |

The failing suite is `src/tests/auth.controller.test.ts`, and it does not fail
on an assertion. It fails at import:

```
val is not a non-empty string or a valid number. val=undefined
  at src/configs/constants/constants.ts:47
    maxAge: ms(process.env.REFRESH_TOKEN_EXPIRY as string)
```

`ms()` throws because `REFRESH_TOKEN_EXPIRY` is unset, at module-import time,
before any test body runs. **One test passes in the entire backend.**

This is the concrete argument for section 5.1: a missing environment variable
should fail at boot with a named list of what is missing, not as an opaque
third-party `TypeError` inside an unrelated test suite.

## 2. Decisions

These were settled before this document was written.

1. **Derive from production and strip**, rather than upgrade in place. `core` is
   already green on the target toolchain. Copy its config layer wholesale,
   cherry-pick the generic `src/`, then delete everything product-specific.
   In-place migration would mean performing Express 4->5, CJS->ESM, ESLint
   8->10, Jest->Vitest, Zod 3->4, Drizzle 0.33->0.45 and ts-node->tsx by hand,
   simultaneously, on code with two tests.
2. **Full core parity minus domain.** Workspace/roles/invitations _and_
   entitlements, Stripe billing, onboarding state machine, and consent/GDPR
   retention all ship.
3. **Infrastructure wired and required.** Postgres, Redis and an OTel collector
   are required to boot and are provided by `docker-compose.yml`.
4. **Latest everything, majors included.** See section 3.
5. **GitHub template repo + `pnpm bootstrap`.**

### 2.1 Stated assumption

"Wired and required" is read as applying to _infrastructure we can run locally_
(Postgres, Redis, OTel collector, Mailpit). Third-party SaaS — Stripe, PostHog,
Google OAuth, real SMTP — is wired end to end and covered by tests, but
env-gated: `pnpm dev` must not require a Stripe account. Each integration
exposes a disabled mode that still type-checks and still runs its tests against
a fake. If a hard requirement is wanted instead, that is a one-line change to
`env.config.ts` and the affected service guards.

## 3. Target stack

Versions are the npm registry `latest` as of 2026-09-14, not `core`'s pins.
`core` itself is behind on several of these; the boilerplate goes first and
records the migration, so the same bumps can later be replayed on `core`.

**Runtime and language**

- Node >=24 (`.nvmrc`: 24), pnpm 12.4.1, ESM, `"type": "module"`.
  Verified against `nodejs.org/dist/index.json` on 2026-09-14: 24 "Krypton" is
  Active LTS; 22 "Jod" — `core`'s pin — has moved to Maintenance. The Dockerfile
  base becomes `node:24-alpine`.
- TypeScript 7.0.2 _(major: native compiler port — highest-risk bump, see 10.1)_
- Express 5.2.1
- Drizzle ORM 0.45.2 / drizzle-kit 0.31.10, `postgres` driver, Postgres 18
  (`uuidv7()` as a column default is a built-in from 18 — no extension)
- Zod 4.6.5 (no `drizzle-zod`; `core` dropped it)

**Majors taken** — each needs a changelog read and a `MIGRATIONS.md` entry:
TypeScript 6 -> 7.0.2 · Vitest 4 -> 5.0.0 · BullMQ 5 -> 6.3.6 ·
nodemailer 9 -> 10.0.10 · eslint-plugin-unicorn 71 -> 74.0.0 · pnpm 11 -> 12.4.1

**Minors and patches taken**: eslint 10.10.0, typescript-eslint 8.70.0,
eslint-plugin-sonarjs 4.2.0, eslint-plugin-check-file 3.3.2, prettier 3.9.6,
lint-staged 17.5.1, globals 17.12.0, helmet 8.3.0, express-rate-limit 8.7.0,
redis 6.2.1, stripe 22.6.2, multer 2.4.0, sharp 0.35.4, p-retry 8.0.1,
posthog-node 5.52.2, @opentelemetry/sdk-node 0.222.0, tsx 4.23.13,
supertest 7.2.2, nodemon 3.1.14.

**Already at latest** (no change): bcrypt 6.0.0, passport 0.7.0, winston 3.19.0,
husky 9.1.7, @opentelemetry/api 1.9.1, express-session 1.19.0.

## 4. What ships

Source paths are in the reference repo's `core` checkout unless stated. "Port"
means copy and scrub; "generalize" means the logic is kept but the
product-specific shape is replaced with a neutral one.

### 4.1 Authentication

Port `src/controllers/auth.controller.ts`, `src/validators/auth.validators.ts`,
`src/utilities/auth.utilities.ts`, `src/middlewares/auth.middleware.ts`,
`src/repositories/user*.repository.ts`, `src/database/models/user*.model.ts`.

- JWT access + refresh, refresh rotation, `user_token` table
- Google OAuth via Passport (`src/utilities/oauth*.utilities.ts`,
  `src/configs/oauth-session.config.ts`), sessions on Redis via `connect-redis`
- Magic link, email verification, forgot/reset password
- `user_auth_provider` for multi-provider identity linking

Dropped: commerce-platform OAuth, partner/agency credential auth, MCP auth.

### 4.2 Tenancy, RBAC, invitations

Port `tenant.model`, `user-membership.model`, `invitation.model`,
`access-request.model`, `tenant-scope-slug.model`, `tenant-settings.model`, and
their repositories/controllers/routes; `src/middlewares/rbac.middleware.ts`,
`tenant-access.middleware.ts`; `src/utilities/{slugify,workspace-name,tenant-identifier,reserved-identifiers}`.

Tenant context comes from the `X-Tenant-ID` header, never from the JWT — this
is `core`'s existing contract and the frontend spec depends on it.

Dropped: the per-tenant onboarding-funnel config table, extraction/pipeline/topology overrides,
agency/partner multi-tenancy.

### 4.3 Billing and entitlements

Port `src/services/billing/*`, `src/clients/stripe.client.ts`,
`billing-{plan,subscription,subscription-item,addon}.model`,
`stripe-webhook-event.model` (idempotency), `src/routes/stripe-webhook.routes.ts`,
`src/middlewares/require-entitlement.middleware.ts`,
`tenant-entitlement-override.model`, and `billing:sync-catalog`.

Generalize: the plan/feature catalog becomes a neutral three-tier example
(`free` / `pro` / `enterprise`) with two sample entitlements, defined in one
constants file so a new project edits one place.

Dropped: commerce-platform billing, its subscription-reconciliation job, GMV-band pricing.

### 4.4 Onboarding, consent, retention

Port `user-onboarding.model` + `onboarding-status.routes`/`onboarding.routes`
(generalized to: verify email -> create workspace -> choose plan -> done),
`user-consent.model`, `src/middlewares/data-retention.middleware.ts`,
`src/utilities/lifecycle-unsubscribe.utilities.ts`.

### 4.5 Platform

- **Middlewares (12 of 17)**: rate-limit (with `SharedRateLimitStore` —
  Redis-backed, latches, falls back to in-memory), request-id, tracing,
  metrics, validation, error, auth, rbac, tenant-access, require-entitlement,
  internal-hmac, data-retention. Dropped: partner-auth, partner-error-envelope,
  require-commerce-session-token, analytics (product-specific vocabulary),
  turnstile (moves to an opt-in recipe).
- **Base classes**: `base.repository.ts`, `base.controller.ts`.
- **Utilities (29 of `core`'s 50 modules)**: auth, global, response, url, retry,
  concurrency, db-error, encryption, hmac, ssrf, svix-signature, origin,
  platform (platform-tenant helpers, not device platform), slugify,
  person-name, role-label, tenant-identifier, workspace-name, invitation-view,
  entitlement-error, oauth, oauth-token, google-callback, email,
  email-identity, email-template, lifecycle-unsubscribe, analytics-key,
  analytics-redaction. Each was checked for domain leakage before being listed;
  the ones carrying references (origin, tenant-identifier, email-template,
  analytics-redaction) are ported and scrubbed, not copied.
  `iframe-breakout.utilities.ts` is explicitly **not** ported — it exists to
  break out of the commerce platform's admin iframe.
- **Queues**: BullMQ 6 + Redis, with four generic jobs — email delivery sweep,
  token/session reaper, webhook-event cleanup, and one scheduled example.
  Dropped: all 19 pipeline/scoring/extraction jobs.
- **Email**: nodemailer 10 with three swappable transports — SMTP/Mailpit and
  Resend are ported (`src/clients/resend.client.ts`); the SES transport is
  carried over from this boilerplate's existing `@aws-sdk/client-ses`
  integration, not from `core`. Plus `src/utilities/email-template.utilities.ts`,
  HTML templates, `email_log` + delivery sweep.
- **Observability**: `src/observability/tracing.ts` (OTel SDK, OTLP HTTP),
  `correlation.ts`, `httpMetrics`; winston with the OTel log transport; PostHog
  node client, env-gated.
- **Health**: `/health` (shallow, liveness) and `/health/ready` (deep, checks
  DB + Redis) — the split is deliberate and documented; graceful shutdown on
  SIGTERM.
- **Storage**: multer + sharp upload pipeline. `core`'s
  `src/services/storage.service.ts` is Google Cloud Storage — that adapter is
  ported as-is. A local-disk adapter (the default, so `pnpm dev` needs no cloud
  account) and an S3-compatible adapter are **new code** against the same
  interface, not ports.
- **Seeders**: `src/database/seeders/` — platform tenant, demo tenant, an admin
  and a member user, billing catalog.
- **Scripts**: `mint-user-token`, `bootstrap`, `sync-billing-catalog`,
  `typecheck-tests-ratchet.mjs`.

Dropped wholesale: the scoring, onboarding-funnel, metrics-layer and
semantic-model subsystems; the cloud data warehouse and dbt integrations;
insights, chat/LLM, daily-report, narration, fleet-ops, k8s client, Slack;
the commerce-platform and marketing-data connectors; MCP server.

## 5. New code — not ported from anywhere

These are gaps in `core` too. The boilerplate is where they get built.

### 5.1 Fail-fast environment validation — `src/configs/env.config.ts`

`core` reads `process.env` ad hoc across 46 constants files; a missing variable
surfaces as a runtime `undefined` deep in a request. Replace with a single Zod
4 schema parsed once at boot, exporting a typed frozen `env` object and exiting
non-zero with a readable list of every missing/invalid key. `.env.example` is
generated from that schema by a script, so the two cannot drift.

### 5.2 OpenAPI 3.0 — `src/configs/openapi.config.ts`

The Zod validators already describe every request. Zod 4 ships
`z.toJSONSchema(schema, { target: 'openapi-3.0' })` natively, so no
`zod-to-json-schema` (which `core` still carries) and no `zod-openapi`. Each
validator gains `.meta({ title, description })`; a build step walks the route
table and emits `openapi.json`; a Scalar UI is mounted at `/docs` in non-production.

### 5.3 `docker-compose.yml`

Postgres 18, Redis 7.2, an OTel collector, and Mailpit for mail capture. This
is what makes "required infrastructure" cost one command.

### 5.4 `scripts/bootstrap.ts`

Generalized from `core/scripts/bootstrap.ts`, with all sibling-repo
(semantics/agents/infra/skaffold) logic removed. Steps: prompt for project name
and scope -> rewrite `package.json`, `README`, docs and repo URLs -> generate
JWT keypair, `SESSION_SECRET`, `INTERNAL_HMAC_SECRET` -> write `.env` and
`.env.test.local` from the env schema -> `docker compose up -d` -> create DB ->
migrate -> seed -> print a minted dev token and working curl examples.
Flags `--force` and `--keys-only` are kept.

### 5.5 Architectural fix — split `index.ts`

`core/src/index.ts` is 38k and does app construction, route mounting, worker
startup, listen and shutdown. The boilerplate must not teach that. Split into
`src/app.ts` (build and return the Express app — importable by supertest with
no side effects), `src/server.ts` (listen, workers, graceful shutdown) and
`src/index.ts` (entrypoint, ~10 lines).

## 6. Conventions

Ported from `core/eslint.config.mjs` and enforced, not merely documented:

- `eslint-plugin-check-file` pins filename and folder naming —
  `*.controller.ts`, `*.repository.ts`, `*.service.ts`, `*.validators.ts`,
  `*.middleware.ts`, `*.model.ts`, `*.utilities.ts`, `*.constants.ts`,
  kebab-case folders.
- `@/*` path alias; `tsc-alias --resolve-full-paths` on build.
- `sonarjs`, `unicorn`, `promise`, `import` rule sets. The ~25 `unicorn` rules
  `core` disables are re-examined rather than copied: each disable there is
  justified by an existing-code count ("304 occurrences"), which a greenfield
  boilerplate does not have. Only disables with a stated semantic reason carry over.
- Conventional commits via commitlint 21 + commitizen (`pnpm commit`).

## 7. Testing

Ported harness: `tests/helpers/global-setup.ts` (auto-creates and migrates the
test DB), `tests/helpers/test-database.ts` (one Postgres database per worker),
the `tests/fixtures/factories` pattern, and the `.env.test` layering
(process env > `.env.test.local` > committed `.env.test`, mirroring the CI env
block — a new test var must be added in both).

- Vitest 5, `pool: 'forks'`. `TEST_WORKER_COUNT` and `maxWorkers` must stay
  equal, or a worker connects to a database that was never created.
- Layout `tests/unit/**` and `tests/integration/**`, plus colocated
  `src/**/*.test.ts` for utilities — `core`'s vitest `include` covers both
  and its ported utilities carry their tests with them.
- Every shipped middleware, utility, validator, repository and route has at
  least one test. The auth, tenancy, invitation, billing-webhook, entitlement
  and onboarding flows have integration tests through supertest.
- No object literal describing a model is duplicated across test files —
  factories only.
- Coverage: v8 provider, thresholds at 80% for lines, functions, branches and
  statements (`core`'s numbers, ported as-is). CI runs
  `vitest run --coverage`, so the threshold is a gate rather than a report.
- `core`'s typecheck-tests ratchet is ported with an **empty** baseline.
  `core`'s freezes 452 pre-existing errors across 106 files; a greenfield repo
  inherits none, so here the ratchet holds the line at zero rather than
  freezing debt.

## 8. Repo hygiene

`.github/workflows/ci.yml` (Postgres 18 + Redis services, lint, typecheck,
test, build), `.github/workflows/build-only.yml`, multi-stage `Dockerfile`
(non-root uid 10001, pnpm store cache mount, `HEALTHCHECK NONE` because the
orchestrator owns probes), `.dockerignore`, `.nvmrc`, `.npmrc`
(`engine-strict=true`), `dependabot.yml`, `CODEOWNERS`, `.devcontainer/`,
`.gitleaks.toml` and `SECURITY.md` (ported from the reference repo's `infra`),
`.editorconfig`, husky `pre-commit` (lockfile drift, cached eslint, changed
tests) and `pre-push` (full sweep).

Docs: `README.md` (quickstart), `ARCHITECTURE.md`, `STRUCTURE.md` (where new
code goes), `DATABASE.md`, `CONTRIBUTING.md`, `MIGRATIONS.md` (the major-bump
log), `CLAUDE.md` and `AGENTS.md`.

## 9. Out of scope

- Any change to `core`, or to any other sibling service in the same fleet. The
  upgrade decision was explicitly scoped to the boilerplates; they act as the
  proving ground, and `MIGRATIONS.md` is the artifact that makes the same bumps
  replayable on `core` later.
- A `create-*` CLI. GitHub template + `pnpm bootstrap` is the chosen shape.
- GraphQL, tRPC, WebSockets, i18n, feature-flag service. Recipes, not defaults.
- **Platform admin** — `core`'s `admin.routes`/`admin.controller` and the
  matching `_protected/admin/tenants/*` screens. A cross-tenant
  list/suspend/impersonate console is arguably generic under "full parity minus
  domain", but `core`'s is built around fleet operations and would need
  rewriting rather than stripping. Called out here rather than dropped silently:
  say so if it should ship, and it moves into scope on both sides.

## 10. Risks

1. **TypeScript 7 is the native compiler port.** The largest behavioural change
   in the set. `typescript-eslint` 8.70 and `tsc-alias` must be verified against
   it before anything else is built; if either is incompatible, TS 7 is the one
   bump to defer, and that decision gets recorded rather than silently taken.
2. **BullMQ 6 and nodemailer 10** are majors with runtime (not just type)
   surface. Both need their integration tests written before the port, not after.
3. **Scrub completeness.** Every ported file is grepped for the product
   identifiers and domain vocabulary now listed in `.github/domain-terms.txt`,
   and for real hostnames, before commit. CI gets a grep gate so it cannot
   regress.
4. **Never read or copy** `.env`, `.env.secrets.*`, `.env.skaffold`,
   `.env.test` from the production repos — those hold live values.
   `.env.example` only.
5. **The derive-and-strip premise was verified, not assumed.** `core`'s last
   three GitHub Actions runs were green on 2026-09-14 (Deploy on `develop` plus
   two PR CI runs). `pulse`'s `develop` is green; one docs-branch PR was red at
   the time of writing. Re-check before the port begins — deriving from a red
   source repo removes the entire safety argument for this approach.
6. **Scope.** This is a large build. It is sequenced in the implementation plan
   so that each stage leaves the repo green and runnable, rather than landing as
   one unreviewable commit.

## 11. Contract with the frontend

The React spec depends on these being stable:
`POST /api/v1/auth/{register,login,refresh,logout,verify-email,forgot-password,reset-password}`,
`GET /api/v1/auth/google` + callback, `GET/PATCH /api/v1/profile`,
`GET/POST /api/v1/tenants`, `GET/POST/DELETE /api/v1/tenants/:id/members`,
`POST /api/v1/invitations` + `POST /api/v1/invitations/:token/accept`,
`GET /api/v1/onboarding/status`, `GET /api/v1/billing/{plans,subscription}`,
`POST /api/v1/billing/checkout`. Tenant selection is the `X-Tenant-ID` header.
Backend is specified and built first.

## 12. Standards

These apply to every file, ported or new, and are enforced rather than
documented — a convention that lives only in a doc decays.

Testing standards are in section 7, alongside the ported harness.

### 12.1 Documentation — JSDoc

`core` already carries 4,507 JSDoc blocks across 610 of its 727 source files
(84%), including 204 `@example` blocks — and 871 `@param` / 368 `@returns` /
65 `@throws` tags. The convention is established; what is missing fleet-wide is
enforcement (`eslint-plugin-jsdoc` appears in no repo). The boilerplate adds it
at 64.4.0, in TypeScript mode:

- `jsdoc/require-jsdoc` with `publicOnly: true` — exported symbols must be
  documented, internal helpers need not be.
- `jsdoc/require-param-description` and `require-returns-description`: on.
- `jsdoc/require-param-type` and `require-returns-type`: **off**. TypeScript
  already carries the types, and repeating them in the comment creates a second
  source of truth that drifts. This is the line between a useful rule and a
  noisy one.
- `check-alignment`, `check-param-names`, `check-tag-names`,
  `no-undefined-types`: on.
- Every module carries a file-header comment saying what it is for and, where
  the answer is not obvious, **why it exists**. The model is
  `core/src/configs/rate-limit-store.config.ts`, whose header explains that the
  store latches from memory to Redis because limiters are built at import time,
  before the startup sequence connects anything. That comment is worth more
  than any per-function tag.

### 12.2 Supply chain and secrets

- `pnpm audit --prod` as a blocking CI step.
- `dependabot.yml`, grouped by ecosystem, weekly.
- Gitleaks at **both** layers. `infra/.pre-commit-config.yaml` (gitleaks pinned
  to a tagged release, plus large-file and private-key hooks) is ported for the
  laptop layer, and a blocking CI workflow is added — `core` has no gitleaks
  workflow today, so the fleet's only credential scanning is one that a
  developer can skip with `--no-verify`.
- `.gitleaks.toml` ported from `infra`; `SECURITY.md` adapted from `infra`'s
  (which is 38k and product-specific) down to a boilerplate-sized policy.

## 13. Added this round — new code, not in `core`

Each is flagged separately so the spec review is its approval gate.

- **MFA** — TOTP enrolment and verification plus single-use recovery codes,
  with `user_mfa_factor` and `user_recovery_code` models and a step-up check in
  `auth.middleware`. `core` has none, and a 2026 SaaS boilerplate without MFA is
  incomplete. Passkeys/WebAuthn are deliberately **not** included; they ship as
  a recipe.
- **Generic audit log** — an `audit_log` model, repository and
  `recordAuditEvent(actor, tenant, action, subject, metadata, ip, userAgent)`
  helper. `core` has seven log tables and every one of them is domain-specific;
  the generic one is what a new project actually needs first.
- **Pagination convention** — cursor-based paging in `common.validators.ts`
  (`limit`, `cursor`, `order`), a `paginate()` helper on `base.repository`, and
  one response envelope (`data`, `nextCursor`, `hasMore`). `core` has no shared
  convention, so each endpoint invents its own.
- **Security baseline**, written into `SECURITY.md` rather than left implicit:
  - CSRF — the API is Bearer-token with `SameSite` cookies, so no CSRF token
    middleware ships. The reasoning is documented, because "we have no CSRF
    protection" and "CSRF does not apply to this design" look identical in a
    code review.
  - Password hashing stays bcrypt at cost 12 (`core`'s choice). argon2id is
    OWASP's current preference and ships as a recipe with a migration note.
  - `helmet` with an explicit Content-Security-Policy rather than its defaults.
  - Rate limiters keep `standardHeaders: true` / `legacyHeaders: false`.

## 14. Packaging fixes carried into the port

`core` has `@types/express-session`, `@types/passport`,
`@types/passport-google-oauth20` and `drizzle-kit` in `dependencies` rather
than `devDependencies`. Types are compile-time only, and the production image
migrates with `node dist/database/migrate.js` rather than drizzle-kit, so all
four move to `devDependencies` here and the runtime image is verified to boot
without them. Carried as a fix, not copied as a pattern.
