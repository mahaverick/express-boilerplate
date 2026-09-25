// src/routes/auth.routes.ts
//
// Registration, login, refresh, logout, verify-email,
// resend-verification, forgot-password, reset-password, and
// change-password — all nine share the one `/api/v1/auth` mount point
// wired in index.routes.ts, so they live in this one router.
//
// Built and returned by a function, not registered as a top-level side
// effect on an exported const: the latter is exactly what
// unicorn/no-top-level-side-effects exists to catch, and createApp()
// (app.ts) already establishes "build inside a function, return the
// result" as this codebase's convention for assembling Express objects.
// `createRateLimiter` follows the identical pattern for the same reason —
// see rate-limit.middleware.ts's header comment.
//
// EVERY route on this router carries a limiter, each with its own store
// prefix. That is the standing rule for this file, not nine independent
// decisions: an unlimited auth route is either an enumeration oracle, a
// bcrypt/email amplifier, a password oracle, or some combination.
// `RATE_LIMITS` (rate-limit.constants.ts) holds the per-endpoint reasoning,
// one comment per entry. verify-email and reset-password each carry their
// own single `rl:verify-email:` / `rl:reset-password:` prefix;
// resend-verification and forgot-password each carry TWO limiters in
// series, with their own prefixes (`rl:resend-verification-ip:` /
// `rl:resend-verification-email:`, `rl:forgot-password-ip:` /
// `rl:forgot-password-email:`) — see the matching `RATE_LIMITS` entries for
// why one composite key is not enough for either pair of threats.
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
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the auth routes.
 * @returns A router mounted at `/api/v1/auth` by `index.routes.ts`.
 */
