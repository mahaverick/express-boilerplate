/**
 * @file Auth handlers, HTTP only: parse the body, call auth.service or
 * google-auth.service, and shape the reply (cookies, redirects, status and
 * envelope). The enumeration and timing rules live in auth.service.ts.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { getEnv } from '@/configs/env.config'
import { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'
import { BaseController } from '@/controllers/base.controller'
import {
  authenticatedUserId,
  clearHostOnlyPlainRefreshCookie,
  currentRefreshCookie,
  oauthIntentOf,
  readRefreshTokenCookie,
  refreshCookieOptions,
  revokePresentedSession,
  setRefreshTokenCookie,
} from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { redactedForLog } from '@/errors/postgres-errors'
import { toPublicAuthProviders } from '@/presenters/auth-provider.presenter'
import { toProfileResponse } from '@/presenters/user.presenter'
import * as authService from '@/services/auth.service'
import { completeGoogleSignIn } from '@/services/google-auth.service'
import { logger } from '@/services/logger.service'
import { revokeOtherSessions } from '@/services/session.service'
import { requestSignInLink, verifySignInLink } from '@/services/sign-in-link.service'
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
import {
  signInLinkRequestSchema,
  signInLinkVerifySchema,
} from '@/validators/sign-in-link.validators'

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
 * Attach a freshly issued refresh token to the response for the Google
 * OAuth callback: `setRefreshTokenCookie` with `sameSite: 'lax'` in place of
 * its `'strict'` default.
 *
 * `'lax'` here is a decision, and it costs nothing: a `'lax'` cookie is still
 * withheld from cross-site `POST`s and subresource requests, and both routes
 * that act on the cookie, `/refresh` and `/logout`, are `POST`s behind the
 * Origin check, and the one `GET` that reads it, this callback, only revokes.
 * It also lasts only until the first rotation, which re-sets the cookie
 * `'strict'` (SECURITY.md, "The refresh cookie", `#the-refresh-cookie`).
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
 * form is another scope of the name that was read, so it is cleared too.
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

const SIGN_IN_LINK_REQUEST_MESSAGE = 'Check your inbox for a sign-in link.'

/**
 * The query a Google callback's success redirect carries: the stored
 * redirect, then `new=1` for an account this sign-in created.
 * @param redirect - The same-origin path the start stored, if any.
 * @param isNewUser - Whether the sign-in created the account.
 * @returns `?…`, or '' when there is nothing to carry.
 */
