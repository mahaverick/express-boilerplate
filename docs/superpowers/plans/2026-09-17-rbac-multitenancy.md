# RBAC + Multi-Tenancy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in multi-tenancy seam with tenants, settings, 5-tier role-based memberships, tenant-resolution middleware, and a complete tenant management API.

**Architecture:** Three new tables (tenants, tenant_settings, user_memberships), two middleware functions (resolveTenant + requireRole), 10 API endpoints. `resolveTenant` reads from `request.params.slug` on tenant routes (not a header — avoids confused-deputy). Non-members get 404 (not 403 — Ruling G, don't leak existence). Tenant context extends the existing `RequestContext` AsyncLocalStorage (no second store).

**Tech Stack:** Drizzle ORM, Express middleware, Zod 4 for validation.

**Spec:** `docs/superpowers/specs/2026-09-17-rbac-multitenancy-design.md`

## Global Constraints

- TypeScript pinned `~6.0.3`, Zod 4.6.5
- No barrel files — import directly
- `db` from `@/services/database.service` (NOT `getDatabase()`)
- `exactOptionalPropertyTypes: true`
- FKs use `.references(() => model.id, { onDelete: 'cascade' })`
- `BaseRepository` requires `SoftDeletableTableConfig` (id, deletedAt, updatedAt) — tenants CAN extend it; tenant_settings and user_memberships are standalone
- Repos don't accept tx handles — transaction call sites insert directly against `tx` (Stream 5 precedent)
- `pnpm db:migration:generate` generates migrations — commit SQL + meta/
- Tests hitting Docker under tests/integration/
- Every mutating auth-adjacent route needs a rate limiter

## Spec Corrections

1. **Spec §3 `X-Tenant-ID` header:** For `/tenants/:slug/*` routes, `resolveTenant` reads `request.params.slug`, NOT the header. The header form (`X-Tenant-ID`) is for future tenant-scoped resource routes. `resolveTenant` takes a source option: `resolveTenant({ from: 'param' })` (default) or `resolveTenant({ from: 'header' })`.
2. **Spec §3 step 3 returns 403:** Wrong — returns 404 (same as non-existent). Non-members must not learn a tenant exists. Consistent with Ruling G.
3. **Spec §3 separate AsyncLocalStorage:** Use the existing `RequestContext` store — extend its interface with `tenant?: { tenantId, tenantSlug, role }`. `resolveTenant` calls `requestContextStore.enterWith(...)`. No second store, no new file.
4. **Spec §4 safety rules:** Admin cannot target another admin or owner. The role matrix:

| Actor \ Target | owner      | admin | manager | editor | viewer |
| -------------- | ---------- | ----- | ------- | ------ | ------ |
| owner          | self-only* | yes   | yes     | yes    | yes    |
| admin          | no         | no    | yes     | yes    | yes    |
| manager        | no         | no    | no      | no     | no     |
| editor         | no         | no    | no      | no     | no     |
| viewer         | no         | no    | no      | no     | no     |

*owner can't remove/demote self if they're the last owner

5. **Slug validation:** `z.string().min(3).max(100).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)` with a reserved-words list.
6. **Rate limiters:** `POST /tenants` and `POST /tenants/:slug/members` need rate limiters (user-keyed, not IP-keyed — behind requireAuth).
7. **`TENANT_ID_HEADER = 'X-Tenant-Id'`** in `tenant.constants.ts` for the future header form.
8. **`TenantRepository.create()`** does all 3 inserts (tenant + settings + owner membership) directly against a `db.transaction()` tx handle — doesn't call the other repos.

---

### Task 1: Constants + Models + Migration + Repositories

**Files:**

- Create: `src/constants/tenant.constants.ts`
- Create: `src/database/models/tenant.model.ts` (tenants + tenant_settings)
- Create: `src/database/models/user-membership.model.ts`
- Create: `src/repositories/tenant.repository.ts`
- Create: `src/repositories/tenant-settings.repository.ts`
- Create: `src/repositories/user-membership.repository.ts`
- Create: migration (generated)
- Create: `tests/integration/repositories/tenant.repository.test.ts`
- Create: `tests/integration/repositories/user-membership.repository.test.ts`

**Interfaces:**

- Produces: `TENANT_LIFECYCLE_STATES`, `TenantLifecycleState`, `MEMBERSHIP_ROLES`, `MembershipRole`, `TENANT_ID_HEADER`, `RESERVED_SLUGS`
- Produces: `tenantModel`, `tenantSettingsModel`, `userMembershipModel` + inferred types
- Produces: `TenantRepository` (extends BaseRepository): `findBySlug`, `findBySlugOrId`, `findActiveBySlug`, `create` (atomic 3-insert), `listForUser`
- Produces: `TenantSettingsRepository` (standalone): `findByTenantId`, `update`
- Produces: `UserMembershipRepository` (standalone): `findByUserAndTenant`, `listByTenant` (with user info, no passwordHash), `listByUser` (with tenant info), `create`, `updateRole`, `delete`, `countOwners`

Key implementation details:

- `TenantRepository` extends `BaseRepository` (has deletedAt + updatedAt). `findActiveBySlug` adds `lifecycleState = 'active'` on top of BaseRepository's soft-delete scope.
- `TenantRepository.create()` uses `db.transaction(async (tx) => {...})` for all 3 inserts directly — doesn't call TenantSettingsRepo or UserMembershipRepo (they don't accept tx).
- `listByTenant` returns `Array<{ membership: UserMembership; user: Pick<User, 'id'|'email'|'firstName'|'lastName'> }>` — never returns `passwordHash`.
- `countOwners(tenantId)` for the "last owner" safety check.
- `userMembershipModel.role` has a CHECK constraint against MEMBERSHIP_ROLES (same pattern as auth_providers.provider).

