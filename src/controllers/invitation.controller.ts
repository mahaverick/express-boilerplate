/**
 * @file The invitee's side of an invitation: preview (public), the one-click
 * verify (public; it signs the invitee in) and accept (signed in). A
 * malformed token answers exactly like an unknown one, so the shape check
 * tells a caller nothing the lookup would not.
 */
import { BaseController } from '@/controllers/base.controller'
import {
  authenticatedUserId,
  revokePresentedSession,
  setRefreshTokenCookie,
} from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import { toProfileResponse } from '@/presenters/user.presenter'
import {
  accept,
  INVITATION_INVALID_CODE,
  INVITATION_INVALID_MESSAGE,
  preview,
  verifyInvitation,
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
   * `POST /invitations/verify`: accept an invitation in one click, signed
   * out. Signs the invitee in, creating a verified account when the address
   * has none (`isNewUser`), and joins them. Every link that signs nobody in,
   * a used one included, answers one 404 `invitation_invalid` with no cookie.
   * A refresh cookie the browser still presented has its session revoked once
   * the new one is issued, as a sign-in by link does. `no-store`, as every
   * token response (RFC 6749 §5.1).
   */
  verifyInvitation = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const token = invitationTokenFrom(request.body)
    const session = await verifyInvitation(token)
    await revokePresentedSession(request, { emitSignedOut: false })

    setRefreshTokenCookie(
      request,
      response,
      session.refreshToken.raw,
      session.refreshToken.expiresAt
    )
    successResponse(
      response,
      {
        user: toProfileResponse(session.user, session.platformRole),
        accessToken: session.accessToken,
        isNewUser: session.isNewUser,
        tenant: session.tenant,
        role: session.role,
      },
      'Invitation accepted.'
    )
  })

  /**
   * `POST /invitations/accept`: accept an invitation as the signed-in user,
   * behind `requireAuth`. Idempotent for the invitee: `alreadyMember` says
   * whether they had joined already.
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
