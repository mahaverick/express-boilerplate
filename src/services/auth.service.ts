/**
 * @file Email-and-password authentication. An unknown email and a wrong password
 * get the same status, body and bcrypt cost (`getDummyHash`), so neither content
 * nor timing reveals a registered address. Work that runs after the reply
 * (register's mail, requestPasswordReset) never rejects: a rejection on one branch
 * only would be an enumeration oracle.
 */
import { randomUUID } from 'node:crypto'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import type { FrontendApp } from '@/constants/frontend.constants'
import { JobPriority } from '@/constants/queue.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { AuthProviderRecord } from '@/database/models/auth-provider.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { addEmailJob } from '@/jobs/email.job'
import { addNotificationJob } from '@/jobs/notification.job'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { autoJoinSafely, getPlatformMembership } from '@/services/platform.service'
import {
  claimToken,
  denySessionsAfterCommit,
  issueRefreshToken,
  issueToken,
  markSessionReauthenticated,
  revokeAllSessions,
  revokeSessionRows,
  rotateRefreshToken,
  signAccessToken,
  type IssuedRefreshToken,
} from '@/services/session.service'
import {
  buildPasswordResetUrl,
  frontendUrl,
  markEmailVerified,
  MISSING_FIRST_NAME_FALLBACK,
  sendVerificationMail,
} from '@/services/verification.service'
import { PASSWORD_CHANGED_TEMPLATE_KEY } from '@/templates/email/password-changed.template'
import { PASSWORD_RESET_TEMPLATE_KEY } from '@/templates/email/password-reset.template'
import { REGISTRATION_ATTEMPT_TEMPLATE_KEY } from '@/templates/email/registration-attempt.template'
import type { EmailResendOptions } from '@/types/email-context'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { getDummyHash, hashPassword, isPasswordValid } from '@/utilities/password.utilities'
import type {
  ChangePasswordInput,
  LoginInput,
  ReauthenticateInput,
  RegisterInput,
  ResetPasswordInput,
} from '@/validators/auth.validators'

const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()
const tenantRepository = new TenantRepository()

const INVALID_RESET_TOKEN_MESSAGE = 'Invalid or expired reset link.'
const FEDERATED_ONLY_MESSAGE =
  'This account signs in with Google and has no password. Use forgot-password to set one.'
const INCORRECT_PASSWORD_MESSAGE = 'Incorrect password.'
const REAUTH_FEDERATED_MESSAGE =
  'This account signs in with Google and has no password. Set a password to confirm sensitive actions.'

/**
 * A successful login: the user row, a signed access token and a new refresh token.
 */
export interface LoginResult {
  user: User
  accessToken: string
  refreshToken: IssuedRefreshToken
  platformRole: MembershipRole | null
}

/**
 * A successful refresh: a new access token and the rotated refresh token.
 */
export interface RefreshResult {
  accessToken: string
  refreshToken: IssuedRefreshToken
}

/**
 * A user's linked sign-in methods, and whether the account has a password.
 */
export interface AuthProvidersResult {
  providers: AuthProviderRecord[]
  hasPassword: boolean
}

/**
 * Tell the owner of an already-registered address that someone tried to
 * register it. The holder may have been soft-deleted since the insert failed;
 * then the fallback name is used and the job's correlation id is `''`, which
 * email.job.ts uses for logging only, never as a database key.
 * @param email - The address that was submitted.
 */
async function sendRegistrationAttemptMail(email: string): Promise<void> {
  const existing = await userRepository.findByEmail(email)
  await addEmailJob(
    {
      to: email,
      templateKey: REGISTRATION_ATTEMPT_TEMPLATE_KEY,
      variables: {
        // The stored name, never the submitted one: that is attacker-chosen text in the victim's inbox.
        firstName: existing?.firstName ?? MISSING_FIRST_NAME_FALLBACK,
        appName: getEnv().APP_NAME,
      },
    },
    existing?.id ?? '',
    { priority: JobPriority.normal }
  )
}

/**
 * Whether a registration write failed because the address is taken. Both
 * repositories translate a Postgres unique violation into HttpError 409.
 * @param error - The error the registration transaction threw.
 * @returns True for that 409.
 */
