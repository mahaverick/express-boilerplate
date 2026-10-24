/**
 * @file Handlers for a workspace's billing reads: its entitlements, which any
 * member and staff with platform access may read, and the reference
 * plan-gated route, workspace insights.
 */
import { BaseController } from '@/controllers/base.controller'
import { tenantPrincipal } from '@/controllers/helpers.controller'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { getWorkspaceInsights } from '@/services/billing/insights.service'
import { successResponse } from '@/utilities/response.utilities'

/**
 * Billing handlers for the tenant routes.
 */
class BillingController extends BaseController {
  /**
   * `GET /tenants/:slug/entitlements`: the effective plan, state, features
   * and limits, without where each value came from.
   */
  getEntitlements = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    const { sources: _sources, ...entitlements } = await getEffectiveEntitlements(tenantId)
    successResponse(response, entitlements)
  })

  /**
   * `GET /tenants/:slug/insights`: the last 30 days' joins and invitations.
   */
  getInsights = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    successResponse(response, await getWorkspaceInsights(tenantId))
  })
}

/**
 * The billing controller instance the routes mount.
 */
export const billingController = new BillingController()
