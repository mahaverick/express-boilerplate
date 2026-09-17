# RBAC + Multi-Tenancy Seam — Design Spec

Status: approved in brainstorming
Session: https://claude.ai/code/session_018W6fi5MwVob2Vr1AexY5Mu
Date: 2026-09-17
Stream: 6 of 7 (see `2026-09-16-boilerplate-roadmap.md`)

## Problem

The boilerplate has no concept of tenants, roles, or authorization beyond
"is the user logged in." Every authenticated user can access every resource.
There is no way to group users into organizations, assign roles, or scope
data by tenant.

Both Ofluence/core and Consequential/core have full RBAC + multi-tenancy.
Ofluence uses RLS policies on Postgres; Consequential uses middleware-level
enforcement. This design takes the best from both — Consequential's middleware
approach (simpler, easier to understand) with Ofluence's AsyncLocalStorage
tenant context pattern.

## Solution

An opt-in multi-tenancy seam with:

- A `tenants` table with lifecycle states (active/suspended/archived)
- A `tenant_settings` table for per-tenant configuration
- A `user_memberships` table linking users to tenants with 5-tier RBAC roles
- `resolveTenant` middleware that reads `X-Tenant-ID` and sets tenant context
- `requireRole(...roles)` middleware for role-based access control
- 10 API endpoints for tenant CRUD, member management, and settings
- Opt-in: existing routes are unchanged; new routes compose the middleware

## 1. Tenant Model

**File:** `src/database/models/tenant.model.ts`

### `tenants` table

| Column            | Type                | Constraints                  | Notes                             |
| ----------------- | ------------------- | ---------------------------- | --------------------------------- |
| `id`              | `varchar(36)`       | PK, default `uuidv7()`       |                                   |
| `name`            | `varchar(255)`      | NOT NULL                     | Display name                      |
| `slug`            | `varchar(100)`      | NOT NULL, unique             | URL-safe identifier               |
| `description`     | `varchar(1000)`     | nullable                     |                                   |
| `logo`            | `varchar(255)`      | nullable                     | URL to logo                       |
| `website`         | `varchar(255)`      | nullable                     |                                   |
| `lifecycle_state` | `varchar(20)`       | NOT NULL, default `'active'` | `active`, `suspended`, `archived` |
| `deleted_at`      | `timestamp with tz` | nullable                     | Soft delete                       |
| `created_at`      | `timestamp with tz` | NOT NULL, default `now()`    |                                   |
| `updated_at`      | `timestamp with tz` | NOT NULL, default `now()`    |                                   |

Unique index on `slug` (partial: `WHERE deleted_at IS NULL`).

### Lifecycle States

```typescript
export const TENANT_LIFECYCLE_STATES = ['active', 'suspended', 'archived'] as const
export type TenantLifecycleState = (typeof TENANT_LIFECYCLE_STATES)[number]
```

- `active` — fully operational, default for new tenants
- `suspended` — temporarily disabled (billing issue, abuse, etc.)
- `archived` — soft-deleted terminal state

### `tenant_settings` table

| Column       | Type                | Constraints                   | Notes                        |
| ------------ | ------------------- | ----------------------------- | ---------------------------- |
| `tenant_id`  | `varchar(36)`       | PK, FK → `tenants.id` CASCADE | One-to-one                   |
| `timezone`   | `varchar(64)`       | NOT NULL, default `'UTC'`     | IANA timezone                |
| `locale`     | `varchar(10)`       | NOT NULL, default `'en'`      | BCP 47 locale                |
| `metadata`   | `jsonb`             | nullable                      | Extensible per-tenant config |
| `updated_at` | `timestamp with tz` | NOT NULL, default `now()`     |                              |

`tenant_id` is both the PK and the FK — one settings row per tenant.

## 2. Membership Model

**File:** `src/database/models/user-membership.model.ts`

### Roles

```typescript
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'manager', 'editor', 'viewer'] as const
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]
```

