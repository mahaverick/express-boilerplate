// src/middlewares/auth.middleware.ts
//
// requireAuth is the gate every protected route sits behind. It does two
// things that are deliberately kept as separate steps inside one exported
// middleware, not two exported middlewares — a later plan (MFA step-up,
// tenant scoping) composes by reading `request.user` AFTER requireAuth has
// run, not by re-running half of this one, so there is no seam worth
// exporting yet:
//
//   1. Verify the bearer token's signature — delegated entirely to
//      `verifyAccessToken` (token.utilities.ts), the one place that knows
//      the signing secret and the pinned algorithm. This module never
//      re-implements that check.
//   2. Load the user the token claims to be, and confirm the account can
//      still authenticate at all.
//
// Step 2 is not optional, and it is the reason this file exists rather than
// a two-line `jwt.verify` call inline at every route. A JWT is stateless by
// design: once signed, its claims stay valid until `exp` regardless of
// anything that happens to the account afterwards. Trusting the decoded
// `sub` alone would mean disabling or soft-deleting a user does nothing —
// every access token already issued to them keeps working, silently, until
// it naturally expires. Loading the user turns that into an immediate
// rejection instead.
//
// The cost this trades for that guarantee: every authenticated request now
// costs one extra database read (`findById`), on top of what the route
// itself will usually do anyway. A purely stateless JWT would not need it.
// The alternatives — a short-lived in-memory cache of "known-good" user
// ids, or a revocation list checked only for tokens that were explicitly
// revoked — would shrink that cost back down at the price of a window
// (bounded by the cache TTL, or unbounded for anything short of explicit
// revocation) in which a disabled account keeps working. Neither is built
// here; this comment is what makes that a chosen trade-off rather than an
// oversight for the next person to rediscover.
import { type NextFunction, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/middlewares/error.middleware'
import { UserRepository } from '@/repositories/user.repository'
import { verifyAccessToken, type AccessTokenPayload } from '@/utilities/token.utilities'

const userRepository = new UserRepository()

// RFC 6750: `Authorization: Bearer <token>`. `\S+` (rather than `.+`)
// rejects a header that is nothing but the scheme and whitespace — e.g.
// `"Bearer "` or `"Bearer    "` — without needing a separate `.trim()` and
// without the backtracking risk a greedy `.+` next to `\s+` would invite.
const BEARER_PATTERN = /^Bearer\s+(\S+)$/

/**
 * Machine-readable code identifying an expired access token, carried in
 * `HttpError`'s `errors` payload (`{ code: ACCESS_TOKEN_EXPIRED_CODE }`).
 *
 * This is the distinction a client needs to act correctly: "my access
 * token expired, try the refresh token" is a silent, automatic recovery;
 * every other 401 from this middleware means the credential itself is no
 * good and the user must sign in again. A client cannot tell those apart
 * safely by matching on `message` — that string is for a human reading
 * logs and is free to change wording — and this response has no field
 * meant for a machine-readable code other than `errors`, which
 * error.middleware.ts's envelope already reserves for exactly this kind of
 * structured, non-prose detail. Reusing it here avoids widening the
 * envelope contract (touching error.middleware.ts / response.utilities.ts)
 * for a single new field.
 */
export const ACCESS_TOKEN_EXPIRED_CODE = 'ACCESS_TOKEN_EXPIRED'

/**
 * The subset of a user row it is safe to attach to `request.user`.
 * Deliberately excludes `passwordHash` — and everything else a route
 * handler has no business reading off the authenticated principal.
 */
export interface AuthenticatedUser {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
}

/**
 * Narrow a full user row to the fields `request.user` exposes.
 * @param user - The loaded, already-validated user row.
 * @returns The fields safe to attach to a request.
 */
function toAuthenticatedUser(user: User): AuthenticatedUser {
  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
}

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
 * Whether a token's own, UNVERIFIED `exp` claim already names a moment in
 * the past — mirroring the exact boundary `jsonwebtoken` itself uses
 * (`now >= exp`, in whole seconds) so this never disagrees with the
 * rejection `verifyAccessToken` already made.
 *
 * This intentionally never checks the signature. It only ever runs after
 * `verifyAccessToken` has already rejected the token for some reason, and
 * it exists purely to pick a more useful client-facing code for a
 * rejection that is happening either way. Trusting an unverified claim
 * here cannot weaken the real security decision: a forged `exp` on a
 * tampered token can only change WHICH 401 code an already-rejected caller
 * receives (expired vs. generic), never whether the request is let
 * through — that still requires passing `verifyAccessToken`'s signature
 * check, which this function has no part in.
 * @param token - The raw bearer token, already known to fail `verifyAccessToken`.
 * @returns True when the token's own claim says it expired.
 */
function isExpiredByOwnClaim(token: string): boolean {
  const decoded = jwt.decode(token, { json: true })
  const expiresAt = decoded?.exp
  return typeof expiresAt === 'number' && Math.floor(Date.now() / 1000) >= expiresAt
}

/**
 * Verify a bearer token, translating an expired token into a distinguishable
 * rejection. Every other failure (bad signature, wrong algorithm, malformed
 * structure, missing `sub`) passes through `verifyAccessToken`'s own generic
 * 401 unchanged.
 * @param token - The raw bearer token.
 * @returns The token's payload.
 * @throws {HttpError} 401. Carries `errors: { code: ACCESS_TOKEN_EXPIRED_CODE }` when the token is expired.
 */
function verifyBearerToken(token: string): AccessTokenPayload {
  try {
    return verifyAccessToken(token)
  } catch (error) {
    if (isExpiredByOwnClaim(token)) {
      throw new HttpError('Access token expired', 401, { code: ACCESS_TOKEN_EXPIRED_CODE })
    }
    throw error
  }
}

/**
 * Load the user a verified token claims to be, and confirm the account is
 * still one that may authenticate — see this file's header comment for why
 * that check exists and what it costs.
 *
 * `findById` already excludes a soft-deleted row (`BaseRepository.scope`).
 * `active` is a separate column, unrelated to soft-delete, and is checked
 * here explicitly: a soft-delete and a deactivation are different events,
 * either one alone must be enough to invalidate every outstanding access
 * token for that user, and handling only one of the two would silently
 * leave the other's tokens working.
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
 * on success; forwards a rejection to `next` (and so to the terminal error
 * handler) otherwise.
 *
 * Catches explicitly and calls `next(error)` itself, rather than throwing
 * and leaning on Express 5's own promise-rejection-to-`next` forwarding.
 * Both work when this runs inside a real Express router, but only the
 * explicit form also behaves correctly when a test calls this function
 * directly — awaiting a middleware that instead threw would surface as an
 * unhandled rejection in the test, not a call to `next`.
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
    const payload = verifyBearerToken(token)
    request.user = await loadAuthenticatedUser(payload.sub)
    next()
  } catch (error) {
    next(error)
  }
}
