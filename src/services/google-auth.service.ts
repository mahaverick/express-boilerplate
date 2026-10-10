/**
 * @file The account-linking policy for Google Sign-In: from the raw profile
 * passport.config.ts hands over, decide between a returning user, a link to an
 * existing account, a new account, or a rejection.
 */
import { randomUUID } from 'node:crypto'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { withTransaction } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { assertSignInAllowed } from '@/services/maintenance-mode/maintenance-mode.service'
import { autoJoinSafely } from '@/services/platform.service'
import {
  denySessionsAfterCommit,
  issueRefreshToken,
  revokeAllSessions,
  revokeSessionRows,
  type IssuedRefreshToken,
} from '@/services/session.service'
import { markEmailVerified } from '@/services/verification.service'

const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()

/**
 * The primary email a Google profile carries, lowercased, and whether Google
 * itself verified it. `emails` may be absent (a Workspace admin can restrict
 * it), and verification is read from both `emails[0].verified` and
 * `_json.email_verified`, OR'd, rather than trusting either alone.
 * @param profile - The raw Google profile.
 * @returns The lowercased email and Google's verification claim for it.
 * @throws {HttpError} 400 `google_email_missing`, when the profile carries no email.
 */
function verifiedGoogleEmail(profile: GoogleProfile): { email: string; isVerified: boolean } {
  const primary = profile.emails?.[0]
  if (!primary?.value) {
    throw new HttpError('Google did not share an email address', 400, 'google_email_missing')
  }
  const isVerified = primary.verified || profile._json.email_verified === true
  return { email: primary.value.toLowerCase(), isVerified }
}

/**
 * Link a Google identity to an existing user, treating a lost insert race
 * (a double-submitted callback for the same Google account, hence the same
 * user) as already linked.
 * @param userId - The user to link the identity to.
 * @param googleId - Google's stable profile id (`profile.id`).
 */
async function linkGoogleProvider(userId: string, googleId: string): Promise<void> {
  try {
    await authProviderRepository.create({ userId, provider: 'google', providerId: googleId })
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return
    throw error
  }
}

/**
 * A verified Google identity takes over a never-verified account: a
 * squatter's password and any OTHER Google link are removed, the email is
 * marked verified, and every session revoked.
 *
 * Sessions are revoked first on their own, so a failed write leaves no
 * squatter session alive, then again in the claim's transaction, under the
 * user row lock: a refresh rotation in flight either commits before the lock
 * and is revoked there, or waits and finds its token revoked.
 * @param userId - The unverified account's id.
 * @param googleId - Google's stable profile id of the claiming identity.
 * @returns The account, now verified, federated-only and linked.
 * @throws {HttpError} 500 when the account vanished mid-claim.
 */
export async function claimUnverifiedAccount(userId: string, googleId: string): Promise<User> {
  await revokeAllSessions(userId)

  const { claimed, revokedSessionIds } = await withTransaction(async (tx) => {
    await userRepository.lockById(userId, 'no key update', tx)

    // Cleared first, or resolveGoogleUser's first lookup would still resolve that other Google id here.
    await authProviderRepository.deleteGoogleLinksExcept(userId, googleId, tx)
    await authProviderRepository.createIfAbsent(
      { userId, provider: 'google', providerId: googleId },
      tx
    )

    // The claiming identity is Google-verified, which proves the mailbox.
    await markEmailVerified(userId, tx)

    // eslint-disable-next-line unicorn/no-null -- a null hash is the federated-only state (user.model.ts)
    const updated = await userRepository.update(userId, { passwordHash: null }, {}, tx)
    if (!updated) throw new HttpError('Update returned no row', 500)
    return { claimed: updated, revokedSessionIds: await revokeSessionRows(userId, {}, tx) }
  })
  await denySessionsAfterCommit(userId, revokedSessionIds)
  return claimed
}

/**
 * The user a Google Sign-In resolves to, and whether this sign-in created it.
 */
interface ResolvedGoogleUser {
  user: User
  isNew: boolean
}

/**
 * Resolve the user a Google Sign-In resolves to, linking or creating one
 * when needed.
 *
 * 1. `(google, profile.id)` first: the OIDC `sub` never changes, so a
 *    returning user stays correct whatever happened to their inbox.
 * 2. An email match is accepted only when Google verified the address;
 *    otherwise anyone adding `victim@example.com` to a Google account could
 *    sign in as its owner.
 * 3. A never-verified match is taken over (`claimUnverifiedAccount`); a
 *    verified one is linked untouched.
 * 4. A new account gets its 'email' and 'google' rows in one transaction.
 * @param profile - The raw Google profile.
 * @returns The existing, newly linked, or newly created user, and whether it is new.
 * @throws {HttpError} 400 `google_email_missing`, 401 `google_auth_failed` (linked user deleted), 403 `email_not_verified`, or a database error.
 */