5-tier hierarchy (from Consequential's model):

- `owner` — full control, can transfer ownership, can delete tenant
- `admin` — manage members (invite, remove, change roles below admin), manage settings
- `manager` — manage resources and content, but not members or settings
- `editor` — create and edit content
- `viewer` — read-only access

### `user_memberships` table

| Column       | Type                | Constraints                         | Notes                          |
| ------------ | ------------------- | ----------------------------------- | ------------------------------ |
| `id`         | `varchar(36)`       | PK, default `uuidv7()`              |                                |
| `user_id`    | `varchar(36)`       | NOT NULL, FK → `users.id` CASCADE   |                                |
| `tenant_id`  | `varchar(36)`       | NOT NULL, FK → `tenants.id` CASCADE |                                |
| `role`       | `varchar(20)`       | NOT NULL, default `'viewer'`        | CHECK against MEMBERSHIP_ROLES |
| `created_at` | `timestamp with tz` | NOT NULL, default `now()`           |                                |
| `updated_at` | `timestamp with tz` | NOT NULL, default `now()`           |                                |

Unique constraint on `(user_id, tenant_id)` — one role per tenant per user.
Index on `(tenant_id)` for listing members.

## 3. Tenant Context Middleware

**File:** `src/middlewares/tenant.middleware.ts`

### `resolveTenant`

Reads `X-Tenant-ID` header (accepts slug or UUID):

1. Look up tenant by slug or id
2. Verify `lifecycleState === 'active'` and `deletedAt IS NULL` — 404 otherwise
3. Look up `user_memberships` for `(request.user.id, tenant.id)` — 403 if none
4. Set `request.principal = { tenantId, tenantSlug, role }`
5. Wrap the rest of the request in `tenantContextStore` (AsyncLocalStorage)

Must run AFTER `requireAuth` (needs `request.user`).

### `requireRole(...allowedRoles)`

Returns a middleware that checks `request.principal.role`:

```typescript
export function requireRole(...allowedRoles: MembershipRole[]) {
  return (request, response, next) => {
    if (!request.principal || !allowedRoles.includes(request.principal.role)) {
      throw new HttpError('Insufficient permissions', 403)
    }
    next()
  }
}
```

Must run AFTER `resolveTenant`.

### `request.principal`

New property on Express Request (separate from `request.user`):

```typescript
interface RequestPrincipal {
  tenantId: string
  tenantSlug: string
  role: MembershipRole
}
```

Declared in `src/types/express.d.ts` alongside the existing `user` and `id`.

### Tenant Context Store

```typescript
export const tenantContextStore = new AsyncLocalStorage<{
  tenantId: string
  role: MembershipRole
}>()
```

Available to any code that needs the current tenant without passing it
through function arguments — same pattern as `requestContextStore`.

## 4. API Endpoints

All behind `requireAuth`. Tenant-scoped endpoints additionally use
`resolveTenant` and optionally `requireRole`.

**File:** `src/controllers/tenant.controller.ts`
**File:** `src/routes/tenant.routes.ts`

### Tenant CRUD

| Method  | Path             | Middleware                                            | Purpose                         |
| ------- | ---------------- | ----------------------------------------------------- | ------------------------------- |
| `POST`  | `/tenants`       | requireAuth                                           | Create tenant (creator → owner) |
| `GET`   | `/tenants`       | requireAuth                                           | List user's tenants             |
| `GET`   | `/tenants/:slug` | requireAuth, resolveTenant                            | Get tenant details              |
| `PATCH` | `/tenants/:slug` | requireAuth, resolveTenant, requireRole(owner, admin) | Update tenant                   |

### Member Management

| Method   | Path                             | Middleware                                            | Purpose       |
| -------- | -------------------------------- | ----------------------------------------------------- | ------------- |
| `GET`    | `/tenants/:slug/members`         | requireAuth, resolveTenant                            | List members  |
| `POST`   | `/tenants/:slug/members`         | requireAuth, resolveTenant, requireRole(owner, admin) | Add member    |
| `PATCH`  | `/tenants/:slug/members/:userId` | requireAuth, resolveTenant, requireRole(owner)        | Change role   |
| `DELETE` | `/tenants/:slug/members/:userId` | requireAuth, resolveTenant, requireRole(owner, admin) | Remove member |

### Settings

| Method  | Path                      | Middleware                                            | Purpose         |
| ------- | ------------------------- | ----------------------------------------------------- | --------------- |
| `GET`   | `/tenants/:slug/settings` | requireAuth, resolveTenant                            | Get settings    |
| `PATCH` | `/tenants/:slug/settings` | requireAuth, resolveTenant, requireRole(owner, admin) | Update settings |

### Safety Rules

- Creating a tenant auto-creates a settings row and an owner membership (atomic)
- Can't remove the last owner
- Can't change the last owner's role
- Owner can't be removed — must transfer ownership first
- Admin can add/remove members but only with roles below admin (manager, editor, viewer)

## 5. Repositories

### TenantRepository (`src/repositories/tenant.repository.ts`)

Extends `BaseRepository` (has `deletedAt` + `updatedAt`):

- `findBySlug(slug)` / `findBySlugOrId(slugOrId)`
- `create(data)` — creates tenant + settings + owner membership in a transaction
- `listForUser(userId)` — tenants the user has memberships in
- `update(id, data)` — standard update

### TenantSettingsRepository (`src/repositories/tenant-settings.repository.ts`)

Standalone (PK is `tenantId`, no `deletedAt`):

- `findByTenantId(tenantId)`
- `update(tenantId, data)`

### UserMembershipRepository (`src/repositories/user-membership.repository.ts`)

Standalone:

- `findByUserAndTenant(userId, tenantId)`
- `listByTenant(tenantId)` — with joined user info (email, name)
- `listByUser(userId)` — with joined tenant info (name, slug)
- `create(data)` — with unique violation → 409
- `updateRole(id, role)`
- `delete(id)`
- `countOwners(tenantId)` — for "last owner" safety check

## 6. File Structure

**New files:**

| File                                             | Purpose                          |
| ------------------------------------------------ | -------------------------------- |
| `src/database/models/tenant.model.ts`            | tenants + tenant_settings tables |
| `src/database/models/user-membership.model.ts`   | user_memberships with role       |
| `src/repositories/tenant.repository.ts`          | Tenant CRUD                      |
| `src/repositories/tenant-settings.repository.ts` | Settings get/update              |
| `src/repositories/user-membership.repository.ts` | Membership CRUD                  |
| `src/controllers/tenant.controller.ts`           | All 10 handlers                  |
| `src/validators/tenant.validators.ts`            | Request validation               |
| `src/routes/tenant.routes.ts`                    | Route wiring                     |
| `src/middlewares/tenant.middleware.ts`           | resolveTenant + requireRole      |
| `src/constants/tenant.constants.ts`              | Lifecycle states, roles          |

**Modified files:**

| File                         | Change                             |
| ---------------------------- | ---------------------------------- |
| `src/types/express.d.ts`     | Add `principal?: RequestPrincipal` |
| `src/routes/index.routes.ts` | Mount tenant router                |
| `CLAUDE.md`                  | Document RBAC conventions          |

**No new dependencies.**

## 7. What This Does NOT Include

- **RLS policies** — middleware enforcement only (simpler, portable)
- **Tenant-scoped data models** — the seam is opt-in; derived projects add `tenantId` to their models
- **Invitation emails** — adds membership directly (invitation flow is a follow-up)
- **Billing / subscription** — project-specific
- **Agency / polymorphic context** — project-specific
- **Shopify integration** — project-specific
- **Permission matrices** — roles are hierarchical, not permission-based
- **Tenant creation limits** — rate limiting covers abuse; quotas are a billing concern
