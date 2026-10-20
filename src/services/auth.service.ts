/**
 * @file The session pieces every sign-in shares: the platform role a sign-in
 * response reports, the refresh rotation, and the caller's linked sign-in
 * methods. Signing in itself is by an emailed link (sign-in-link.service.ts),
 * an invitation link (tenant-invitation.service.ts) or Google
 * (google-auth.service.ts).
 */
import type { MembershipRole } from '@/constants/tenant.constants'
import type { AuthProviderRecord } from '@/database/models/auth-provider.model'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { redactedForLog } from '@/errors/postgres-errors'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { logger } from '@/services/logger.service'
import { getPlatformMembership } from '@/services/platform.service'
import {
  rotateRefreshToken,
  signAccessToken,
  type IssuedRefreshToken,
} from '@/services/session.service'

const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()

/**
 * A successful refresh: a new access token and the rotated refresh token.
 */
export interface RefreshResult {
  accessToken: string
  refreshToken: IssuedRefreshToken
}

/**
 * The signed-in user's platform role, for a sign-in response only (a
 * sign-in link or an invitation link). A failed read answers null: the
 * sign-in passed, and the next /profile corrects it.
 * @param userId - The user who just signed in.
 * @returns Their platform role, or null.
 */
export async function platformRoleForLogin(userId: string): Promise<MembershipRole | null> {
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
 * Which methods can sign an account in.
 * @param userId - The authenticated caller's id.
 * @returns The provider rows (unordered).
 * @throws {HttpError} 404 `user_not_found`.
 */
export async function getAuthProviders(userId: string): Promise<AuthProviderRecord[]> {
  const user = await userRepository.findById(userId)
  if (!user) {
    throw notFoundError('ownAccount')
  }

  return authProviderRepository.findByUser(userId)
}
