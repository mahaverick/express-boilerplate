/**
 * @file Handlers for a workspace's billing: its entitlements, which any
 * member and staff with platform access may read, the reference plan-gated
 * route (workspace insights), the billing read, and an owner's checkout,
 * confirm, interval switch, card change, cancel and invoice list.
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom, tenantPrincipal } from '@/controllers/helpers.controller'
import {
  cancelPaid,
  confirmCheckout,
  getTenantBilling,
  listInvoices,
  startCardChange,
  startCheckout,
  startIntervalSwitch,
} from '@/services/billing/checkout.service'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { getWorkspaceInsights } from '@/services/billing/insights.service'
import { successResponse } from '@/utilities/response.utilities'
import {
  billingIntervalBodySchema,
  checkoutConfirmBodySchema,
  emptyBillingBodySchema,
  invoiceListQuerySchema,
} from '@/validators/billing.validators'
import { parseBody } from '@/validators/parse.validators'

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

  /**
   * `GET /tenants/:slug/billing`: the workspace's billing, with the billing
   * email for an owner only.
   */
  getBilling = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    successResponse(response, await getTenantBilling(actorFrom(request), tenantId))
  })

  /**
   * `POST /tenants/:slug/billing/checkout`: a checkout for Paid.
   */
  startCheckout = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    const { interval } = parseBody(billingIntervalBodySchema, request.body)
    successResponse(response, await startCheckout(actorFrom(request), tenantId, interval))
  })

  /**
   * `POST /tenants/:slug/billing/checkout/confirm`: confirm a finished checkout.
   */
  confirmCheckout = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    const body = parseBody(checkoutConfirmBodySchema, request.body)
    successResponse(response, await confirmCheckout(actorFrom(request), tenantId, body))
  })

  /**
   * `POST /tenants/:slug/billing/interval`: switch to the other interval from the period end.
   */
  switchInterval = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    const { interval } = parseBody(billingIntervalBodySchema, request.body)
    successResponse(response, await startIntervalSwitch(actorFrom(request), tenantId, interval))
  })

  /**
   * `POST /tenants/:slug/billing/payment-method`: a card change on the current subscription.
   */
  changePaymentMethod = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    parseBody(emptyBillingBodySchema, request.body ?? {})
    successResponse(response, await startCardChange(actorFrom(request), tenantId))
  })

  /**
   * `POST /tenants/:slug/billing/cancel`: cancel Paid.
   */
  cancel = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    parseBody(emptyBillingBodySchema, request.body ?? {})
    successResponse(response, await cancelPaid(actorFrom(request), tenantId))
  })

  /**
   * `GET /tenants/:slug/billing/invoices`: one page of the owner's invoices.
   */
  listInvoices = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    const { cursor } = parseBody(invoiceListQuerySchema, request.query)
    successResponse(response, await listInvoices(actorFrom(request), tenantId, cursor))
  })
}

/**
 * The billing controller instance the routes mount.
 */
export const billingController = new BillingController()
