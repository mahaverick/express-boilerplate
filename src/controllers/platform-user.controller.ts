/**
 * @file Handlers for `/api/v1/platform/users`. Every route runs behind
 * `requireAuth` and `requirePlatformRole` (platform-user.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import {
  createUser,
  getUserDetail,
  resendUserVerification,
  searchUsers,
  sendPasswordSetup,
  updateUser,
} from '@/services/platform-user.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  newPlatformUserSchema,
  parseIdParameter,
  platformUserSearchSchema,
  updatePlatformUserSchema,
} from '@/validators/platform.validators'

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

  /**
   * `POST /platform/users`: create a user and mail a set-password link.
   */
  createUser = this.handle(async (request, response) => {
    const input = parseBody(newPlatformUserSchema, request.body)
    const result = await createUser(actorFrom(request), input)
    successResponse(response, result, 'User created.', 201)
  })

  /**
   * `PATCH /platform/users/:id`: change a user's names.
   */
  updateUser = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, USER_NOT_FOUND)
    const input = parseBody(updatePlatformUserSchema, request.body)
    successResponse(response, await updateUser(actorFrom(request), userId, input), 'User updated.')
  })

  /**
   * `POST /platform/users/:id/password-setup`: mail a set-password or reset link.
   */
  sendPasswordSetup = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, USER_NOT_FOUND)
    const result = await sendPasswordSetup(actorFrom(request), userId)
    successResponse(response, result, 'Password link sent.')
  })

  /**
   * `POST /platform/users/:id/resend-verification`: mail a fresh verification link.
   */
  resendVerification = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, USER_NOT_FOUND)
    const result = await resendUserVerification(actorFrom(request), userId)
    successResponse(response, result, 'Verification link sent.')
  })
}

/**
 * The controller the platform user routes mount.
 */
export const platformUserController = new PlatformUserController()
