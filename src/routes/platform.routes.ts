/**
 * @file Staff routes, mounted at `/api/v1/platform`. The role gate runs before
 * the limiter, so a refused caller sees no `RateLimit-*` headers.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { auditController } from '@/controllers/audit.controller'
import { platformController } from '@/controllers/platform.controller'
import { requireAuth, requireRecentAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { requirePlatformRole } from '@/middlewares/platform.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'
import { createPlatformUserRouter } from '@/routes/platform-user.routes'

/**
 * Build the platform routes.
 * @returns A router mounted at `/api/v1/platform` by `index.routes.ts`, every route behind `requireAuth`.
 */
export function createPlatformRouter(): Router {
  const router = Router()
  router.use(requireAuth)
  // One instance: separate ones would split the budget on the in-memory fallback.
  const searchLimiter = createRateLimiter(RATE_LIMITS.platformSearch)
  // One instance shared by every /platform write, users' and tenants'.
  const writeLimiter = createRateLimiter(RATE_LIMITS.platformWrite)
  router.use('/users', createPlatformUserRouter({ searchLimiter, writeLimiter }))
  router.get(
    '/tenants',
    requirePlatformRole('viewer'),
    searchLimiter,
    platformController.searchTenants
  )
  router.post(
    '/tenants',
    requirePlatformRole('admin'),
    requireJsonContentType,
    writeLimiter,
    platformController.createTenant
  )
  router.post(
    '/tenants/:id/owner-invitation',
    requirePlatformRole('admin'),
    requireJsonContentType,
    requireRecentAuth(),
    writeLimiter,
    platformController.reissueOwnerInvitation
  )
  router.post(
    '/tenants/:id/suspend',
    requirePlatformRole('admin'),
    requireJsonContentType,
    requireRecentAuth(),
    writeLimiter,
    platformController.suspendTenant
  )
  router.post(
    '/tenants/:id/reactivate',
    requirePlatformRole('admin'),
    requireJsonContentType,
    writeLimiter,
    platformController.reactivateTenant
  )
  router.post(
    '/tenants/:id/archive',
    requirePlatformRole('admin'),
    requireJsonContentType,
    requireRecentAuth(),
    writeLimiter,
    platformController.archiveTenant
  )
  router.get(
    '/tenants/:id',
    requirePlatformRole('viewer'),
    searchLimiter,
    platformController.getTenant
  )
  router.get('/stats', requirePlatformRole('viewer'), searchLimiter, platformController.getStats)
  router.get('/audit-log', requirePlatformRole('admin'), auditController.listPlatformAuditLog)
  return router
}
