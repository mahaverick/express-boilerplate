/**
 * @file Auth handlers, HTTP only: parse the body, call auth.service or
 * google-auth.service, and shape the reply (cookies, redirects, status and
 * envelope). The enumeration and timing rules live in auth.service.ts.
 */
import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from 'express'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { getEnv, isCookieSecure, type Env } from '@/configs/env.config'
import {
  GOOGLE_STRATEGY_NAME,
  // eslint-disable-next-line sonarjs/deprecation -- the plain-http cookie name, revoked and cleared under COOKIE_SECURE
  LEGACY_REFRESH_TOKEN_COOKIE_NAME,
  refreshCookieSpec,
  type RefreshCookieSpec,
} from '@/constants/auth.constants'
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId, oauthAppOf } from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { redactedForLog } from '@/errors/postgres-errors'
import { toPublicAuthProviders } from '@/presenters/auth-provider.presenter'
import { toProfileResponse } from '@/presenters/user.presenter'
import * as authService from '@/services/auth.service'
import { completeGoogleSignIn } from '@/services/google-auth.service'
import { logger } from '@/services/logger.service'
import { revokeRefreshToken } from '@/services/session.service'
import { frontendUrl } from '@/services/verification.service'
import { messageResponse, successResponse } from '@/utilities/response.utilities'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  reauthenticateSchema,
  registerSchema,
  resetPasswordSchema,
} from '@/validators/auth.validators'
import { parseBody } from '@/validators/parse.validators'

/**
 * A URL without any trailing slashes, so `${base}/path` never doubles one.
 * @param url - A configured frontend URL.
 * @returns The URL with trailing slashes removed.
 */
function withoutTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') {
    end -= 1
  }
  return url.slice(0, end)
}

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
 * The refresh token to redeem: the current cookie's only, by the
 * newest-cookie rule (`readCookie`). Under COOKIE_SECURE the unprefixed
 * `refreshToken` is never redeemed: a sibling subdomain or an on-path
 * attacker on plain http can plant it, which is what the prefix stops.
 * Without COOKIE_SECURE the current name is that unprefixed one.
 * @param request - The incoming request.
 * @returns The raw refresh token, or undefined when the current cookie was not sent.
 */
