// src/middlewares/auth.middleware.ts
//
// requireAuth is the gate every protected route sits behind. It does three
// things that are deliberately kept as separate steps inside one exported
// middleware, not several exported middlewares — tenant scoping
// (`resolveTenant()`, tenant.middleware.ts) already composes this way,
// reading `request.user` AFTER requireAuth has run rather than re-running
// part of this one, and a future MFA step-up would compose the same way, so
// there is no seam worth exporting yet:
//
//   1. Verify the bearer token's signature — delegated entirely to
//      `verifyAccessToken` (session.service.ts), the one place that knows
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
// Every session-revocation function in session.service.ts — logout,
// refresh-token reuse detection, password reset and change — denies every
// session it revokes, so within this middleware revocation does imply
// denial. Two things stay
// outside that on purpose:
// `revokeAllForUserAndPurpose` denies nothing, correctly, since it is used
// for purpose-scoped cleanups (stale verification links) that are not
// session revocations at all; and deactivating a user (`user.active =
// false`) denies nothing either — step 3's `findById` read below is what
// catches that, on the next request.
import { type NextFunction, type Request, type Response } from 'express'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import { HttpError } from '@/errors/http-error'
import { toAuthenticatedUser, type AuthenticatedUser } from '@/presenters/user.presenter'
import { UserRepository } from '@/repositories/user.repository'
import { isSessionDenied } from '@/services/session-denylist.service'
import { verifyAccessToken } from '@/services/session.service'

const userRepository = new UserRepository()

// RFC 6750: `Authorization: Bearer <token>`. `\S+` (rather than `.+`)
// rejects a header that is nothing but the scheme and whitespace — e.g.
// `"Bearer "` or `"Bearer    "` — without needing a separate `.trim()` and
// without the backtracking risk a greedy `.+` next to `\s+` would invite.
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
    // `notification-stream.controller.ts`'s `requireSessionId`, which
    // already runs exactly that check today (see its own comment for why
    // that endpoint has no tolerance for a sid-less token) — rather than
    // merely deleting the `payload.sid &&` prefix. Deleting
    // only the prefix does not compile (`isSessionDenied` takes `string`,
    // `payload.sid` is `string | undefined`), and reaching for a
    // type-level fix instead — making `sid` REQUIRED on
    // `AccessTokenPayload` so `verifyAccessToken` itself rejects a sid-less
    // token as `'invalid'` — silently changes the client-facing outcome:
    // that path carries no `ACCESS_TOKEN_EXPIRED_CODE`, so the axios
    // interceptor keyed on that code (react-boilerplate's
    // interceptors.ts) does NOT retry after a refresh — `if (!isExpired)`
    // rejects the error straight to the caller. It does not sign the user
    // out either (`redirectToLogin` sits in the catch around the refresh,
    // which never runs on this path), which is worse, not better: the
    // user is left STUCK, every REST call failing, until the token
    // expires on its own and the expired path finally triggers a refresh.
    // The explicit check above is what keeps this cheap: it costs one
    // legitimate user holding a genuinely pre-`sid` token a single 401
    // carrying the code their client already knows means "refresh and
    // retry". This wave does not remove the tolerance; whoever does only
    // needs to confirm the window above has passed.
    if (payload.sid && (await isSessionDenied(payload.sid))) {
      throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
    }
    // `exactOptionalPropertyTypes: true` (tsconfig.json): a sid-less token
    // must leave `request.sessionId` UNSET, not assigned `undefined` — see
    // `sessionId`'s own comment (express.d.ts) for who reads this and why.
    if (payload.sid) {
      request.sessionId = payload.sid
    }
    if (payload.exp !== undefined) {
      request.accessTokenExpiresAt = new Date(payload.exp * 1000)
    }
    request.user = await loadAuthenticatedUser(payload.sub)
    next()
  } catch (error) {
    next(error)
  }
}
