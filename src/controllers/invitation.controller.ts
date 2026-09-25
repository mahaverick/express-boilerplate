// src/controllers/invitation.controller.ts
//
// The invitee's side of an invitation: preview (public) and accept (signed
// in). A malformed token answers exactly like an unknown one, so the shape
// check tells a caller nothing the lookup would not.
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
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
 * Handlers for `/api/v1/invitations`.
 */
class InvitationController extends BaseController {
  /**
   * `POST /invitations/preview`: show what a token invites its holder to.
   * Public: no sign-in needed.
   */
  previewInvitation = this.handle(async (request, response) => {
    const token = invitationTokenFrom(request.body)
    const invitation = await preview(token)
    successResponse(response, invitation, 'Invitation retrieved.')
  })

  /**
   * `POST /invitations/accept`: accept an invitation as the signed-in user,
   * behind `requireAuth`.
   */
  acceptInvitation = this.handle(async (request, response) => {
    const userId = authenticatedUserId(request)
    const token = invitationTokenFrom(request.body)
    const accepted = await accept(token, userId)
    successResponse(response, accepted, 'Invitation accepted.')
  })
}

/**
 * The invitation controller the invitation routes mount.
 */
export const invitationController = new InvitationController()
