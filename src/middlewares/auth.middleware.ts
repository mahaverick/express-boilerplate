/**
 * @file `requireAuth`, the gate every protected route sits behind, and
 * `requireRecentAuth`, the step-up gate a destructive route adds after it.
 * Later middleware (`resolveTenant`) composes after it by reading `request.user`.
 */
import { type NextFunction, type Request, type Response } from 'express'
import {
  ACCESS_TOKEN_EXPIRED_CODE,
  REAUTH_REQUIRED_CODE,
  STEP_UP_MAX_AGE_MS,
} from '@/constants/auth.constants'
import { HttpError } from '@/errors/http-error'
import { toAuthenticatedUser, type AuthenticatedUser } from '@/presenters/user.presenter'
import { UserRepository } from '@/repositories/user.repository'
import { requestContextStore } from '@/services/request-context.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { verifyAccessToken } from '@/services/session.service'
import { isRecentAuth } from '@/utilities/recent-auth.utilities'

const userRepository = new UserRepository()

/**
 * RFC 6750 `Authorization: Bearer <token>`. `\S+` rejects a header that is
 * only the scheme and whitespace, with no backtracking risk from `.+` beside
 * `\s+`.
 */
const BEARER_PATTERN = /^Bearer\s+(\S+)$/

/**
 * Read the bearer token out of the Authorization header.
 * @param request - The incoming request.
 * @returns The raw token.
 * @throws {HttpError} 401, when the header is missing or is not a well-formed `Bearer <token>` value.
 */
function getBearerToken(request: Request): string {
  const match = BEARER_PATTERN.exec(request.get('Authorization') ?? '')
  const token = match?.[1]
  if (!token) {
    throw new HttpError('Missing or malformed Authorization header', 401)
  }
  return token
}

/**
 * Verify a bearer token and return its payload, translating
 * `verifyAccessToken`'s discriminated result into the client-facing
 * rejection. Both branches come from `jsonwebtoken`'s verified judgement,
 * never from an unverified re-reading of the token's claims.
 * @param token - The raw bearer token.
 * @returns The token's payload.
 * @throws {HttpError} 401. Carries `code: ACCESS_TOKEN_EXPIRED_CODE` when the token is expired.
 */
function verifyBearerToken(token: string): ReturnType<typeof verifyAccessToken> & { ok: true } {
  const result = verifyAccessToken(token)
  if (result.ok) return result

  if (result.reason === 'expired') {
    throw new HttpError('Access token expired', 401, ACCESS_TOKEN_EXPIRED_CODE)
  }
  throw new HttpError('Invalid access token', 401)
}

/**
 * Load the user a verified token claims to be, and confirm the account may
 * still authenticate. `findById` excludes a soft-deleted row
 * (`BaseRepository.scope`); `active` is checked here, so either a soft-delete
 * or a deactivation alone invalidates every outstanding access token.
 * @param userId - The `sub` claim of a token that has already passed signature verification.
 * @returns The user, narrowed to the fields safe to attach to a request.
 * @throws {HttpError} 401, when no such active user exists.
 */
async function loadAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
  const user = await userRepository.findById(userId)
  if (!user || !user.active) {
    throw new HttpError('Account no longer exists or is inactive', 401)
  }
  return toAuthenticatedUser(user)
}

/**
 * Require a valid, live-user-backed access token. Populates `request.user`
 * on success; forwards a rejection to `next` otherwise.
 *
 * Three steps: verify the signature (`verifyAccessToken`, the one place that
 * knows the secret and algorithm); reject a token whose session (`sid`) is on
 * the denylist, which ends an access token at logout instead of at expiry;
 * then load the user and check the account. The user load is not replaced by
 * the denylist: a JWT stays valid until `exp`, and deactivation and
 * soft-delete deny no session, so only the load stops a disabled account's
 * tokens. It costs one `findById` per request; a cache of known-good ids
 * would trade that for a window in which a disabled account keeps working,
 * and is deliberately not built. Every session revocation in
 * session.service.ts also denies the session; `revokeAllForUserAndPurpose`
 * (verification-link cleanup) is not a session revocation and denies nothing.
 *
 * A verified token without `sid` skips the denylist and is admitted until it
 * expires (at most `ACCESS_TOKEN_TTL`). To drop that tolerance, throw a 401
 * with `ACCESS_TOKEN_EXPIRED_CODE` for it, as `requireSessionId`
 * (notification-stream.controller.ts) does. Making `sid` required in
 * `verifyAccessToken` instead would answer 401 without that code, which the
 * react client's interceptor treats as a verdict on the token and signs the
 * user out rather than refreshing.
 *
 * Catches and calls `next(error)` itself, so a test that calls it directly
 * sees a call to `next`, not an unhandled rejection.
 * @param request - The incoming request.
 * @param _response - The response. Unused: a rejection is reported by the terminal error handler, not here.
 * @param next - Passes control on once `request.user` is populated, or forwards the rejection.
 */
export async function requireAuth(
  request: Request,
  _response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getBearerToken(request)
    const { payload } = verifyBearerToken(token)
    if (payload.sid && (await isSessionDenied(payload.sid))) {
      throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
    }
    if (payload.sid) {
      request.sessionId = payload.sid
    }
    if (payload.exp !== undefined) {
      request.accessTokenExpiresAt = new Date(payload.exp * 1000)
    }
    if (payload.auth_time !== undefined) {
      request.authTime = payload.auth_time
    }
    request.user = await loadAuthenticatedUser(payload.sub)
    const context = requestContextStore.getStore()
    if (context) context.userId = request.user.id
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Require that the session behind the access token authenticated within
 * `maxAgeMs`: the step-up gate a destructive route adds (ASVS 7.5.3). Reads
 * `request.authTime`, which `requireAuth` copies from the verified token's
 * `auth_time`, so it must run after `requireAuth`. The predicate is
 * `isRecentAuth` (recent-auth.utilities.ts), so a token with no claim
 * counts as stale. The refusal is a
 * 401 carrying REAUTH_REQUIRED_CODE: the client confirms the user's identity
 * and retries. Nothing is revoked.
 * @param maxAgeMs - The oldest authentication accepted. Defaults to STEP_UP_MAX_AGE_MS.
 * @returns An Express middleware.
 */
export function requireRecentAuth(
  maxAgeMs: number = STEP_UP_MAX_AGE_MS
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, _response, next) => {
    if (!request.user) {
      next(new HttpError('Authentication required', 401))
      return
    }
    if (!isRecentAuth(request.authTime, Date.now(), maxAgeMs)) {
      next(new HttpError('Confirm your identity to continue', 401, REAUTH_REQUIRED_CODE))
      return
    }
    next()
  }
}
