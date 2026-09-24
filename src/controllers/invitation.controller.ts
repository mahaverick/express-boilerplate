// src/controllers/invitation.controller.ts
//
// The invitee's side of an invitation: preview (public) and accept (signed
// in). A malformed token answers exactly like an unknown one, so the shape
// check tells a caller nothing the lookup would not.
import { type NextFunction, type Request, type Response } from 'express'
import { HttpError } from '@/middlewares/error.middleware'
import {
  accept,
  INVITATION_INVALID_CODE,
  INVITATION_INVALID_MESSAGE,
  preview,
} from '@/services/tenant-invitation.service'
import { successResponse } from '@/utilities/response.utilities'
import { invitationTokenInputSchema } from '@/validators/invitation.validators'

/**
 * The raw token from a request body.
 * @param input - `request.body`.
 * @returns The token.
 * @throws {HttpError} 404 `invitation_invalid`, when the input carries no well-formed token.
 */
function invitationTokenFrom(input: unknown): string {
  const result = invitationTokenInputSchema.safeParse(input)
  if (!result.success) {
    throw new HttpError(INVITATION_INVALID_MESSAGE, 404, INVITATION_INVALID_CODE)
  }
  return result.data.token
}

/**
 * The authenticated caller's id; a 401 if a route reaches this handler
 * without `requireAuth`. Same four-line guard as tenant.controller.ts's.
 * @param request - The incoming request.
 * @returns The caller's id.
 * @throws {HttpError} 401, when `request.user` was never populated.
 */
function authenticatedUserId(request: Request): string {
  if (!request.user) throw new HttpError('Authentication required', 401)
  return request.user.id
}

/**
 * Show what a token invites its holder to. Public: no sign-in needed.
 * @param request - The incoming request, carrying `{ token }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function previewInvitation(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = invitationTokenFrom(request.body)
    const invitation = await preview(token)
    successResponse(response, invitation, 'Invitation retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * Accept an invitation as the signed-in user.
 * @param request - The incoming request, behind `requireAuth`, carrying `{ token }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function acceptInvitation(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = authenticatedUserId(request)
    const token = invitationTokenFrom(request.body)
    const accepted = await accept(token, userId)
    successResponse(response, accepted, 'Invitation accepted.')
  } catch (error) {
    next(error)
  }
}
