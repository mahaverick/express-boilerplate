/**
 * @file The two account writes a proven mailbox makes: creating a verified
 * account for an address that has none (`createLinkedAccount`), and taking
 * over a never-verified account that holds the address
 * (`claimNeverVerifiedAccount`), which a sign-in link, an invitation link and
 * a verified Google identity all do. A link's claim also clears the
 * squatter's credentials (`clearSquatterCredentials`). `markEmailVerified`
 * stays the only writer of `email_verified_at`.
 */
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { denySessionsAfterCommit, revokeSessionRows } from '@/services/session.service'
import { markEmailVerified } from '@/services/verification.service'

const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()

/**
 * The 500 a claim answers when the account it locks is gone (deleted since
 * the caller's lookup). A link verify maps it to its own generic invalid
 * answer (`isClaimedAccountGone`); every other caller sees the plain 500.
 */
class ClaimedAccountGoneError extends HttpError {
  /**
   * The 500 with the claim's fixed message.
   */
  constructor() {
    super('Claimed user not found', 500)
  }
}

/**
 * Whether a claim failed because the account it was claiming is gone.
 * @param error - The error `claimNeverVerifiedAccount` threw.
 * @returns True for `ClaimedAccountGoneError`.
 */
export function isClaimedAccountGone(error: unknown): boolean {
  return error instanceof ClaimedAccountGoneError
}

/**
 * Create a verified account for an address whose mailbox was just proven:
 * the user row, the release of the address's `email` row from any
 * soft-deleted account, the new account's `email` row, and the
 * verification, in the caller's transaction. No password, no name. The
 * caller emits `email_verified` once its transaction commits.
 * @param email - The address, stored lowercased.
 * @param tx - The creating transaction.
 * @returns The new account, verified.
 * @throws {HttpError} 409 when a live account holds the address (the users unique index, through `BaseRepository.create`); 500 when the new row cannot be verified.
 */
export async function createLinkedAccount(email: string, tx: DbTransaction): Promise<User> {
  const address = email.toLowerCase()
  const user = await userRepository.create(
    {
      email: address,
      // eslint-disable-next-line unicorn/no-null -- an account a link created has no password (user.model.ts)
      passwordHash: null,
    },
    tx
  )
  // A soft-deleted account may still hold this address's 'email' row; release it for the new account.
  await authProviderRepository.releaseEmailOfDeletedUsers(address, tx)
  await authProviderRepository.create(
    { userId: user.id, provider: 'email', providerId: address },
    tx
  )
  const verified = await markEmailVerified(user.id, tx)
  if (!verified) throw new HttpError('Created user could not be verified', 500)
  return verified
}

/**
 * Whether a write failed because a live account holds the address:
 * `BaseRepository.create` translates the users unique violation into 409,
 * which `createLinkedAccount` passes on.
 * @param error - The error the creating transaction threw.
 * @returns True for that 409.
 */
export function isAddressTaken(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 409
}

/**
 * A proven mailbox takes over the never-verified account that holds its
 * address: whatever `inLock` writes (the caller's clean-up of a squatter's
 * credentials, and its own link), the verification, and every session
 * revoked.
 *
 * Precondition: the caller has proven the mailbox and checked, before any
 * lock, that the account's email was never verified. Each transaction below
 * re-reads the row under the lock and stops when it is verified by then (a
 * concurrent claim won): that account belongs to the mailbox owner, so it
 * is returned as it is, with nothing revoked, written or emitted.
 *
 * Sessions are revoked first, in a committed transaction of their own under
 * the user row lock (as `revokeAllSessions` does), so every refresh token
 * that existed, and the successor of a rotation that was in flight, is
 * already revoked if the claim fails. The claim's transaction locks the user
 * row, runs `inLock`, verifies and revokes again under the same lock: a session
 * created between the two either commits before the lock and is revoked
 * there, or waits and finds its token revoked. The revoked sessions' access
 * tokens are denied after the commit, best effort
 * (`denySessionsAfterCommit`), so they can stay valid for up to
 * `ACCESS_TOKEN_TTL` when Redis refuses. `email_verified` is emitted after
 * the commit when this call's write verified the row.
 * @param userId - The never-verified account's id.
 * @param inLock - Writes to make in the claim's transaction, after the lock and before the verification.
 * @returns The account as the claim's transaction left it.
 * @throws {HttpError} 500 when the account vanished mid-claim (`isClaimedAccountGone`).
 */
export async function claimNeverVerifiedAccount(
  userId: string,
  inLock?: (tx: DbTransaction) => Promise<void>
): Promise<User> {
  const firstPass = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(userId, 'no key update', tx)
    if (!locked) throw new ClaimedAccountGoneError()
    if (locked.emailVerifiedAt !== null) return { verified: locked }
    return { sessionIds: await revokeSessionRows(userId, {}, tx) }
  })
  if ('verified' in firstPass) return firstPass.verified
  await denySessionsAfterCommit(userId, firstPass.sessionIds)

  const { claimed, verifiedNow, revokedSessionIds } = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(userId, 'no key update', tx)
    if (!locked) throw new ClaimedAccountGoneError()
    if (locked.emailVerifiedAt !== null) {
      return { claimed: locked, verifiedNow: false, revokedSessionIds: [] }
    }
    await inLock?.(tx)
    const verified = await markEmailVerified(userId, tx)
    const sessionIds = await revokeSessionRows(userId, {}, tx)
    const row = await userRepository.findById(userId, {}, tx)
    if (!row) throw new ClaimedAccountGoneError()
    return { claimed: row, verifiedNow: verified !== undefined, revokedSessionIds: sessionIds }
  })
  await denySessionsAfterCommit(userId, revokedSessionIds)
  if (verifiedNow) {
    await emitDomainEvent({ type: 'email_verified', userId, at: new Date() })
  }
  return claimed
}

/**
 * The writes a link makes on a never-verified account it claims, in the
 * claim's locked transaction: a squatter who registered the address first
 * loses their password and any federated link, since the click proves the
 * mailbox is someone else's.
 * @param userId - The never-verified account.
 * @returns The callback for `claimNeverVerifiedAccount`.
 */
export function clearSquatterCredentials(userId: string): (tx: DbTransaction) => Promise<void> {
  return async (tx) => {
    await authProviderRepository.deleteFederatedForUser(userId, tx)
    // eslint-disable-next-line unicorn/no-null -- a null hash is the password-less state (user.model.ts)
    await userRepository.update(userId, { passwordHash: null }, {}, tx)
  }
}
