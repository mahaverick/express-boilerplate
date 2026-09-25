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
// fields, and `toUpdateValues` below only ever reads the two keys that
// schema can produce. There is deliberately no second check here (e.g.
// re-validating that `email`/`active` were not requested) — a second,
// independent allow-list is exactly the kind of duplicate definition that
// drifts from the first one over time.
import { type NextFunction, type Request, type Response } from 'express'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import type { NewUser } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { toPublicUser } from '@/presenters/user.presenter'
import { UserRepository } from '@/repositories/user.repository'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { updateProfileSchema, type UpdateProfileInput } from '@/validators/profile.validators'

const userRepository = new UserRepository()

/**
 * The row columns a validated `PATCH /api/v1/profile` body should write,
 * built from `input` rather than from the raw request body.
 *
 * `Object.hasOwn` — not `input.firstName !== undefined` — is what
 * distinguishes "the client omitted this field" (leave the column alone,
 * so the key is never added to `values`) from "the client sent an explicit
 * `null`" (clear the column, so the key IS added, holding `null`). Reading
 * `input.firstName` directly for a key that passed `hasOwn` also means no
 * `null` literal needs to appear in this file: the only `null` that can
 * flow into `values` is the one the client actually sent, carried through
 * from `updateProfileSchema`'s own parsed output.
 * @param input - The already-validated request body.
 * @returns Only the columns the caller actually supplied, ready for `UserRepository.update`.
 */
function toUpdateValues(
  input: UpdateProfileInput
): Partial<Pick<NewUser, 'firstName' | 'lastName'>> {
  const values: Partial<Pick<NewUser, 'firstName' | 'lastName'>> = {}
  if (Object.hasOwn(input, 'firstName')) values.firstName = input.firstName
  if (Object.hasOwn(input, 'lastName')) values.lastName = input.lastName
  return values
}

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
    const userId = authenticatedUserId(request)
    const user = await userRepository.findById(userId)
    if (!user) {
      throw new HttpError('User not found', 404)
    }
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
    const values = toUpdateValues(input)
    const hasChanges = Object.keys(values).length > 0
    const user = hasChanges
      ? await userRepository.update(userId, values)
      : await userRepository.findById(userId)
    if (!user) {
      throw new HttpError('User not found', 404)
    }
    successResponse(response, toPublicUser(user), 'Profile updated.')
  } catch (error) {
    next(error)
  }
}
