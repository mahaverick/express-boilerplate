/**
 * @file Everything about proving a mailbox: the frontend links mailed to a user,
 * the verification mail, verifying with token and password, resending, and
 * `markEmailVerified`, the one writer of `users.email_verified_at`.
 */
import { getEnv, type Env } from '@/configs/env.config'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { addNotificationJob } from '@/jobs/notification.job'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, type DbExecutor } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { logger } from '@/services/logger.service'
import { autoJoinSafely } from '@/services/platform.service'
import { claimToken, issueToken } from '@/services/session.service'
import { EMAIL_VERIFICATION_TEMPLATE_KEY } from '@/templates/email/email-verification.template'
import type { EmailResendOptions } from '@/types/email-context'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { getDummyHash, isPasswordValid } from '@/utilities/password.utilities'

const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

const VERIFICATION_PATH = 'verify-email'
/**
 * Not RESET_PASSWORD_PATH: sonarjs/no-hardcoded-passwords flags a "password"
 * identifier holding a string literal.
 */
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
 * Build an absolute frontend URL for one page, carrying a raw token. Links
 * point at the frontend (WEB_URL), whose page POSTs the token to this API: a
 * GET link that acted by itself would put the token in a query string this
 * server logs, and a mail scanner following links could spend it.
 * @param pagePath - The frontend page, relative to WEB_URL.
 * @param rawToken - The raw token, never its hash.
 * @param webUrl - The frontend origin.
 * @returns The absolute URL with `token` as a query parameter.
 */
function buildTokenUrl(pagePath: string, rawToken: string, webUrl: string): string {
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
 * The configured origin for one frontend. Always one of two configured
 * values, never request input, so choosing `app` cannot send a link anywhere else.
 * @param app - The frontend the link or redirect is for.
 * @param env - The configured origins; defaults to the validated environment.
 * @returns APEX_URL for 'apex' when it is set, WEB_URL otherwise.
 */
export function frontendUrl(
  app: FrontendApp,
  env: Pick<Env, 'WEB_URL' | 'APEX_URL'> = getEnv()
): string {
  return app === 'apex' && env.APEX_URL !== undefined ? env.APEX_URL : env.WEB_URL
}

/**
 * Issue a verification token for a user, then enqueue a `verify_email`
 * notification job — the worker fans it out into an in-app row and the
 * mail carrying the link (email is not user-disableable for this type).
 * The mail's message row records `app` as the frontend its link opens.
 * @param user - The user to verify.
 * @param app - The frontend the link opens; the customer app by default.
 * @param options - `resentFromId` when a staff resend re-runs this flow for an earlier message.
 */
export async function sendVerificationMail(
  user: User,
  app: FrontendApp = 'web',
  options: EmailResendOptions = {}
): Promise<void> {
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
        verificationUrl: buildVerificationUrl(issued.raw, frontendUrl(app)),
        appName: getEnv().APP_NAME,
      },
    },
    emailContext: { linkApp: app, ...options },
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
 * password. Every failure throws the same 400. The password is required:
 * without it, someone who registered another person's address with a password
 * they chose would get the account verified by the owner's own click.
 *
 * Claim FIRST, compare SECOND: one presentation is one attempt, so a wrong
 * password spends the token. The dummy hash runs when there is no user, so
 * an unknown token costs the same bcrypt time as a real one. A link that
 * verifies a still-unverified account emits `email_verified`; one for an
 * account already verified emits nothing.
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
  // Revoke the other links, or a token read out of an older mail still works.
  await userTokenRepository.revokeAllForUserAndPurpose(user.id, 'email_verification')
  if (user.emailVerifiedAt === null) {
    await emitDomainEvent({ type: 'email_verified', userId: user.id, at: new Date() })
  }
}

/**
 * Revoke a user's outstanding verification links and mail a new one.
 * Revoke FIRST: the new token's row does not exist yet, so reversing the
 * order would mail a link this call had just revoked.
 * @param user - The unverified user who asked for another link.
 * @param app - The frontend the new link opens.
 */
async function resendVerificationMail(user: User, app: FrontendApp): Promise<void> {
  // Purpose-scoped: revokeAllForUser would also revoke refresh tokens, logging the user out everywhere.
  await userTokenRepository.revokeAllForUserAndPurpose(user.id, 'email_verification')
  await sendVerificationMail(user, app)
}

/**
 * Look up a resend-verification address, and return the mail work for the
 * controller to start once it has responded. The lookup runs before the
 * response on every branch; the mail only for an existing, unverified user.
 * @param email - The submitted address.
 * @param app - The frontend the mailed link opens; the customer app by default.
 * @returns A function that sends the mail when one is due; it never rejects.
 */
export async function prepareResendVerification(
  email: string,
  app: FrontendApp = 'web'
): Promise<() => Promise<void>> {
  const user = await userRepository.findByEmail(email)
  return async () => {
    if (!user || user.emailVerifiedAt) return
    try {
      await resendVerificationMail(user, app)
    } catch (error) {
      logger.error('Resend verification mail failed', { error: redactedForLog(error) })
    }
  }
}
