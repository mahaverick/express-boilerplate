// src/routes/tenant.routes.ts
//
// Thirteen routes, mounted at `/api/v1/tenants` by index.routes.ts. Same
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
// THE RATE LIMITERS (`createCreateTenantRateLimiter`,
// `createInviteTenantMemberRateLimiter`) run BEFORE `resolveTenant()`, so
// an over-budget caller gets its 429 before `resolveTenant()`'s two
// database reads. The invite limiter is built ONCE and mounted on both
// invite and resend, so the two spend one budget; building it per route
// would give each its own.
import { Router } from 'express'
import {
  createTenant,
  getSettings,
  getTenant,
  inviteMember,
  listInvitations,
  listMembers,
  listTenants,
  removeMember,
  resendInvitation,
  revokeInvitation,
  updateMemberRole,
  updateSettings,
  updateTenant,
} from '@/controllers/tenant.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import {
  createCreateTenantRateLimiter,
  createInviteTenantMemberRateLimiter,
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

  // -- Member management -- (members join only by invitation, below)
  router.get('/:slug/members', resolveTenant(), listMembers)
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

  // -- Invitations --
  const inviteRateLimiter = createInviteTenantMemberRateLimiter()
  router.get('/:slug/invitations', resolveTenant(), requireRole('owner', 'admin'), listInvitations)
  router.post(
    '/:slug/invitations',
    requireJsonContentType,
    inviteRateLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    inviteMember
  )
  // Takes no body; an absent Content-Type passes requireJsonContentType.
  router.post(
    '/:slug/invitations/:id/resend',
    requireJsonContentType,
    inviteRateLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    resendInvitation
  )
  router.delete(
    '/:slug/invitations/:id',
    requireJsonContentType,
    resolveTenant(),
    requireRole('owner', 'admin'),
    revokeInvitation
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
