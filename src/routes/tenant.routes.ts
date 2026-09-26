// src/routes/tenant.routes.ts
//
// Fourteen routes, mounted at `/api/v1/tenants` by index.routes.ts. Same
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
// THE RATE LIMITERS (`createRateLimiter(RATE_LIMITS.createTenant)`,
// `createRateLimiter(RATE_LIMITS.inviteTenantMember)`) run BEFORE
// `resolveTenant()`, so an over-budget caller gets its 429 before
// `resolveTenant()`'s two database reads. Invite and resend share the
// `rl:invite-tenant-member:` budget: Redis merges them by prefix, and
// building the limiter ONCE keeps them merged on the in-memory fallback
// too, where each instance counts alone.
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { auditController } from '@/controllers/audit.controller'
import { tenantController } from '@/controllers/tenant.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'
import { requireRole, resolveTenant } from '@/middlewares/tenant.middleware'

/**
 * Build the tenant routes.
 * @returns A router mounted at `/api/v1/tenants` by `index.routes.ts`, every route behind `requireAuth`.
 */
export function createTenantRouter(): Router {
  const router = Router()
  router.use(requireAuth)

  // One instance, reused at every call site below with no route-specific
  // limiter of its own — matching inviteRateLimiter's own reasoning: on
  // the in-memory fallback, separate createRateLimiter(...) calls would
  // count separately, splitting one 60/minute budget into five.
  const writeLimiter = createRateLimiter(RATE_LIMITS.authenticatedWrite)

  // -- Tenant CRUD --
  router.post(
    '/',
    requireJsonContentType,
    createRateLimiter(RATE_LIMITS.createTenant),
    tenantController.createTenant
  )
  router.get('/', tenantController.listTenants)
  router.get('/:slug', resolveTenant(), tenantController.getTenant)
  router.patch(
    '/:slug',
    requireJsonContentType,
    writeLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    tenantController.updateTenant
  )

  // -- Member management -- (members join only by invitation, below)
  router.get('/:slug/members', resolveTenant(), tenantController.listMembers)
  // Owner only: a role change is gated tighter than a removal. The matrix
  // itself is `canActorModifyTarget` in policies/tenant.policy.ts.
  router.patch(
    '/:slug/members/:userId',
    requireJsonContentType,
    writeLimiter,
    resolveTenant(),
    requireRole('owner'),
    tenantController.updateMemberRole
  )
  router.delete(
    '/:slug/members/:userId',
    requireJsonContentType,
    writeLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    tenantController.removeMember
  )

  // -- Invitations --
  const inviteRateLimiter = createRateLimiter(RATE_LIMITS.inviteTenantMember)
  router.get(
    '/:slug/invitations',
    resolveTenant(),
    requireRole('owner', 'admin'),
    tenantController.listInvitations
  )
  router.post(
    '/:slug/invitations',
    requireJsonContentType,
    inviteRateLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    tenantController.inviteMember
  )
  // Takes no body; an absent Content-Type passes requireJsonContentType.
  // Resend and revoke answer a non-UUID :id with 400 validation, not 404.
  router.post(
    '/:slug/invitations/:id/resend',
    requireJsonContentType,
    inviteRateLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    tenantController.resendInvitation
  )
  router.delete(
    '/:slug/invitations/:id',
    requireJsonContentType,
    writeLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    tenantController.revokeInvitation
  )

  // -- Settings --
  router.get('/:slug/settings', resolveTenant(), tenantController.getSettings)
  router.patch(
    '/:slug/settings',
    requireJsonContentType,
    writeLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    tenantController.updateSettings
  )

  // -- Audit log -- (the effective role: staff admins pass, staff viewers don't)
  router.get(
    '/:slug/audit-log',
    resolveTenant(),
    requireRole('owner', 'admin'),
    auditController.listTenantAuditLog
  )

  return router
}
