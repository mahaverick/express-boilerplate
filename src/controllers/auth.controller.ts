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
import { HttpError } from '@/middlewares/error.middleware'
import { UserRepository } from '@/repositories/user.repository'
import { hashPassword, isPasswordValid } from '@/utilities/password.utilities'
import { successResponse } from '@/utilities/response.utilities'
import { issueRefreshToken, signAccessToken } from '@/utilities/token.utilities'
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
 */
interface PublicUser {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  createdAt: Date
}

/**
 * Narrow a full user row to the fields `PublicUser` exposes.
 * @param user - The full row read from or written to the database.
 * @returns The public projection of that row.
 */
function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    createdAt: user.createdAt,
  }
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
