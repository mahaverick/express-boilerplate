/**
 * @file The tenant routes, mounted at `/api/v1/tenants`, all behind a
 * router-wide `requireAuth`. `resolveTenant()` and `requireRole` are
 * per-route, since `POST /` and `GET /` have no `:slug`. Every mutating route
 * carries `requireJsonContentType` (the CSRF gate; see
 * content-type.middleware.ts), per-route because the GETs have no body. Each
 * limiter runs before `resolveTenant()`, so an over-budget caller gets its 429
 * before that middleware's database reads.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { auditController } from '@/controllers/audit.controller'
import { tenantController } from '@/controllers/tenant.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'
import {
  isOfferingAdminOrOwner,
  requireRecentAuthOnPlatformTenant,
  requireRole,
  resolveTenant,
} from '@/middlewares/tenant.middleware'

/**
 * Build the tenant routes. `requireRole` checks the effective role, so staff
 * admins pass the owner/admin routes (the audit log included) and staff
 * viewers do not. On the platform tenant, member role changes, removals,
 * admin/owner invitations and every resend also need a recent sign-in
 * (`requireRecentAuthOnPlatformTenant`).
 * @returns A router mounted at `/api/v1/tenants` by `index.routes.ts`, every route behind `requireAuth`.
 */
export function createTenantRouter(): Router {
  const router = Router()
  router.use(requireAuth)

  // One instance: separate ones would split the budget on the in-memory fallback.
  const writeLimiter = createRateLimiter(RATE_LIMITS.authenticatedWrite)

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

  router.get('/:slug/members', resolveTenant(), tenantController.listMembers)
  router.patch(
    '/:slug/members/:userId',
    requireJsonContentType,
    writeLimiter,
    resolveTenant(),
    requireRole('owner'),
    requireRecentAuthOnPlatformTenant(),
    tenantController.updateMemberRole
  )
  router.delete(
    '/:slug/members/:userId',
    requireJsonContentType,
    writeLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    requireRecentAuthOnPlatformTenant(),
    tenantController.removeMember
  )

  // Invite and resend share one budget, on Redis (same prefix) and in memory (one instance).
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
    requireRecentAuthOnPlatformTenant(isOfferingAdminOrOwner),
    tenantController.inviteMember
  )
  router.post(
    '/:slug/invitations/:id/resend',
    requireJsonContentType,
    inviteRateLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    requireRecentAuthOnPlatformTenant(),
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

  router.get('/:slug/settings', resolveTenant(), tenantController.getSettings)
  router.patch(
    '/:slug/settings',
    requireJsonContentType,
    writeLimiter,
    resolveTenant(),
    requireRole('owner', 'admin'),
    tenantController.updateSettings
  )

  router.get(
    '/:slug/audit-log',
    resolveTenant(),
    requireRole('owner', 'admin'),
    auditController.listTenantAuditLog
  )

  return router
}
