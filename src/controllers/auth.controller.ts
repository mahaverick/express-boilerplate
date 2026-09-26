// src/controllers/auth.controller.ts
//
// HTTP only: parse the body, call auth.service / google-auth.service, and
// shape the reply — cookies, redirects, status and envelope. The
// enumeration and timing rules live with the work, in auth.service.ts.
import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from 'express'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { getEnv, isCookieSecure, type Env } from '@/configs/env.config'
import {
  GOOGLE_STRATEGY_NAME,
  LEGACY_REFRESH_TOKEN_COOKIE_NAME,
  refreshCookieSpec,
  type RefreshCookieSpec,
} from '@/constants/auth.constants'
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { toPublicAuthProviders } from '@/presenters/auth-provider.presenter'
import { toProfileResponse } from '@/presenters/user.presenter'
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
 * The refresh cookie's name, path and domain for this deployment.
 * @param env - The validated environment.
 * @returns The current cookie's spec.
 */
function currentRefreshCookie(env: Env): RefreshCookieSpec {
  return refreshCookieSpec({ COOKIE_SECURE: isCookieSecure(env), COOKIE_DOMAIN: env.COOKIE_DOMAIN })
}

/**
 * Whether two specs name the same browser cookie, which the browser keys on
 * name, domain and path.
 * @param a - One spec.
 * @param b - The other.
 * @returns True when a Set-Cookie for one replaces the other.
 */
function isSameCookie(a: RefreshCookieSpec, b: RefreshCookieSpec): boolean {
  return a.name === b.name && a.path === b.path && a.domain === b.domain
}

/**
 * Cookie options for one refresh-cookie spec. A clear must repeat the path
 * and domain it was set with, or the browser keeps the original.
 * @param spec - The cookie.
 * @param env - The validated environment.
 * @param sameSite - The cookie's `SameSite` attribute.
 * @returns Options for `response.cookie` or `response.clearCookie`.
 */
function refreshCookieOptions(
  spec: RefreshCookieSpec,
  env: Env,
  sameSite: 'strict' | 'lax'
): CookieOptions {
  return {
    httpOnly: true,
    secure: isCookieSecure(env),
    sameSite,
    path: spec.path,
    ...(spec.domain !== undefined && { domain: spec.domain }),
  }
}

/**
 * The value of the last cookie named `name` in the request.
 *
 * Parsed directly off the raw `Cookie` header rather than via cookie-parser:
 * this API reads only its own refresh cookie. Decodes the value the way
 * Express's `response.cookie` encoded it (`encodeURIComponent`).
 *
 * Takes the LAST value of that name. A browser can hold two, one per domain
 * scope, after `COOKIE_DOMAIN` is changed. It sends same-path cookies oldest
 * first (RFC 6265 §5.4, by creation time), so the last is the most recently
 * created one. That is the one set under the current scope, except after
 * `COOKIE_DOMAIN` is reverted to an earlier value: overwriting a cookie keeps
 * its original creation time (RFC 6265 §5.3 step 11.3), so the other scope's
 * cookie reads as newer, and refresh fails until the user logs in again or it
 * expires (REFRESH_TOKEN_TTL). Reading the first cookie instead would hand
 * the stale token to reuse detection after every domain change, which
 * revokes the live session.
 * @param request - The incoming request.
 * @param name - The cookie name.
 * @returns The decoded value, or undefined when no cookie of that name was sent.
 */
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie
  if (!header) return undefined

  const prefix = `${name}=`
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

/**
 * The refresh token to use: the current cookie's, else the legacy
 * `refreshToken` cookie's, each by the newest-cookie rule (`readCookie`).
 * @param request - The incoming request.
 * @returns The raw refresh token, or undefined when neither cookie was sent.
 */
function readRefreshTokenCookie(request: Request): string | undefined {
  const current = currentRefreshCookie(getEnv())
  return readCookie(request, current.name) ?? readCookie(request, LEGACY_REFRESH_TOKEN_COOKIE_NAME)
}

/**
 * Every distinct refresh token the request carries, current and legacy.
 * @param request - The incoming request.
 * @returns The raw tokens, without duplicates.
 */
function presentedRefreshTokens(request: Request): string[] {
  const current = currentRefreshCookie(getEnv())
  const tokens = [
    readCookie(request, current.name),
    readCookie(request, LEGACY_REFRESH_TOKEN_COOKIE_NAME),
  ].filter((token): token is string => token !== undefined)
  return [...new Set(tokens)]
}

/**
 * When the request carried the legacy `refreshToken` cookie, clear it: the
 * host-only form, and the COOKIE_DOMAIN form when one is set. A form that is
 * the current cookie is skipped, so this never clears the cookie being set.
 * Added before any new cookie, so a browser that treats two scopes as one
 * cookie keeps the new one.
 * @param request - The incoming request.
 * @param response - The response to add the clearing Set-Cookie lines to.
 * @param env - The validated environment.
 */