function isAddressTaken(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 409
}

/**
 * Register a user with an email and password.
 *
 * A free and a taken address get the same reply; only the mail differs. The
 * user row and its 'email' provider row commit together or not at all.
 * `providerId` is lowercased here as well as by `emailSchema`, so this
 * insert stays correct if that schema changes.
 * @param input - The validated registration body.
 * @returns The follow-up mail, for the controller to start after replying; it never rejects.
 */
export async function register(input: RegisterInput): Promise<() => Promise<void>> {
  const passwordHash = await hashPassword(input.password)

  let created: User | undefined
  try {
    created = await withTransaction(async (tx) => {
      const user = await userRepository.create(
        {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
        },
        tx
      )

      // A soft-deleted account may still hold this address's 'email' row; release it for the new account.
      await authProviderRepository.releaseEmailOfDeletedUsers(input.email.toLowerCase(), tx)

      await authProviderRepository.create(
        { userId: user.id, provider: 'email', providerId: input.email.toLowerCase() },
        tx
      )

      return user
    })
  } catch (error) {
    // Only a 409 (a live account holds the address) becomes the 202; anything else must surface.
    if (!isAddressTaken(error)) throw error
  }

  if (created) {
    const user = created
    return async () => {
      try {
        await sendVerificationMail(user, input.app)
      } catch (error) {
        logger.error('Verification mail failed', { error: redactedForLog(error) })
      }
    }
  }

  return async () => {
    try {
      await sendRegistrationAttemptMail(input.email)
    } catch (error) {
      logger.error('Registration-attempt mail failed', { error: redactedForLog(error) })
    }
  }
}

/**
 * The signed-in user's platform role, for the login response only. A failed
 * read answers null: the credentials passed, and the next /profile corrects it.
 * @param userId - The user who just signed in.
 * @returns Their platform role, or null.
 */
async function platformRoleForLogin(userId: string): Promise<MembershipRole | null> {
  try {
    return await getPlatformMembership(userId)
  } catch (error) {
    logger.warn('Platform role could not be read for the login response', {
      error: redactedForLog(error),
      userId,
    })
    // eslint-disable-next-line unicorn/no-null -- the login user reports JSON null for "not staff"
    return null
  }
}

/**
 * Log in with an email and password.
 *
 * Unknown, wrong-password, inactive and unverified all fail through ONE
 * guard, after ONE bcrypt comparison, with one 401 — a separate early
 * return for any of them would be a timing oracle. The message is literally
 * false for an unverified account with the right password; that is accepted.
 *
 * The token is issued in a transaction that re-reads the user FOR SHARE. A
 * password change or reset still in flight is waited for, and one that
 * committed after the compare answers the same 401, so no session outlives it.
 * A deactivation or soft delete that committed after the first read answers
 * the same 401 there too.
 * @param input - The validated login body.
 * @returns The user, their platform role, an access token and a new refresh token.
 * @throws {HttpError} 401 'Invalid email or password'.
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const user = await userRepository.findByEmail(input.email)
  const hashToCompare = user?.passwordHash ?? (await getDummyHash())
  const isPasswordCorrect = await isPasswordValid(input.password, hashToCompare)

  if (!user || !isPasswordCorrect || !user.active || !user.passwordHash || !user.emailVerifiedAt) {
    throw new HttpError('Invalid email or password', 401)
  }

  // After the guard, so a failed attempt leaves no trace; before tokens, so a failed UPDATE sets no cookie.
  await userRepository.update(user.id, { lastLoggedInAt: new Date() })
  // After the guard, so a failed attempt never reaches it; it never throws.
  await autoJoinSafely(user)

  const comparedHash = user.passwordHash
  const sessionId = randomUUID()
  const refreshToken = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(user.id, 'share', tx)
    // Re-checked under the lock: a deactivation or delete that committed since the first read wins.
    if (!locked?.active || locked.passwordHash !== comparedHash) {
      throw new HttpError('Invalid email or password', 401)
    }
    return issueRefreshToken(user.id, sessionId, tx)
  })
  const accessToken = signAccessToken(user, sessionId, refreshToken.authenticatedAt)
  const platformRole = await platformRoleForLogin(user.id)
  return { user, accessToken, refreshToken, platformRole }
}

/**
 * Rotate a refresh token for a new access/refresh pair, re-checking that
 * the account is still active (as requireAuth does for every bearer request).
 * The access token keeps the session's authentication time: refreshing is not
 * re-authenticating.
 * @param rawToken - The raw refresh token from the cookie.
 * @returns A new access token and the rotated refresh token.
 * @throws {HttpError} 401, from rotation or when the account is gone or inactive.
 */
