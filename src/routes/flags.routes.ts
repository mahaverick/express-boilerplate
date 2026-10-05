/**
 * @file The tenantless flag routes, mounted at `/api/v1/flags` behind
 * `requireAuth`: react's client flags with no tenant (`tenant_role` `none`)
 * and its exposure report. The tenant and staff variants live on the tenant
 * and platform routers.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { flagsController } from '@/controllers/flags.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the tenantless flag routes.
 * @returns A router mounted at `/api/v1/flags` by `index.routes.ts`.
 */
export function createFlagsRouter(): Router {
  const router = Router()
  router.use(requireAuth)
  router.get('/', flagsController.getFlags)
  router.post(
    '/exposures',
    requireJsonContentType,
    createRateLimiter(RATE_LIMITS.flagExposure),
    flagsController.recordExposures
  )
  return router
}
