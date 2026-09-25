// src/controllers/verification.controller.ts
//
// HTTP only; the rules are in verification.service.ts. Every failure answers
// identically: distinguishable failures would be a token-state oracle, and a
// distinguishable wrong password would tell a link holder the address is squatted.
import type { Response } from 'express'
import { BaseController } from '@/controllers/base.controller'
import { HttpError } from '@/errors/http-error'
import * as verificationService from '@/services/verification.service'
import { messageResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  resendVerificationSchema,
  verifyEmailSchema,
  type ResendVerificationInput,
  type VerifyEmailInput,
} from '@/validators/verification.validators'

const RESEND_RESPONSE_MESSAGE = 'If that address needs verification, a new link has been sent.'

/**
 * Send resend-verification's one response shape, so the envelope can never
 * drift between branches.
 * @param response - The response to send on.
 */
function respondResendAccepted(response: Response): void {
  messageResponse(response, RESEND_RESPONSE_MESSAGE, 202)
}

/**
 * Handlers for the email-verification routes under `/api/v1/auth`.
 */
class VerificationController extends BaseController {
  /**
   * `POST /auth/verify-email`: verify an email address with a token from the
   * mailed link and the account's password.
   */
  verifyEmail = this.handle(async (request, response) => {
    // parseBody's field-level 400 is distinguishable from this endpoint's one
    // failure, so a body missing `password` would answer differently.
    let input: VerifyEmailInput
    try {
      input = parseBody(verifyEmailSchema, request.body)
    } catch {
      throw new HttpError(verificationService.INVALID_VERIFICATION_TOKEN_MESSAGE, 400)
    }

    await verificationService.verifyEmail(input.token, input.password)

    messageResponse(response, 'Email verified.')
  })

  /**
   * `POST /auth/resend-verification`: send a fresh verification link, if and
   * only if the address belongs to an existing, unverified account.
   * Identical response in every case.
   *
   * The lookup runs before the response on every branch; the mail runs after
   * it, so an SMTP round trip on one branch cannot be timed.
   */
  resendVerification = this.handle(async (request, response) => {
    // A malformed address must answer like a well-formed unknown one.
    let input: ResendVerificationInput
    try {
      input = parseBody(resendVerificationSchema, request.body)
    } catch {
      respondResendAccepted(response)
      return
    }
    const sendMail = await verificationService.prepareResendVerification(input.email)

    respondResendAccepted(response)
    // Not awaited, and never rejects: the service logs its own failure, so a
    // mail failure can neither delay nor change a response already sent.
    void sendMail()
  })
}

/**
 * The verification controller the auth routes mount.
 */
export const verificationController = new VerificationController()
