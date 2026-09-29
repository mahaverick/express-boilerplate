/**
 * @file Handlers for `/api/v1/platform/users`. Every route runs behind
 * `requireAuth` and `requirePlatformRole` (platform-user.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { getUserDetail, searchUsers } from '@/services/platform-user.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { parseIdParameter, platformUserSearchSchema } from '@/validators/platform.validators'

/**
 * The 404 a malformed or unknown user id answers.
 */
const USER_NOT_FOUND = 'User not found'

/**
 * Handlers for `/api/v1/platform/users`.
 */
class PlatformUserController extends BaseController {
  /**
   * `GET /platform/users`: search users (soft-deleted ones only under `status=deleted`).
   */
  searchUsers = this.handle(async (request, response) => {
    const query = parseBody(platformUserSearchSchema, request.query)
    successResponse(response, await searchUsers(query), 'Users retrieved.')
  })

  /**
   * `GET /platform/users/:id`: one user's detail.
   */
  getUser = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, USER_NOT_FOUND)
    successResponse(response, await getUserDetail(userId), 'User retrieved.')
  })
}

/**
 * The controller the platform user routes mount.
 */
export const platformUserController = new PlatformUserController()
