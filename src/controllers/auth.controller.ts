// src/controllers/auth.controller.ts
//
// HTTP only: parse the body, call auth.service / google-auth.service, and
// shape the reply — cookies, redirects, status and envelope. The
// enumeration and timing rules live with the work, in auth.service.ts.
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { getEnv, isCookieSecure, type Env } from '@/configs/env.config'
import {
  GOOGLE_STRATEGY_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_PATH,
} from '@/constants/auth.constants'
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import { toPublicAuthProviders } from '@/presenters/auth-provider.presenter'
import { toPublicUser } from '@/presenters/user.presenter'
import * as authService from '@/services/auth.service'
import { completeGoogleSignIn } from '@/services/google-auth.service'
import { logger } from '@/services/logger.service'
import { revokeRefreshToken } from '@/services/session.service'
import { messageResponse, successResponse } from '@/utilities/response.utilities'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '@/validators/auth.validators'
import { parseBody } from '@/validators/parse.validators'

/**
 * Attach a freshly issued refresh token to the response as an httpOnly
 * cookie, scoped to the auth routes that read it (refresh and logout).
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
 *
 * `Secure` and `Domain` come from `COOKIE_SECURE` (via `isCookieSecure`) and
 * `COOKIE_DOMAIN`; `clearRefreshTokenCookie` must repeat both. With
 * `COOKIE_DOMAIN` set, `clearHostOnlyRefreshTokenCookie` runs first, so a
 * browser holding a host-only cookie from before the domain was set drops it.
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
  const env = getEnv()
  clearHostOnlyRefreshTokenCookie(response, env)
  response.cookie(REFRESH_TOKEN_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: isCookieSecure(env),
    sameSite,
    path: REFRESH_TOKEN_COOKIE_PATH,
    ...(env.COOKIE_DOMAIN !== undefined && { domain: env.COOKIE_DOMAIN }),
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
 * When `COOKIE_DOMAIN` is set, clear the host-only refresh-token cookie, the
 * one set before `COOKIE_DOMAIN` was. The browser keys a cookie on name,
 * domain and path, so a `Domain=` cookie does not replace it, and the
 * browser would keep sending both. Does nothing when `COOKIE_DOMAIN` is unset:
 * the host-only cookie is then the live one.
 *
 * `setRefreshTokenCookie` calls this before it sets the new cookie, so a
 * browser that treats the two scopes as one cookie keeps the new one.
 * @param response - The response to add the clearing Set-Cookie to.
 * @param env - The validated environment.
 */
function clearHostOnlyRefreshTokenCookie(response: Response, env: Env): void {
  if (env.COOKIE_DOMAIN === undefined) return
  response.clearCookie(REFRESH_TOKEN_COOKIE_NAME, {
    httpOnly: true,
    secure: isCookieSecure(env),
    sameSite: 'strict',
    path: REFRESH_TOKEN_COOKIE_PATH,
  })
}

/**
 * Clear the refresh-token cookie on logout.
 *
 * The options passed to `clearCookie` must agree with the ones
 * `setRefreshTokenCookie` set it with — `path` and `domain` in particular —
 * or the browser treats this as clearing a DIFFERENT cookie and the
 * original one survives. With `COOKIE_DOMAIN` set, the host-only cookie is
 * cleared too (`clearHostOnlyRefreshTokenCookie`).
 * @param response - The response to clear the cookie on.
 */
