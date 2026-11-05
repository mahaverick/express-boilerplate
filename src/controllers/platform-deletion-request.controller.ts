/**
 * @file Handlers for `/api/v1/platform/deletion-requests`. Every route runs
 * behind `requireAuth` and `requirePlatformRole`
 * (platform-deletion-request.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { listOpenDeletionRequests } from '@/services/account-deletion.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { platformDeletionRequestListSchema } from '@/validators/platform.validators'

/**
 * Handlers for `/api/v1/platform/deletion-requests`.
 */
class PlatformDeletionRequestController extends BaseController {
  /**
   * `GET /platform/deletion-requests`: list the open account deletion requests.
   */
  searchDeletionRequests = this.handle(async (request, response) => {
    const query = parseBody(platformDeletionRequestListSchema, request.query)
    successResponse(response, await listOpenDeletionRequests(query), 'Deletion requests retrieved.')
  })
}

/**
 * The one `PlatformDeletionRequestController`.
 */
export const platformDeletionRequestController = new PlatformDeletionRequestController()