export async function refresh(rawToken: string): Promise<RefreshResult> {
  const rotated = await rotateRefreshToken(rawToken)
  const user = await userRepository.findById(rotated.userId)
  if (!user || !user.active) {
    throw new HttpError('Account no longer exists or is inactive', 401)
  }
  return {
    accessToken: signAccessToken(user, rotated.sessionId, rotated.authenticatedAt),
    refreshToken: rotated,
  }
}

/**
 * Issue a password-reset token for `user` and queue the reset mail. Rejects
 * when the token or the job cannot be written; callers decide whether that
 * is swallowed (forgot-password) or reported (staff password-setup). The
 * mail's message row records `app` as the frontend its link opens.
 * @param user - The account to reset.
 * @param app - The frontend the reset link opens.
 * @param options - `resentFromId` when a staff resend re-runs this flow for an earlier message.
 * @returns Resolves once the mail job is queued.
 */
export async function sendPasswordResetMail(
  user: User,
  app: FrontendApp,
  options: EmailResendOptions = {}
): Promise<void> {
  const issued = await issueToken(
    user.id,
    'password_reset',
    requireDurationMs(getEnv().PASSWORD_RESET_TTL)
  )

  await addNotificationJob({
    userId: user.id,
    type: 'password_reset_requested',
    title: 'Password reset requested',
    body: `We received a request to reset your ${getEnv().APP_NAME} password.`,
    metadata: { templateKey: PASSWORD_RESET_TEMPLATE_KEY },
    email: {
      to: user.email,
      templateKey: PASSWORD_RESET_TEMPLATE_KEY,
      variables: {
        firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
        resetUrl: buildPasswordResetUrl(issued.raw, frontendUrl(app)),
        appName: getEnv().APP_NAME,
      },
    },
    emailContext: { linkApp: app, ...options },
  })
}

/**
 * Issue a password-reset token and mail the link, but only when `email`
 * belongs to an existing, active account.
 * @param email - The address submitted to `/forgot-password`.
 * @param app - The frontend the reset link opens.
 */
async function sendPasswordResetMailIfRegistered(email: string, app: FrontendApp): Promise<void> {
  const user = await userRepository.findByEmail(email)
  // A deactivated account could not sign in after resetting; the caller's reply is the same either way.
  if (!user?.active) return
  await sendPasswordResetMail(user, app)
}

/**
 * Mail a reset link if the address has an account. The controller replies
 * BEFORE calling this — the lookup itself would otherwise be a timing
 * oracle — so it must never reject.
 * @param email - The address submitted to `/forgot-password`.
 * @param app - The frontend the reset link opens; the customer app by default.
 * @returns Resolves when the work is done or its failure is logged.
 */
export async function requestPasswordReset(email: string, app: FrontendApp = 'web'): Promise<void> {
  try {
    await sendPasswordResetMailIfRegistered(email, app)
  } catch (error) {
    logger.error('Forgot-password mail failed', { error: redactedForLog(error) })
  }
}

/**
 * Reset a password with a token from the mailed link.
 *
 * Any claim failure (unknown, wrong purpose, used, expired) and a deleted
 * account answer the same 400. Every token is revoked first, on its own:
 * a failed write then still leaves no session alive, and every purpose goes,
 * so older reset links die too. The user row is then locked, the hash
 * stored and the tokens revoked again in one transaction. That second revoke
 * catches a session a login or refresh created after the first: either it committed
 * before the lock and is revoked here, or it waited on the lock and sees the
 * new state. Those sessions are denied after commit; if Redis refuses, the
 * reset stands and one error line is logged.
 * @param input - The validated `{ token, password }` body.
 * @returns Resolves once the password is stored.
 * @throws {HttpError} 400 'Invalid or expired reset link.'
 */
