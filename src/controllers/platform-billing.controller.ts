/**
 * @file Handlers for the staff billing routes: one tenant's under
 * `/api/v1/platform/tenants/:id/billing`, and the plans, prices, billing
 * settings and alerts under `/api/v1/platform`. Every route runs behind
 * `requireAuth` and `requirePlatformRole` (platform-billing.routes.ts), and
 * every write behind `requireRecentAuth`. Each write answers the view it
 * changed. A body is parsed before the grant or plan id is looked up, so a
 * write's validation answer does not depend on which one it names.
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import {
  addGrant,
  cancelByStaff,
  createPrice,
  extendTrial,
  getBillingSettings,
  getStaffTenantBilling,
  listBillingAlerts,
  listStaffBillingEvents,
  listStaffBillingHistory,
  listStaffBillingSubscriptions,
  listStaffInvoices,
  listStaffPlans,
  previewPlanChange,
  resyncTenantBilling,
  revokeGrant,
  updateBillingSettings,
  updatePlan,
} from '@/services/platform-billing.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  billingAlertListSchema,
  billingEventListSchema,
  billingHistoryListSchema,
  billingSubscriptionListSchema,
  createPriceBodySchema,
  extendTrialBodySchema,
  grantBodySchema,
  planPreviewBodySchema,
  staffCancelBodySchema,
  staffInvoiceListSchema,
  updateBillingSettingsBodySchema,
  updatePlanBodySchema,
} from '@/validators/platform-billing.validators'
import { parseIdParameter, reasonBodySchema } from '@/validators/platform.validators'

/**
 * Handlers for one tenant's staff billing routes.
 */
class PlatformBillingController extends BaseController {
  /**
   * `GET /platform/tenants/:id/billing`: the tenant's billing, provider ids, grants, history and events.
   */
  getBilling = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    successResponse(
      response,
      await getStaffTenantBilling(actorFrom(request), tenantId),
      'Billing retrieved.'
    )
  })

  /**
   * `GET /platform/tenants/:id/billing/history`: one page of the tenant's billing state changes.
   */
  listHistory = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const query = parseBody(billingHistoryListSchema, request.query)
    successResponse(
      response,
      await listStaffBillingHistory(actorFrom(request), tenantId, query),
      'Billing history retrieved.'
    )
  })

  /**
   * `GET /platform/tenants/:id/billing/events`: one page of the tenant's payment provider events.
   */
  listEvents = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const query = parseBody(billingEventListSchema, request.query)
    successResponse(
      response,
      await listStaffBillingEvents(actorFrom(request), tenantId, query),
      'Billing events retrieved.'
    )
  })

  /**
   * `GET /platform/tenants/:id/billing/subscriptions`: one page of the subscriptions the tenant has held.
   */
  listSubscriptions = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const query = parseBody(billingSubscriptionListSchema, request.query)
    successResponse(
      response,
      await listStaffBillingSubscriptions(actorFrom(request), tenantId, query),
      'Subscriptions retrieved.'
    )
  })

  /**
   * `GET /platform/tenants/:id/billing/invoices`: one page of the tenant's invoices, newest first.
   */
  listInvoices = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const query = parseBody(staffInvoiceListSchema, request.query)
    successResponse(
      response,
      await listStaffInvoices(actorFrom(request), tenantId, query),
      'Invoices retrieved.'
    )
  })

  /**
   * `POST /platform/tenants/:id/billing/resync`: sync the tenant with its payment provider now.
   */
  resync = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const { reason } = parseBody(reasonBodySchema, request.body)
    successResponse(
      response,
      await resyncTenantBilling(actorFrom(request), tenantId, reason),
      'Billing synced.'
    )
  })

  /**
   * `POST /platform/tenants/:id/billing/extend-trial`: extend the trial, or start one on Free.
   */
  extendTrial = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const { days, reason } = parseBody(extendTrialBodySchema, request.body)
    successResponse(
      response,
      await extendTrial(actorFrom(request), tenantId, days, reason),
      'Trial extended.'
    )
  })

  /**
   * `POST /platform/tenants/:id/billing/grants`: grant a limit or feature beyond the plan.
   */
  addGrant = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const body = parseBody(grantBodySchema, request.body)
    successResponse(response, await addGrant(actorFrom(request), tenantId, body), 'Grant added.')
  })

  /**
   * `POST /platform/tenants/:id/billing/grants/:grantId/revoke`: revoke one of the tenant's grants.
   */
  revokeGrant = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const { reason } = parseBody(reasonBodySchema, request.body)
    const grantId = parseIdParameter(request.params.grantId, 'grant')
    successResponse(
      response,
      await revokeGrant(actorFrom(request), tenantId, grantId, reason),
      'Grant revoked.'
    )
  })

  /**
   * `POST /platform/tenants/:id/billing/cancel`: cancel the subscription at its cycle end or now.
   */
  cancel = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const { when, reason } = parseBody(staffCancelBodySchema, request.body)
    successResponse(
      response,
      await cancelByStaff(actorFrom(request), tenantId, when, reason),
      'Subscription cancelled.'
    )
  })

  /**
   * `GET /platform/plans`: both plans with prices and tenant counts, and the catalog.
   */
  listPlans = this.handle(async (_request, response) => {
    successResponse(response, await listStaffPlans(), 'Plans retrieved.')
  })

  /**
   * `POST /platform/plans/:id/preview`: what an entitlements edit would change, and for how many tenants.
   */
  previewPlan = this.handle(async (request, response) => {
    const { entitlements } = parseBody(planPreviewBodySchema, request.body)
    const planId = parseIdParameter(request.params.id, 'plan')
    successResponse(response, await previewPlanChange(planId, entitlements), 'Preview ready.')
  })

  /**
   * `PATCH /platform/plans/:id`: edit a plan's name, description or entitlements.
   */
  updatePlan = this.handle(async (request, response) => {
    const body = parseBody(updatePlanBodySchema, request.body)
    const planId = parseIdParameter(request.params.id, 'plan')
    successResponse(response, await updatePlan(actorFrom(request), planId, body), 'Plan saved.')
  })

  /**
   * `POST /platform/plans/:id/prices`: add a price, retiring the active one of its interval.
   */
  createPrice = this.handle(async (request, response) => {
    const body = parseBody(createPriceBodySchema, request.body)
    const planId = parseIdParameter(request.params.id, 'plan')
    successResponse(response, await createPrice(actorFrom(request), planId, body), 'Price added.')
  })

  /**
   * `GET /platform/billing-settings`: the trial and grace settings.
   */
  getSettings = this.handle(async (_request, response) => {
    successResponse(response, await getBillingSettings(), 'Billing settings retrieved.')
  })

  /**
   * `PATCH /platform/billing-settings`: change the trial or grace settings.
   */
  updateSettings = this.handle(async (request, response) => {
    const body = parseBody(updateBillingSettingsBodySchema, request.body)
    successResponse(
      response,
      await updateBillingSettings(actorFrom(request), body),
      'Billing settings saved.'
    )
  })

  /**
   * `GET /platform/billing/alerts`: one page of billing alerts.
   */
  listAlerts = this.handle(async (request, response) => {
    const query = parseBody(billingAlertListSchema, request.query)
    successResponse(response, await listBillingAlerts(query), 'Billing alerts retrieved.')
  })
}

/**
 * The controller the staff billing routes mount.
 */
export const platformBillingController = new PlatformBillingController()
