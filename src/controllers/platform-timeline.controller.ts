/**
 * @file Handlers for `GET /api/v1/platform/users/:id/timeline` and
 * `GET /api/v1/platform/tenants/:id/timeline`. Both run behind
 * `requireAuth`, `requirePlatformRole('admin')` and the `platform-timeline`
 * limiter (platform.routes.ts, platform-user.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import { getTenantTimeline, getUserTimeline } from '@/services/platform-timeline.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { parseIdParameter, platformTimelineQuerySchema } from '@/validators/platform.validators'

/**
 * Handlers for the two timeline routes.
 */
class PlatformTimelineController extends BaseController {
  /**
   * `GET /platform/users/:id/timeline`: one page of a user's PostHog timeline.
   */
  getUserTimeline = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, 'User not found')
    const query = parseBody(platformTimelineQuerySchema, request.query)
    const page = await getUserTimeline(actorFrom(request), userId, query)
    successResponse(response, page, 'Timeline retrieved.')
  })

  /**
   * `GET /platform/tenants/:id/timeline`: one page of a tenant's PostHog timeline.
   */
  getTenantTimeline = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'Tenant not found')
    const query = parseBody(platformTimelineQuerySchema, request.query)
    const page = await getTenantTimeline(actorFrom(request), tenantId, query)
    successResponse(response, page, 'Timeline retrieved.')
  })
}

/**
 * The controller the timeline routes mount.
 */
export const platformTimelineController = new PlatformTimelineController()
