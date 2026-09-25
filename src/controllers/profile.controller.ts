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
import { type NextFunction, type Request, type Response } from 'express'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import { toPublicUser } from '@/presenters/user.presenter'
import {
  getProfile as getProfileRecord,
  updateProfile as updateProfileRecord,
} from '@/services/profile.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { updateProfileSchema } from '@/validators/profile.validators'

/**
 * Get the authenticated user's own profile.
 * @param request - The incoming request, carrying the authenticated user set by `requireAuth`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function getProfile(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = await getProfileRecord(authenticatedUserId(request))
    successResponse(response, toPublicUser(user), 'Profile retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * Update the authenticated user's own profile.
 *
 * Only the fields `updateProfileSchema` names (`firstName`, `lastName`) can
 * ever reach the database from this handler — see this file's header
 * comment and profile.validators.ts's for why `email`, `id`, `passwordHash`
 * and `active` cannot be changed here no matter what the request body
 * contains. A body with no recognised fields at all (every key stripped, or
 * none supplied) skips the write entirely and returns the current row
 * unchanged, rather than issuing a no-op `UPDATE` that would still bump
 * `updatedAt` for a request that changed nothing.
 * @param request - The incoming request, carrying the authenticated user set by `requireAuth`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function updateProfile(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = authenticatedUserId(request)
    const input = parseBody(updateProfileSchema, request.body)
    const user = await updateProfileRecord(userId, input)
    successResponse(response, toPublicUser(user), 'Profile updated.')
  } catch (error) {
    next(error)
  }
}
