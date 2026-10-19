/**
 * @file Auth handlers, HTTP only: parse the body, call auth.service or
 * google-auth.service, and shape the reply (cookies, redirects, status and
 * envelope). The enumeration and timing rules live in auth.service.ts.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import passport from 'passport'
import { getEnv } from '@/configs/env.config'
import type { GoogleCallbackResult, StepUpAuthenticateOptions } from '@/configs/passport.config'
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
import { frontendUrl } from '@/services/frontend-links.service'
import { completeGoogleSignIn } from '@/services/google-auth.service'
import { logger } from '@/services/logger.service'
import { revokeOtherSessions } from '@/services/session.service'
import { requestSignInLink, verifySignInLink } from '@/services/sign-in-link.service'
import {
  confirmGoogleStepUp,
  confirmStepUpLink,
  isStepUpIntentFresh,
  requestStepUpLink,
  startGoogleStepUp,
  type StepUpIntent,
} from '@/services/step-up.service'
import { messageResponse, successResponse } from '@/utilities/response.utilities'
import { revokeOtherSessionsSchema } from '@/validators/auth.validators'
import { parseBody } from '@/validators/parse.validators'
import {
  signInLinkRequestSchema,
  signInLinkVerifySchema,
} from '@/validators/sign-in-link.validators'
import { stepUpEmptyBodySchema, stepUpLinkVerifySchema } from '@/validators/step-up.validators'

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
 * Where a Google step-up popup lands: Apex's confirm page, with
 * `result=confirmed` or `error=step_up_failed`.
 * @param query - The page's query, without the `?`.
 * @returns The absolute URL.
 */
function stepUpConfirmPage(query: 'result=confirmed' | 'error=step_up_failed'): string {
  return `${withoutTrailingSlashes(frontendUrl('apex'))}/auth/confirm?${query}`
}

/**
 * The Google authorization a step-up asks for: `openid` for the ID token,
 * `max_age=0` for a fresh login whose `auth_time` the callback checks, and
 * `prompt=select_account`, which Google documents, for the account choice.
 */
const STEP_UP_GOOGLE_OPTIONS: StepUpAuthenticateOptions = {
  scope: ['openid', 'email', 'profile'],
  prompt: 'select_account',
  maxAge: 0,
}

/**
 * Handlers for `/api/v1/auth`.
 */
class AuthController extends BaseController {
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
   * signs nobody in answers one 400 `LINK_INVALID`, as does an `email` that
   * is not the link's address, which spends nothing. A refresh cookie the
   * browser still presented has its session revoked once the new one is
   * issued; the reply carries the redirect stored with the
   * link. `no-store`, as every token response (RFC 6749 §5.1).
   */
  verifySignInLink = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const input = parseBody(signInLinkVerifySchema, request.body)
    const session = await verifySignInLink(input.token, input.email)
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
   * The one exception: a link or Google sign-in in another tab that lands
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
   * `POST /auth/step-up/link/request`: mail a "confirm it's you" link for the
   * caller's session, behind `requireAuth` and `requirePlatformRole('viewer')`.
   * Takes `{}` or no body. Answers 202 with when the next request may mail
   * again; inside the cooldown a 429 `STEP_UP_LINK_COOLDOWN` with
   * `Retry-After`.
   */
  requestStepUpLink = this.handle(async (request, response) => {
    // A body-less POST leaves request.body undefined; it means the same as `{}`.
    parseBody(stepUpEmptyBodySchema, request.body ?? {})
    const result = await requestStepUpLink(authenticatedUserId(request), request.sessionId)

    successResponse(response, result, 'Check your inbox for a confirmation link.', 202)
  })

