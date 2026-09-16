# Boilerplate Roadmap — 7 Work Streams

Status: approved in brainstorming, not yet specced individually.
Session: https://claude.ai/code/session_01X9GsWxpLHaAkfEGJQMv5hB
Date: 2026-09-16

## Starting state

- `main` is at `7171af7` — B3's email-verification work is merged (20 commits, 395 tests passing).
- `origin/main` is 20 commits behind local `main` — NOT yet pushed.
- The only outdated dependency is `nodemailer` 10.0.9 → 10.0.10 (trivial). TypeScript 7 is
  blocked by `typescript-eslint@8.70.0` peering `<6.1.0` (documented in `MIGRATIONS.md`).
- The `feat/verify-email` worktree can be removed (merged to main).
- Docker compose stack (`feat-auth-postgres-1` etc.) is still running on ports 5433/6380/1025/8025.

## Sequencing (dependency order)

Each stream is its own spec → plan → subagent-driven execution cycle.

### Stream 1: Winston Structured Logging

**Why first:** every subsequent feature uses the logger.
**What:** replace `console.error` / `console.log` everywhere with a Winston logger service.
JSON output in production, human-readable in development. Correlate with request-id.
**Reference:** both Ofluence/core and Consequential/core use Winston with the same pattern.
**Scope:** `src/services/logger.service.ts`, update every `console.error` call site, add
log-level env var, add tests.
**Estimated size:** bounded — one service, ~15 call sites to update.

### Stream 2: BullMQ Job Queue

**Why second:** email moves behind it, OTEL traces it later.
**What:** add BullMQ with a worker pattern. Move email sending behind a queue (the fire-and-forget
`.catch()` pattern becomes a proper queued job). Add a health check for the queue.
**Reference:** both production codebases use BullMQ with Redis.
**Scope:** `src/services/queue.service.ts`, `src/jobs/email.job.ts`, `src/workers/email.worker.ts`,
update `register` and `resend-verification` to enqueue instead of fire-and-forget.
**Estimated size:** bounded-to-architectural — new service + worker + job pattern.

### Stream 3: Wire OpenTelemetry

**Why third:** instruments Express, Postgres, Redis, BullMQ all at once. Requires the logger
(for OTEL log correlation) and the queue (to instrument it).
**What:** wire `@opentelemetry/sdk-node` with Express, HTTP, Postgres, Redis instrumentation.
Export to the collector already running in docker-compose. Add Grafana dashboards.
**Reference:** both production codebases have full OTEL stacks.
**Scope:** `src/observability/tracing.ts`, env vars for OTEL endpoint, `--import` flag in
start script, docker-compose additions (Tempo, Prometheus, Grafana if not already present).
**Estimated size:** architectural — touches boot sequence, docker-compose, CI.

### Stream 4: Forgot / Reset Password

**Why fourth:** the infrastructure is already built (B3 Task 6 is planned in
`docs/superpowers/plans/2026-09-15-email-and-recovery.md`). Uses the logger and queue from
streams 1-2.
**What:** `POST /auth/forgot-password`, `POST /auth/reset-password`. Identical response for
known/unknown addresses. A successful reset must also set `emailVerifiedAt` (documented in
Task 6's own text, added during verify-email). Reset revokes all sessions.
**Reference:** the plan already exists with steps — needs the same front-loading of exact values
that the verify-email plan got.
**Scope:** new controller, validators, rate limiters, route wiring. The `password_reset`
token purpose and template already exist.
**Estimated size:** bounded — similar shape to Task 7 (verify-email).

### Stream 5: Google OAuth (Passport.js)

**Why fifth:** both production apps have it. Requires the auth system from B2-B3 plus the
logger from stream 1.
**What:** `passport-google-oauth20`, session store in Redis, `GET /auth/google`,
`GET /auth/google/callback`. Link to existing user by email or create new.
**Reference:** Ofluence/core uses Passport.js + `connect-redis` for sessions. Consequential/core
uses the same pattern plus Shopify OAuth.
**Scope:** new middleware, strategy, routes, env vars (Google client ID/secret), session config.
**Estimated size:** architectural — new auth flow, session management, callback handling.

### Stream 6: RBAC + Multi-Tenancy Seam

**Why sixth:** the most invasive — touches the user model, adds a tenant model, and every
protected route gains a role check. Requires everything above.
**What:** add a `tenants` table, a `user_memberships` table with roles, a `requireRole(...roles)`
middleware, and a tenant-scoping middleware. The seam is opt-in: a derived project that doesn't
need multi-tenancy ignores it.
**Reference:** Ofluence uses RLS policies on Postgres. Consequential uses middleware-level
scoping. The boilerplate should pick one and document the trade.
**Scope:** new models, migrations, repositories, middleware, update route wiring.
**Estimated size:** architectural — new subsystem.

### Stream 7: React Boilerplate Rebuild

**Why last:** the backend must be stable first, since the frontend calls it.
**What:** full rewrite of `~/Mahaverick/react-boilerplate`.

- React 18 → 19 (with React Compiler)
- React Router → TanStack Router (file-based, type-safe)
- Redux → Zustand (client state) + TanStack Query (server state)
- Tailwind 3 → Tailwind 4
- React Hook Form → TanStack Form + Zod 4
- Add proper tests (Vitest + Testing Library + MSW)
- Add CI workflow
- Add Dockerfile (nginx, matching production frontends)
- Align endpoint paths with the express-boilerplate's actual routes
- Fix the 498/401 token-expiry mismatch
  **Reference:** both Ofluence/pulse and Consequential/pulse are React 19 + TanStack Router +
  Zustand + Tailwind 4. Use them as the reference stack.
  **Estimated size:** architectural — full rewrite, ~2-3 hours.

## What NOT to build

Out of scope for all streams (these are project-specific, not boilerplate material):

- ML pipeline (Ofluence-specific)
- Cube.js semantic layer (Consequential-specific)
- dbt/BigQuery pipeline (Consequential-specific)
- Shopify/Stripe billing integration (project-specific)
- MCP server (project-specific, though the pattern could be documented)
- Agent platform (project-specific)

## Cross-pollination notes (for when you return to the production codebases)

### Consequential should adopt from Ofluence:

- Playwright E2E tests (pulse + apex have none)
- PostHog feature-flag kill switches (`maintenance.middleware.ts`)
- Renovate or Dependabot for dependency updates
- Trivy container scanning in CI
- Mutation proof test pattern (from the boilerplate's `tests/helpers/mutate.ts`)

### Ofluence should adopt from Consequential:

- MCP server pattern (expose analytics to LLMs)
- Kubernetes migration (off the single VM)
- Operational Claude Code skills (deploy/promote/hotfix)
- HMAC for service-to-service auth (stronger than API keys)
- TypeScript typecheck ratchet (incremental strict adoption)

### Both should adopt from the boilerplate:

- Mutation proof tests (`withMutatedMethod` / `withMutatedModule`, committed and gated)
- The `CLAUDE.md` convention (gotchas and non-derivable context)
- Secret scanning (gitleaks in CI + pre-commit)
