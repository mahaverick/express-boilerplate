/**
 * @file Handlers for `/api/v1/platform/tenants/:id/billing`. Every route runs
 * behind `requireAuth` and `requirePlatformRole` (platform-billing.routes.ts),
 * and every write behind `requireRecentAuth`. Each write answers the staff
 * billing view after it. A body is parsed before the grant id, so a write's
 * validation answer does not depend on which grant it names.
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import {
  addGrant,
  cancelByStaff,
  extendTrial,
  getStaffTenantBilling,
  resyncTenantBilling,
  revokeGrant,
} from '@/services/platform-billing.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  extendTrialBodySchema,
  grantBodySchema,
  staffCancelBodySchema,
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
}

/**
 * The controller the staff billing routes mount.
 */
export const platformBillingController = new PlatformBillingController()