export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const claimed = await claimToken(input.token, 'password_reset')
  const user = claimed ? await userRepository.findById(claimed.userId) : undefined
  if (!claimed || !user) {
    throw new HttpError(INVALID_RESET_TOKEN_MESSAGE, 400)
  }

  const passwordHash = await hashPassword(input.password)

  await revokeAllSessions(user.id)

  const revokedSessionIds = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(user.id, 'no key update', tx)
    if (!locked) throw new HttpError(INVALID_RESET_TOKEN_MESSAGE, 400)
    if (!locked.emailVerifiedAt) {
      // A federated link on a never-verified account may be a squatter's; the reset proves the mailbox.
      await authProviderRepository.deleteFederatedForUser(user.id, tx)
    }
    await userRepository.update(user.id, { passwordHash }, {}, tx)
    // A reset proves the mailbox; markEmailVerified never moves an earlier timestamp.
    if (!locked.emailVerifiedAt) await markEmailVerified(user.id, tx)
    return revokeSessionRows(user.id, {}, tx)
  })
  await denySessionsAfterCommit(user.id, revokedSessionIds)
}

/**
 * Change the caller's own password.
 *
 * Order: federated-only guard (before any compare, so a password-less
 * account is not told "wrong password"); verify current; reject a no-op;
 * hash; then one transaction that locks the user row, stores the hash and
 * revokes every OTHER session; then deny those sessions; then notify.
 *
 * The one transaction closes the race with a login: the login either
 * commits first and loses its session here, or waits on the row lock and
 * sees the new hash. A failed store changes nothing. If the denylist write
 * fails after commit, the change stands, one error line is logged, and the
 * revoked sessions' access tokens stay valid for up to ACCESS_TOKEN_TTL.
 *
 * Without a session id (no `sid` claim) every session is revoked, the
 * caller's included — that token cannot be told apart from a stolen one.
 * @param userId - The authenticated caller's id.
 * @param currentSessionId - The session to spare, when the token carried one.
 * @param input - The validated `{ currentPassword, newPassword }` body.
 * @returns Resolves once the password is stored; the notification is not awaited, so a mail failure never fails a change that already committed. The mail carries no secret.
 * @throws {HttpError} 401 when the account is gone; 400 for federated-only, a wrong current password, or no change.
 */
export async function changePassword(
  userId: string,
  currentSessionId: string | undefined,
  input: ChangePasswordInput
): Promise<void> {
  // request.user carries no passwordHash; re-load the real row.
  const user = await userRepository.findById(userId)
  if (!user) {
    throw new HttpError('Account no longer exists or is inactive', 401)
  }

  if (!user.passwordHash) {
    throw new HttpError(FEDERATED_ONLY_MESSAGE, 400)
  }

  const isCurrentPasswordCorrect = await isPasswordValid(input.currentPassword, user.passwordHash)
  if (!isCurrentPasswordCorrect) {
    throw new HttpError('Current password is incorrect.', 400)
  }

  const isSameAsCurrent = await isPasswordValid(input.newPassword, user.passwordHash)
  if (isSameAsCurrent) {
    throw new HttpError('New password must be different from the current password.', 400)
  }

  const passwordHash = await hashPassword(input.newPassword)

  const revokeOptions = currentSessionId ? { exceptSessionId: currentSessionId } : {}
  const revokedSessionIds = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(user.id, 'no key update', tx)
    if (!locked) throw new HttpError('Account no longer exists or is inactive', 401)
    await userRepository.update(user.id, { passwordHash }, {}, tx)
    return revokeSessionRows(user.id, revokeOptions, tx)
  })
  await denySessionsAfterCommit(user.id, revokedSessionIds)

  const notificationJob = addNotificationJob({
    userId: user.id,
    type: 'password_changed',
    title: 'Password changed',
    body: `Your ${getEnv().APP_NAME} password was changed.`,
    metadata: { templateKey: PASSWORD_CHANGED_TEMPLATE_KEY },
    email: {
      to: user.email,
      templateKey: PASSWORD_CHANGED_TEMPLATE_KEY,
      variables: {
        firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
        appName: getEnv().APP_NAME,
      },
    },
  })
  // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget: the mail must not block the response, and the change has already been committed regardless of whether it sends
  notificationJob.catch((error: unknown) => {
    logger.error('Password-changed mail failed', { error })
  })
}

