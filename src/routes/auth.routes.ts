// src/routes/auth.routes.ts
//
// Registration and login today. Task 7 adds refresh and logout to this same
// router — deliberately the same file, since all four share the one
// `/api/v1/auth` mount point wired in index.routes.ts.
//
// Built and returned by a function, not registered as a top-level side
// effect on an exported const: the latter is exactly what
// unicorn/no-top-level-side-effects exists to catch, and createApp()
// (app.ts) already establishes "build inside a function, return the
// result" as this codebase's convention for assembling Express objects.
import { Router } from 'express'
import { login, register } from '@/controllers/auth.controller'

/**
 * Build the auth routes.
 * @returns A router mounted at `/api/v1/auth` by `index.routes.ts`.
 */
export function createAuthRouter(): Router {
  const router = Router()
  router.post('/register', register)
  router.post('/login', login)
  return router
}