- [ ] Steps: Create constants → models → generate migration → repos → tests → commit

---

### Task 2: Middleware (resolveTenant + requireRole)

**Files:**

- Create: `src/middlewares/tenant.middleware.ts`
- Modify: `src/middlewares/request-context.middleware.ts` (extend `RequestContext` interface)
- Modify: `src/types/express.d.ts` (add `principal?: RequestPrincipal`)
- Create: `tests/unit/middlewares/tenant.middleware.test.ts`
- Create: `tests/integration/middlewares/tenant.middleware.test.ts`

**Interfaces:**

- Consumes: `TenantRepository.findActiveBySlug`, `UserMembershipRepository.findByUserAndTenant`
- Consumes: `requestContextStore` from request-context.middleware
- Produces: `resolveTenant(options?: { from: 'param' | 'header' })` — middleware
- Produces: `requireRole(...roles: MembershipRole[])` — middleware factory
- Produces: `RequestPrincipal` type on `request.principal`

Key implementation details:

- `resolveTenant({ from: 'param' })` (default): reads `request.params.slug`
- `resolveTenant({ from: 'header' })`: reads `request.get(TENANT_ID_HEADER)`
- Both non-member AND non-existent return 404 (Ruling G — no existence leak)
- Extends `RequestContext` with `tenant?: { tenantId, tenantSlug, role }` — uses `requestContextStore.enterWith()` to add tenant info to the existing ALS context. Logger picks up `tenantId` for free.
- Verify `request.principal` doesn't collide with `@types/passport` — grep the types before choosing the name.
- `requireRole` checks `request.principal.role` against allowed roles, returns 403 if not.

- [ ] Steps: Extend RequestContext → express.d.ts → middleware → unit tests (mocked repos) → integration tests (real DB) → commit

---

### Task 3: Controller + Validators + Routes + Rate Limiters

**Files:**

- Create: `src/controllers/tenant.controller.ts`
- Create: `src/validators/tenant.validators.ts`
- Create: `src/routes/tenant.routes.ts`
- Modify: `src/routes/index.routes.ts` (mount tenant router)
- Modify: `src/middlewares/rate-limit.middleware.ts` (add tenant rate limiters)
- Create: `tests/integration/api/tenant.test.ts`

**Interfaces:**

- Consumes: All 3 repositories, `resolveTenant`, `requireRole`, `requireAuth`
- Produces: 10 route handlers

Key implementation details:

- Slug validation: `z.string().min(3).max(100).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)` + reserved words check
- `POST /tenants` and `POST /tenants/:slug/members` have user-keyed rate limiters (behind requireAuth — use `request.user!.id` as key, not IP)
- Member management enforces the actor→target role matrix (spec correction #4)
- `POST /tenants/:slug/members` accepts `{ email, role }` — looks up user by email, adds membership
- `PATCH /tenants/:slug/members/:userId` accepts `{ role }` — checks matrix before updating
- `DELETE /tenants/:slug/members/:userId` — checks matrix + last-owner guard
- Tests: create tenant, list tenants, CRUD members, role matrix enforcement (table-driven), settings CRUD, slug validation, reserved words, rate limiting, 404 for non-members

- [ ] Steps: Validators → rate limiters → controller → routes → mount → tests → commit

---

### Task 4: Documentation + Logger Integration

**Files:**

- Modify: `CLAUDE.md` — document RBAC conventions + "how to scope your own model" seam
- Modify: `src/services/logger.service.ts` — add `tenantId` to log output from RequestContext

Key implementation details:

- Logger's `addRequestContext` already reads `requestContextStore.getStore()?.requestId`. Now also reads `.tenant?.tenantId` and adds it as a `tenantId` field when present.
- CLAUDE.md: document the seam — how a derived project adds `tenantId` to its own models, uses `resolveTenant({ from: 'header' })` for resource routes, and uses `requestContextStore.getStore()?.tenant?.tenantId` for tenant-scoped queries.

- [ ] Steps: Logger integration → CLAUDE.md → .env.example (if any new env vars) → tests → commit
