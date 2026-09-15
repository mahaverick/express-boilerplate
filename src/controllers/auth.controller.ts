// src/controllers/auth.controller.ts
//
// Two properties matter more than the endpoints themselves:
//
// 1. Registration never returns `passwordHash`. `toPublicUser` below builds
//    the response from an explicit field list rather than `delete`-ing the
//    key off the row — a `delete` is exactly the thing someone forgets to
//    add when a new sensitive column shows up later.
//
// 2. An unknown email and a wrong password are answered IDENTICALLY: same
//    status, same body, AND the same cost. Returning the same body but
//    skipping the bcrypt comparison for an unknown email would still leak
//    which addresses are registered, just through response TIMING instead
//    of response content — a wrong password pays for a real bcrypt compare
//    and an unknown email would otherwise return almost immediately.
//    `getDummyHash` below exists so both paths always run one real
//    comparison, at the same configured cost (BCRYPT_COST), regardless of
//    whether a matching row exists.
import { randomUUID } from 'node:crypto'
import { type NextFunction, type Request, type Response } from 'express'
import { getEnv } from '@/configs/env.config'
import { REFRESH_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_PATH } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { toAuthenticatedUser, type AuthenticatedUser } from '@/middlewares/auth.middleware'
import { HttpError } from '@/middlewares/error.middleware'
import { UserRepository } from '@/repositories/user.repository'
import { hashPassword, isPasswordValid } from '@/utilities/password.utilities'
import { successResponse } from '@/utilities/response.utilities'
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '@/utilities/token.utilities'
import { loginSchema, parseBody, registerSchema } from '@/validators/auth.validators'

const userRepository = new UserRepository()

// A fixed, non-secret plaintext — never a real password, never compared
// against a real account. Hashed lazily (only once actually needed) and
// memoised for the life of the process, using the SAME `hashPassword` every
// real password goes through — so it always costs the current BCRYPT_COST,
// never a stale cost captured in a hard-coded hash string that would
// silently stop matching the moment that constant changes and quietly
// reopen the timing gap this exists to close.
//
// That closes the STALE DUMMY half of the problem, and only that half. The
// dummy tracks BCRYPT_COST; a stored hash does not — bcrypt encodes the
// cost it was written with, so an existing row keeps verifying at that
// cost forever. Raise BCRYPT_COST and the two stop agreeing, inverted:
// existing users verify more cheaply than the dummy, and an unknown email
// becomes measurably SLOWER than a wrong password rather than identical.
// Nothing this function can do fixes that — there is no single cost that
// matches every row. The remedy (rehash-on-successful-login) and the
// decision it belongs to are documented on BCRYPT_COST itself
// (auth.constants.ts), which is where someone about to raise the cost is
// actually looking.
//
// The memoisation cache lives inside this IIFE's closure rather than as a
// top-level module variable, mirroring env.config.ts's `getEnv` — satisfying
// unicorn/no-top-level-assignment-in-function without disabling it.
const getDummyHash: () => Promise<string> = (() => {
  let cached: Promise<string> | undefined
  return (): Promise<string> => {
    cached ??= hashPassword('not-a-real-password-used-only-to-pay-bcrypts-cost')
    return cached
  }
})()

/**
 * The fields of a user row it is safe to return to a client. An explicit
 * allow-list — see this file's header comment for why.
 *
 * DERIVED, not declared: this is `AuthenticatedUser` (auth.middleware.ts,
 * the projection attached to `request.user`) plus `createdAt`, which is the
 * only field the two ever differed by. They used to be two independent
 * hand-maintained lists, which is precisely the drift this file's header
 * comment warns about one paragraph earlier — a field added to one and not
 * the other, or excluded from one and not the other, with nothing to catch
 * it. Extending rather than repeating makes that impossible: a change to
 * the narrower shape reaches this one automatically.
 *
 * Exported so profile.controller.ts can reuse this exact shape for
 * `GET`/`PATCH /api/v1/profile` instead of defining a third "what a user
 * looks like to a client".
 */
export interface PublicUser extends AuthenticatedUser {
  createdAt: Date
}

