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
import { revokeOtherSessions, revokeRefreshToken } from '@/services/session.service'
import { frontendUrl } from '@/services/verification.service'
import { messageResponse, successResponse } from '@/utilities/response.utilities'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  reauthenticateSchema,
  registerSchema,
  resetPasswordSchema,
  revokeOtherSessionsSchema,
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
 * `refreshToken` is never read: a sibling subdomain or an on-path
 * attacker on plain http can plant it. `__Host-` stops both; `__Secure-`
 * (used with COOKIE_DOMAIN) stops only the plain-http planter, since
 * COOKIE_DOMAIN already trusts its subdomains.
 * Without COOKIE_SECURE the current name is that unprefixed one.
 * @param request - The incoming request.
 * @returns The raw refresh token, or undefined when the current cookie was not sent.
 */
function readRefreshTokenCookie(request: Request): string | undefined {
  return readCookie(request, currentRefreshCookie(getEnv()).name)
}

/**
 * Revoke the session of the refresh token the request carries, if any.
 * Logout's revoke, and also run after a sign-in: a session the browser's
 * cookie pointed at would otherwise stay refreshable after the new cookie
 * replaces it, outlive the next logout, and never trip reuse detection. The
 * new session's token is never the one revoked: it is only in the response.
 * @param request - The request whose cookie names the session.
 * @param options - `emitSignedOut: false` for a sign-in, which is not the user signing out.
 * @param options.emitSignedOut - Whether a live revoke emits `user_signed_out`; default true.
 * @returns Resolves once the presented token's session, if any, is revoked.
 */
async function revokePresentedSession(
  request: Request,
  options: { emitSignedOut?: boolean } = {}
): Promise<void> {
  const rawToken = readRefreshTokenCookie(request)
  if (rawToken === undefined) return
  await revokeRefreshToken(rawToken, options)
}

/**
 * Without COOKIE_SECURE but with COOKIE_DOMAIN, when the request carried a
 * `refreshToken` cookie, clear its host-only form too: the browser may hold
 * that scope beside the current one, and either may be the one it sent.
 * Added before any new cookie, so a browser that treats two scopes as one
 * cookie keeps the new one. Under COOKIE_SECURE it clears nothing.
 * @param request - The incoming request.
 * @param response - The response to add the clearing Set-Cookie line to.
 * @param env - The validated environment.
 */
function clearHostOnlyPlainRefreshCookie(request: Request, response: Response, env: Env): void {
  if (isCookieSecure(env) || env.COOKIE_DOMAIN === undefined) return
  const hostOnly = refreshCookieSpec({ COOKIE_SECURE: false })
  if (readCookie(request, hostOnly.name) === undefined) return
  response.clearCookie(hostOnly.name, refreshCookieOptions(hostOnly, env, 'strict'))
}

/**
 * Attach a freshly issued refresh token to the response as an httpOnly
 * cookie, named and scoped by `refreshCookieSpec`, after
 * `clearHostOnlyPlainRefreshCookie`.
 *
 * `sameSite: 'strict'` is the cookie half of this API's stated CSRF
 * position (SECURITY.md: Bearer access tokens plus `SameSite` cookies, no
 * CSRF middleware) — it assumes the frontend and this API share the same
 * registrable domain (eTLD+1). A deployment that splits them across
 * different top-level domains would need `'lax'` or a real CSRF token
 * instead, since `'strict'` would then never send this cookie back at all.
 * `setOAuthRefreshTokenCookie` below is the one caller that passes `'lax'`.
 * @param request - The request, checked for a host-only plain cookie to clear.
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
  clearHostOnlyPlainRefreshCookie(request, response, env)
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
 * it was set with, and its host-only plain form when
 * `clearHostOnlyPlainRefreshCookie` applies.
 * @param request - The request, checked for a host-only plain cookie to clear.
 * @param response - The response to clear the cookie on.
 */
function clearRefreshTokenCookie(request: Request, response: Response): void {
  const env = getEnv()
  const spec = currentRefreshCookie(env)
  response.clearCookie(spec.name, refreshCookieOptions(spec, env, 'strict'))
  clearHostOnlyPlainRefreshCookie(request, response, env)
}

/**
 * Clear the refresh cookie a failed refresh read, in every form the clear
 * helpers use for that name. `readRefreshTokenCookie` reads only the current
 * name. Without COOKIE_SECURE that is the unprefixed one, and its host-only
 * form is another scope of the one name that was read, so it is cleared too.
 * @param request - The refresh request.
 * @param response - The response to add the clearing Set-Cookie lines to.
 */
function clearPresentedRefreshCookie(request: Request, response: Response): void {
  const env = getEnv()
  const current = currentRefreshCookie(env)
  response.clearCookie(current.name, refreshCookieOptions(current, env, 'strict'))
  clearHostOnlyPlainRefreshCookie(request, response, env)
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
   * A refresh cookie the browser still presented has its session revoked
   * once the new one is issued. `no-store`, as every token response (RFC 6749 §5.1).
   */
  login = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const input = parseBody(loginSchema, request.body)
    const session = await authService.login(input)
    await revokePresentedSession(request, { emitSignedOut: false })

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
   * carrying only an unprefixed `refreshToken` cookie answers 401 and leaves
   * that cookie and its session alone: it is never read.
   * `no-store`, as every token response (RFC 6749 §5.1).
   */
  refresh = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const rawToken = readRefreshTokenCookie(request)
    if (!rawToken) throw new HttpError('Missing refresh token', 401)

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
   * `POST /auth/logout`: revoke the session the presented refresh token
   * belongs to, and clear the cookie either way.
   *
   * Reads the current cookie only, never the body (see `refresh` above for
   * why). Deliberately does not require a valid access token: a user wanting
   * to log out has often just watched their access token expire, and
   * revocation only ever needs the refresh cookie.
   * A missing, forged, or already-revoked token is treated identically to a
   * live one — see `revokeRefreshToken`'s JSDoc for why logout must never let
   * a caller learn which raw value was actually live.
   */
  logout = this.handle(async (request, response) => {
    await revokePresentedSession(request)
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
   * spared (`request.sessionId`): only the chain its refresh cookie names,
   * when the browser sent a live one (`readRefreshTokenCookie`, current name
   * only), or else the whole session. See auth.service.ts's `changePassword`
   * for the order and the failure design.
   */
  changePassword = this.handle(async (request, response) => {
    const input = parseBody(changePasswordSchema, request.body)
    await authService.changePassword(
      authenticatedUserId(request),
      request.sessionId,
      input,
      readRefreshTokenCookie(request)
    )

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
   * `POST /auth/sessions/revoke-others`: sign the caller out of every other
   * session, behind `requireAuth`, keeping the one this request came from
   * (`request.sessionId`): only the chain its refresh cookie names, when the
   * browser sent a live one (`readRefreshTokenCookie`, current name only),
   * or else the whole session. Takes `{}` or no body; answers how many
   * signed-in other sessions ended.
   */
  revokeOtherSessions = this.handle(async (request, response) => {
    // A body-less POST leaves request.body undefined; it means the same as `{}`.
    parseBody(revokeOtherSessionsSchema, request.body ?? {})
    const revoked = await revokeOtherSessions(
      authenticatedUserId(request),
      request.sessionId,
      readRefreshTokenCookie(request)
    )

    successResponse(response, { revoked }, 'Other sessions signed out.')
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
   * A refresh cookie the request carried (a Lax one from an earlier Google
   * sign-in; the cross-site hop withholds a Strict one) has its session
   * revoked once the new one is issued, as `login` does.
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
            await revokePresentedSession(request, { emitSignedOut: false })
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
