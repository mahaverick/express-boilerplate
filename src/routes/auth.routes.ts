// src/routes/auth.routes.ts
//
// Registration, login, refresh, and logout — all four share the one
// `/api/v1/auth` mount point wired in index.routes.ts, so they live in this
// one router.
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
// prefix. That is the standing rule for this file, not four independent
// decisions: an unlimited auth route is either an enumeration oracle, a
// bcrypt/email amplifier, or both. rate-limit.middleware.ts's header
// comment holds the per-endpoint reasoning and the convention B3's
// forgot-password/resend-verification routes must follow when they land
// here.
import { Router } from 'express'
import { login, logout, refresh, register } from '@/controllers/auth.controller'
import {
  createLoginRateLimiter,
  createLogoutRateLimiter,
  createRefreshRateLimiter,
  createRegisterRateLimiter,
} from '@/middlewares/rate-limit.middleware'

/**
 * Build the auth routes.
 * @returns A router mounted at `/api/v1/auth` by `index.routes.ts`.
 */
export function createAuthRouter(): Router {
  const router = Router()
  router.post('/register', createRegisterRateLimiter(), register)
  router.post('/login', createLoginRateLimiter(), login)
  router.post('/refresh', createRefreshRateLimiter(), refresh)
  router.post('/logout', createLogoutRateLimiter(), logout)
  return router
}
