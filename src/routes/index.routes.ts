// src/routes/index.routes.ts
//
// Not a barrel: `index.ts` re-export modules are banned everywhere in this
// codebase (see CLAUDE.md) because they hide real edges from
// import-x/no-cycle. This file re-exports nothing — it BUILDS one `Router`
// and mounts feature routers on it by path prefix, which is what
// `check-file` allows an "index" file to do (a router, not an aggregating
// re-export) and is why it lives at `src/routes/index.routes.ts` rather
// than `src/routes/index.ts`.
//
// The single mount point for every versioned feature router. `app.ts`
// wires this ONE router under `/api/v1`, so a new feature (Task 8's
// profile router) is one more `router.use(...)` line here, not another
// `app.use(...)` in app.ts.
import { Router } from 'express'
import { createAuthRouter } from '@/routes/auth.routes'
import { createProfileRouter } from '@/routes/profile.routes'

/**
 * Build the versioned API router.
 * @returns A router with every feature router mounted, ready for
 * `app.use('/api/v1', ...)`.
 */
export function createApiRouter(): Router {
  const router = Router()
  router.use('/auth', createAuthRouter())
  router.use('/profile', createProfileRouter())
  return router
}
