/**
 * @file A workspace owner's tax routes under `/tenants/:slug/billing`, added
 * to the tenant router as flat `/:slug/…` routes next to the billing routes,
 * so the route walks in the maintenance-mode and limiter tests see each full
 * path. The tenant router applies `requireAuth`. None needs a payment
 * provider: tax documents outlive the payments switch. Each route takes
 * `resolveTenant()` and `requireMemberOwner`, which refuses everyone but an
 * owner by membership (staff acting through a platform role included); the
 * write also takes the JSON gate and the billing write budget it shares with
 * the other owner billing writes, and the service re-checks the owner.
 */
import type { Router } from 'express'
import {
  TAX_DETAILS_OWNER_ONLY_MESSAGE,
  TAX_DOCUMENTS_OWNER_ONLY_MESSAGE,
} from '@/constants/billing.constants'
import { taxController } from '@/controllers/tax.controller'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { requireMemberOwner, resolveTenant } from '@/middlewares/tenant.middleware'
import type { BillingRouteLimiters } from '@/routes/billing.routes'

/**
 * Add the owner's tax routes to the tenant router.
 * @param router - The tenant router.
 * @param limiters - The billing limiters, the same instances the billing routes mount.
 */
export function addTaxRoutes(
  router: Router,
  limiters: Pick<BillingRouteLimiters, 'billingRead' | 'billingWrite'>
): void {
  router.get(
    '/:slug/billing/tax-details',
    limiters.billingRead,
    resolveTenant(),
    requireMemberOwner(TAX_DOCUMENTS_OWNER_ONLY_MESSAGE),
    taxController.getTaxDetails
  )
  router.patch(
    '/:slug/billing/tax-details',
    requireJsonContentType,
    limiters.billingWrite,
    resolveTenant(),
    requireMemberOwner(TAX_DETAILS_OWNER_ONLY_MESSAGE),
    taxController.saveTaxDetails
  )
  router.get(
    '/:slug/billing/tax-documents',
    limiters.billingRead,
    resolveTenant(),
    requireMemberOwner(TAX_DOCUMENTS_OWNER_ONLY_MESSAGE),
    taxController.listTaxDocuments
  )
  router.get(
    '/:slug/billing/tax-documents/:id/pdf',
    limiters.billingRead,
    resolveTenant(),
    requireMemberOwner(TAX_DOCUMENTS_OWNER_ONLY_MESSAGE),
    taxController.getTaxDocumentPdf
  )
}
