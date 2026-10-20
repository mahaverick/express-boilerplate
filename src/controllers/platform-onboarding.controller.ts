/**
 * @file Handlers for `/api/v1/platform/onboarding` and
 * `/api/v1/platform/tenants/:id/onboarding`. Every route runs behind
 * `requireAuth` and `requirePlatformRole` (platform-onboarding.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import {
  completeTenantStep,
  getOnboardingFunnel,
  getTenantOnboardingDetail,
  listOnboardingTenants,
  sendOnboardingReminder,
} from '@/services/platform-onboarding.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  onboardingFunnelQuerySchema,
  onboardingTenantListSchema,
  parseStepKeyParameter,
} from '@/validators/platform-onboarding.validators'
import { parseIdParameter, reasonBodySchema } from '@/validators/platform.validators'

/**
 * Handlers for the staff onboarding routes.
 */
class PlatformOnboardingController extends BaseController {
  /**
   * `GET /platform/onboarding/funnel`: per-step completion over a range.
   */
  getFunnel = this.handle(async (request, response) => {
    const { range } = parseBody(onboardingFunnelQuerySchema, request.query)
    successResponse(response, await getOnboardingFunnel(range), 'Onboarding funnel retrieved.')
  })

  /**
   * `GET /platform/onboarding/tenants`: one page of the tenants in one onboarding state, searchable by name and sortable.
   */
  searchTenants = this.handle(async (request, response) => {
    const query = parseBody(onboardingTenantListSchema, request.query)
    successResponse(response, await listOnboardingTenants(query), 'Onboarding tenants retrieved.')
  })

  /**
   * `GET /platform/tenants/:id/onboarding`: one tenant's onboarding, in any lifecycle state.
   */
  getTenantOnboarding = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    successResponse(
      response,
      await getTenantOnboardingDetail(tenantId),
      'Tenant onboarding retrieved.'
    )
  })

  /**
   * `POST /platform/tenants/:id/onboarding/steps/:key/complete`: mark a tenant step complete, with a reason.
   */
  completeStep = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const stepKey = parseStepKeyParameter(request.params.key)
    const { reason } = parseBody(reasonBodySchema, request.body)
    successResponse(
      response,
      await completeTenantStep(actorFrom(request), tenantId, stepKey, reason),
      'Onboarding step completed.'
    )
  })

  /**
   * `POST /platform/tenants/:id/onboarding/remind`: email the active owners a reminder, with a reason.
   */
  sendReminder = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const { reason } = parseBody(reasonBodySchema, request.body)
    const result = await sendOnboardingReminder(actorFrom(request), tenantId, reason)
    successResponse(
      response,
      result,
      result.emailSent ? 'Reminder sent.' : 'The reminder could not be queued for every owner.'
    )
  })
}

/**
 * The controller the staff onboarding routes mount.
 */
export const platformOnboardingController = new PlatformOnboardingController()
