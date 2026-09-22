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
//      the signing secret and the pinned algorithm, and returns a
//      discriminated result naming why a rejected token was rejected. This
//      module never re-implements that check, and never re-derives WHY a
//      token failed from data it cannot itself trust — see
//      `verifyAccessToken`'s own header comment.
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
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/middlewares/error.middleware'
import { UserRepository } from '@/repositories/user.repository'
import { isSessionDenied } from '@/services/session-denylist.service'
import { verifyAccessToken } from '@/utilities/token.utilities'

const userRepository = new UserRepository()

// RFC 6750: `Authorization: Bearer <token>`. `\S+` (rather than `.+`)
// rejects a header that is nothing but the scheme and whitespace — e.g.
// `"Bearer "` or `"Bearer    "` — without needing a separate `.trim()` and
// without the backtracking risk a greedy `.+` next to `\s+` would invite.
const BEARER_PATTERN = /^Bearer\s+(\S+)$/

/**
 * Machine-readable code identifying an expired access token, carried in the
 * error envelope's `code` field (`error.middleware.ts` / `HttpError`).
 *
 * This is the distinction a client needs to act correctly: "my access
 * token expired, try the refresh token" is a silent, automatic recovery;
 * every other 401 from this middleware means the credential itself is no
 * good and the user must sign in again. A client cannot tell those apart
 * safely by matching on `message` — that string is for a human reading
 * logs and is free to change wording.
 */
export const ACCESS_TOKEN_EXPIRED_CODE = 'ACCESS_TOKEN_EXPIRED'

/**
 * The subset of a user row it is safe to attach to `request.user`.
 * Deliberately excludes `passwordHash` — and everything else a route
 * handler has no business reading off the authenticated principal.
 *
 * This is the NARROWER of this codebase's two user projections, and the one
 * the other is built from: `PublicUser` (auth.controller.ts) extends this
 * interface with `createdAt`, and `toPublicUser` calls
 * `toAuthenticatedUser` below rather than repeating its field list. Before
 * that, the two were independent hand-maintained copies differing only in
 * `createdAt` — exactly the duplicate-definition drift auth.controller.ts's
 * own header comment argues against. The dependency runs in this direction
 * (controller -> middleware) because that is the direction imports already
 * run here; the reverse would be a new layering inversion.
 *
 * WHAT THAT MAKES TRUE, for whoever adds a field next: everything on
 * `request.user` is CLIENT-VISIBLE by construction, because `PublicUser`
 * inherits it and `GET /api/v1/profile` returns that. A later plan adding
 * server-only principal data — a role, a tenant id, an impersonation flag —
 * must not add it here expecting it to stay internal. Put that on its own
 * request property (`request.principal`, say) and leave this one meaning
 * "the user, as the user may see themselves".
 */
export interface AuthenticatedUser {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
}

/**
 * Narrow a full user row to the fields `request.user` exposes.
 *
 * Exported because `toPublicUser` (auth.controller.ts) builds on it — see
 * `AuthenticatedUser` above for why the two projections are related this
 * way round rather than duplicated.
 * @param user - The loaded, already-validated user row.
 * @returns The fields safe to attach to a request.
 */
export function toAuthenticatedUser(user: User): AuthenticatedUser {
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
 * Verify a bearer token and return its payload, translating
 * `verifyAccessToken`'s discriminated result into the client-facing
 * rejection. Both branches of that result come from `jsonwebtoken`'s own
 * verified judgement of the token — never from an unverified re-reading of
 * its claims — so this never has to guess why a token failed; it only has
 * to translate a fact `verifyAccessToken` already established.
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
    const { payload } = verifyBearerToken(token)
    // A token with no `sid` predates this claim; accept it until it
    // expires. See the spec's "Honest limits" — one release of tolerance.
    if (payload.sid && (await isSessionDenied(payload.sid))) {
      throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
    }
    request.user = await loadAuthenticatedUser(payload.sub)
    next()
  } catch (error) {
    next(error)
  }
}
