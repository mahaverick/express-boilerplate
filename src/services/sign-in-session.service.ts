/**
 * @file The session every sign-in method ends with: stamp the last login,
 * re-check the account under a lock, issue the refresh and access tokens and
 * read the platform role. A link and a passkey both finish here, so a change
 * to how a session is issued is made once.
 */
import { randomUUID } from 'node:crypto'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { platformRoleForLogin } from '@/services/auth.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import {
  issueRefreshToken,
  signAccessToken,
  type IssuedRefreshToken,
} from '@/services/session.service'

const userRepository = new UserRepository()

/**
 * A new session: its tokens and the user's platform role.
 */
export interface IssuedSignInSession {
  accessToken: string
  refreshToken: IssuedRefreshToken
  platformRole: MembershipRole | null
}

/**
 * Issue the session for an account that passed every sign-in check. The last
 * login is stamped first, so a failed UPDATE sets no cookie; then one
 * transaction re-reads the user FOR SHARE, so a deactivation or soft delete
 * that committed since the lookup wins and one that commits later waits and
 * revokes the session.
 * @param user - The account to sign in.
 * @param refuse - Builds the error thrown when the account is inactive or gone under the lock, or when `canSignInUnderLock` returns false.
 * @param canSignInUnderLock - An extra check or write the sign-in needs under the same lock; false refuses the sign-in and rolls back.
 * @returns The tokens and the platform role.
 * @throws {Error} What `refuse` builds.
 */
export async function issueSignInSession(
  user: User,
  refuse: () => Error,
  canSignInUnderLock?: (locked: User, tx: DbTransaction) => Promise<boolean>
): Promise<IssuedSignInSession> {
  await userRepository.update(user.id, { lastLoggedInAt: new Date() })

  const sessionId = randomUUID()
  const refreshToken = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(user.id, 'share', tx)
    if (!locked?.active) throw refuse()
    if (canSignInUnderLock && !(await canSignInUnderLock(locked, tx))) throw refuse()
    return issueRefreshToken(user.id, sessionId, tx)
  })
  const accessToken = signAccessToken(user, sessionId, refreshToken.authenticatedAt)
  const platformRole = await platformRoleForLogin(user.id)
  return { accessToken, refreshToken, platformRole }
}