function clearLegacyRefreshCookies(request: Request, response: Response, env: Env): void {
  if (readCookie(request, LEGACY_REFRESH_TOKEN_COOKIE_NAME) === undefined) return
  const current = currentRefreshCookie(env)
  const forms = [refreshCookieSpec({ COOKIE_SECURE: false })]
  if (env.COOKIE_DOMAIN !== undefined) {
    forms.push(refreshCookieSpec({ COOKIE_SECURE: false, COOKIE_DOMAIN: env.COOKIE_DOMAIN }))
  }
  for (const form of forms) {
    if (!isSameCookie(form, current)) {
      response.clearCookie(form.name, refreshCookieOptions(form, env, 'strict'))
    }
  }
}

/**
 * Attach a freshly issued refresh token to the response as an httpOnly
 * cookie, named and scoped by `refreshCookieSpec`, and clear a legacy
 * cookie the request carried.
 *
 * `sameSite: 'strict'` is the cookie half of this API's stated CSRF
 * position (SECURITY.md: Bearer access tokens plus `SameSite` cookies, no
 * CSRF middleware) — it assumes the frontend and this API share the same
 * registrable domain (eTLD+1). A deployment that splits them across
 * different top-level domains would need `'lax'` or a real CSRF token
 * instead, since `'strict'` would then never send this cookie back at all.
 * `setOAuthRefreshTokenCookie` below is the one caller that passes `'lax'`.
 * @param request - The request, checked for a legacy cookie to clear.
 * @param response - The response to set the cookie on.
 * @param rawToken - The raw refresh token.
 * @param expiresAt - When the token expires.
 * @param sameSite - The cookie's `SameSite` attribute. Defaults to `'strict'`.
 */
function setRefreshTokenCookie(
  request: Request,
  response: Response,
  rawToken: string,
  expiresAt: Date,
  sameSite: 'strict' | 'lax' = 'strict'
): void {
  const env = getEnv()
  clearLegacyRefreshCookies(request, response, env)
  const spec = currentRefreshCookie(env)
  response.cookie(spec.name, rawToken, {
    ...refreshCookieOptions(spec, env, sameSite),
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
 * other endpoint — while allowing it on this top-level GET redirect chain.
 * A legacy `refreshToken` set by an earlier OAuth callback is `'lax'` and can
 * arrive here; `setRefreshTokenCookie` clears it like any other set.
 * @param request - The callback request.
 * @param response - The response to set the cookie on.
 * @param rawToken - The raw refresh token.
 * @param expiresAt - When the token expires.
 */
function setOAuthRefreshTokenCookie(
  request: Request,
  response: Response,
  rawToken: string,
  expiresAt: Date
): void {
  setRefreshTokenCookie(request, response, rawToken, expiresAt, 'lax')
}

/**
 * Clear the refresh cookie on logout, with the same name, path and domain
 * it was set with, and any legacy cookie the request carried.
 * @param request - The request, checked for a legacy cookie to clear.
 * @param response - The response to clear the cookie on.
 */
function clearRefreshTokenCookie(request: Request, response: Response): void {
  const env = getEnv()
  const spec = currentRefreshCookie(env)
  response.clearCookie(spec.name, refreshCookieOptions(spec, env, 'strict'))
  clearLegacyRefreshCookies(request, response, env)
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

    setRefreshTokenCookie(
      request,
      response,
      session.refreshToken.raw,
      session.refreshToken.expiresAt
    )
    successResponse(
      response,
      {
        user: toProfileResponse(session.user, session.platformRole),
        accessToken: session.accessToken,
      },
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

    setRefreshTokenCookie(
      request,
      response,
      refreshed.refreshToken.raw,
      refreshed.refreshToken.expiresAt
    )
    successResponse(response, { accessToken: refreshed.accessToken }, 'Token refreshed.')
  })

  /**
   * `POST /auth/logout`: revoke the session each presented refresh token
   * belongs to, and clear the cookies either way.
   *
   * Reads the same cookies `refresh` above does (current and legacy) — see
   * that handler's comment for why not the body too. Deliberately does not
   * require a valid access token: a user wanting to log out has often just
   * watched their access token expire, and revocation only ever needs the
   * refresh cookie.
   * A missing, forged, or already-revoked token is treated identically to a
   * live one — see `revokeRefreshToken`'s own header comment for why logout
   * must never let a caller learn which raw value was actually live.
   */
  logout = this.handle(async (request, response) => {
    // Both cookies, when a browser still holds the legacy one: logging out
    // ends both sessions. One at a time, since each locks the user row.
    for (const rawToken of presentedRefreshTokens(request)) {
      await revokeRefreshToken(rawToken)
    }
    clearRefreshTokenCookie(request, response)
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
            setOAuthRefreshTokenCookie(request, response, refreshToken.raw, refreshToken.expiresAt)

            response.redirect(`${env.WEB_URL}/auth/callback`)
          } catch (innerError) {
            logger.error('Google OAuth callback failed', { error: redactedForLog(innerError) })
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
