/**
 * @file Handlers for `GET /api/v1/platform/users/:id/errors` and
 * `GET /api/v1/platform/tenants/:id/errors`. Both run behind `requireAuth`,
 * `requirePlatformRole('admin')` and the `platform-timeline` limiter shared
 * with the timelines (platform.routes.ts, platform-user.routes.ts). They
 * take no query.
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import { getTenantErrors, getUserErrors } from '@/services/platform-errors.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseIdParameter } from '@/validators/platform.validators'

/**
 * Handlers for the two Errors routes.
 */
class PlatformErrorsController extends BaseController {
  /**
   * `GET /platform/users/:id/errors`: a user's PostHog error issues.
   */
  getUserErrors = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, 'User not found')
    const page = await getUserErrors(actorFrom(request), userId)
    successResponse(response, page, 'Errors retrieved.')
  })

  /**
   * `GET /platform/tenants/:id/errors`: a tenant's PostHog error issues.
   */
  getTenantErrors = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'Tenant not found')
    const page = await getTenantErrors(actorFrom(request), tenantId)
    successResponse(response, page, 'Errors retrieved.')
  })
}

/**
 * The controller the Errors routes mount.
 */
export const platformErrorsController = new PlatformErrorsController()
