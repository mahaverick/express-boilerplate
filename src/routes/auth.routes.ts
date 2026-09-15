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
// `createLoginRateLimiter`/`createRefreshRateLimiter` follow the identical
// pattern for the same reason — see rate-limit.middleware.ts's header
// comment.
import { Router } from 'express'
import { login, logout, refresh, register } from '@/controllers/auth.controller'
import {
  createLoginRateLimiter,
  createRefreshRateLimiter,
} from '@/middlewares/rate-limit.middleware'

/**
 * Build the auth routes.
 * @returns A router mounted at `/api/v1/auth` by `index.routes.ts`.
 */
export function createAuthRouter(): Router {
  const router = Router()
  router.post('/register', register)
  router.post('/login', createLoginRateLimiter(), login)
  router.post('/refresh', createRefreshRateLimiter(), refresh)
  router.post('/logout', logout)
  return router
}
