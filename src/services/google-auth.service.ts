/**
 * @file The account-linking policy for Google Sign-In: from the raw profile
 * passport.config.ts hands over, decide between a returning user, a link to an
 * existing account, a new account, or a rejection. On Apex, Google signs in
 * only an existing, active staff account and never creates one.
 */
import { randomUUID } from 'node:crypto'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { claimNeverVerifiedAccount, isClaimedAccountGone } from '@/services/account-claim.service'
import { withTransaction } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { getMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { assertSignInAllowed } from '@/services/maintenance-mode/maintenance-mode.service'
import { getPlatformMembership } from '@/services/platform.service'
import { issueRefreshToken, type IssuedRefreshToken } from '@/services/session.service'
import { markEmailVerified } from '@/services/verification.service'

const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()

/**
 * The one answer for a Google sign-in that reaches no account it may sign
 * in: the callback redirects with its code, `google_auth_failed`.
 * @param message - What went wrong, for the log only.
 * @returns A 401 `google_auth_failed`.
 */
function googleAuthFailed(message: string): HttpError {
  return new HttpError(message, 401, 'google_auth_failed')
}

/**
 * The primary email a Google profile carries, lowercased, and whether Google
 * reports it verified. `emails` is absent when Google returned no email
 * claim. The address counts as verified when `emails[0].verified` or
 * `_json.email_verified` is true; passport-google-oauth20's userinfo parser
 * fills both from the same `email_verified` claim.
 * @param profile - The raw Google profile.
 * @returns The lowercased email and whether Google reports it verified, or undefined when the profile carries no email.
 */
function googleEmailClaim(
  profile: GoogleProfile
): { email: string; isVerified: boolean } | undefined {
  const primary = profile.emails?.[0]
  if (!primary?.value) return undefined
  const isVerified = primary.verified || profile._json.email_verified === true
  return { email: primary.value.toLowerCase(), isVerified }
}

/**
 * `googleEmailClaim`, refusing a profile that carries no email.
 * @param profile - The raw Google profile.
 * @returns The lowercased email and whether Google reports it verified.
 * @throws {HttpError} 400 `google_email_missing`, when the profile carries no email.
 */
function verifiedGoogleEmail(profile: GoogleProfile): { email: string; isVerified: boolean } {
  const claim = googleEmailClaim(profile)
  if (!claim) {
    throw new HttpError(
      "Google didn't share your email address. Sign in with an emailed link instead.",
      400,
      'google_email_missing'
    )
  }
  return claim
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
 * A verified Google identity takes over a never-verified account
 * (`claimNeverVerifiedAccount`): inside its locked transaction, any OTHER
 * Google link is removed and this identity is linked; the email is then
 * marked verified and every session revoked.
 *
 * Precondition: the caller has checked that Google verified the profile's
 * email, that it matches this account's address, and that the account's email
 * was never verified (checked before the lock). Nothing here checks any of it.
 * @param userId - The unverified account's id.
 * @param googleId - Google's stable profile id of the claiming identity.
 * @returns The account, now verified and linked.
 * @throws {HttpError} 500 when the account vanished mid-claim.
 */
function claimUnverifiedAccount(userId: string, googleId: string): Promise<User> {
  return claimNeverVerifiedAccount(userId, async (tx) => {
    // Cleared first, or resolveGoogleUser's first lookup would still resolve that other Google id here.
    await authProviderRepository.deleteGoogleLinksExcept(userId, googleId, tx)
    await authProviderRepository.createIfAbsent(
      { userId, provider: 'google', providerId: googleId },
      tx
    )
  })
}

/**
 * The user a Google Sign-In resolves to, and whether this sign-in created it.
 */
interface ResolvedGoogleUser {
  user: User
  isNew: boolean
}

/**
 * The account this profile could sign in to, found without writing anything:
 * the same lookups `resolveGoogleUser` makes, in the same order (the Google
 * link, then the profile's primary email), so both find the same account.
 * An email Google has not verified reaches no account here, as it reaches
 * none in `resolveGoogleUser`; matching it would let anyone who adds an
 * address to a Google account learn whether its owner is staff.
 * @param profile - The raw Google profile.
 * @returns The linked account, or the account a verified email matches, or undefined.
 */
async function findReachableGoogleUser(profile: GoogleProfile): Promise<User | undefined> {
  const link = await authProviderRepository.findByProviderAndId('google', profile.id)
  if (link) return userRepository.findById(link.userId)
  const claim = googleEmailClaim(profile)
  return claim?.isVerified ? userRepository.findByEmail(claim.email) : undefined
}

/**
 * Resolve the user a Google Sign-In resolves to, linking one when needed and
 * creating one when `allowCreate` says so.
 *
 * 1. `(google, profile.id)` first: the OIDC `sub` is a stable account id, so
 *    a returning user stays correct whatever happened to their inbox.
 * 2. An email Google has not verified is refused before it is looked up,
 *    with one 403 whether or not it is registered: otherwise anyone adding
 *    `victim@example.com` to a Google account could sign in as its owner,
 *    or learn whether the address has an account.
 * 3. A never-verified match is taken over (`claimUnverifiedAccount`); a
 *    verified one is linked untouched. An account deleted during the claim
 *    is the generic `google_auth_failed`, never the claim's 500.
 * 4. With `allowCreate`, a new account gets its 'email' and 'google' rows in
 *    one transaction; without it, an address with no account is the generic
 *    `google_auth_failed`.
 * @param profile - The raw Google profile.
 * @param options - Whether an address with no account gets one.
 * @param options.allowCreate - True to create an account for an unknown verified address.
 * @returns The existing, newly linked, or newly created user, and whether it is new.
 * @throws {HttpError} 400 `google_email_missing`, 401 `google_auth_failed` (linked user deleted, account gone mid-claim, or no account and no creation), 403 `email_not_verified`, 500 when a row it just wrote cannot be read back, or a database error.
 */
async function resolveGoogleUser(
  profile: GoogleProfile,
  options: { allowCreate: boolean }
): Promise<ResolvedGoogleUser> {
  const existingLink = await authProviderRepository.findByProviderAndId('google', profile.id)
  if (existingLink) {
    const user = await userRepository.findById(existingLink.userId)
    if (!user) {
      // Reachable: deletes are soft, so a deleted user keeps their provider rows.
      throw googleAuthFailed('This Google account is no longer linked to an active user')
    }
    return { user, isNew: false }
  }

  const { email, isVerified } = verifiedGoogleEmail(profile)
  // Before the email lookup, so a registered and an unknown address get one answer at one cost (step 2 above).
  if (!isVerified) {
    throw new HttpError(
      "Google hasn't verified this email address. Sign in with an emailed link instead.",
      403,
      'email_not_verified'
    )
  }
  const existingUser = await userRepository.findByEmail(email)

  if (existingUser) {
    if (existingUser.emailVerifiedAt === null) {
      return { user: await claimForGoogle(existingUser.id, profile.id), isNew: false }
    }

    await linkGoogleProvider(existingUser.id, profile.id)
    return { user: existingUser, isNew: false }
  }

  if (!options.allowCreate) throw googleAuthFailed('No account uses this Google address')

  const created = await withTransaction(async (tx) => {
    const createdUser = await userRepository.create({ email }, tx)

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
 * `claimUnverifiedAccount`, with an account deleted since the lookup read as
 * the generic `google_auth_failed`, as a link claim reads it as its own
 * invalid link. A deactivated one comes back inactive, and the caller's
 * active check refuses it.
 * @param userId - The never-verified account.
 * @param googleId - Google's stable profile id of the claiming identity.
 * @returns The claimed account.
 * @throws {HttpError} 401 `google_auth_failed` when the account is gone.
 */
async function claimForGoogle(userId: string, googleId: string): Promise<User> {
  try {
    return await claimUnverifiedAccount(userId, googleId)
  } catch (error) {
    if (isClaimedAccountGone(error)) throw googleAuthFailed('The claimed account is gone')
    throw error
  }
}

/**
 * The account an Apex Google sign-in reaches, refused unless it is an
 * existing, active staff account, before anything is written: a profile that
 * reaches no account, an inactive one, or one with no platform role all get
 * the one `google_auth_failed`, so Apex never creates, links or claims for
 * them and says nothing about which it was.
 * @param profile - The raw Google profile.
 * @throws {HttpError} 401 `google_auth_failed`.
 */
async function assertApexStaff(profile: GoogleProfile): Promise<void> {
  const reachable = await findReachableGoogleUser(profile)
  if (!reachable?.active || (await getPlatformMembership(reachable.id)) === null) {
    throw googleAuthFailed('Apex Google sign-in reached no active staff account')
  }
}

/**
 * A completed Google Sign-In: the new session's refresh token, for the
 * controller to set as a cookie, and whether this sign-in created the account.
 */
export interface GoogleSignIn {
  refreshToken: IssuedRefreshToken
  isNewUser: boolean
}

/**
 * Complete a Google Sign-In: resolve the user, refuse an inactive one, stamp
 * `lastLoggedInAt`, and issue a refresh token for a fresh session.
 *
 * On Apex, in every mode, the profile must first reach an existing, active
 * staff account (`assertApexStaff`, a read-only lookup), and resolving it
 * never creates one: an unknown, a customer, an inactive or an unverified
 * profile all get `google_auth_failed` and no session. On web an unknown
 * verified address gets a new account.
 *
 * The active check runs again under the user-row lock before the session is
 * issued, so a deactivation or deletion that committed before the lock is
 * taken gets no session; one that commits later waits for that lock and
 * revokes the session just issued (`deactivateUser`). Once the session is
 * issued, a sign-in that created the account emits `user_signed_up`, and
 * every one emits `user_signed_in`.
 *
 * In `full` maintenance a user with no platform role is refused before
 * anything is written: `assertSignInAllowed` runs on a read-only lookup
 * (`findReachableGoogleUser`), ahead of `resolveGoogleUser`. A profile that
 * reaches no account (none matches, or Google has not verified the address)
 * is refused the same way, so none is created, linked or claimed, and every
 * refused caller gets the same 503, ahead of any 400 or 403
 * `resolveGoogleUser` would give. The controller redirects with
 * `error=MAINTENANCE_MODE`. In any other mode that lookup is skipped on web:
 * that check would allow the sign-in without reading it.
 * @param profile - The raw Google profile from the callback.
 * @param app - The frontend the sign-in started from.
 * @returns The new session's refresh token and whether the account is new.
 * @throws {HttpError} 401 `google_auth_failed` on Apex for anything but an active staff account; 503 `MAINTENANCE_MODE` in `full` unless the account is staff (checked before `resolveGoogleUser` and again after it); any `resolveGoogleUser` error; 401 `google_auth_failed` for an inactive or deleted account.
 */
export async function completeGoogleSignIn(
  profile: GoogleProfile,
  app: FrontendApp
): Promise<GoogleSignIn> {
  if (app === 'apex') {
    await assertApexStaff(profile)
  } else if (getMaintenanceMode().mode === 'full') {
    // Before any write: in `full` only staff get a session, and a profile that reaches no account cannot be staff.
    const reachable = await findReachableGoogleUser(profile)
    await assertSignInAllowed(reachable?.id)
  }

  const { user, isNew } = await resolveGoogleUser(profile, { allowCreate: app !== 'apex' })

  if (!user.active) throw googleAuthFailed('Account is inactive')
  // Again on the resolved account: the mode, or the account a lookup finds, can change between the two checks.
  await assertSignInAllowed(user.id)
  // Again on Apex: the role the first check read may have been revoked since.
  if (app === 'apex' && (await getPlatformMembership(user.id)) === null) {
    throw googleAuthFailed('Apex Google sign-in reached no staff account')
  }

  await userRepository.update(user.id, { lastLoggedInAt: new Date() })

  const refreshToken = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(user.id, 'share', tx)
    // Re-checked under the lock, as a link verify does: a deactivation that committed since the lookup wins.
    if (!locked?.active) throw googleAuthFailed('Account is inactive')
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
  return { refreshToken, isNewUser: isNew }
}
