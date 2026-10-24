/**
 * @file A workspace's billing routes under `/tenants/:slug`. They are added
 * to the tenant router as flat `/:slug/…` routes rather than a nested `/:slug`
 * router, so the route walks in the maintenance-mode and limiter tests see
 * each full path. The tenant router applies `requireAuth`. The owner's
 * writes and the invoice list need a payment provider: `requirePaymentsEnabled`
 * answers the unknown-route 404 without one, ahead of the JSON gate and the
 * limiter, as an unknown path would. The writes then take the JSON gate, the
 * shared `billingWrite` limiter, `resolveTenant()` and `requireRole('owner')`;
 * the service refuses staff acting through platform access with the same 403.
 */
import type { RequestHandler, Router } from 'express'
import { billingController } from '@/controllers/billing.controller'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { requireFeature, requirePaymentsEnabled } from '@/middlewares/entitlement.middleware'
import { requireRole, resolveTenant } from '@/middlewares/tenant.middleware'

/**
 * The limiters the billing routes mount, built once by the tenant router so
 * every route that shares a budget shares one instance.
 */
export interface BillingRouteLimiters {
  /**
   * One budget across the owner's billing writes.
   */
  billingWrite: RequestHandler
  /**
   * The invoice list's budget.
   */
  billingRead: RequestHandler
}

/**
 * Add the billing routes to the tenant router. `GET /:slug/insights` is the
 * reference plan-gated route: `requireFeature` runs after `resolveTenant()`.
 * @param router - The tenant router.
 * @param limiters - The billing limiters.
 */
export function addBillingRoutes(router: Router, limiters: BillingRouteLimiters): void {
  router.get('/:slug/entitlements', resolveTenant(), billingController.getEntitlements)
  router.get(
    '/:slug/insights',
    resolveTenant(),
    requireFeature('advanced_example'),
    billingController.getInsights
  )
  router.get('/:slug/billing', resolveTenant(), billingController.getBilling)

  const ownerWrite = [
    requirePaymentsEnabled,
    requireJsonContentType,
    limiters.billingWrite,
    resolveTenant(),
    requireRole('owner'),
  ]
  router.post('/:slug/billing/checkout', ...ownerWrite, billingController.startCheckout)
  router.post('/:slug/billing/checkout/confirm', ...ownerWrite, billingController.confirmCheckout)
  router.post('/:slug/billing/interval', ...ownerWrite, billingController.switchInterval)
  router.post('/:slug/billing/payment-method', ...ownerWrite, billingController.changePaymentMethod)
  router.post('/:slug/billing/cancel', ...ownerWrite, billingController.cancel)
  router.get(
    '/:slug/billing/invoices',
    requirePaymentsEnabled,
    limiters.billingRead,
    resolveTenant(),
    requireRole('owner'),
    billingController.listInvoices
  )
}
