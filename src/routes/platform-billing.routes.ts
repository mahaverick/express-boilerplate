/**
 * @file Staff billing of one tenant, `createPlatformTenantBillingRouter`,
 * mounted at `/api/v1/platform/tenants/:id/billing` by `createPlatformRouter`
 * behind its router-wide `requireAuth`. Each route names its own role gate
 * and runs it first, so a refused caller gets the plain 404: then, on a
 * write, the JSON gate, the step-up check and the limiter. The read is a
 * platform viewer's; the resync, the trial extension and grants a manager's;
 * the cancel an admin's. Every write needs a recent sign-in: each changes
 * what a tenant may use or what it pays.
 */
import { Router } from 'express'
import { platformBillingController } from '@/controllers/platform-billing.controller'
import { requireRecentAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { requirePlatformRole } from '@/middlewares/platform.middleware'
import type { PlatformLimiters } from '@/routes/platform-user.routes'

/**
 * Build one tenant's staff billing routes. `mergeParams`, so the handlers
 * read the mount's `:id`.
 * @param limiters - The shared `platformSearch` and `platformWrite` limiters.
 * @returns A router mounted at `/api/v1/platform/tenants/:id/billing`.
 */
export function createPlatformTenantBillingRouter(limiters: PlatformLimiters): Router {
  const router = Router({ mergeParams: true })
  router.get(
    '/',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformBillingController.getBilling
  )
  router.post(
    '/resync',
    requirePlatformRole('manager'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformBillingController.resync
  )
  router.post(
    '/extend-trial',
    requirePlatformRole('manager'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformBillingController.extendTrial
  )
  router.post(
    '/grants',
    requirePlatformRole('manager'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformBillingController.addGrant
  )
  router.post(
    '/grants/:grantId/revoke',
    requirePlatformRole('manager'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformBillingController.revokeGrant
  )
  router.post(
    '/cancel',
    requirePlatformRole('admin'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformBillingController.cancel
  )
  return router
}
