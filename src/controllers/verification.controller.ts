// src/controllers/verification.controller.ts
//
// Verification proves TWO things together, and needs both: the caller can
// read the mailbox (they hold the token) and the caller set the password
// (they can produce it). Either alone is insufficient, because an attacker
// can register an address they do not own — so the password is what stops
// a squatted account's real owner from verifying, with their own click,
// an account whose password the attacker chose. The spec's "Squatting"
// section has the full argument; do not remove the password field.
//
// Every failure answers identically. Four distinguishable failures would
// be a token-state oracle, and a distinguishable wrong-password failure
// would tell whoever holds a link that the address is squatted.
import { type NextFunction, type Request, type Response } from 'express'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { logger } from '@/services/logger.service'
import { getDummyHash, isPasswordValid } from '@/utilities/password.utilities'
import { successResponse } from '@/utilities/response.utilities'
import { claimToken } from '@/utilities/token.utilities'
import { sendVerificationMail } from '@/utilities/verification-mail.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  resendVerificationSchema,
  verifyEmailSchema,
  type ResendVerificationInput,
  type VerifyEmailInput,
} from '@/validators/verification.validators'

// Module-private instances, matching auth.controller.ts:37 and
// token.utilities.ts — this codebase does not export repository
// singletons, each module constructs its own.
const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

const INVALID_TOKEN_MESSAGE = 'Invalid or expired verification token.'

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
    // parseBody throws HttpError('Validation failed', 400, ..., fieldErrors)
    // (parse.validators.ts). That envelope is DISTINGUISHABLE from
    // this endpoint's identical-failure envelope, so a body missing
    // `password` would answer differently from a wrong password — the
    // oracle this endpoint exists to avoid, reintroduced through the
    // validator. Rethrow it as the one failure this endpoint has.
    let input: VerifyEmailInput
    try {
      input = parseBody(verifyEmailSchema, request.body)
    } catch {
      throw new HttpError(INVALID_TOKEN_MESSAGE, 400)
    }

    // Claim FIRST, compare SECOND. One presentation is one attempt, so a
    // wrong password spends the token — see SECURITY.md. The order also
    // means a valid token is never left claimable by an attacker probing
    // passwords against it.
    const claimed = await claimToken(input.token, 'email_verification')
    const user = claimed ? await userRepository.findById(claimed.userId) : undefined

    // The dummy hash runs even when there is no user, so an unknown token
    // costs the same bcrypt time as a real one — the same reasoning, and
    // the same helper, login uses (auth.controller.ts).
    const hashToCompare = user?.passwordHash ?? (await getDummyHash())
    const isPasswordCorrect = await isPasswordValid(input.password, hashToCompare)

    if (!isPasswordCorrect || !claimed || !user || !user.passwordHash) {
      throw new HttpError(INVALID_TOKEN_MESSAGE, 400)
    }

    // undefined means the row was ALREADY verified, which is success: a
    // double-clicked link must not be an error. See markEmailVerified.
    await userRepository.markEmailVerified(user.id)
    // Any other link mailed to this user is now pointless; leaving it live
    // means a token read out of an older mail still works.
    await userTokenRepository.revokeAllForUserAndPurpose(user.id, 'email_verification')

    // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
    successResponse(response, null, 'Email verified.')
  } catch (error) {
    next(error)
  }
}

const RESEND_RESPONSE_MESSAGE = 'If that address needs verification, a new link has been sent.'

/**
 * Send resend-verification's one response shape. Every case — malformed
 * body, unknown address, unverified, already verified — answers through
 * this single call so the envelope can never drift between branches. Also
 * keeps the `unicorn/no-null` disable to one place instead of one per call
 * site.
 * @param response - The response to send on.
 */
function respondResendAccepted(response: Response): void {
  // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
  successResponse(response, null, RESEND_RESPONSE_MESSAGE, 202)
}

/**
 * Send a fresh verification link, if and only if the address belongs to an
 * existing, unverified account.
 *
 * The response is identical in all three cases — unknown address, known
 * and unverified, known and already verified. Anything else makes this a
 * cheaper enumeration oracle than register, since it needs no password.
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
    // Same reasoning as verifyEmail: a malformed address must not answer
    // differently from a well-formed unknown one, or this becomes a
    // cheaper oracle than the one it was built to avoid.
    let input: ResendVerificationInput
    try {
      input = parseBody(resendVerificationSchema, request.body)
    } catch {
      respondResendAccepted(response)
      return
    }
    const user = await userRepository.findByEmail(input.email)

    // Respond first: an SMTP round trip on one branch only is a timing
    // oracle, and this endpoint has no bcrypt cost to hide behind.
    respondResendAccepted(response)

    if (!user || user.emailVerifiedAt) return

    // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget: the mail must not block the response, and awaiting would make the two branches differ by SMTP latency (Ruling T; see auth.controller.ts's register for the identical pattern)
    resendVerificationMail(user).catch((error: unknown) => {
      logger.error('Resend verification mail failed', { error })
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Revoke the user's outstanding verification links and mail a new one.
 *
 * Revoke FIRST, send SECOND — load-bearing, not incidental.
 * `revokeAllForUserAndPurpose` revokes every still-live row for this user
 * and purpose at the instant it runs, with no exception for a row that
 * does not exist yet. `sendVerificationMail` issues the new token via
 * `issueToken`, which inserts a fresh row. Reversing the order would mail
 * a link whose token this same call had just revoked — dead on arrival,
 * with the 202 response giving no sign anything was wrong.
 * @param user - The unverified user who asked for another link.
 */
async function resendVerificationMail(user: User): Promise<void> {
  // Purpose-scoped: revokeAllForUser would take the user's live REFRESH
  // tokens with it and log them out everywhere.
  await userTokenRepository.revokeAllForUserAndPurpose(user.id, 'email_verification')
  await sendVerificationMail(user)
}
