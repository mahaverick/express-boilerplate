/**
 * @file The `/api/v1/auth` router. Every route except `GET /providers` (a read
 * of the caller's own data) carries a rate limiter with its own store prefix:
 * an unlimited auth route is an enumeration oracle, a bcrypt or mail
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
import { requirePlatformRole } from '@/middlewares/platform.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the auth routes.
 *
 * `requireJsonContentType` is mounted router-wide, ahead of every route, as a
 * CSRF control (see content-type.middleware.ts). A GET carries no content
 * type, which it allows, so the Google routes pass it too.
 *
 * Google OAuth routes are mounted only when `isGoogleOAuthEnabled()`.
 * `configurePassport()` runs here, before either route can handle a request;
 * it is idempotent. On both routes the limiter runs before `oauthSession`, so
 * an over-budget caller gets a 429 before a session is written to Redis. Both
 * share one `oauthSession` instance, since the callback reads the `state` the
 * redirect wrote.
 * @returns A router mounted at `/api/v1/auth` by `index.routes.ts`.
 */
export function createAuthRouter(): Router {
  const router = Router()
  // Router-wide so no route can miss the CSRF gate.
  router.use(requireJsonContentType)
  router.post('/register', createRateLimiter(RATE_LIMITS.register), authController.register)
  // ip+email 5/15min, then IP 100/15min, then account 100/h; a rejection spends no later budget.
  router.post(
    '/login',
    createRateLimiter(RATE_LIMITS.login),
    createRateLimiter(RATE_LIMITS.loginIp),
    createRateLimiter(RATE_LIMITS.loginAccount),
    authController.login
  )
  router.post('/refresh', createRateLimiter(RATE_LIMITS.refresh), authController.refresh)
  router.post('/logout', createRateLimiter(RATE_LIMITS.logout), authController.logout)
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
  // Per-IP and per-address limiters bound the mail one IP or one victim address can trigger.
  router.post(
    '/forgot-password',
    createRateLimiter(RATE_LIMITS.forgotPasswordIp),
    createRateLimiter(RATE_LIMITS.forgotPasswordEmail),
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
  // Staff-only step-up: the platform gate answers non-staff the unknown-route 404 before this limiter keys on request.user.id.
  router.post(
    '/reauthenticate',
    requireAuth,
    requirePlatformRole('viewer'),
    createRateLimiter(RATE_LIMITS.reauthenticate),
    authController.reauthenticate
  )

  // No limiter: a read of the caller's own data, with no oracle to probe.
  router.get('/providers', requireAuth, authController.getAuthProviders)

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
