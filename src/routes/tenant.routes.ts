// src/routes/tenant.routes.ts
//
// Ten routes, mounted at `/api/v1/tenants` by index.routes.ts. Same
// "build inside a function" convention every other router in this codebase
// follows — see auth.routes.ts's own header comment for why (
// unicorn/no-top-level-side-effects, plus `rateLimit(...)`'s per-instance
// `Store` making a module-scope limiter unsafe to share, rate-limit
// .middleware.ts's own header comment).
//
// `requireAuth` is ROUTER-WIDE (`router.use(...)`, mirroring
// profile.routes.ts) — every route here needs an authenticated caller, none
// is a public endpoint. `resolveTenant()`/`requireRole(...)` are
// deliberately PER-ROUTE, not router-wide: `POST /` and `GET /` have no
// `:slug` segment to resolve a tenant from at all (creating/listing tenants
// happens before any single tenant is in scope), so a router-wide
// `resolveTenant()` would 404 both of them.
//
// `requireJsonContentType` is on every mutating route (POST/PATCH/DELETE) —
// same CSRF reasoning as auth.routes.ts's own router-wide use of it (a
// cross-site FORM POST/PATCH/DELETE would otherwise reach these handlers
// carrying `express.urlencoded()`'s parsed body), applied per-route here
// rather than router-wide because half this router's routes are GETs that
// must not reject an unset/absent content type.
//
// THE TWO RATE LIMITERS (`createCreateTenantRateLimiter`,
// `createAddTenantMemberRateLimiter`) are placed BEFORE `resolveTenant()`
// on `POST /:slug/members`, not after `requireRole` — the same ordering
// reasoning `createGoogleOAuthCallbackRateLimiter`'s own comment in
// auth.routes.ts gives for running a limiter ahead of the work it protects:
// `resolveTenant()` costs two database reads (`findActiveBySlug` +
// `findByUserAndTenant`), and an over-budget caller must be rejected with a
// 429 BEFORE either of those runs, not after. `POST /` has no `resolveTenant`
// to run ahead of at all, so its limiter's position (right after
// `requireJsonContentType`) is simply "as early as the chain allows".
import { Router } from 'express'
import {
  addMember,
  createTenant,
  getSettings,
  getTenant,
  listMembers,
  listTenants,
  removeMember,
  updateMemberRole,
  updateSettings,
  updateTenant,
} from '@/controllers/tenant.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import {
  createAddTenantMemberRateLimiter,
  createCreateTenantRateLimiter,
} from '@/middlewares/rate-limit.middleware'
import { requireRole, resolveTenant } from '@/middlewares/tenant.middleware'

/**
 * Build the tenant routes.
 * @returns A router mounted at `/api/v1/tenants` by `index.routes.ts`, every route behind `requireAuth`.
 */
export function createTenantRouter(): Router {
  const router = Router()
  router.use(requireAuth)

  // -- Tenant CRUD --
  router.post('/', requireJsonContentType, createCreateTenantRateLimiter(), createTenant)
  router.get('/', listTenants)
  router.get('/:slug', resolveTenant(), getTenant)
  router.patch(
    '/:slug',
    requireJsonContentType,
    resolveTenant(),
    requireRole('owner', 'admin'),
    updateTenant
  )

  // -- Member management --
  router.get('/:slug/members', resolveTenant(), listMembers)
  router.post(
    '/:slug/members',
    requireJsonContentType,
    createAddTenantMemberRateLimiter(),
    resolveTenant(),
    requireRole('owner', 'admin'),
    addMember
  )
  // Owner only — see tenant.controller.ts's `canActorModifyTarget` for why
  // a role CHANGE is gated tighter than a removal.
  router.patch(
    '/:slug/members/:userId',
    requireJsonContentType,
    resolveTenant(),
    requireRole('owner'),
    updateMemberRole
  )
  router.delete(
    '/:slug/members/:userId',
    requireJsonContentType,
    resolveTenant(),
    requireRole('owner', 'admin'),
    removeMember
  )

  // -- Settings --
  router.get('/:slug/settings', resolveTenant(), getSettings)
  router.patch(
    '/:slug/settings',
    requireJsonContentType,
    resolveTenant(),
    requireRole('owner', 'admin'),
    updateSettings
  )

  return router
}