/**
 * Narrow a full user row to the fields `PublicUser` exposes.
 *
 * Built from `toAuthenticatedUser` for the same reason `PublicUser` extends
 * `AuthenticatedUser`: one field list, not two that agree today.
 * @param user - The full row read from or written to the database.
 * @returns The public projection of that row.
 */
export function toPublicUser(user: User): PublicUser {
  return { ...toAuthenticatedUser(user), createdAt: user.createdAt }
}

/**
 * Whether the current environment should mark cookies `Secure`
 * (HTTPS-only).
 *
 * Keyed on `NODE_ENV === 'production'` rather than hard-coded: a hard-coded
 * `true` would make cookie-based login impossible over plain HTTP in local
 * development (browsers refuse a `Secure` cookie set over `http://`), and a
 * hard-coded `false` would ship a refresh token over an unencrypted
 * connection in production.
 * @returns True outside local development and test.
 */
export function isSecureCookieEnvironment(): boolean {
  return getEnv().NODE_ENV === 'production'
}

/**
 * Attach a freshly issued refresh token to the response as an httpOnly
 * cookie, scoped to the auth routes that read it (refresh/logout, Task 7).
 *
 * `sameSite: 'strict'` is the cookie half of this API's stated CSRF
 * position (SECURITY.md: Bearer access tokens plus `SameSite` cookies, no
 * CSRF middleware) — it assumes the frontend and this API share the same
 * registrable domain (eTLD+1). A deployment that splits them across
 * different top-level domains would need `'lax'` or a real CSRF token
 * instead, since `'strict'` would then never send this cookie back at all.
 * @param response - The response to set the cookie on.
 * @param rawToken - The raw refresh token.
 * @param expiresAt - When the token expires.
 */
function setRefreshTokenCookie(response: Response, rawToken: string, expiresAt: Date): void {
  response.cookie(REFRESH_TOKEN_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: isSecureCookieEnvironment(),
    sameSite: 'strict',
    path: REFRESH_TOKEN_COOKIE_PATH,
    expires: expiresAt,
  })
}

/**
 * Clear the refresh-token cookie on logout.
 *
 * The options passed to `clearCookie` must agree with the ones
 * `setRefreshTokenCookie` set it with — `path` in particular — or the
 * browser treats this as clearing a DIFFERENT cookie and the original one
 * survives.
 * @param response - The response to clear the cookie on.
 */
function clearRefreshTokenCookie(response: Response): void {
  response.clearCookie(REFRESH_TOKEN_COOKIE_NAME, {
    httpOnly: true,
    secure: isSecureCookieEnvironment(),
    sameSite: 'strict',
    path: REFRESH_TOKEN_COOKIE_PATH,
  })
}

/**
 * Read the refresh-token cookie off an incoming request.
 *
 * Parsed directly off the raw `Cookie` header rather than via a
 * `request.cookies` populated by cookie-parser middleware: this API has
 * exactly one cookie, whose name it already knows, so adding a dependency
 * (or hand-rolling more of RFC 6265 than a single named value needs) buys
 * nothing here. Decodes the value the same way Express's `response.cookie`
 * encoded it (`encodeURIComponent`, by default).
 * @param request - The incoming request.
 * @returns The raw refresh token, or undefined when the cookie is absent.
 */
function readRefreshTokenCookie(request: Request): string | undefined {
  const header = request.headers.cookie
  if (!header) return undefined

  const prefix = `${REFRESH_TOKEN_COOKIE_NAME}=`
  const match = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
  if (!match) return undefined

  const rawValue = match.slice(prefix.length)
  try {
    return decodeURIComponent(rawValue)
  } catch {
    return rawValue
  }
}