/**
 * Which methods can sign an account in, and whether it has a password.
 *
 * `hasPassword` is not derivable from the rows: a Google signup also writes
 * an 'email' row, so that row is present for accounts that cannot log in
 * with a password.
 * @param userId - The authenticated caller's id.
 * @returns The provider rows (unordered) and whether a password is set.
 * @throws {HttpError} 404 'User not found'.
 */
export async function getAuthProviders(userId: string): Promise<AuthProvidersResult> {
  const user = await userRepository.findById(userId)
  if (!user) {
    throw new HttpError('User not found', 404)
  }

  const providers = await authProviderRepository.findByUser(userId)
  return { providers, hasPassword: user.passwordHash !== null }
}

/**
 * A confirmed step-up: a new access token for the same session.
 */
export interface ReauthenticateResult {
  accessToken: string
}

/**
 * Audit one step-up attempt in the platform tenant: `POST
 * /auth/reauthenticate` admits staff only, so the actor is a member there.
 * @param userId - The staff member, actor and target both.
 * @param outcome - Whether the identity was confirmed.
 * @param tx - The transaction to write in.
 * @throws {HttpError} 500 when the platform tenant is missing.
 */
async function recordReauthentication(
  userId: string,
  outcome: 'success' | 'failure',
  tx: DbTransaction
): Promise<void> {
  const platform = await tenantRepository.findPlatformTenant(tx)
  if (!platform) throw new HttpError('The platform tenant is missing', 500)
  await record(
    {
      action: 'auth.reauthenticated',
      actor: { userId },
      access: 'member',
      tenantId: platform.id,
      targetId: userId,
      metadata: { outcome },
    },
    tx
  )
}

/**
 * Confirm a signed-in staff member's identity again with their password, for
 * step-up (`requireRecentAuth`): move the session's `authenticated_at` to now
 * and sign a new access token carrying it. The refresh token is untouched,
 * since the session is the same.
 *
 * A wrong password is a 400, never a 401: every client signs out on a
 * non-expiry 401 that carried a token, and a mistyped password must not end
 * the session. A success and a wrong password are audited
 * (`auth.reauthenticated`): a success in the transaction that moves the
 * time, a wrong password in a transaction of its own, since the refusal
 * writes nothing else. A token without a session, an account gone or
 * inactive, a passwordless account and a rate-limited attempt are refused
 * before any audit write. A correct password on a session that ended is
 * refused by `markSessionReauthenticated` before the success entry is
 * written, so it leaves none.
 * @param userId - The authenticated caller.
 * @param sessionId - The caller's session (the token's `sid`); undefined for a token without one.
 * @param input - The validated `{ password }` body.
 * @returns A new access token for the same session.
 * @throws {HttpError} 401 with ACCESS_TOKEN_EXPIRED_CODE for a token without `sid`, an account gone or inactive, or a session that has ended; 400 for a passwordless account or a wrong password.
 */
export async function reauthenticate(
  userId: string,
  sessionId: string | undefined,
  input: ReauthenticateInput
): Promise<ReauthenticateResult> {
  if (sessionId === undefined) {
    throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
  }
  const user = await userRepository.findById(userId)
  if (!user || !user.active) {
    throw new HttpError('Account no longer exists or is inactive', 401, ACCESS_TOKEN_EXPIRED_CODE)
  }
  if (!user.passwordHash) {
    throw new HttpError(REAUTH_FEDERATED_MESSAGE, 400)
  }
  if (!(await isPasswordValid(input.password, user.passwordHash))) {
    await withTransaction((tx) => recordReauthentication(userId, 'failure', tx))
    throw new HttpError(INCORRECT_PASSWORD_MESSAGE, 400)
  }

  const authenticatedAt = await withTransaction(async (tx) => {
    const at = await markSessionReauthenticated(userId, sessionId, tx)
    await recordReauthentication(userId, 'success', tx)
    return at
  })
  return { accessToken: signAccessToken(user, sessionId, authenticatedAt) }
}
