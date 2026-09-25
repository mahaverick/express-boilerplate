// src/services/verification.service.ts
//
// Everything about proving a mailbox: the frontend links mailed to a user,
// the verification mail, verifying with token + password, resending, and
// markEmailVerified, the one writer of users.email_verified_at.
//
// Every link points at the FRONTEND (WEB_URL), not this API. The user
// clicks one in a mail client, lands on a page, and that page POSTs the
// token onward — with the account password for verification, with a new
// password for a reset — to this API's own endpoint. A GET link that acted
// on its own would put the token in a query string this server logs, and
// would let any mail scanner that follows links spend it before the user
// ever sees the message.
//
// Verification proves TWO things together: the caller can read the mailbox
// (they hold the token) and set the password (they can produce it). The
// spec's "Squatting" section has the full argument; do not drop the password.
import { getEnv } from '@/configs/env.config'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { addNotificationJob } from '@/jobs/notification.job'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, type DbExecutor } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { autoJoinSafely } from '@/services/platform.service'
import { claimToken, issueToken } from '@/services/session.service'
import { EMAIL_VERIFICATION_TEMPLATE_KEY } from '@/templates/email/email-verification.template'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { getDummyHash, isPasswordValid } from '@/utilities/password.utilities'

const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

const VERIFICATION_PATH = 'verify-email'
// Named RESET_PATH, not RESET_PASSWORD_PATH: sonarjs/no-hardcoded-passwords
// flags any identifier containing "password" paired with a string literal.
const RESET_PATH = 'reset-password'
const INVITATION_ACCEPT_PATH = 'invitations/accept'

/**
 * The name a template greets an unnamed user by. `firstName` is optional
 * at registration but REQUIRED by every template — requireEmailVariables
 * throws on a missing one and sendMail catches that into a 'failed' log
 * row, so without a fallback the mail silently never arrives.
 */
export const MISSING_FIRST_NAME_FALLBACK = 'there'

/**
 * The one failure verify-email answers, whatever went wrong.
 */
export const INVALID_VERIFICATION_TOKEN_MESSAGE = 'Invalid or expired verification token.'

/**
 * Build an absolute frontend URL for one page, carrying a raw token.
 * @param pagePath - The frontend page, relative to WEB_URL.
 * @param rawToken - The raw token, never its hash.
 * @param webUrl - The frontend origin.
 * @returns The absolute URL with `token` as a query parameter.
 */
function buildTokenUrl(pagePath: string, rawToken: string, webUrl: string): string {
  // `new URL(path, base)` resolves a trailing slash on the base correctly
  // and percent-encodes the token.
  const url = new URL(pagePath, webUrl.endsWith('/') ? webUrl : `${webUrl}/`)
  url.searchParams.set('token', rawToken)
  return url.href
}

/**
 * Build the verification link mailed to a user.
 * @param rawToken - The raw token from `issueToken`, never its hash.
 * @param webUrl - The frontend origin; defaults to the configured `WEB_URL`.
 * @returns An absolute URL carrying the token as a query parameter.
 */
export function buildVerificationUrl(rawToken: string, webUrl: string = getEnv().WEB_URL): string {
  return buildTokenUrl(VERIFICATION_PATH, rawToken, webUrl)
}

/**
 * Build the password-reset link mailed to a user.
 * @param rawToken - The raw `password_reset`-purpose token from `issueToken`, never its hash.
 * @param webUrl - The frontend origin; defaults to the configured `WEB_URL`.
 * @returns An absolute URL carrying the token as a query parameter.
 */
export function buildPasswordResetUrl(rawToken: string, webUrl: string = getEnv().WEB_URL): string {
  return buildTokenUrl(RESET_PATH, rawToken, webUrl)
}

/**
 * Build the invitation accept link mailed to an invitee. The page it opens
 * POSTs the token to `/invitations/preview` and then `/invitations/accept`.
 * @param rawToken - The raw invitation token, never its hash.
 * @param webUrl - The frontend origin; defaults to the configured `WEB_URL`.
 * @returns An absolute URL carrying the token as a query parameter.
 */
export function buildInvitationAcceptUrl(
  rawToken: string,
  webUrl: string = getEnv().WEB_URL
): string {
  return buildTokenUrl(INVITATION_ACCEPT_PATH, rawToken, webUrl)
}