/**
 * Register a new user with an email and password.
 *
 * Duplicate-email handling is not implemented here: `UserRepository.create`
 * already translates the table's unique-violation into `HttpError(409)` —
 * re-checking it here would be a second, driftable copy of that decision.
 * @param request - The incoming request, carrying the registration body.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function register(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = parseBody(registerSchema, request.body)
    const passwordHash = await hashPassword(input.password)
    const user = await userRepository.create({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
    })
    successResponse(response, toPublicUser(user), 'Registration successful.', 201)
  } catch (error) {
    next(error)
  }
}

/**
 * Log in with an email and password.
 *
 * See this file's header comment for why an unknown email and a wrong
 * password are answered identically, in both body and cost. A deactivated
 * account (`active: false`) is rejected the same way, after the same
 * comparison, through the same `HttpError` — not a distinct response — so
 * "these credentials are correct but the account is disabled" is never
 * something a caller can learn from this endpoint. A soft-deleted user
 * never reaches this function's `user` check at all: `findByEmail` already
 * excludes a soft-deleted row, so that case behaves exactly like an unknown
 * email.
 * @param request - The incoming request, carrying the login body.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function login(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = parseBody(loginSchema, request.body)
    const user = await userRepository.findByEmail(input.email)
    const hashToCompare = user?.passwordHash ?? (await getDummyHash())
    const isPasswordCorrect = await isPasswordValid(input.password, hashToCompare)

    if (!user || !isPasswordCorrect || !user.active || !user.passwordHash) {
      throw new HttpError('Invalid email or password', 401)
    }

    const sessionId = randomUUID()
    const accessToken = signAccessToken(user)
    const refreshToken = await issueRefreshToken(user.id, sessionId)
    setRefreshTokenCookie(response, refreshToken.raw, refreshToken.expiresAt)

    successResponse(response, { user: toPublicUser(user), accessToken }, 'Login successful.')
  } catch (error) {
    next(error)
  }
}

/**
 * Rotate a refresh token for a new access/refresh token pair.
 *
 * Reads the refresh token from its httpOnly cookie ONLY — never from the
 * request body, even as a fallback. The cookie is httpOnly specifically so
 * no script on the frontend origin can ever read the raw value
 * (`setRefreshTokenCookie`'s own header comment); accepting the same token
 * from the body as well would only matter to a client that already has the
 * raw value some other way, and would then let ANY page that can make the
 * browser send a POST with an attacker-chosen body attempt a refresh with
 * whatever token it supplies — exactly the surface `sameSite: 'strict'`
 * exists to narrow for the cookie itself. A non-browser client (a mobile
 * app, a CLI) is served fine by sending the same `Cookie` header; nothing
 * about this endpoint depends on being called from a browser.
 *
 * The rotated user's `active` status is re-checked here — the same check
 * `requireAuth` (auth.middleware.ts) makes for every bearer-token request —
 * so a deactivated account cannot mint a fresh, working access token merely
 * because it still held a live refresh token.
 * @param request - The incoming request, carrying the refresh cookie.
 * @param response - The response.
 * @param next - Forwards a rejection (missing cookie, or `rotateRefreshToken`'s own 401s) to the terminal error handler.
 */
export async function refresh(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawToken = readRefreshTokenCookie(request)
    if (!rawToken) {
      throw new HttpError('Missing refresh token', 401)
    }

    const rotated = await rotateRefreshToken(rawToken)
    const user = await userRepository.findById(rotated.userId)
    if (!user || !user.active) {
      throw new HttpError('Account no longer exists or is inactive', 401)
    }

    setRefreshTokenCookie(response, rotated.raw, rotated.expiresAt)
    successResponse(response, { accessToken: signAccessToken(user) }, 'Token refreshed.')
  } catch (error) {
    next(error)
  }
}

/**
 * Log out: revoke the session the presented refresh token belongs to, and
 * clear the cookie either way.
 *
 * Reads the same cookie `refresh` above does — see that function's header
 * comment for why not the body too. Deliberately does not require a valid
 * access token: a user wanting to log out has often just watched their
 * access token expire, and revocation only ever needs the refresh cookie.
 * A missing, forged, or already-revoked token is treated identically to a
 * live one — see `revokeRefreshToken`'s own header comment for why logout
 * must never let a caller learn which raw value was actually live.
 * @param request - The incoming request, carrying the refresh cookie if any.
 * @param response - The response.
 * @param next - Forwards an unexpected failure to the terminal error handler.
 */
export async function logout(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawToken = readRefreshTokenCookie(request)
    if (rawToken) {
      await revokeRefreshToken(rawToken)
    }
    clearRefreshTokenCookie(response)
    successResponse(response, undefined, 'Logged out.')
  } catch (error) {
    next(error)
  }
}
