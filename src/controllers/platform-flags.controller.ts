/**
 * @file Handlers for `GET /api/v1/platform/flags`, `/flags/unregistered`
 * and `/flags/meta` (behind `requirePlatformRole('viewer')` and the shared
 * `platform-search` limiter) and `GET /api/v1/platform/flags/evaluate` (behind
 * `requirePlatformRole('admin')` and its own `flag-evaluate`
 * limiter), in platform.routes.ts.
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import {
  evaluateFlagsFor,
  getFlagsMeta,
  listFlags,
  listUnregisteredFlags,
} from '@/services/platform-flags.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  platformFlagListSchema,
  platformFlagsEvaluateQuerySchema,
  platformUnregisteredFlagListSchema,
} from '@/validators/platform.validators'

/**
 * Handlers for the flag inspector routes.
 */
class PlatformFlagsController extends BaseController {
  /**
   * `GET /platform/flags`: a page of the registry joined with the live snapshot.
   */
  listFlags = this.handle((request, response) => {
    const query = parseBody(platformFlagListSchema, request.query)
    successResponse(response, listFlags(query), 'Flags retrieved.')
  })

  /**
   * `GET /platform/flags/unregistered`: a page of the flags the registry lacks.
   */
  listUnregisteredFlags = this.handle((request, response) => {
    const query = parseBody(platformUnregisteredFlagListSchema, request.query)
    successResponse(response, listUnregisteredFlags(query), 'Unregistered flags retrieved.')
  })

  /**
   * `GET /platform/flags/meta`: the traits reference and the snapshot's age.
   */
  getFlagsMeta = this.handle(async (_request, response) => {
    successResponse(response, await getFlagsMeta(), 'Flags meta retrieved.')
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