export function createAuthRouter(): Router {
  const router = Router()
  // Router-wide, ahead of every route: a CSRF control, not a formatting
  // preference. Without it, `express.urlencoded()` (mounted globally in
  // app.ts) lets an attacker's page auto-submit a cross-site FORM to
  // /login and silently log the victim into the attacker's account —
  // `sameSite: 'strict'` governs when a cookie is SENT, not whether a
  // cross-site response may SET one. Mounted with `use` rather than
  // per-route so every route on this router inherits it by default
  // instead of having to remember. See content-type.middleware.ts.
  router.use(requireJsonContentType)
  router.post('/register', createRateLimiter(RATE_LIMITS.register), authController.register)
  // Three limiters in series, tightest first, so an attempt it rejects
  // never spends the per-IP or per-account budget. See
  // ARCHITECTURE.md/SECURITY.md.
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
  // Two limiters in series, not a composite key — each bounds its own
  // threat, and either firing alone must be enough. See the
  // resendVerificationIp/resendVerificationEmail entries in
  // `RATE_LIMITS`.
  router.post(
    '/resend-verification',
    createRateLimiter(RATE_LIMITS.resendVerificationIp),
    createRateLimiter(RATE_LIMITS.resendVerificationEmail),
    verificationController.resendVerification
  )
  // Same two-limiters-in-series shape as resend-verification, for the
  // identical reason (see the forgotPasswordIp/forgotPasswordEmail entries
  // in `RATE_LIMITS`): forgot-password already answers identically for a
  // known and an unknown address, so it leaks no account, but that alone
  // does not bound how much outbound mail one IP — or one victim address —
  // can trigger.
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
  // The two routes on this router that are NOT public: siblings of
  // forgot-password/reset-password (same "what this account signs in with"
  // family), not of /profile (name/avatar) — so they live here, not on
  // profile.routes.ts. This router has no router-wide `requireAuth` the way
  // profile.routes.ts does, so it is attached PER-ROUTE, here. On
  // change-password it goes ahead of the rate limiter — deliberately in that
  // order: `RATE_LIMITS.changePassword` keys on `request.user.id`
  // (rate-limit.constants.ts's own comment on `authenticatedUserRateLimitKey`),
  // which does not exist until `requireAuth` has populated it. Every other
  // limiter on this router runs first, ahead of its
  // handler, because every other route is unauthenticated; this is the one
  // exception, for the identical reason its limiter is keyed on the user
  // rather than IP.
  router.post(
    '/change-password',
    requireAuth,
    createRateLimiter(RATE_LIMITS.changePassword),
    authController.changePassword
  )

  // No rate limiter: this one only reads, returns nothing an unauthenticated
  // caller could obtain, and offers no oracle to probe — unlike
  // change-password above, whose limiter exists because it says whether a
  // supplied password is correct. `requireAuth` is the whole guard.
  router.get('/providers', requireAuth, authController.getAuthProviders)

  // Google OAuth — only mounted when GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
  // are configured (isGoogleOAuthEnabled(), passport.config.ts); an
  // unconfigured deployment never exposes this route at all rather than
  // exposing one that would fail on first use. `router.use(requireJsonContentType)`
  // above still runs ahead of this route, deliberately not bypassed: a GET
  // navigation (a real browser redirect, or supertest's `.get()`) sends no
  // `Content-Type` header, which `mediaTypeOf` normalises to `''` —
  // `ACCEPTED_MEDIA_TYPES` already allows that (content-type.middleware.ts's
  // own header comment: "a request with no content type at all is allowed,
  // on purpose"), so this GET route passes through the same middleware
  // every POST route does without needing a different position on the
  // router or an exemption.
  //
  // `configurePassport()` is called here, not at module scope: it must run
  // exactly once before either OAuth route can handle a request, and
  // `createAuthRouter()` is that one guaranteed call site — see
  // passport.config.ts's own header comment for why it is safe to call on
  // every `createAuthRouter()` invocation (idempotent registration) rather
  // than needing a separate boot-time hook.
  //
  // `createRateLimiter(RATE_LIMITS.googleOAuth)` is listed FIRST in the
  // chain, ahead of `oauthSession` — same ordering every other route on
  // this router uses (the limiter runs before the handler it protects),
  // and load-bearing here specifically: it must reject an over-budget
  // caller with a 429 BEFORE `oauthSession` ever writes a session to
  // Redis, or the limiter would still let an attacker spend the exact
  // resource it exists to bound.
  if (isGoogleOAuthEnabled()) {
    configurePassport()
    const oauthSession = createOAuthSessionMiddleware()
    router.get(
      '/google',
      createRateLimiter(RATE_LIMITS.googleOAuth),
      oauthSession,
      passport.initialize(),
      // `as RequestHandler`: `@types/passport`'s `Authenticator.authenticate`
      // resolves to `any` for the `PassportStatic` singleton — its
      // `AuthenticateRet` generic parameter defaults to `any` and nothing in
      // this project instantiates `Authenticator` with a narrower one, which
      // holds regardless of `GOOGLE_STRATEGY_NAME` vs the `'google'` literal.
      // Left uncast, `@typescript-eslint/no-unsafe-argument` correctly flags
      // handing an `any` into `router.get`'s `RequestHandler` parameter.
      passport.authenticate(GOOGLE_STRATEGY_NAME, {
        scope: ['profile', 'email'],
      }) as RequestHandler
    )
    // The callback route: Google redirects here after the user completes (or
    // abandons) its consent screen. `createRateLimiter(RATE_LIMITS.googleOAuthCallback)`
    // runs first, ahead of `oauthSession`, for the same ordering reason as
    // `/google` above — a 429 must land before `oauthSession` (or
    // `authController.handleGoogleCallback`'s own database work) spends
    // anything. Reuses the SAME `oauthSession` middleware instance built
    // above rather than a second `createOAuthSessionMiddleware()` call: both
    // routes read/write one session (the `state` value `/google` wrote,
    // `passport-oauth2` reads back here for its CSRF check), so both must
    // resolve to the same underlying express-session configuration — a
    // second call would still work (it lazily builds an equivalent
    // middleware) but would needlessly duplicate the Redis-latch machinery
    // `createOAuthSessionMiddleware`'s own header comment describes. The
    // account-linking policy lives in `findOrCreateByGoogle`
    // (google-auth.service.ts), which `authController.handleGoogleCallback`
    // reaches through `completeGoogleSignIn`.
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
