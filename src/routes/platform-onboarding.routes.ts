/**
 * @file Staff onboarding: `createPlatformOnboardingRouter`, mounted at
 * `/api/v1/platform/onboarding`, and `createPlatformTenantOnboardingRouter`,
 * at `/api/v1/platform/tenants/:id/onboarding`, both by
 * `createPlatformRouter` behind its router-wide `requireAuth`. Each route
 * names its own role gate and runs it first, before the JSON gate and the
 * limiter, so a refused caller gets the plain 404. No route here needs a
 * recent sign-in: neither a reminder nor a manual completion grants access.
 */
import { Router } from 'express'
import { platformOnboardingController } from '@/controllers/platform-onboarding.controller'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { requirePlatformRole } from '@/middlewares/platform.middleware'
import type { PlatformLimiters } from '@/routes/platform-user.routes'

/**
 * Build the cross-tenant onboarding routes.
 * @param limiters - The shared `platformSearch` and `platformWrite` limiters.
 * @returns A router mounted at `/api/v1/platform/onboarding`.
 */
export function createPlatformOnboardingRouter(limiters: PlatformLimiters): Router {
  const router = Router()
  router.get(
    '/funnel',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformOnboardingController.getFunnel
  )
  router.get(
    '/tenants',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformOnboardingController.searchTenants
  )
  return router
}

/**
 * Build one tenant's onboarding routes. `mergeParams`, so the handlers read
 * the mount's `:id`.
 * @param limiters - The shared `platformSearch` and `platformWrite` limiters.
 * @returns A router mounted at `/api/v1/platform/tenants/:id/onboarding`.
 */
export function createPlatformTenantOnboardingRouter(limiters: PlatformLimiters): Router {
  const router = Router({ mergeParams: true })
  router.get(
    '/',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformOnboardingController.getTenantOnboarding
  )
  router.post(
    '/steps/:key/complete',
    requirePlatformRole('admin'),
    requireJsonContentType,
    limiters.writeLimiter,
    platformOnboardingController.completeStep
  )
  router.post(
    '/remind',
    requirePlatformRole('admin'),
    requireJsonContentType,
    limiters.writeLimiter,
    platformOnboardingController.sendReminder
  )
  return router
}
