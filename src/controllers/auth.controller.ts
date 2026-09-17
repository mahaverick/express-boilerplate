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
//    `getDummyHash` (@/utilities/password.utilities) exists so both paths
//    always run one real comparison, at the same configured cost
//    (BCRYPT_COST), regardless of whether a matching row exists. See its
//    own header comment there for how it stays in step with BCRYPT_COST and
//    why it's memoised.
import { randomUUID } from 'node:crypto'
import { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { getEnv } from '@/configs/env.config'
import {
  GOOGLE_STRATEGY_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_PATH,
} from '@/constants/auth.constants'
import { JobPriority } from '@/constants/queue.constants'
import { authProviderModel } from '@/database/models/auth-provider.model'
import type { User } from '@/database/models/user.model'
import { userModel } from '@/database/models/user.model'
import { addEmailJob } from '@/jobs/email.job'
import { addNotificationJob } from '@/jobs/notification.job'
import { toAuthenticatedUser, type AuthenticatedUser } from '@/middlewares/auth.middleware'
import { HttpError } from '@/middlewares/error.middleware'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { PASSWORD_RESET_TEMPLATE_KEY } from '@/templates/email/password-reset.template'
import { REGISTRATION_ATTEMPT_TEMPLATE_KEY } from '@/templates/email/registration-attempt.template'
import { getDummyHash, hashPassword, isPasswordValid } from '@/utilities/password.utilities'
import { successResponse } from '@/utilities/response.utilities'
import {
  claimToken,
  issueRefreshToken,
  issueToken,
  requireDurationMs,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '@/utilities/token.utilities'
import { buildPasswordResetUrl } from '@/utilities/verification-link.utilities'
import {
  MISSING_FIRST_NAME_FALLBACK,
  sendVerificationMail,
} from '@/utilities/verification-mail.utilities'
import {
  forgotPasswordSchema,
  loginSchema,
  parseBody,
  registerSchema,
  resetPasswordSchema,
} from '@/validators/auth.validators'

const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()

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
 *
 * `sameSite` is a parameter, defaulting to `'strict'`, rather than a second
 * copy of this function — `setOAuthRefreshTokenCookie` below is the one
 * caller that passes `'lax'` explicitly, for a reason specific to ITS
 * request, not a reason to weaken every other caller's default.
 * @param response - The response to set the cookie on.
 * @param rawToken - The raw refresh token.
 * @param expiresAt - When the token expires.
 * @param sameSite - The cookie's `SameSite` attribute. Defaults to `'strict'`.
 */
function setRefreshTokenCookie(
  response: Response,
  rawToken: string,
  expiresAt: Date,
  sameSite: 'strict' | 'lax' = 'strict'
): void {
  response.cookie(REFRESH_TOKEN_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: isSecureCookieEnvironment(),
    sameSite,
    path: REFRESH_TOKEN_COOKIE_PATH,
    expires: expiresAt,
  })
}

/**
 * Attach a freshly issued refresh token to the response for the Google
 * OAuth callback specifically — identical to `setRefreshTokenCookie` except
 * `sameSite: 'lax'` in place of its `'strict'` default.
 *
 * `'strict'` would not survive the very request this cookie is set for: the
 * browser reaches `handleGoogleCallback` via a top-level navigation
 * REDIRECTED FROM `accounts.google.com` — a cross-site origin from this
 * cookie's point of view — and a `'strict'` cookie set here would then be
 * withheld on the very next request too, since that next request (the
 * browser following `handleGoogleCallback`'s own redirect to
 * `${WEB_URL}/auth/callback`) is issued by a document that just loaded
 * arriving from that same cross-site hop. `'lax'` still withholds the
 * cookie on cross-site subresource requests and cross-site unsafe (non-GET)
 * requests — the actual CSRF surface `'strict'` exists to close for every
 * other endpoint — while allowing it on this top-level GET redirect chain,
 * which is the one shape every other caller of `setRefreshTokenCookie`
 * never needs to allow for.
 * @param response - The response to set the cookie on.
 * @param rawToken - The raw refresh token.
 * @param expiresAt - When the token expires.
 */
function setOAuthRefreshTokenCookie(response: Response, rawToken: string, expiresAt: Date): void {
  setRefreshTokenCookie(response, rawToken, expiresAt, 'lax')
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

const REGISTER_RESPONSE_MESSAGE =
  'If that address can be registered, a verification email has been sent.'

/**
 * Tell the owner of an already-registered address that someone tried to
 * register it.
 * @param email - The address that was submitted.
 */
async function sendRegistrationAttemptMail(email: string): Promise<void> {
  const existing = await userRepository.findByEmail(email)
  await addEmailJob(
    {
      to: email,
      templateKey: REGISTRATION_ATTEMPT_TEMPLATE_KEY,
      variables: {
        // The STORED name, never the submitted one: the submitted value is
        // attacker-chosen text being delivered into the victim's inbox.
        // `??` covers the soft-deleted case, where the address is taken but
        // no visible row exists to read a name from.
        firstName: existing?.firstName ?? MISSING_FIRST_NAME_FALLBACK,
        appName: getEnv().APP_NAME,
      },
    },
    // Soft-deleted case: the address is taken but findByEmail returns no
    // visible row, so there is no id to correlate the job to. '' rather than
    // a lookup fallback — this is logging/correlation only (email.job.ts),
    // never a DB key.
    existing?.id ?? '',
    { priority: JobPriority.normal }
  )
}

/**
 * Register a new user with an email and password.
 *
 * Both a free address and a taken one now answer an identical 202 with
 * `data: null` — the old `201` / `409` split was an enumeration oracle.
 * Only the outbound mail differs: a free address gets a verification link,
 * a taken one gets a "someone tried to register with your email" notice.
 *
 * The response is sent BEFORE the mail, so the two branches do not differ
 * by the latency of an SMTP round trip. The send is deliberately not
 * awaited — `.catch()` handles any rejection (Ruling T: an unhandled
 * rejection under Node 24 kills the process on one branch only =
 * enumeration oracle as denial of service).
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

    let created: User | undefined
    try {
      created = await userRepository.create({
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
      })
    } catch (error) {
      // 409 is how UserRepository.create reports the unique violation
      // (see its own comment). Anything else is a real failure and must
      // still surface — swallowing every error here would turn a database
      // outage into a cheerful 202.
      if (!(error instanceof HttpError) || error.statusCode !== 409) throw error
    }

    // Respond BEFORE sending, so the two branches do not differ by the
    // latency of an SMTP round trip. The send is deliberately not awaited.
    // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
    successResponse(response, null, REGISTER_RESPONSE_MESSAGE, 202)

    if (created) {
      // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget: the mail must not block the response, and awaiting would make the two branches differ by SMTP latency (Ruling T)
      sendVerificationMail(created).catch((error: unknown) => {
        logger.error('Verification mail failed', { error })
      })
      return
    }

    // The address is taken. It may STILL have no visible row — the unique
    // index ignores deleted_at while findByEmail does not — so the name
    // falls back rather than being dereferenced.
    // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget: same reasoning as the verification branch above
    sendRegistrationAttemptMail(input.email).catch((error: unknown) => {
      logger.error('Registration-attempt mail failed', { error })
    })
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
 *
 * An unverified account (`emailVerifiedAt` still null) is refused the same
 * way, through the same guard: joining `!user.emailVerifiedAt` into this
 * condition, rather than a separate early return placed before or after it,
 * is load-bearing. `isPasswordCorrect` is computed above the guard and paid
 * for on every call regardless of which clause ultimately trips, so an
 * unverified account gets the identical 401 body AND the identical bcrypt
 * cost as a wrong password. A separate early return keyed only on
 * `emailVerifiedAt` would let a caller learn "this address exists and is
 * merely unverified" by the response arriving fast (no bcrypt compare)
 * instead of at the wrong-password/unknown-email cost — the same timing
 * oracle this file's header comment already rules out for registration.
 * `'Invalid email or password'` is, in this case, literally false — the
 * credentials ARE correct. That falsehood is accepted deliberately, for
 * the same reason the deactivated-account case accepts it: a truthful
 * "this account exists but isn't verified yet" would confirm both that the
 * address is registered AND that the supplied password is the right one,
 * to anyone merely trying credentials against it.
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

    if (
      !user ||
      !isPasswordCorrect ||
      !user.active ||
      !user.passwordHash ||
      !user.emailVerifiedAt
    ) {
      throw new HttpError('Invalid email or password', 401)
    }

    // AFTER the guard, so a failed attempt leaves no trace on the row, and
    // BEFORE tokens are issued, so a failed UPDATE answers 500 without
    // having already set a refresh cookie for a login the caller is being
    // told did not happen.
    //
    // `new Date()` rather than sql`now()`: this goes through the public
    // `update()`, whose value type is the insert model, and SQL is not
    // part of it (base.repository.ts:93). `update()` also bumps
    // `updated_at` via `touched()`, which is why this is not a raw query.
    await userRepository.update(user.id, { lastLoggedInAt: new Date() })

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

const FORGOT_PASSWORD_RESPONSE_MESSAGE =
  'If that address has an account, a password reset email has been sent.'

/**
 * Issue a password-reset token and mail the link — but only when `email`
 * belongs to an existing account. Runs entirely AFTER `forgotPassword` has
 * already responded (see that function's own comment), the same
 * fire-and-forget shape `sendRegistrationAttemptMail` above uses: a single
 * caller today, so this stays a private helper rather than joining
 * verification-mail.utilities.ts — see that file's own header comment on
 * when a second caller justifies the move.
 * @param email - The address submitted to `/forgot-password`.
 */
async function sendPasswordResetMailIfRegistered(email: string): Promise<void> {
  const user = await userRepository.findByEmail(email)
  if (!user) return

  const issued = await issueToken(
    user.id,
    'password_reset',
    requireDurationMs(getEnv().PASSWORD_RESET_TTL)
  )

  await addNotificationJob({
    userId: user.id,
    type: 'password_reset_requested',
    title: 'Password reset requested',
    body: `We received a request to reset your ${getEnv().APP_NAME} password.`,
    metadata: { templateKey: PASSWORD_RESET_TEMPLATE_KEY },
    email: {
      to: user.email,
      templateKey: PASSWORD_RESET_TEMPLATE_KEY,
      variables: {
        firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
        resetUrl: buildPasswordResetUrl(issued.raw),
        appName: getEnv().APP_NAME,
      },
    },
  })
}

/**
 * Request a password-reset email.
 *
 * Answers an identical 202 with `data: null` for every address, registered
 * or not — see this file's header comment (Ruling G). Stricter than
 * `register`/`resendVerification` about WHEN it responds: those two still
 * run a database lookup or insert before responding (a cost both of their
 * branches pay alike), but this endpoint has nothing shared between
 * branches to hide behind, so the response is sent before the lookup even
 * starts. Everything from the lookup onward is fire-and-forget
 * (`sendPasswordResetMailIfRegistered`), with `.catch()` (Ruling T) so a
 * rejection there can never surface — not as a status code, not as an
 * unhandled rejection that would crash the process on this branch only.
 * Synchronous, deliberately — not `async` — because nothing in this
 * function's own body is ever awaited: `parseBody`/`successResponse` are
 * synchronous, and `sendPasswordResetMailIfRegistered` below is called but
 * never awaited (see this comment's own paragraph above). An `async`
 * signature with no `await` inside it is exactly what
 * `@typescript-eslint/require-await` exists to catch.
 * @param request - The incoming request, carrying `{ email }`.
 * @param response - The response.
 * @param next - Forwards a validation failure to the terminal error handler.
 */
export function forgotPassword(request: Request, response: Response, next: NextFunction): void {
  try {
    const input = parseBody(forgotPasswordSchema, request.body)

    // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
    successResponse(response, null, FORGOT_PASSWORD_RESPONSE_MESSAGE, 202)

    // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget: everything here runs after the response above, so nothing it does (or fails to do) can affect what the caller already received
    sendPasswordResetMailIfRegistered(input.email).catch((error: unknown) => {
      logger.error('Forgot-password mail failed', { error })
    })
  } catch (error) {
    next(error)
  }
}

const INVALID_RESET_TOKEN_MESSAGE = 'Invalid or expired reset link.'

/**
 * Reset a password with a token from the mailed link.
 *
 * Unlike `verifyEmail`, a weak or missing password is NOT folded into the
 * same generic failure as an invalid token: `parseBody` throws its ordinary
 * field-level 400 first, before the token is even looked at. That is safe
 * here in a way it is not for `verifyEmail` — the password there is a
 * SECOND proof of ownership over a possibly-squatted account, so a
 * distinguishable wrong-password response would tell an attacker holding a
 * link that the address is squatted. Here the token itself is the only
 * secret in play (a 256-bit value from a mailed link, not a guessable
 * credential), so telling a caller "your new password is too short" leaks
 * nothing about the token's validity.
 *
 * `claimToken` both atomically claims the token AND checks its `purpose`
 * and expiry (token.utilities.ts) — a claim that resolves undefined for ANY
 * reason (unknown, wrong purpose, already used, expired) answers the same
 * generic 400, so a caller cannot learn which of those actually happened. A
 * soft-deleted user, or one deleted between issuing and claiming, is folded
 * into the same case: `findById` excludes a soft-deleted row by default, so
 * `!user` covers both "the token is bad" and "the account is gone" with the
 * one response neither should be able to tell apart from the other.
 * @param request - The incoming request, carrying `{ token, password }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function resetPassword(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = parseBody(resetPasswordSchema, request.body)

    const claimed = await claimToken(input.token, 'password_reset')
    const user = claimed ? await userRepository.findById(claimed.userId) : undefined
    if (!claimed || !user) {
      throw new HttpError(INVALID_RESET_TOKEN_MESSAGE, 400)
    }

    const passwordHash = await hashPassword(input.password)

    await userRepository.update(user.id, {
      passwordHash,
      // Set ONLY when the user had never verified — a successful reset
      // proves the caller controls the mailbox, which is sufficient first
      // proof for an unverified account, but must not overwrite an
      // EARLIER, real timestamp for one that already had it. Mirrors
      // `markEmailVerified`'s own "never move a timestamp that already
      // records the first proof" idempotence.
      ...(!user.emailVerifiedAt && { emailVerifiedAt: new Date() }),
    })

    // Revokes every live token this user holds, of EVERY purpose —
    // `revokeAllSessions`/`revokeAllForUser` has no purpose predicate. That
    // is intended, not merely tolerated: it takes every refresh token
    // (every session, on every device) with it, which is the point of a
    // password reset, and it also kills any OTHER outstanding
    // `password_reset` link the same user requested earlier, so a stale
    // link from an older request cannot be redeemed after this one already
    // succeeded.
    await revokeAllSessions(user.id)

    // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
    successResponse(response, null, 'Password has been reset.')
  } catch (error) {
    next(error)
  }
}

// == Google OAuth ==
//
// `findOrCreateByGoogle` is the account-linking policy passport.config.ts's
// own header comment says belongs here, not in the Passport verify
// function: `passthroughGoogleProfile` hands `handleGoogleCallback`'s
// `passport.authenticate('google', { session: false }, ...)` the RAW
// Google profile, and deciding what that profile means — a returning
// Google user, a new link to an existing email/password account, an
// outright new account, or a rejection — is this function's job alone.

/**
 * The primary email address a Google profile carries, lowercased, plus
 * whether GOOGLE ITSELF has verified that address.
 *
 * `profile.emails` is guarded rather than assumed present: the OAuth scope
 * this app requests (`['profile', 'email']`, auth.routes.ts/
 * passport.config.ts) is a REQUEST, and a Google Workspace admin can still
 * restrict which fields a consenting user's organization exposes, so an
 * absent or empty array is a real response shape, not defensive-programming
 * theatre. Verification is read from BOTH `emails[0].verified` and
 * `_json.email_verified` and OR'd together, rather than trusting either
 * alone — `@types/passport-google-oauth20` types the first as always
 * present, but that is the library's approximation of Google's actual wire
 * format, not a guarantee this function should stake an account-takeover
 * decision on.
 * @param profile - The raw Google profile handed to `passport.authenticate`'s custom callback.
 * @returns The lowercased email and Google's own verification claim for it.
 * @throws {HttpError} 400, `google_email_missing`, when the profile carries no email at all.
 */
function verifiedGoogleEmail(profile: GoogleProfile): { email: string; isVerified: boolean } {
  const primary = profile.emails?.[0]
  if (!primary?.value) {
    throw new HttpError('Google did not share an email address', 400, 'google_email_missing')
  }
  const isVerified = primary.verified || profile._json.email_verified === true
  return { email: primary.value.toLowerCase(), isVerified }
}

/**
 * Link a Google identity to an existing user, tolerating the exact race
 * `AuthProviderRepository.create`'s own header comment names: two requests
 * for the SAME not-yet-linked Google account (e.g. a double-submitted
 * callback) can both pass `findByProviderAndId` and then race this insert.
 * Both requests resolve the SAME `userId` — they came from the same Google
 * account authenticating twice, hence the same email, hence the same
 * `findByEmail` result — so losing the race and treating the identity as
 * already-linked is equivalent to winning it, never a genuine conflict
 * between two different local accounts.
 * @param userId - The user to link the identity to.
 * @param googleId - Google's stable profile id (`profile.id`).
 */
async function linkGoogleProvider(userId: string, googleId: string): Promise<void> {
  try {
    await authProviderRepository.create({ userId, provider: 'google', providerId: googleId })
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return
    throw error
  }
}

/**
 * Resolve the user a Google Sign-In should resolve to — creating or linking
 * one when necessary. Entirely this task's own policy; see this section's
 * header comment for why none of it lives in the Passport strategy.
 *
 * Order of operations, and why:
 *
 * 1. `(google, profile.id)` is checked FIRST, ahead of email. It is the
 *    only lookup here safe to trust on a RETURNING user without a second
 *    opinion: Google's `profile.id` (the OIDC `sub`) never changes even
 *    when the account's email does, so a returning user's login stays
 *    correct independent of anything that happened to their inbox since
 *    they last signed in.
 * 2. An email match against an EXISTING user is only ever accepted when
 *    `verifiedGoogleEmail` says Google verified it. Google does not require
 *    owning an address to add it to an account as an unverified one, so
 *    accepting an unverified match would let anyone claiming
 *    `victim@example.com` at Google sign in as whichever local user already
 *    owns that address — the account-takeover this file's `handleGoogleCallback`
 *    header comment warns about.
 * 3. Linking does NOT set `emailVerifiedAt` on the existing account, even
 *    though Google just proved control of the mailbox. That proof is not
 *    equivalent to `resetPassword`'s (this file): a reset OVERWRITES the
 *    password, which is what evicts a squatter who registered the address
 *    first and never verified it. Linking touches no password at all, so
 *    setting `emailVerifiedAt` here would flip `login`'s guard
 *    (`!user.emailVerifiedAt`) to true for the SQUATTER's password too —
 *    the exact account-takeover `verifyEmail`'s own two-factor design
 *    (mailbox token AND password) exists to prevent. It also buys the
 *    Google user nothing: neither `refresh` nor `requireAuth`
 *    (auth.middleware.ts) gate on `emailVerifiedAt`, only `login` does, and
 *    a Google user never calls `login`.
 * 4. A brand-new account (no provider link, no email match) is created with
 *    its `'email'` and `'google'` provider rows in ONE transaction — see
 *    `auth-provider.model.ts`'s own header comment for why an `'email'` row
 *    exists for federated users too (it is what lets `findByUser` answer
 *    "does this user have a password login" without a second query against
 *    `users.password_hash`), and this SDD plan's Task 1 carry-forward for
 *    why repositories are bypassed in favour of `db.transaction` here:
 *    `UserRepository`/`AuthProviderRepository` accept no transaction handle,
 *    so an atomic multi-row write goes directly through `tx.insert(...)`
 *    against the Drizzle tables instead.
 * @param profile - The raw Google profile handed to `passport.authenticate`'s custom callback.
 * @returns The user this Google identity resolves to — existing, newly linked, or newly created.
 * @throws {HttpError} 400 `google_email_missing` (no email in the profile), 403 `email_not_verified` (an existing account's email, claimed by a Google identity Google has not verified), or a translated/raw database error from the write itself.
 */
export async function findOrCreateByGoogle(profile: GoogleProfile): Promise<User> {
  const existingLink = await authProviderRepository.findByProviderAndId('google', profile.id)
  if (existingLink) {
    const user = await userRepository.findById(existingLink.userId)
    if (!user) {
      // REACHABLE, not a "cannot happen" guard: `auth_providers.user_id`
      // cascades on a hard delete, but this codebase's own delete is a
      // SOFT one (`UserRepository.softDelete`, sets `deletedAt`, never
      // removes the row) — so a user who soft-deleted (or was
      // soft-deleted) keeps their `auth_providers` rows while
      // `findById`'s default `SoftDeleteOptions` excludes them here. A
      // real Google account signing in again after that lands here, and
      // gets a 4xx it can act on rather than an opaque 500.
      throw new HttpError(
        'This Google account is no longer linked to an active user',
        401,
        'google_auth_failed'
      )
    }
    return user
  }

  const { email, isVerified } = verifiedGoogleEmail(profile)
  const existingUser = await userRepository.findByEmail(email)

  if (existingUser) {
    if (!isVerified) {
      throw new HttpError(
        'This email is registered, but Google has not verified this address',
        403,
        'email_not_verified'
      )
    }

    await linkGoogleProvider(existingUser.id, profile.id)
    return existingUser
  }

  return db.transaction(async (tx) => {
    const [createdUser] = await tx
      .insert(userModel)
      .values({
        email,
        // eslint-disable-next-line unicorn/no-null -- passwordHash is nullable specifically for a federated-only user (user.model.ts's own comment) — this account IS that case, not merely "no value given yet"
        passwordHash: null,
        ...(isVerified && { emailVerifiedAt: new Date() }),
      })
      .returning()

    // Same "cannot happen but guard anyway" reasoning as UserRepository's
    // own insertOne (user.repository.ts): a single-row insert.returning()
    // that does not throw always returns exactly one row.
    if (!createdUser) throw new HttpError('Insert returned no row', 500)

    await tx.insert(authProviderModel).values([
      { userId: createdUser.id, provider: 'email', providerId: email },
      { userId: createdUser.id, provider: 'google', providerId: profile.id },
    ])

    return createdUser
  })
}

/**
 * Handle Google's redirect back to this API once the user completes (or
 * abandons) Google's consent screen.
 *
 * `session: false` on `passport.authenticate`: this API is stateless JWT
 * end to end, and the OAuth `express-session`
 * (`createOAuthSessionMiddleware`, passport.config.ts) exists ONLY to carry
 * the CSRF `state` value across the redirect round-trip. Letting Passport
 * call `req.login()` here would additionally try to SERIALIZE this Google
 * profile into that same session — and nothing in this app ever
 * deserializes a session-backed user back out again.
 *
 * The custom three-argument `passport.authenticate` callback below receives
 * exactly what `passthroughGoogleProfile` (passport.config.ts) handed to
 * `done()`: the raw Google profile, not a resolved user. That callback is
 * NOT awaited by Passport itself, so its body is wrapped in an
 * immediately-invoked async function — an `async` callback passed directly
 * to `passport.authenticate` would turn a rejection (e.g.
 * `findOrCreateByGoogle` throwing) into an unhandled promise rejection
 * instead of a response.
 *
 * Every failure redirects to the FRONTEND's `/login?error=...`, never
 * answers this API's own JSON error envelope: the browser arrives here via
 * a full-page navigation FROM Google, not a fetch/XHR call that envelope
 * was ever built to answer. `HttpError.code` (when `findOrCreateByGoogle`
 * threw one — `google_email_missing`, `email_not_verified`) is forwarded
 * into the query string verbatim so the frontend can show a specific
 * message; anything else (a raw database error, a translated 500) collapses
 * to the generic `processing_failed`, and Google reporting `error`/no
 * profile at all (the user cancelled, or denied consent) is its own
 * `google_auth_failed`.
 * @param request - The incoming callback request, carrying Google's `code`/`state` query parameters.
 * @param response - The response.
 * @param next - Forwards a synchronous failure from `passport.authenticate` itself to the terminal error handler. Every failure from this handler's own async body redirects instead — see this comment's own note on why that body cannot simply throw into `next`.
 */
export function handleGoogleCallback(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  const env = getEnv()

  const authenticate = passport.authenticate(
    GOOGLE_STRATEGY_NAME,
    { session: false },
    (error: unknown, profile: GoogleProfile | false | null) => {
      void (async () => {
        if (error || !profile) {
          logger.error('Google OAuth callback failed', { error })
          response.redirect(`${env.WEB_URL}/login?error=google_auth_failed`)
          return
        }

        try {
          const user = await findOrCreateByGoogle(profile)

          // Same guard `login` (above) makes before issuing anything: a
          // deactivated account must not walk away with a live refresh
          // token just because it still owns a valid Google identity.
          // `refresh`'s own re-check of `active` would eventually catch
          // this on the first rotation attempt, but only after this
          // handler had already written a `user_tokens` row and told the
          // browser (via the redirect below) that sign-in succeeded.
          if (!user.active) {
            throw new HttpError('Account is inactive', 401, 'google_auth_failed')
          }

          await userRepository.update(user.id, { lastLoggedInAt: new Date() })

          const sessionId = randomUUID()
          const refreshToken = await issueRefreshToken(user.id, sessionId)
          setOAuthRefreshTokenCookie(response, refreshToken.raw, refreshToken.expiresAt)

          response.redirect(`${env.WEB_URL}/auth/callback`)
        } catch (innerError) {
          logger.error('Google OAuth callback failed', { error: innerError })
          const code =
            innerError instanceof HttpError && innerError.code
              ? innerError.code
              : 'processing_failed'
          response.redirect(`${env.WEB_URL}/login?error=${code}`)
        }
      })()
    }
    // `as RequestHandler`: identical cast, for the identical reason, as the
    // `/google` redirect route's own `passport.authenticate(...)` call —
    // see auth.routes.ts's header comment beside that cast.
  ) as RequestHandler

  authenticate(request, response, next)
}
