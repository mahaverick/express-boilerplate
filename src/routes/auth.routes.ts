// src/routes/auth.routes.ts
//
// Registration, login, refresh, logout, verify-email, and
// resend-verification — all six share the one `/api/v1/auth` mount point
// wired in index.routes.ts, so they live in this one router.
//
// Built and returned by a function, not registered as a top-level side
// effect on an exported const: the latter is exactly what
// unicorn/no-top-level-side-effects exists to catch, and createApp()
// (app.ts) already establishes "build inside a function, return the
// result" as this codebase's convention for assembling Express objects.
// The `create*RateLimiter` factories follow the identical pattern for the
// same reason — see rate-limit.middleware.ts's header comment.
//
// EVERY route on this router carries a limiter, each with its own store
// prefix. That is the standing rule for this file, not six independent
// decisions: an unlimited auth route is either an enumeration oracle, a
// bcrypt/email amplifier, or both. rate-limit.middleware.ts's header
// comment holds the per-endpoint reasoning and the convention B3's still-
// pending forgot-password route must follow when it lands here.
// verify-email has its own `rl:verify-email:` prefix on this pattern;
// resend-verification carries TWO limiters in series, each with its own
// prefix (`rl:resend-verification-ip:` / `rl:resend-verification-email:`)
// — see rate-limit.middleware.ts for why one composite key is not enough
// for this pair of threats.
import { Router } from 'express'
import { login, logout, refresh, register } from '@/controllers/auth.controller'
import { resendVerification, verifyEmail } from '@/controllers/verification.controller'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import {
  createLoginRateLimiter,
  createLogoutRateLimiter,
  createRefreshRateLimiter,
  createRegisterRateLimiter,
  createResendVerificationEmailRateLimiter,
  createResendVerificationIpRateLimiter,
  createVerifyEmailRateLimiter,
} from '@/middlewares/rate-limit.middleware'

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
  // per-route so B3's routes inherit it by default instead of having to
  // remember. See content-type.middleware.ts.
  router.use(requireJsonContentType)
  router.post('/register', createRegisterRateLimiter(), register)
  router.post('/login', createLoginRateLimiter(), login)
  router.post('/refresh', createRefreshRateLimiter(), refresh)
  router.post('/logout', createLogoutRateLimiter(), logout)
  router.post('/verify-email', createVerifyEmailRateLimiter(), verifyEmail)
  // Two limiters in series, not a composite key — each bounds its own
  // threat, and either firing alone must be enough. See
  // rate-limit.middleware.ts's header comment.
  router.post(
    '/resend-verification',
    createResendVerificationIpRateLimiter(),
    createResendVerificationEmailRateLimiter(),
    resendVerification
  )
  return router
}