/**
 * Issue a verification token for a user, then enqueue a `verify_email`
 * notification job — the worker fans it out into an in-app row and the
 * mail carrying the link (email is not user-disableable for this type).
 * @param user - The user to verify.
 */
export async function sendVerificationMail(user: User): Promise<void> {
  const issued = await issueToken(
    user.id,
    'email_verification',
    requireDurationMs(getEnv().EMAIL_VERIFICATION_TTL)
  )
  await addNotificationJob({
    userId: user.id,
    type: 'verify_email',
    title: 'Verify your email',
    body: `Please verify your email address for ${getEnv().APP_NAME}.`,
    metadata: { templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY },
    email: {
      to: user.email,
      templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
      variables: {
        firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
        verificationUrl: buildVerificationUrl(issued.raw),
        appName: getEnv().APP_NAME,
      },
    },
  })
}

/**
 * Mark a user's email verified. The only writer of users.email_verified_at;
 * a no-op when it is already set, so an earlier timestamp never moves. On
 * the transition to verified, an address on PLATFORM_EMAIL_DOMAINS joins the
 * platform tenant as viewer, unless it already has a platform membership; a
 * failure there is logged, never thrown.
 * @param userId - The user whose mailbox has been proven.
 * @param executor - The pool, or the caller's transaction to join.
 * @returns Resolves once the row is verified, or was already.
 */
export async function markEmailVerified(userId: string, executor: DbExecutor = db): Promise<void> {
  const verified = await userRepository.markEmailVerified(userId, executor)
  if (verified) await autoJoinSafely(verified, executor)
}

/**
 * Verify an email with a token from the mailed link and the account's
 * password. Every failure throws the same 400.
 *
 * Claim FIRST, compare SECOND: one presentation is one attempt, so a wrong
 * password spends the token. The dummy hash runs when there is no user, so
 * an unknown token costs the same bcrypt time as a real one.
 * @param token - The raw verification token.
 * @param password - The account's password.
 * @returns Resolves once the account is verified (or already was).
 * @throws {HttpError} 400 INVALID_VERIFICATION_TOKEN_MESSAGE, for any failure.
 */
export async function verifyEmail(token: string, password: string): Promise<void> {
  const claimed = await claimToken(token, 'email_verification')
  const user = claimed ? await userRepository.findById(claimed.userId) : undefined

  const hashToCompare = user?.passwordHash ?? (await getDummyHash())
  const isPasswordCorrect = await isPasswordValid(password, hashToCompare)

  if (!isPasswordCorrect || !claimed || !user || !user.passwordHash) {
    throw new HttpError(INVALID_VERIFICATION_TOKEN_MESSAGE, 400)
  }

  // Already verified is success: a double-clicked link must not be an error.
  await markEmailVerified(user.id)
  // Any other link mailed to this user is now pointless; leaving it live
  // means a token read out of an older mail still works.
  await userTokenRepository.revokeAllForUserAndPurpose(user.id, 'email_verification')
}

/**
 * Revoke a user's outstanding verification links and mail a new one.
 * Revoke FIRST: the new token's row does not exist yet, so reversing the
 * order would mail a link this call had just revoked.
 * @param user - The unverified user who asked for another link.
 */
async function resendVerificationMail(user: User): Promise<void> {
  // Purpose-scoped: revokeAllForUser would take the user's live refresh
  // tokens with it and log them out everywhere.
  await userTokenRepository.revokeAllForUserAndPurpose(user.id, 'email_verification')
  await sendVerificationMail(user)
}

/**
 * Look up a resend-verification address, and return the mail work for the
 * controller to start once it has responded. The lookup runs before the
 * response on every branch; the mail only for an existing, unverified user.
 * @param email - The submitted address.
 * @returns A function that sends the mail when one is due; it never rejects.
 */
export async function prepareResendVerification(email: string): Promise<() => Promise<void>> {
  const user = await userRepository.findByEmail(email)
  return async () => {
    if (!user || user.emailVerifiedAt) return
    try {
      await resendVerificationMail(user)
    } catch (error) {
      logger.error('Resend verification mail failed', { error: redactedForLog(error) })
    }
  }
}
