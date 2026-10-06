/**
 * @file Staff routes, mounted at `/api/v1/platform`. The role gate runs before
 * the limiter, so a refused caller sees no `RateLimit-*` headers, and every
 * OPTIONS gets the unknown-route 404, so no `Allow` header lists a route's
 * methods. `POST /me/flags/exposures` is telemetry, not a staff action: it
 * takes no step-up and `logStaffWrites` leaves it out.
 */
import { Router } from 'express'
import { getEnv } from '@/configs/env.config'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { auditController } from '@/controllers/audit.controller'
import { flagsController } from '@/controllers/flags.controller'
import { platformErrorsController } from '@/controllers/platform-errors.controller'
import { platformFlagsController } from '@/controllers/platform-flags.controller'
import { platformMaintenanceModeController } from '@/controllers/platform-maintenance-mode.controller'
import { platformSystemController } from '@/controllers/platform-system.controller'
import { platformTimelineController } from '@/controllers/platform-timeline.controller'
import { platformController } from '@/controllers/platform.controller'
import { requireAuth, requireRecentAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import {
  logStaffWrites,
  refusePlatformOptions,
  requirePlatformRole,
} from '@/middlewares/platform.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'
import {
  createPlatformEmailRouter,
  createPlatformEmailSuppressionRouter,
} from '@/routes/platform-email.routes'
import {
  createPlatformOnboardingRouter,
  createPlatformTenantOnboardingRouter,
} from '@/routes/platform-onboarding.routes'
import { createPlatformUserRouter } from '@/routes/platform-user.routes'

/**
 * Build the platform routes.
 * @returns A router mounted at `/api/v1/platform` by `index.routes.ts`, every route behind `requireAuth`.
 */
export function createPlatformRouter(): Router {
  const router = Router()
  router.use(requireAuth)
  router.use(refusePlatformOptions)
  router.use(logStaffWrites)
  // One instance: separate ones would split the budget on the in-memory fallback.
  const searchLimiter = createRateLimiter(RATE_LIMITS.platformSearch)
  // One instance shared by every /platform write: users', tenants', emails' and onboarding's.
  const writeLimiter = createRateLimiter(RATE_LIMITS.platformWrite)
  // One instance shared by the user and tenant timelines and Errors views.
  const timelineLimiter = createRateLimiter(RATE_LIMITS.platformTimeline, {
    limit: getEnv().TIMELINE_REQUESTS_PER_MINUTE,
  })
  router.use('/users', createPlatformUserRouter({ searchLimiter, writeLimiter, timelineLimiter }))
  router.use('/emails', createPlatformEmailRouter({ searchLimiter, writeLimiter }))
  router.use(
    '/email-suppressions',
    createPlatformEmailSuppressionRouter({ searchLimiter, writeLimiter })
  )
  router.use('/onboarding', createPlatformOnboardingRouter({ searchLimiter, writeLimiter }))
  router.use(
    '/tenants/:id/onboarding',
    createPlatformTenantOnboardingRouter({ searchLimiter, writeLimiter })
  )
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
  router.post(
    '/tenants/:id/purge',
    requirePlatformRole('owner'),
    requireJsonContentType,
    requireRecentAuth(),
    writeLimiter,
    platformController.purgeTenant
  )
  router.get(
    '/tenants/:id',
    requirePlatformRole('viewer'),
    searchLimiter,
    platformController.getTenant
  )
  router.get(
    '/tenants/:id/timeline',
    requirePlatformRole('admin'),
    timelineLimiter,
    platformTimelineController.getTenantTimeline
  )
  router.get(
    '/tenants/:id/errors',
    requirePlatformRole('admin'),
    timelineLimiter,
    platformErrorsController.getTenantErrors
  )
  router.get('/stats', requirePlatformRole('viewer'), searchLimiter, platformController.getStats)
  router.get(
    '/system/status',
    requirePlatformRole('admin'),
    searchLimiter,
    platformSystemController.getStatus
  )
  router.get('/audit-log', requirePlatformRole('admin'), auditController.listPlatformAuditLog)
  router.get('/me/flags', requirePlatformRole('viewer'), flagsController.getPlatformFlags)
  router.post(
    '/me/flags/exposures',
    requirePlatformRole('viewer'),
    requireJsonContentType,
    createRateLimiter(RATE_LIMITS.flagExposure),
    flagsController.recordPlatformExposures
  )
  router.get(
    '/flags',
    requirePlatformRole('viewer'),
    searchLimiter,
    platformFlagsController.listFlags
  )
  router.get(
    '/maintenance-mode',
    requirePlatformRole('viewer'),
    searchLimiter,
    platformMaintenanceModeController.getMaintenanceMode
  )
  router.put(
    '/maintenance-mode',
    requirePlatformRole('owner'),
    requireJsonContentType,
    requireRecentAuth(),
    createRateLimiter(RATE_LIMITS.maintenanceModeChange),
    platformMaintenanceModeController.changeMaintenanceMode
  )
  router.get(
    '/flags/evaluate',
    requirePlatformRole('admin'),
    timelineLimiter,
    platformFlagsController.evaluate
  )
  return router
}
