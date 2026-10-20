/**
 * @file The `/api/v1/auth` router. Every route except `GET /providers` (a read
 * of the caller's own data) carries a rate limiter, and routes that share a
 * budget share one limiter instance and its store prefix: an unlimited auth
 * route is an enumeration oracle, a mail amplifier, or a link-guessing
 * oracle. `RATE_LIMITS` (rate-limit.constants.ts) holds each limiter's
 * reasoning.
 */
import { Router, type RequestHandler } from 'express'
import passport from 'passport'
import {
  configurePassport,
  createOAuthSessionMiddleware,
  GOOGLE_STRATEGY_NAME,
  isGoogleOAuthEnabled,
} from '@/configs/passport.config'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { authController } from '@/controllers/auth.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { rememberOAuthApp } from '@/middlewares/oauth-app.middleware'
import { requireAllowedOriginWhenPresent } from '@/middlewares/origin.middleware'
import { refusePlatformOptions } from '@/middlewares/platform.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'
import { createPasskeyRouter } from '@/routes/passkey.routes'

/**
 * Build the auth routes. A person signs in by an emailed link
 * (`/link/request`, then `/link/verify`) or by Google. The refresh cookie
 * drives `/refresh` and `/logout`, a bearer drives `/sessions/revoke-others`
 * and `/providers`, and any signed-in user confirms it's them under `/step-up`
 * (by link) or `/passkeys/step-up` (by passkey).
 *
 * `requireJsonContentType` is mounted router-wide, ahead of every route, as a
 * CSRF control (see content-type.middleware.ts). A GET carries no content
 * type, which it allows, so the Google routes pass it too.
 *
 * The step-up routes under `/step-up` that take a bearer
 * (`/step-up/link/request`, `/step-up/link/verify`) run `requireAuth`, then
 * their limiter; there is no role gate, since step-up is open to every
 * signed-in user. The router-wide JSON gate answers a form body its 415, as
 * on every auth path. An OPTIONS anywhere under `/step-up` gets the
 * unknown path's 404 (`refusePlatformOptions`, right after the JSON gate),
 * not Express's automatic `Allow` answer; the passkey step-up routes sit
 * under `/passkeys/step-up`, which gets the same refusal. The two link
 * routes share one limiter instance, so one budget covers a request and its
 * confirm.
 *
 * `/refresh` and `/logout`, which the refresh cookie authenticates and which
 * take no body, also refuse a disallowed `Origin` (origin.middleware.ts): a
 * same-site sibling page could otherwise send them a body-less POST with the
 * cookie attached. `/link/verify` refuses one too: it sets the refresh
 * cookie and revokes the session the presented one names, so another page
 * must not be able to sign the browser in to an account of its choosing.
 * `/sessions/revoke-others` reads the cookie too, but only to narrow what it
 * spares; it authenticates with the bearer token, which a browser never
 * attaches on its own, so no other page can make it send one and it needs no
 * Origin check.
 *
 * The Google OAuth routes are mounted only when `isGoogleOAuthEnabled()`.
 * `configurePassport()` runs here, before either can handle a request; it is
 * idempotent. On both the limiter runs before `oauthSession`, so an
 * over-budget caller gets a 429 before a session is written to Redis. They
 * share one `oauthSession` instance, so the session middleware is built once.
 * @returns A router mounted at `/api/v1/auth` by `index.routes.ts`.
 */
export function createAuthRouter(): Router {
  const router = Router()
  // Router-wide and first, so no route can miss the CSRF gate.
  router.use(requireJsonContentType)
  // Express would answer OPTIONS on the step-up paths with an Allow header; an unknown auth path gets this 404.
  router.use('/step-up', refusePlatformOptions)
  router.use('/passkeys/step-up', refusePlatformOptions)
  // The two routes the refresh cookie authenticates: the Origin check runs before the limiter, so a refused page spends no budget.
  router.post(
    '/refresh',
    requireAllowedOriginWhenPresent,
    createRateLimiter(RATE_LIMITS.refresh),
    authController.refresh
  )
  router.post(
    '/logout',
    requireAllowedOriginWhenPresent,
    createRateLimiter(RATE_LIMITS.logout),
    authController.logout
  )
  // Per-IP only: a per-address limit would let anyone deny the owner; the follow-up's cooldown and daily budget bound one inbox.
  router.post(
    '/link/request',
    createRateLimiter(RATE_LIMITS.signInLinkRequest),
    authController.requestSignInLink
  )
  // A sign-in sets the refresh cookie: the Origin check runs before the limiter, as on /refresh, so a refused page spends no budget.
  router.post(
    '/link/verify',
    requireAllowedOriginWhenPresent,
    createRateLimiter(RATE_LIMITS.signInLinkVerify),
    authController.verifySignInLink
  )
  // requireAuth first: this limiter keys on request.user.id, which requireAuth sets.
  router.post(
    '/sessions/revoke-others',
    requireAuth,
    createRateLimiter(RATE_LIMITS.revokeOtherSessions),
    authController.revokeOtherSessions
  )
  // Step-up by link, for any signed-in user: requireAuth first, as the limiter keys on request.user.id.
  const stepUpLinkLimiter = createRateLimiter(RATE_LIMITS.stepUpLink)
  router.post(
    '/step-up/link/request',
    requireAuth,
    stepUpLinkLimiter,
    authController.requestStepUpLink
  )
  router.post(
    '/step-up/link/verify',
    requireAuth,
    stepUpLinkLimiter,
    authController.verifyStepUpLink
  )

  // No limiter: a read of the caller's own data, with no oracle to probe.
  router.get('/providers', requireAuth, authController.getAuthProviders)

  // Passkeys: the settings read is public; the rest gate on PASSKEY_MODE (passkey.routes.ts).
  router.use('/passkeys', createPasskeyRouter())

  if (isGoogleOAuthEnabled()) {
    configurePassport()
    const oauthSession = createOAuthSessionMiddleware()
    router.get(
      '/google',
      createRateLimiter(RATE_LIMITS.googleOAuth),
      oauthSession,
      rememberOAuthApp,
      passport.initialize(),
      // Cast: @types/passport types authenticate() on the singleton as any.
      passport.authenticate(GOOGLE_STRATEGY_NAME, {
        scope: ['profile', 'email'],
      }) as RequestHandler
    )
    router.get(
      '/google/callback',
      createRateLimiter(RATE_LIMITS.googleOAuthCallback),
      oauthSession,
      passport.initialize(),
      authController.handleGoogleCallback
    )
  }

  return router
}
