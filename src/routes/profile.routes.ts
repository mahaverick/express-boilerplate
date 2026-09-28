/**
 * @file The profile routes. `requireAuth` is mounted router-wide, so a new
 * route inherits the gate.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { profileController } from '@/controllers/profile.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the profile routes.
 * @returns A router mounted at `/api/v1/profile` by `index.routes.ts`, every route behind `requireAuth`.
 */
export function createProfileRouter(): Router {
  const router = Router()
  router.use(requireAuth)
  router.get('/', profileController.getProfile)
  router.patch(
    '/',
    createRateLimiter(RATE_LIMITS.authenticatedWrite),
    profileController.updateProfile
  )
  return router
}
