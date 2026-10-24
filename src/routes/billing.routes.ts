/**
 * @file A workspace's billing routes under `/tenants/:slug`. They are added
 * to the tenant router as flat `/:slug/…` routes rather than a nested `/:slug`
 * router, so the route walks in the maintenance-mode and limiter tests see
 * each full path. The tenant router applies `requireAuth`.
 */
import type { Router } from 'express'
import { billingController } from '@/controllers/billing.controller'
import { requireFeature } from '@/middlewares/entitlement.middleware'
import { resolveTenant } from '@/middlewares/tenant.middleware'

/**
 * Add the billing routes to the tenant router. `GET /:slug/insights` is the
 * reference plan-gated route: `requireFeature` runs after `resolveTenant()`.
 * @param router - The tenant router.
 */
export function addBillingRoutes(router: Router): void {
  router.get('/:slug/entitlements', resolveTenant(), billingController.getEntitlements)
  router.get(
    '/:slug/insights',
    resolveTenant(),
    requireFeature('advanced_example'),
    billingController.getInsights
  )
}