async function resolveGoogleUser(profile: GoogleProfile): Promise<ResolvedGoogleUser> {
  const existingLink = await authProviderRepository.findByProviderAndId('google', profile.id)
  if (existingLink) {
    const user = await userRepository.findById(existingLink.userId)
    if (!user) {
      // Reachable: deletes are soft, so a deleted user keeps their provider rows.
      throw new HttpError(
        'This Google account is no longer linked to an active user',
        401,
        'google_auth_failed'
      )
    }
    return { user, isNew: false }
  }

  const { email, isVerified } = verifiedGoogleEmail(profile)
  const existingUser = await userRepository.findByEmail(email)

  if (existingUser) {
    if (!isVerified) {
      throw new HttpError(
        'This email is registered, but Google has not verified this address',
        403,
        'email_not_verified'
      )
    }

    if (existingUser.emailVerifiedAt === null) {
      return { user: await claimUnverifiedAccount(existingUser.id, profile.id), isNew: false }
    }

    await linkGoogleProvider(existingUser.id, profile.id)
    return { user: existingUser, isNew: false }
  }

  // An unverified Google email must not create an account: anyone can add any address to a Google account.
  if (!isVerified) {
    throw new HttpError('Google has not verified this email address', 403, 'email_not_verified')
  }

  const created = await withTransaction(async (tx) => {
    const createdUser = await userRepository.create(
      {
        email,
        // eslint-disable-next-line unicorn/no-null -- passwordHash is nullable specifically for a federated-only user (user.model.ts) — this account IS that case
        passwordHash: null,
      },
      tx
    )

    await authProviderRepository.releaseEmailOfDeletedUsers(email, tx)

    await authProviderRepository.create(
      { userId: createdUser.id, provider: 'email', providerId: email },
      tx
    )
    await authProviderRepository.create(
      { userId: createdUser.id, provider: 'google', providerId: profile.id },
      tx
    )

    await markEmailVerified(createdUser.id, tx)
    const verified = await userRepository.findById(createdUser.id, {}, tx)
    if (!verified) throw new HttpError('Created user not found', 500)
    return verified
  })
  return { user: created, isNew: true }
}

/**
 * Complete a Google Sign-In: resolve the user, refuse an inactive one, stamp
 * `lastLoggedInAt`, and issue a refresh token for a fresh session.
 * An address on PLATFORM_EMAIL_DOMAINS joins the platform tenant as viewer if it has not already.
 *
 * The active check runs first and again under the user-row lock before the
 * session is issued, so a deactivated account never gets a `user_tokens` row
 * or a success redirect, even when the deactivation races the sign-in. Once
 * the session is issued, a sign-in that created the account emits
 * `user_signed_up`, and every one emits `user_signed_in`.
 * @param profile - The raw Google profile from the callback.
 * @returns The new session's refresh token, for the controller to set as a cookie.
 * In `full` maintenance a user with no platform role is refused after the
 * active check (`assertSignInAllowed`); the controller redirects with
 * `error=MAINTENANCE_MODE`. A new account is still created first, as the
 * lookup does before any refusal.
 * @throws {HttpError} Any `resolveGoogleUser` error, 401 `google_auth_failed` for an inactive or deleted account, or 503 `MAINTENANCE_MODE`.
 */
export async function completeGoogleSignIn(profile: GoogleProfile): Promise<IssuedRefreshToken> {
  const { user, isNew } = await resolveGoogleUser(profile)

  if (!user.active) {
    throw new HttpError('Account is inactive', 401, 'google_auth_failed')
  }
  // Before any sign-in write: in `full` only staff get a session.
  await assertSignInAllowed(user.id)

  await userRepository.update(user.id, { lastLoggedInAt: new Date() })
  // Covers users verified before their domain was listed; it never throws.
  await autoJoinSafely(user)

  const issued = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(user.id, 'share', tx)
    // Re-checked under the lock, as login does: a deactivation that committed since the lookup wins.
    if (!locked?.active) throw new HttpError('Account is inactive', 401, 'google_auth_failed')
    return issueRefreshToken(user.id, randomUUID(), tx)
  })
  if (isNew) {
    await emitDomainEvent({
      type: 'user_signed_up',
      userId: user.id,
      method: 'google',
      at: user.createdAt,
    })
  }
  await emitDomainEvent({
    type: 'user_signed_in',
    userId: user.id,
    method: 'google',
    at: new Date(),
  })
  return issued
}
