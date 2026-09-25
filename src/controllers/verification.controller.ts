// src/controllers/verification.controller.ts
//
// HTTP only; the rules are in verification.service.ts. Every failure answers
// identically: distinguishable failures would be a token-state oracle, and a
// distinguishable wrong password would tell a link holder the address is squatted.
import { type NextFunction, type Request, type Response } from 'express'
import { HttpError } from '@/errors/http-error'
import * as verificationService from '@/services/verification.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  resendVerificationSchema,
  verifyEmailSchema,
  type ResendVerificationInput,
  type VerifyEmailInput,
} from '@/validators/verification.validators'

/**
 * Verify an email address with a token from the mailed link and the
 * account's password.
 * @param request - The incoming request, carrying `{ token, password }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function verifyEmail(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    // parseBody's field-level 400 is distinguishable from this endpoint's one
    // failure, so a body missing `password` would answer differently.
    let input: VerifyEmailInput
    try {
      input = parseBody(verifyEmailSchema, request.body)
    } catch {
      throw new HttpError(verificationService.INVALID_VERIFICATION_TOKEN_MESSAGE, 400)
    }

    await verificationService.verifyEmail(input.token, input.password)

    // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
    successResponse(response, null, 'Email verified.')
  } catch (error) {
    next(error)
  }
}

const RESEND_RESPONSE_MESSAGE = 'If that address needs verification, a new link has been sent.'

/**
 * Send resend-verification's one response shape, so the envelope can never
 * drift between branches.
 * @param response - The response to send on.
 */
function respondResendAccepted(response: Response): void {
  // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
  successResponse(response, null, RESEND_RESPONSE_MESSAGE, 202)
}

/**
 * Send a fresh verification link, if and only if the address belongs to an
 * existing, unverified account. Identical response in every case.
 *
 * The lookup runs before the response on every branch; the mail runs after
 * it, so an SMTP round trip on one branch cannot be timed.
 * @param request - The incoming request, carrying `{ email }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function resendVerification(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
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
    // Never rejects: the service logs its own failure (Ruling T).
    void sendMail()
  } catch (error) {
    next(error)
  }
}