function readRefreshTokenCookie(request: Request): string | undefined {
  return readCookie(request, currentRefreshCookie(getEnv()).name)
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
    // eslint-disable-next-line sonarjs/deprecation -- reads the old cookie name until the next major
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
  // eslint-disable-next-line sonarjs/deprecation -- reads the old cookie name until the next major
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
 * the frontend's `/auth/callback`) is issued by a document that just loaded
 * arriving from that same cross-site hop. `'lax'` still withholds the
 * cookie on cross-site subresource requests and cross-site unsafe (non-GET)
 * requests — the actual CSRF surface `'strict'` exists to close for every
 * other endpoint — while allowing it on this top-level GET redirect chain.
 * A legacy `refreshToken` cookie set by the OAuth callback is `'lax'`, so
 * this cross-site navigation can carry it here; `setRefreshTokenCookie`
 * clears it like any other set.
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

/**
 * Clear the refresh cookie a failed refresh read, in every form the clear
 * helpers use for that name. `readRefreshTokenCookie` reads only the current
 * name. When it is the unprefixed one (plain http), the legacy forms are
 * other scopes of the one name that was read, and are cleared too.
 * @param request - The refresh request.
 * @param response - The response to add the clearing Set-Cookie lines to.
 */
function clearPresentedRefreshCookie(request: Request, response: Response): void {
  const env = getEnv()
  const current = currentRefreshCookie(env)
  response.clearCookie(current.name, refreshCookieOptions(current, env, 'strict'))
  // eslint-disable-next-line sonarjs/deprecation -- detects plain http, where the current name is the unprefixed one
  if (current.name === LEGACY_REFRESH_TOKEN_COOKIE_NAME) {
    clearLegacyRefreshCookies(request, response, env)
  }
}

/**
 * Revoke and clear a legacy `refreshToken` cookie that a refresh carried
 * with no current cookie: under COOKIE_SECURE it is never redeemed, so a
 * planted one signs no one in and a pre-prefix one ends here. Logout's
 * primitive, so it resolves quietly for a dead or forged token.
 * @param request - The refresh request.
 * @param response - The response to add the clearing Set-Cookie lines to.
 * @returns Resolves once the token's session, if any, is revoked.
 */
async function revokeUnredeemedLegacyCookie(request: Request, response: Response): Promise<void> {
  // eslint-disable-next-line sonarjs/deprecation -- the unprefixed name is revoked and cleared, never redeemed
  const legacy = readCookie(request, LEGACY_REFRESH_TOKEN_COOKIE_NAME)
  if (legacy === undefined) return
  await revokeRefreshToken(legacy)
  clearLegacyRefreshCookies(request, response, getEnv())
}

/**
 * Rotate the presented refresh token, clearing its cookie when the answer is 401.
 * @param request - The refresh request.
 * @param response - The response a clear is added to.
 * @param rawToken - The raw token read from the cookie.
 * @returns The new access token and refresh token.
 * @throws {Error} Whatever `authService.refresh` throws, rethrown unchanged.
 */
async function refreshOrClearCookie(
  request: Request,
  response: Response,
  rawToken: string
): Promise<authService.RefreshResult> {
  try {
    return await authService.refresh(rawToken)
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 401) {
      clearPresentedRefreshCookie(request, response)
    }
    throw error
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
   *
   * A 401 after the cookie was read clears that cookie, so the browser stops
   * presenting a dead token on every page load. No 401 leaves the presented
   * token able to refresh:
   * - unknown, or issued for another purpose: no refresh can claim it;
   * - replayed outside the grace window, or into a killed session, or past
   *   the session's absolute lifetime: the session is killed;
   * - expired, or a refresh row without a session: the claim consumed it,
   *   and neither can get a sibling;
   * - the account is gone or inactive: the rotation consumed it, and while
   *   the account stays so every refresh for it answers 401.
   * Inside the grace window a replay into a live session gets a sibling and a
   * fresh cookie, so a 401 racing a successful rotation of the same token
   * comes from a branch that also kills or refuses the fresh cookie's session.
   * The one exception: a login or Google sign-in in another tab that lands
   * while a dead-cookie refresh is in flight loses its own fresh cookie too,
   * since the clear is by name — that user just signs in again.
   * The limiter's 429 and a 5xx never clear. Under COOKIE_SECURE a request
   * carrying only the legacy `refreshToken` cookie answers 401 after that
   * cookie's session is revoked and the cookie cleared: it is never redeemed.
   */
  refresh = this.handle(async (request, response) => {
    const rawToken = readRefreshTokenCookie(request)
    if (!rawToken) {
      await revokeUnredeemedLegacyCookie(request, response)
      throw new HttpError('Missing refresh token', 401)
    }

    const refreshed = await refreshOrClearCookie(request, response, rawToken)

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
   * Reads the current and the legacy cookie, never the body (see `refresh`
   * above for why). Deliberately does not require a valid access token: a
   * user wanting to log out has often just watched their access token
   * expire, and revocation only ever needs the refresh cookie. When the
   * browser holds both the current and the legacy cookie, both sessions end.
   * A missing, forged, or already-revoked token is treated identically to a
   * live one — see `revokeRefreshToken`'s JSDoc for why logout must never let
   * a caller learn which raw value was actually live.
   */
  logout = this.handle(async (request, response) => {
    // One at a time: each revoke locks the user row.
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
    void authService.requestPasswordReset(input.email, input.app)
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
   * `POST /auth/reauthenticate`: step-up for staff, behind `requireAuth` and
   * `requirePlatformRole('viewer')`. Checks the password against the caller's
   * own account, marks the session named by the token's `sid` as just
   * authenticated, and replies with a new access token. The refresh cookie
   * is untouched: the session is the same. See auth.service.ts's
   * `reauthenticate` for why a wrong password is a 400.
   */
  reauthenticate = this.handle(async (request, response) => {
    const input = parseBody(reauthenticateSchema, request.body)
    const result = await authService.reauthenticate(
      authenticatedUserId(request),
      request.sessionId,
      input
    )

    successResponse(response, { accessToken: result.accessToken }, 'Identity confirmed.')
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
   * Every failure redirects to `/login?error=...` on the frontend that
   * started the sign-in, never this API's JSON envelope (the browser arrived
   * by a full-page navigation).
   * `HttpError.code` is forwarded verbatim; anything else is
   * `processing_failed`; Google reporting an error or no profile is
   * `google_auth_failed`. Not wrapped in `handle()` for the same reason.
   * A maintenance-mode refusal is expected and carries the owner's customer
   * message, so it is not logged.
   * @param request - The incoming callback request, carrying Google's `code`/`state` query parameters.
   * @param response - The response.
   * @param next - Forwards a synchronous failure from `passport.authenticate` itself; every failure from the async body redirects instead.
   */
  handleGoogleCallback = (request: Request, response: Response, next: NextFunction): void => {
    const frontend = withoutTrailingSlashes(frontendUrl(oauthAppOf(request)))

    const authenticate = passport.authenticate(
      GOOGLE_STRATEGY_NAME,
      { session: false },
      (error: unknown, profile: GoogleProfile | false | null) => {
        void (async () => {
          if (error || !profile) {
            logger.error('Google OAuth callback failed', { error })
            response.redirect(`${frontend}/login?error=google_auth_failed`)
            return
          }

          try {
            const refreshToken = await completeGoogleSignIn(profile)
            setOAuthRefreshTokenCookie(request, response, refreshToken.raw, refreshToken.expiresAt)

            response.redirect(`${frontend}/auth/callback`)
          } catch (innerError) {
            if (!(innerError instanceof MaintenanceModeError)) {
              logger.error('Google OAuth callback failed', { error: redactedForLog(innerError) })
            }
            const code =
              innerError instanceof HttpError && innerError.code
                ? innerError.code
                : 'processing_failed'
            response.redirect(`${frontend}/login?error=${code}`)
          }
        })()
      }
      // Same cast, for the same reason, as the `/google` route's in auth.routes.ts.
    ) as RequestHandler

    authenticate(request, response, next)
  }
}

/**
 * The auth controller the auth routes mount.
 */
export const authController = new AuthController()
