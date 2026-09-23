// src/middlewares/auth.middleware.ts
//
// requireAuth is the gate every protected route sits behind. It does three
// things that are deliberately kept as separate steps inside one exported
// middleware, not several exported middlewares — a later plan (MFA step-up,
// tenant scoping) composes by reading `request.user` AFTER requireAuth has
// run, not by re-running part of this one, so there is no seam worth
// exporting yet:
//
//   1. Verify the bearer token's signature — delegated entirely to
//      `verifyAccessToken` (token.utilities.ts), the one place that knows
//      the signing secret and the pinned algorithm, and returns a
//      discriminated result naming why a rejected token was rejected. This
//      module never re-implements that check, and never re-derives WHY a
//      token failed from data it cannot itself trust — see
//      `verifyAccessToken`'s own header comment.
//   2. Reject the token if its session (`payload.sid`) has been explicitly
//      denied — `isSessionDenied` (session-denylist.service.ts), a Redis
//      lookup keyed by session id. This is what makes logout end an access
//      token immediately instead of leaving it usable until it naturally
//      expires — WHEN logout has a session to name. `logout`
//      (auth.controller.ts) revokes by reading the refresh cookie, which is
//      the one place the session id to deny comes from; a logout request
//      with no refresh cookie returns 200 and revokes nothing, because
//      there is nothing to name. A token with no `sid` claim (minted
//      before this claim existed) skips this check entirely and falls
//      through to step 3 — see the guard's own comment for why that is
//      deliberate tolerance, not an oversight.
//   3. Load the user the token claims to be, and confirm the account can
//      still authenticate at all.
//
// Step 3 is not optional, and step 2 does not make it so: they close
// different gaps and neither substitutes for the other. A JWT is stateless
// by design: once signed, its claims stay valid until `exp` regardless of
// anything that happens to the account afterwards. Trusting the decoded
// `sub` alone would mean disabling or soft-deleting a user does nothing —
// every access token already issued to them keeps working, silently, until
// it naturally expires. Loading the user turns THAT into an immediate
// rejection. Step 2's denylist knows nothing about deactivation or
// soft-delete — it only knows which session ids were explicitly denied —
// so removing step 3 in favour of step 2 would silently bring back the
// exact problem step 3 exists to close.
//
// Step 3's cost: every authenticated request costs one extra database read
// (`findById`), on top of what the route itself will usually do anyway. A
// purely stateless JWT would not need it. The alternative sometimes
// reached for instead — a short-lived in-memory cache of "known-good" user
// ids — would shrink that cost back down at the price of a window (bounded
// by the cache TTL) in which a disabled account keeps working. That is not
// built here; this paragraph is what makes that a chosen trade-off rather
// than an oversight for the next person to rediscover.
//
// Every session-revocation path inside `UserTokenRepository` —
// `revokeAllForSession` (logout, refresh-token reuse detection) and
// `revokeAllForUser` (password reset) — denies every session it revokes, so
// within this middleware revocation does imply denial. Two things stay
// outside that on purpose:
// `revokeAllForUserAndPurpose` denies nothing, correctly, since it is used
// for purpose-scoped cleanups (stale verification links) that are not
// session revocations at all; and deactivating a user (`user.active =
// false`) denies nothing either — step 3's `findById` read below is what
// catches that, on the next request.
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
 * Machine-readable code identifying a STALE-BUT-OTHERWISE-VALID credential,
 * carried in the error envelope's `code` field (`error.middleware.ts` /
 * `HttpError`).
 *
 * This is the distinction a client needs to act correctly: a 401 carrying
 * this code means "refresh and retry" is a silent, automatic recovery;
 * every other 401 means the credential itself is no good and the user must
 * sign in again. A client cannot tell those apart safely by matching on
 * `message` — that string is for a human reading logs and is free to
 * change wording.
 *
 * THREE emitters share this code, not one, and all three mean the same
 * thing — the credential is not forged or malformed, it is simply no
 * longer honoured, and a refresh (which mints a token against the user's
 * current, live session) is the correct and sufficient response:
 *
 *   1. An EXPIRED access token — `verifyAccessToken`'s `reason: 'expired'`,
 *      thrown inside this file's own `verifyBearerToken`, at :181 below.
 *   2. A token whose session has been explicitly DENIED — the
 *      `isSessionDenied` check inside `requireAuth` itself, at :262 below.
 *   3. In `notification-stream.controller.ts`'s `authenticateStreamRequest`
 *      only: the same denial check as (2), plus a token that carries no
 *      `sid` claim at all — that endpoint has no tolerance for one (unlike
 *      this middleware's own `payload.sid &&` guard in `requireAuth`, at
 *      :233 below), so a sid-less token is rejected outright rather than
 *      admitted until it expires.
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
    // expires. The real bound on how long this tolerance needs to exist is
    // NOT a release cycle — it is `ACCESS_TOKEN_TTL` (fifteen minutes by
    // default) from the moment this deploy first starts minting `sid` into
    // every new token. No token signed before that moment can still carry
    // a valid, unexpired signature once that long has passed, so
    // `payload.sid` is guaranteed truthy for every token that reaches this
    // line, and this whole `if` becomes unreachable dead code at that
    // point, not merely low-risk to remove.
    //
    // WHEN removing it, replace the branch with an explicit check ahead of
    // it — `if (!payload.sid) throw new HttpError('Access token missing
    // session', 401, ACCESS_TOKEN_EXPIRED_CODE)`, mirroring
    // `notification-stream.controller.ts`'s `authenticateStreamRequest` —
    // rather than merely deleting the `payload.sid &&` prefix. Deleting
    // only the prefix does not compile (`isSessionDenied` takes `string`,
    // `payload.sid` is `string | undefined`), and reaching for a
    // type-level fix instead — making `sid` REQUIRED on
    // `AccessTokenPayload` so `verifyAccessToken` itself rejects a sid-less
    // token as `'invalid'` — silently changes the client-facing outcome:
    // that path carries no `ACCESS_TOKEN_EXPIRED_CODE`, so the axios
    // interceptor keyed on that code (react-boilerplate's
    // interceptors.ts) does NOT retry after a refresh — it treats the 401
    // as a real auth verdict and logs the user out. The explicit check
    // above is what keeps this cheap: it costs one legitimate user holding
    // a genuinely pre-`sid` token a single 401 carrying the code their
    // client already knows means "refresh and retry" for ordinary REST
    // calls, not a sign-out. This wave does not remove the tolerance;
    // whoever does only needs to confirm the window above has passed.
    if (payload.sid && (await isSessionDenied(payload.sid))) {
      throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
    }
    request.user = await loadAuthenticatedUser(payload.sub)
    next()
  } catch (error) {
    next(error)
  }
}
