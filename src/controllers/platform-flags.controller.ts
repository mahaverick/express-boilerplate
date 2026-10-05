/**
 * @file Handlers for `GET /api/v1/platform/flags` (behind
 * `requirePlatformRole('viewer')` and the shared `platform-search` limiter)
 * and `GET /api/v1/platform/flags/evaluate` (behind
 * `requirePlatformRole('admin')` and the shared `platform-timeline`
 * limiter), in platform.routes.ts.
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import { evaluateFlagsFor, listFlags } from '@/services/platform-flags.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { platformFlagsEvaluateQuerySchema } from '@/validators/platform.validators'

/**
 * Handlers for the flag inspector routes.
 */
class PlatformFlagsController extends BaseController {
  /**
   * `GET /platform/flags`: the registry joined with the live snapshot.
   */
  listFlags = this.handle(async (_request, response) => {
    successResponse(response, await listFlags(), 'Flags retrieved.')
  })

  /**
   * `GET /platform/flags/evaluate`: one user's flags, with reasons; audited.
   */
  evaluate = this.handle(async (request, response) => {
    const query = parseBody(platformFlagsEvaluateQuerySchema, request.query)
    successResponse(response, await evaluateFlagsFor(actorFrom(request), query), 'Flags evaluated.')
  })
}

/**
 * The controller the flag inspector routes mount.
 */
export const platformFlagsController = new PlatformFlagsController()