function clearRefreshTokenCookie(response: Response): void {
  const env = getEnv()
  response.clearCookie(REFRESH_TOKEN_COOKIE_NAME, {
    httpOnly: true,
    secure: isCookieSecure(env),
    sameSite: 'strict',
    path: REFRESH_TOKEN_COOKIE_PATH,
    ...(env.COOKIE_DOMAIN !== undefined && { domain: env.COOKIE_DOMAIN }),
  })
  clearHostOnlyRefreshTokenCookie(response, env)
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
 *
 * Takes the LAST `refreshToken` value. A browser can hold two, one per
 * domain scope, after `COOKIE_DOMAIN` is changed or unset. It sends
 * same-path cookies oldest first (RFC 6265 §5.4, by creation time), so the
 * last is the most recently created one. That is the one set under the
 * current scope, except after `COOKIE_DOMAIN` is reverted to an earlier
 * value: overwriting a cookie keeps its original creation time (RFC 6265
 * §5.3 step 11.3), so the other scope's cookie reads as newer, and refresh
 * fails until the user logs in again or it expires (REFRESH_TOKEN_TTL).
 * Reading the first cookie instead would hand the stale token to reuse
 * detection after every domain change, which revokes the live session.
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
    .findLast((part) => part.startsWith(prefix))
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

const FORGOT_PASSWORD_RESPONSE_MESSAGE =
  'If that address has an account, a password reset email has been sent.'

/**
 * Handlers for `/api/v1/auth`, except email verification.
 */
class AuthController extends BaseController {
  /**
   * `POST /auth/register`: register a new user with an email and password.
   *
   * A free and a taken address answer an identical 202 with `data: null`
   * (a 201/409 split would be an enumeration oracle). The reply goes out
   * BEFORE the mail, so the branches do not differ by an SMTP round trip.
   */
  register = this.handle(async (request, response) => {
    const input = parseBody(registerSchema, request.body)
    const sendFollowUpMail = await authService.register(input)

    messageResponse(response, REGISTER_RESPONSE_MESSAGE, 202)
    // Never rejects: the service logs its own failure.
    void sendFollowUpMail()
  })

  /**
   * `POST /auth/login`: log in with an email and password. See
   * auth.service.ts for why every failure is one identical, equally-costly 401.
   */
  login = this.handle(async (request, response) => {
    const input = parseBody(loginSchema, request.body)
    const session = await authService.login(input)

    setRefreshTokenCookie(response, session.refreshToken.raw, session.refreshToken.expiresAt)
    successResponse(
      response,
      { user: toPublicUser(session.user), accessToken: session.accessToken },
      'Login successful.'
    )
  })

  /**
   * `POST /auth/refresh`: rotate a refresh token for a new access/refresh
   * token pair.
   *
   * Reads the refresh token from its httpOnly cookie ONLY, never the body:
   * accepting a body token would let any page that can make the browser POST
   * attempt a refresh with a token it chose. A non-browser client sends the
   * same `Cookie` header.
   */
  refresh = this.handle(async (request, response) => {
    const rawToken = readRefreshTokenCookie(request)
    if (!rawToken) {
      throw new HttpError('Missing refresh token', 401)
    }

    const refreshed = await authService.refresh(rawToken)

    setRefreshTokenCookie(response, refreshed.refreshToken.raw, refreshed.refreshToken.expiresAt)
    successResponse(response, { accessToken: refreshed.accessToken }, 'Token refreshed.')
  })

  /**
   * `POST /auth/logout`: revoke the session the presented refresh token
   * belongs to, and clear the cookie either way.
   *
   * Reads the same cookie `refresh` above does — see that handler's comment
   * for why not the body too. Deliberately does not require a valid
   * access token: a user wanting to log out has often just watched their
   * access token expire, and revocation only ever needs the refresh cookie.
   * A missing, forged, or already-revoked token is treated identically to a
   * live one — see `revokeRefreshToken`'s own header comment for why logout
   * must never let a caller learn which raw value was actually live.
   */
  logout = this.handle(async (request, response) => {
    const rawToken = readRefreshTokenCookie(request)
    if (rawToken) {
      await revokeRefreshToken(rawToken)
    }
    clearRefreshTokenCookie(response)
    messageResponse(response, 'Logged out.')
  })

  /**
   * `POST /auth/forgot-password`: request a password-reset email.
   *
   * An identical 202 for every address. Unlike register, nothing is shared
   * between branches to hide behind, so the reply goes out before the lookup
   * even starts, and the rest is fire-and-forget. Synchronous on purpose:
   * nothing here is awaited.
   */
  forgotPassword = this.handle((request, response) => {
    const input = parseBody(forgotPasswordSchema, request.body)

    messageResponse(response, FORGOT_PASSWORD_RESPONSE_MESSAGE, 202)
    // Never rejects: the service logs its own failure.
    void authService.requestPasswordReset(input.email)
  })

  /**
   * `POST /auth/reset-password`: reset a password with a token from the
   * mailed link.
   *
   * A weak password gets parseBody's ordinary field-level 400 before the token
   * is looked at. That is safe here, unlike verify-email: the token is the only
   * secret in play, so "too short" leaks nothing about it.
   */
  resetPassword = this.handle(async (request, response) => {
    const input = parseBody(resetPasswordSchema, request.body)
    await authService.resetPassword(input)

    messageResponse(response, 'Password has been reset.')
  })

  /**
   * `POST /auth/change-password`: change the authenticated caller's own
   * password, behind `requireAuth`. The session presenting this request is
   * spared (`request.sessionId`); see auth.service.ts's `changePassword` for
   * the order and the failure design.
   */
  changePassword = this.handle(async (request, response) => {
    const input = parseBody(changePasswordSchema, request.body)
    await authService.changePassword(authenticatedUserId(request), request.sessionId, input)

    messageResponse(response, 'Password has been changed.')
  })

  /**
   * `GET /auth/providers`: which methods can sign this account in, and
   * whether it has a password. Read-only by design: unlinking is a separate
   * feature (may you remove your last way in?).
   */
  getAuthProviders = this.handle(async (request, response) => {
    const { providers, hasPassword } = await authService.getAuthProviders(
      authenticatedUserId(request)
    )

    successResponse(
      response,
      { providers: toPublicAuthProviders(providers), hasPassword },
      'Auth providers retrieved.'
    )
  })

  /**
   * `GET /auth/google/callback`: handle Google's redirect back to this API
   * once the user completes (or abandons) Google's consent screen.
   *
   * `session: false`: the OAuth express-session exists only to carry the CSRF
   * `state`; letting Passport call `req.login()` would serialize the profile
   * into it for nothing. Passport does not await the custom callback, so its
   * body is an immediately-invoked async function — an async callback passed
   * directly would turn a rejection into an unhandled one.
   *
   * Every failure redirects to the frontend's `/login?error=...`, never this
   * API's JSON envelope (the browser arrived by a full-page navigation).
   * `HttpError.code` is forwarded verbatim; anything else is
   * `processing_failed`; Google reporting an error or no profile is
   * `google_auth_failed`.
   *
   * Not wrapped in `handle()`: every failure redirects to the frontend, and
   * a JSON error envelope would reach a browser mid-navigation.
   * @param request - The incoming callback request, carrying Google's `code`/`state` query parameters.
   * @param response - The response.
   * @param next - Forwards a synchronous failure from `passport.authenticate` itself; every failure from the async body redirects instead.
   */
  handleGoogleCallback = (request: Request, response: Response, next: NextFunction): void => {
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
            const refreshToken = await completeGoogleSignIn(profile)
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
}

/**
 * The auth controller the auth routes mount.
 */
export const authController = new AuthController()