function callbackQuery(redirect: string | undefined, isNewUser: boolean): string {
  const query = new URLSearchParams()
  if (redirect !== undefined) query.set('redirect', redirect)
  if (isNewUser) query.set('new', '1')
  const text = query.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * Handlers for `/api/v1/auth`, except email verification (`VerificationController`).
 */
class AuthController extends BaseController {
  /**
   * `POST /auth/register`: register a new user with an email and password.
   *
   * A free and a taken address answer an identical 202 with `data: null`
   * (a 201/409 split would be an enumeration oracle). The reply goes out
   * BEFORE the follow-up work (the sign-up event and the mail), so the two
   * branches do not differ by that work's cost.
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
   * auth.service.ts for why every credential failure is one identical,
   * equally costly 401. A refresh cookie the browser still presented has its
   * session revoked once the new one is issued. `no-store`, as every token
   * response (RFC 6749 §5.1).
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
   * `POST /auth/link/request`: ask for a sign-in link by email.
   *
   * One identical 202 with `data: null` for every address, new, existing or
   * deactivated. The handler is synchronous on purpose: the reply goes out
   * before the lookup, the cooldown or the mail, so no branch differs by
   * their cost, and the follow-up runs after it.
   */
  requestSignInLink = this.handle((request, response) => {
    const input = parseBody(signInLinkRequestSchema, request.body)
    const followUp = requestSignInLink(input)

    messageResponse(response, SIGN_IN_LINK_REQUEST_MESSAGE, 202)
    // Never rejects: the service logs its own failure.
    void followUp()
  })

  /**
   * `POST /auth/link/verify`: sign in with the token from a mailed link,
   * creating the account on the first click (`isNewUser`). Every link that
   * signs nobody in answers one 400 `LINK_INVALID`. A refresh cookie the
   * browser still presented has its session revoked once the new one is
   * issued, as `login` does; the reply carries the redirect stored with the
   * link. `no-store`, as every token response (RFC 6749 §5.1).
   */
  verifySignInLink = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const input = parseBody(signInLinkVerifySchema, request.body)
    const session = await verifySignInLink(input.token)
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
        isNewUser: session.isNewUser,
        redirect: session.redirect,
      },
      'Signed in.'
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
   * A 401 from `authService.refresh` clears that cookie, so the browser stops
   * presenting a dead token on every page load. None of those 401s leaves the
   * presented token able to refresh:
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
   * A current cookie sent with an empty value answers 401 and is cleared the
   * same way; a request with no current cookie clears nothing.
   * The limiter's 429 and a 5xx never clear. Under COOKIE_SECURE a request
   * carrying only an unprefixed `refreshToken` cookie answers 401 and leaves
   * that cookie and its session alone: it is never read.
   * `no-store`, as every token response (RFC 6749 §5.1).
   */
  refresh = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const rawToken = readRefreshTokenCookie(request)
    if (!rawToken) {
      // An empty current cookie can never refresh: clear it as any other 401 does, or the browser sends it on every refresh.
      if (rawToken === '') clearPresentedRefreshCookie(request, response)
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
   * `POST /auth/logout`: revoke the session the presented refresh token
   * belongs to, and clear the cookie either way.
   *
   * Reads the current cookie only, never the body (see `refresh` for why).
   * Deliberately does not require a valid access token: a user wanting to log
   * out has often just watched their access token expire, and revocation only
   * ever needs the refresh cookie. A missing, forged or already-revoked token
   * gets the same reply as a live one (see `revokeRefreshToken` for why, and
   * for the timing it does not hide).
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
   * starts and the rest is fire-and-forget. The handler is synchronous on
   * purpose: nothing in it is awaited.
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
   * A weak password gets `parseBody`'s field-level 400 before the token is
   * looked at. That is safe here, unlike verify-email: the token is the only
   * secret in play, so "too short" leaks nothing about it.
   */
  resetPassword = this.handle(async (request, response) => {
    const input = parseBody(resetPasswordSchema, request.body)
    await authService.resetPassword(input)

    messageResponse(response, 'Password has been reset.')
  })

  /**
   * `POST /auth/change-password`: change the authenticated caller's own
   * password, behind `requireAuth`. The session making this request is spared
   * (`request.sessionId`): only the chain its refresh cookie names, when the
   * browser sent a live one (`readRefreshTokenCookie`, current name only), or
   * else the whole session. A token without a session id spares nothing. See
   * `changePassword` in auth.service.ts for the order and the failure design.
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
   * is untouched: the session is the same. See `reauthenticate` in
   * auth.service.ts for why a wrong password is a 400.
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
   * or else the whole session. A token without a session id gets a 401. Takes
   * `{}` or no body. Answers how many signed-in other sessions it ended.
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
   * whether it has a password. Read-only: unlinking a method would need its own
   * guard against removing the last way in.
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
   * body is an immediately-invoked async function: an async callback passed
   * directly would turn a rejection into an unhandled one.
   *
   * A refresh cookie the request carried (a Lax one from an earlier Google
   * sign-in; the cross-site hop withholds a Strict one) has its session
   * revoked once the new one is issued, as `login` does.
   *
   * A success redirects to `/auth/callback` on the frontend that started the
   * sign-in, carrying the redirect the start stored (`redirect=`) and `new=1`
   * when the sign-in created the account.
   *
   * Every failure of the async body redirects to `/login?error=...` on the
   * frontend that started the sign-in, never this API's JSON envelope (the
   * browser arrived by a full-page navigation), so it is not wrapped in
   * `handle()`. `HttpError.code` is forwarded verbatim and anything else is
   * `processing_failed`; Google reporting an error or no profile is
   * `google_auth_failed`. A maintenance-mode refusal is expected, so it is not
   * logged.
   * @param request - The incoming callback request, carrying Google's `code`/`state` query parameters.
   * @param response - The response.
   * @param next - Forwards a synchronous failure from `passport.authenticate` itself.
   */
  handleGoogleCallback = (request: Request, response: Response, next: NextFunction): void => {
    const intent = oauthIntentOf(request)
    const frontend = withoutTrailingSlashes(frontendUrl(intent.app))

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
            const { refreshToken, isNewUser } = await completeGoogleSignIn(profile, intent.app)
            await revokePresentedSession(request, { emitSignedOut: false })
            setOAuthRefreshTokenCookie(request, response, refreshToken.raw, refreshToken.expiresAt)

            response.redirect(
              `${frontend}/auth/callback${callbackQuery(intent.redirect, isNewUser)}`
            )
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
      // Cast for the same reason as the `/google` route in auth.routes.ts: @types/passport types authenticate() as any.
    ) as RequestHandler

    authenticate(request, response, next)
  }
}

/**
 * The instance whose handlers `createAuthRouter` mounts.
 */
export const authController = new AuthController()
