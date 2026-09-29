/**
 * @file Staff routes, mounted at `/api/v1/platform`. The role gate runs before
 * the limiter, so a refused caller sees no `RateLimit-*` headers.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { auditController } from '@/controllers/audit.controller'
import { platformController } from '@/controllers/platform.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requirePlatformRole } from '@/middlewares/platform.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the platform routes.
 * @returns A router mounted at `/api/v1/platform` by `index.routes.ts`, every route behind `requireAuth`.
 */
export function createPlatformRouter(): Router {
  const router = Router()
  router.use(requireAuth)
  // One instance: separate ones would split the budget on the in-memory fallback.
  const searchLimiter = createRateLimiter(RATE_LIMITS.platformSearch)
  router.get(
    '/tenants',
    requirePlatformRole('viewer'),
    searchLimiter,
    platformController.searchTenants
  )
  router.get('/stats', requirePlatformRole('viewer'), searchLimiter, platformController.getStats)
  router.get('/audit-log', requirePlatformRole('admin'), auditController.listPlatformAuditLog)
  return router
}
