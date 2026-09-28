/**
 * @file Handlers for `/api/v1/profile`, behind `requireAuth`. Both reply with
 * `toProfileResponse` (user.presenter.ts), the one definition of what a user
 * looks like to a client.
 */
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import { toProfileResponse } from '@/presenters/user.presenter'
import { getProfile, updateProfile } from '@/services/profile.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { updateProfileSchema } from '@/validators/profile.validators'

/**
 * Handlers for `/api/v1/profile`.
 */
class ProfileController extends BaseController {
  /**
   * `GET /profile`: the authenticated user's own profile.
   */
  getProfile = this.handle(async (request, response) => {
    const { user, platformRole } = await getProfile(authenticatedUserId(request))
    successResponse(response, toProfileResponse(user, platformRole), 'Profile retrieved.')
  })

  /**
   * `PATCH /profile`: update the authenticated user's own profile.
   *
   * The mass-assignment defence is `updateProfileSchema` alone: only the
   * fields it names (`firstName`, `lastName`) reach the database, and
   * `toUpdateValues` (profile.service.ts) reads only those two keys. There is
   * deliberately no second allow-list here, which would drift from the first.
   * A body with no recognised fields skips the write and returns the current
   * row, so `updatedAt` is not bumped by a request that changed nothing.
   */
  updateProfile = this.handle(async (request, response) => {
    const userId = authenticatedUserId(request)
    const input = parseBody(updateProfileSchema, request.body)
    const { user, platformRole } = await updateProfile(userId, input)
    successResponse(response, toProfileResponse(user, platformRole), 'Profile updated.')
  })
}

/**
 * The profile controller the profile routes mount.
 */
export const profileController = new ProfileController()
