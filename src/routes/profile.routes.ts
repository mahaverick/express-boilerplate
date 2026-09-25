// src/routes/profile.routes.ts
//
// The first authenticated feature router. `requireAuth` is attached with
// `router.use(...)` ahead of both routes rather than repeated per-route
// (`router.get('/', requireAuth, profileController.getProfile)`), so a
// third profile route added later inherits the gate automatically instead
// of it being one more thing a future edit can forget to add.
import { Router } from 'express'
import { profileController } from '@/controllers/profile.controller'
import { requireAuth } from '@/middlewares/auth.middleware'

/**
 * Build the profile routes.
 * @returns A router mounted at `/api/v1/profile` by `index.routes.ts`, every route behind `requireAuth`.
 */
export function createProfileRouter(): Router {
  const router = Router()
  router.use(requireAuth)
  router.get('/', profileController.getProfile)
  router.patch('/', profileController.updateProfile)
  return router
}
