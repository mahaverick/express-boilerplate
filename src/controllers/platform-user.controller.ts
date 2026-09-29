/**
 * @file Handlers for `/api/v1/platform/users`. Every route runs behind
 * `requireAuth` and `requirePlatformRole` (platform-user.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import {
  createUser,
  deactivateUser,
  deleteUser,
  getUserDetail,
  reactivateUser,
  resendUserVerification,
  searchUsers,
  sendPasswordSetup,
  signOutUser,
  updateUser,
} from '@/services/platform-user.service'
import { messageResponse, successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  newPlatformUserSchema,
  parseIdParameter,
  platformUserSearchSchema,
  reasonBodySchema,
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

  /**
   * `POST /platform/users/:id/deactivate`: block sign-in and end every session.
   */
  deactivateUser = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, USER_NOT_FOUND)
    const { reason } = parseBody(reasonBodySchema, request.body)
    successResponse(
      response,
      await deactivateUser(actorFrom(request), userId, reason),
      'User deactivated.'
    )
  })

  /**
   * `POST /platform/users/:id/reactivate`: allow sign-in again.
   */
  reactivateUser = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, USER_NOT_FOUND)
    const { reason } = parseBody(reasonBodySchema, request.body)
    successResponse(
      response,
      await reactivateUser(actorFrom(request), userId, reason),
      'User reactivated.'
    )
  })

  /**
   * `POST /platform/users/:id/sign-out`: end every session.
   */
  signOutUser = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, USER_NOT_FOUND)
    const { reason } = parseBody(reasonBodySchema, request.body)
    await signOutUser(actorFrom(request), userId, reason)
    messageResponse(response, 'User signed out everywhere.')
  })

  /**
   * `DELETE /platform/users/:id`: soft-delete and end every session.
   */
  deleteUser = this.handle(async (request, response) => {
    const userId = parseIdParameter(request.params.id, USER_NOT_FOUND)
    const { reason } = parseBody(reasonBodySchema, request.body)
    await deleteUser(actorFrom(request), userId, reason)
    messageResponse(response, 'User deleted.')
  })
}

/**
 * The controller the platform user routes mount.
 */
export const platformUserController = new PlatformUserController()
