/**
 * @file The `/api/v1/auth` router. Every route except `GET /providers` (a read
 * of the caller's own data) carries a rate limiter, and routes that share a
 * budget share one limiter instance and its store prefix: an unlimited auth
 * route is an enumeration oracle, a bcrypt or mail
 * amplifier, or a password oracle. `RATE_LIMITS`
 * (rate-limit.constants.ts) holds each limiter's reasoning.
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
import { verificationController } from '@/controllers/verification.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { rememberOAuthApp } from '@/middlewares/oauth-app.middleware'
import { requireAllowedOriginWhenPresent } from '@/middlewares/origin.middleware'
import { refusePlatformOptions, requirePlatformRole } from '@/middlewares/platform.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the auth routes.
 *
 * `requireJsonContentType` is mounted router-wide, ahead of every route, as a
 * CSRF control (see content-type.middleware.ts). A GET carries no content
 * type, which it allows, so the Google routes pass it too.
 *
 * The staff-only step-up routes under `/step-up` that take a bearer
 * (`/step-up/link/request`, `/step-up/link/verify`, `/step-up/google/start`)
 * answer a refused caller exactly what an unknown auth path answers: the
 * router-wide JSON gate's 415 for a form body, as on every auth path, and
 * otherwise the platform role gate's 404 before the limiter, so no
 * `RateLimit-*` headers. An OPTIONS anywhere under `/step-up` gets the
 * unknown path's 404 (`refusePlatformOptions`, right after the JSON gate),
 * not Express's automatic `Allow` answer. The two link routes share one
 * limiter instance, so one budget covers a request and its confirm.
 *
 * `/refresh` and `/logout`, which the refresh cookie authenticates and which
 * take no body, also refuse a disallowed `Origin` (origin.middleware.ts): a
 * same-site sibling page could otherwise send them a body-less POST with the
 * cookie attached. `/link/verify` refuses one too: it sets the refresh
 * cookie and revokes the session the presented one names, so another page
 * must not be able to sign the browser in to an account of its choosing.
 * `/change-password` and `/sessions/revoke-others` read the cookie too, but
 * only to narrow what they spare; they authenticate with the bearer token,
 * which a browser never attaches on its own, so no other page can make it
 * send one and they need no Origin check.
 *
 * Google OAuth routes, the two Google step-up routes included, are mounted
 * only when `isGoogleOAuthEnabled()`. `configurePassport()` runs here, before
 * any of them can handle a request; it is idempotent. On every one the
 * limiter runs before `oauthSession`, so an over-budget caller gets a 429
 * before a session is written to Redis. They share one `oauthSession`
 * instance, so the session middleware is built once, and `/google` and the
 * step-up popup's `GET /step-up/google`, the two navigations to Google, share
 * one `googleOAuth` limiter instance. The step-up popup's route carries no
 * bearer: the start (`POST /step-up/google/start`, staff only) wrote the
 * intent it needs into the OAuth session, and without one it redirects to
 * Apex's confirm page with an error.
 * @returns A router mounted at `/api/v1/auth` by `index.routes.ts`.
 */
export function createAuthRouter(): Router {
  const router = Router()
  // Router-wide and first, so no route can miss the CSRF gate.
  router.use(requireJsonContentType)
  // Express would answer OPTIONS on the staff routes with an Allow header; an unknown auth path gets this 404.
  router.use('/step-up', refusePlatformOptions)
  router.post('/register', createRateLimiter(RATE_LIMITS.register), authController.register)
  // ip+email 5/15min, then IP 100/15min, then account 100/h; a rejection spends no later budget.
  router.post(
    '/login',
    createRateLimiter(RATE_LIMITS.login),
    createRateLimiter(RATE_LIMITS.loginIp),
    createRateLimiter(RATE_LIMITS.loginAccount),
    authController.login
  )
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
  router.post(
    '/verify-email',
    createRateLimiter(RATE_LIMITS.verifyEmail),
    verificationController.verifyEmail
  )
  // Two limiters in series, not a composite key: each bounds its own threat.
  router.post(
    '/resend-verification',
    createRateLimiter(RATE_LIMITS.resendVerificationIp),
    createRateLimiter(RATE_LIMITS.resendVerificationEmail),
    verificationController.resendVerification
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
  // Per-IP only: a per-address limit would let anyone deny the owner; the service's mail cooldown bounds one inbox.
  router.post(
    '/forgot-password',
    createRateLimiter(RATE_LIMITS.forgotPasswordIp),
    authController.forgotPassword
  )
  router.post(
    '/reset-password',
    createRateLimiter(RATE_LIMITS.resetPassword),
    authController.resetPassword
  )
  // requireAuth first: this limiter keys on request.user.id, which requireAuth sets.
  router.post(
    '/change-password',
    requireAuth,
    createRateLimiter(RATE_LIMITS.changePassword),
    authController.changePassword
  )
  // requireAuth first: this limiter keys on request.user.id, which requireAuth sets.
  router.post(
    '/sessions/revoke-others',
    requireAuth,
    createRateLimiter(RATE_LIMITS.revokeOtherSessions),
    authController.revokeOtherSessions
  )
  // Staff-only step-up: the platform gate answers non-staff the unknown-route 404 before the limiter keys on request.user.id.
  const stepUpLinkLimiter = createRateLimiter(RATE_LIMITS.stepUpLink)
  router.post(
    '/step-up/link/request',
    requireAuth,
    requirePlatformRole('viewer'),
    stepUpLinkLimiter,
    authController.requestStepUpLink
  )
  router.post(
    '/step-up/link/verify',
    requireAuth,
    requirePlatformRole('viewer'),
    stepUpLinkLimiter,
    authController.verifyStepUpLink
  )

  // No limiter: a read of the caller's own data, with no oracle to probe.
  router.get('/providers', requireAuth, authController.getAuthProviders)

  if (isGoogleOAuthEnabled()) {
    configurePassport()
    const oauthSession = createOAuthSessionMiddleware()
    const googleOAuthLimiter = createRateLimiter(RATE_LIMITS.googleOAuth)
    router.get(
      '/google',
      googleOAuthLimiter,
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
    // Staff-only, as the link routes: the role gate before the limiter, and the session written last.
    router.post(
      '/step-up/google/start',
      requireAuth,
      requirePlatformRole('viewer'),
      createRateLimiter(RATE_LIMITS.stepUpGoogle),
      oauthSession,
      authController.startGoogleStepUp
    )
    router.get(
      '/step-up/google',
      googleOAuthLimiter,
      oauthSession,
      passport.initialize(),
      authController.openGoogleStepUp
    )
  }

  return router
}
