/**
 * @file The invitee's side of an invitation: preview (public), the verify
 * (public; it signs a new address in, or mails a confirm link), the confirm
 * link's click (public; it signs in) and accept (signed in). A malformed
 * token answers exactly like an unknown one, so the shape check tells a
 * caller nothing the lookup would not.
 */
import type { Request, Response } from 'express'
import { z } from 'zod'
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
  confirmInvitation,
  INVITATION_CONFIRM_INVALID_MESSAGE,
  INVITATION_CONFIRM_MESSAGE,
  INVITATION_INVALID_CODE,
  INVITATION_INVALID_MESSAGE,
  preview,
  verifyInvitation,
  type InvitationSession,
} from '@/services/tenant-invitation.service'
import { successResponse } from '@/utilities/response.utilities'
import {
  invitationConfirmInputSchema,
  invitationTokenInputSchema,
} from '@/validators/invitation.validators'
import { VALIDATION_FAILED_MESSAGE } from '@/validators/parse.validators'

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
 * The confirm body's token and displayed address. A non-string address is
 * the validation 400 (`errors.email`), checked first; every other shape
 * (a missing, non-string or malformed token, a body that is not an object)
 * is the confirm page's generic 404 (`INVITATION_CONFIRM_INVALID_MESSAGE`).
 * @param input - `request.body`.
 * @returns The token and the address, trimmed and lowercased, when sent.
 * @throws {HttpError} 400 `Check the highlighted fields, then try again.` with `errors.email`; 404 `invitation_invalid`.
 */
function confirmInputFrom(input: unknown): { token: string; email?: string } {
  const result = invitationConfirmInputSchema.safeParse(input)
  if (!result.success) {
    const { email } = z.flattenError(result.error).fieldErrors
    if (email !== undefined)
      throw new HttpError(VALIDATION_FAILED_MESSAGE, 400, undefined, {
        email,
      })
    throw new HttpError(INVITATION_CONFIRM_INVALID_MESSAGE, 404, INVITATION_INVALID_CODE)
  }
  const shape = invitationTokenInputSchema.safeParse({ token: result.data.token })
  if (!shape.success) {
    throw new HttpError(INVITATION_CONFIRM_INVALID_MESSAGE, 404, INVITATION_INVALID_CODE)
  }
  const { token } = shape.data
  return result.data.email === undefined ? { token } : { token, email: result.data.email }
}

/**
 * Send a join's session: the refresh cookie and the `200` body both
 * signed-out joins answer with.
 * @param request - The request, for the cookie's attributes.
 * @param response - The response.
 * @param session - The joined session.
 */
function sendInvitationSession(
  request: Request,
  response: Response,
  session: InvitationSession
): void {
  setRefreshTokenCookie(request, response, session.refreshToken.raw, session.refreshToken.expiresAt)
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
   * `POST /invitations/verify`: a click on an invitation link, signed out.
   * A customer invitation to an address with no account joins in one click:
   * it signs the invitee in, creating a verified account, and joins them.
   * Every other click answers `202` "Check your inbox" with the invited
   * address, sets no cookie and leaves the presented session alone; the
   * confirm-link mail runs after the reply. Every link that signs nobody in,
   * a used one included, answers one 404 `invitation_invalid` with no
   * cookie. On a one-click join, a refresh cookie the browser still
   * presented has its session revoked once the new one is issued, as a
   * sign-in by link does. `no-store`, as every token response (RFC 6749
   * §5.1).
   */
  verifyInvitation = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const token = invitationTokenFrom(request.body)
    const outcome = await verifyInvitation(token)
    if (outcome.kind === 'confirm') {
      successResponse(
        response,
        { confirmationSent: true, email: outcome.email },
        INVITATION_CONFIRM_MESSAGE,
        202
      )
      // Never rejects: the service logs its own failure.
      void outcome.followUp()
      return
    }
    await revokePresentedSession(request, { emitSignedOut: false })
    sendInvitationSession(request, response, outcome.session)
  })

  /**
   * `POST /invitations/confirm`: a click on the emailed confirm link. Signs
   * the invitee in, counted as a recent sign-in, and joins them, creating
   * the account for a staff invitation to a new address (`isNewUser`). Every
   * refusal answers one 404 `invitation_invalid` and spends nothing. A
   * refresh cookie the browser still presented has its session revoked once
   * the new one is issued. `no-store`.
   */
  confirmInvitation = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const input = confirmInputFrom(request.body)
    const session = await confirmInvitation(input.token, input.email)
    await revokePresentedSession(request, { emitSignedOut: false })
    sendInvitationSession(request, response, session)
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