  /**
   * `POST /auth/step-up/link/verify`: confirm a step-up link for the caller's
   * session, behind `requireAuth` and `requirePlatformRole('viewer')`, and
   * reply with a new access token carrying the new `auth_time`. The refresh
   * cookie is untouched: the session is the same. A link this session cannot
   * use answers 400 `LINK_INVALID`, never a 401. `no-store`, as every token
   * response (RFC 6749 §5.1).
   */
  verifyStepUpLink = this.handle(async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const input = parseBody(stepUpLinkVerifySchema, request.body)
    const result = await confirmStepUpLink(
      authenticatedUserId(request),
      request.sessionId,
      input.token
    )

    successResponse(response, { accessToken: result.accessToken }, 'Identity confirmed.')
  })

  /**
   * `POST /auth/step-up/google/start`: record a Google step-up for the
   * caller's session in the OAuth session, behind `requireAuth`,
   * `requirePlatformRole('viewer')` and the OAuth session middleware, and
   * answer 204 with the OAuth session cookie. The Apex popup then opens
   * `GET /auth/step-up/google`, a navigation, which carries that cookie but
   * no bearer: that is why the start is a call of its own. Takes `{}` or no
   * body.
   */
  startGoogleStepUp = this.handle(async (request, response) => {
    parseBody(stepUpEmptyBodySchema, request.body ?? {})
    const intent = await startGoogleStepUp(authenticatedUserId(request), request.sessionId)
    request.session.oauthIntent = intent

    response.status(204).end()
  })

  /**
   * `GET /auth/step-up/google`: the Apex popup's navigation to Google for a
   * step-up the start recorded, no older than the OAuth session lasts. It
   * asks Google for a fresh login (`STEP_UP_GOOGLE_OPTIONS`). With no such
   * intent the popup lands on Apex's confirm page with
   * `error=step_up_failed`. Not wrapped in `handle()`: it answers with a
   * redirect, never the JSON envelope.
   * @param request - The popup's request, after the OAuth session middleware and `passport.initialize()`.
   * @param response - The response.
   * @param next - Forwards a synchronous failure from `passport.authenticate` itself.
   */
  openGoogleStepUp = (request: Request, response: Response, next: NextFunction): void => {
    const intent = oauthIntentOf(request)
    if (intent.kind !== 'step_up' || !isStepUpIntentFresh(intent)) {
      response.redirect(stepUpConfirmPage('error=step_up_failed'))
      return
    }
    // Cast for the same reason as the `/google` route in auth.routes.ts: @types/passport types authenticate() as any.
    const authenticate = passport.authenticate(
      GOOGLE_STRATEGY_NAME,
      STEP_UP_GOOGLE_OPTIONS
    ) as RequestHandler
    authenticate(request, response, next)
  }

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
   * `GET /auth/providers`: which methods can sign this account in, as
   * `{ providers }`. Every account has its `email` row, since an emailed link
   * signs any account in. Read-only: unlinking a method would need its own
   * guard against removing the last way in.
   */
  getAuthProviders = this.handle(async (request, response) => {
    const providers = await authService.getAuthProviders(authenticatedUserId(request))

    successResponse(
      response,
      { providers: toPublicAuthProviders(providers) },
      'Auth providers retrieved.'
    )
  })

  /**
   * `GET /auth/google/callback`: handle Google's redirect back to this API
   * once the user completes (or abandons) Google's consent screen.
   *
   * The stored intent picks the branch. A step-up goes to
   * `completeGoogleStepUp`, which never
   * sets a cookie or issues a session; a stored step-up whose fields do not
   * check out is refused as a failed step-up, never read as a sign-in.
   * Everything below describes the sign-in branch.
   *
   * `session: false`: the OAuth express-session exists only to carry the CSRF
   * `state`; letting Passport call `req.login()` would serialize the profile
   * into it for nothing. Passport does not await the custom callback, so its
   * body is an immediately-invoked async function: an async callback passed
   * directly would turn a rejection into an unhandled one.
   *
   * A refresh cookie the request carried (a Lax one from an earlier Google
   * sign-in; the cross-site hop withholds a Strict one) has its session
   * revoked once the new one is issued, as a link sign-in does.
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
    if (intent.kind === 'invalid_step_up') {
      // A tampered step-up never reads as a sign-in: refuse before Google's answer is even read.
      delete request.session.oauthIntent
      response.redirect(stepUpConfirmPage('error=step_up_failed'))
      return
    }
    if (intent.kind === 'step_up') {
      this.completeGoogleStepUp(intent, request, response, next)
      return
    }
    const frontend = withoutTrailingSlashes(frontendUrl(intent.app))

    const authenticate = passport.authenticate(
      GOOGLE_STRATEGY_NAME,
      { session: false },
      (error: unknown, result: GoogleCallbackResult | false | null) => {
        void (async () => {
          if (error || !result) {
            logger.error('Google OAuth callback failed', { error })
            response.redirect(`${frontend}/login?error=google_auth_failed`)
            return
          }

          try {
            const { refreshToken, isNewUser } = await completeGoogleSignIn(
              result.profile,
              intent.app
            )
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

  /**
   * The callback's step-up branch: the intent is removed from the OAuth
   * session first, so the round-trip confirms at most once, then
   * `confirmGoogleStepUp` checks the ID token and the linked identity and
   * marks the session. The popup lands on Apex's confirm page, with
   * `result=confirmed` or `error=step_up_failed`. This branch sets no cookie,
   * issues no token and revokes nothing: the session that asked is the one
   * confirmed, and the popup's own cookies are left as they are.
   * @param intent - The stored step-up intent.
   * @param request - The callback request.
   * @param response - The response.
   * @param next - Forwards a synchronous failure from `passport.authenticate` itself.
   */
  private completeGoogleStepUp(
    intent: StepUpIntent,
    request: Request,
    response: Response,
    next: NextFunction
  ): void {
    delete request.session.oauthIntent
    const authenticate = passport.authenticate(
      GOOGLE_STRATEGY_NAME,
      { session: false },
      (error: unknown, result: GoogleCallbackResult | false | null) => {
        void (async () => {
          if (error || !result) {
            logger.warn('Google step-up callback failed', { error })
            response.redirect(stepUpConfirmPage('error=step_up_failed'))
            return
          }
          try {
            await confirmGoogleStepUp(intent, result.profile, result.idToken)
            response.redirect(stepUpConfirmPage('result=confirmed'))
          } catch (innerError) {
            // A refusal is logged where its reason is known; anything else is a fault.
            if (!(innerError instanceof HttpError && innerError.code === 'step_up_failed')) {
              logger.error('Google step-up callback failed', { error: redactedForLog(innerError) })
            }
            response.redirect(stepUpConfirmPage('error=step_up_failed'))
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
