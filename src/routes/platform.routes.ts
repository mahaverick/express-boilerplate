// src/routes/platform.routes.ts
//
// Staff routes, mounted at /api/v1/platform by index.routes.ts. The role
// gate runs before the limiter: a refused caller must see no RateLimit headers.
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
  router.get(
    '/tenants',
    requirePlatformRole('viewer'),
    createRateLimiter(RATE_LIMITS.platformSearch),
    platformController.searchTenants
  )
  router.get('/audit-log', requirePlatformRole('admin'), auditController.listPlatformAuditLog)
  return router
}
