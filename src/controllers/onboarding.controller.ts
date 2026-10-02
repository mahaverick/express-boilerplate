/**
 * @file The customer onboarding handlers, behind tenant.routes.ts's
 * router-wide `requireAuth` and each route's `resolveTenant`. Writes pass the
 * actor; the service re-reads their access under lock.
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom, tenantPrincipal } from '@/controllers/helpers.controller'
import {
  completeStepAsMember,
  dismissOnboarding,
  getTenantOnboarding,
  undismissOnboarding,
} from '@/services/onboarding.service'
import { successResponse } from '@/utilities/response.utilities'
import { onboardingStepParametersSchema } from '@/validators/onboarding.validators'
import { parseBody } from '@/validators/parse.validators'

/**
 * Handlers for `/api/v1/tenants/:slug/onboarding`.
 */
class OnboardingController extends BaseController {
  /**
   * `GET /tenants/:slug/onboarding`: any member, or staff through platform
   * access, who see no member step as theirs.
   */
  getOnboarding = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const viewer = {
      // eslint-disable-next-line unicorn/no-null -- staff reading through platform access have no membership
      userId: principal.access === 'member' ? actorFrom(request).userId : null,
    }
    const view = await getTenantOnboarding(principal.tenantId, viewer)
    successResponse(response, view, 'Onboarding retrieved.')
  })

  /**
   * `POST /tenants/:slug/onboarding/steps/:key/complete`: tick a manual step;
   * a member step completes for the caller. Members only
   * (`requireMembership`).
   */
  completeStep = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const { key } = parseBody(onboardingStepParametersSchema, request.params)
    const view = await completeStepAsMember(actorFrom(request), principal.tenantId, key)
    successResponse(response, view, 'Step completed.')
  })

  /**
   * `POST /tenants/:slug/onboarding/dismiss`: hide the checklist. Owners by
   * membership only (`requireMembership`, then `requireRole('owner')`).
   */
  dismiss = this.handle(async (request, response) => {
    const view = await dismissOnboarding(actorFrom(request), tenantPrincipal(request).tenantId)
    successResponse(response, view, 'Getting started dismissed.')
  })

  /**
   * `POST /tenants/:slug/onboarding/undismiss`: show the checklist again.
   * Owners by membership only.
   */
  undismiss = this.handle(async (request, response) => {
    const view = await undismissOnboarding(actorFrom(request), tenantPrincipal(request).tenantId)
    successResponse(response, view, 'Getting started restored.')
  })
}

/**
 * The onboarding controller the tenant routes mount.
 */
export const onboardingController = new OnboardingController()
