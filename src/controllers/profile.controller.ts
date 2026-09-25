// src/controllers/profile.controller.ts
//
// The first authenticated routes in this codebase — both handlers assume
// `requireAuth` (auth.middleware.ts) has already run and populated
// `request.user`. `authenticatedUserId` (helpers.controller.ts) still
// guards against a missing `request.user` rather than asserting it with
// `!`: today that can only happen if a route is wired up wrong
// (profile.routes.ts mounts requireAuth ahead of both handlers), but a
// defensive 401 here costs nothing and turns a future routing mistake into
// an auth failure instead of a crash or, worse, `undefined` flowing into a
// database lookup.
//
// `getProfile`/`updateProfile` both respond with `toPublicUser` (imported
// from user.presenter.ts, not redefined) — see that function's own header
// comment for why this codebase keeps exactly one definition of "what a
// user looks like to a client".
//
// `updateProfile`'s mass-assignment defence is `updateProfileSchema`
// (profile.validators.ts) alone: it is the only allow-list of writable
// fields, and `toUpdateValues` (profile.service.ts) only ever reads the two
// keys that schema can produce. There is deliberately no second check here
// (e.g. re-validating that `email`/`active` were not requested) — a second,
// independent allow-list is exactly the kind of duplicate definition that
// drifts from the first one over time.
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import { toPublicUser } from '@/presenters/user.presenter'
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
    const user = await getProfile(authenticatedUserId(request))
    successResponse(response, toPublicUser(user), 'Profile retrieved.')
  })

  /**
   * `PATCH /profile`: update the authenticated user's own profile.
   *
   * Only the fields `updateProfileSchema` names (`firstName`, `lastName`) can
   * ever reach the database from this handler — see this file's header
   * comment and profile.validators.ts's for why `email`, `id`, `passwordHash`
   * and `active` cannot be changed here no matter what the request body
   * contains. A body with no recognised fields at all (every key stripped, or
   * none supplied) skips the write entirely and returns the current row
   * unchanged, rather than issuing a no-op `UPDATE` that would still bump
   * `updatedAt` for a request that changed nothing.
   */
  updateProfile = this.handle(async (request, response) => {
    const userId = authenticatedUserId(request)
    const input = parseBody(updateProfileSchema, request.body)
    const user = await updateProfile(userId, input)
    successResponse(response, toPublicUser(user), 'Profile updated.')
  })
}

/**
 * The profile controller the profile routes mount.
 */
export const profileController = new ProfileController()
