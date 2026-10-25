/**
 * @file Staff billing routes. `createPlatformTenantBillingRouter` is one
 * tenant's, mounted at `/api/v1/platform/tenants/:id/billing` by
 * `createPlatformRouter` behind its router-wide `requireAuth`; the read is a
 * platform viewer's, the resync, the trial extension and grants a manager's,
 * the cancel an admin's. `addPlatformPlanRoutes` registers the plans,
 * prices, billing settings and alerts flat on the platform router: the plan
 * and settings reads are a viewer's, everything else an admin's. Each route
 * names its own role gate and runs it first, so a refused caller gets the
 * plain 404: then, on a write, the JSON gate, the step-up check and the
 * limiter. Every write needs a recent sign-in, since each changes what
 * tenants may use or pay; the plan preview writes nothing and takes no
 * reason, so it needs none.
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

/**
 * Register the plans, prices, billing settings and alerts routes on the
 * platform router, flat, so the route walk sees each one under its full path.
 * @param router - The platform router.
 * @param limiters - The shared `platformSearch` and `platformWrite` limiters.
 */
export function addPlatformPlanRoutes(router: Router, limiters: PlatformLimiters): void {
  router.get(
    '/plans',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformBillingController.listPlans
  )
  router.post(
    '/plans/:id/preview',
    requirePlatformRole('admin'),
    requireJsonContentType,
    limiters.writeLimiter,
    platformBillingController.previewPlan
  )
  router.patch(
    '/plans/:id',
    requirePlatformRole('admin'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformBillingController.updatePlan
  )
  router.post(
    '/plans/:id/prices',
    requirePlatformRole('admin'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformBillingController.createPrice
  )
  router.get(
    '/billing-settings',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformBillingController.getSettings
  )
  router.patch(
    '/billing-settings',
    requirePlatformRole('admin'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformBillingController.updateSettings
  )
  router.get(
    '/billing/alerts',
    requirePlatformRole('admin'),
    limiters.searchLimiter,
    platformBillingController.listAlerts
  )
}
