/**
 * @file Staff message tracking: `createPlatformEmailRouter`, mounted at
 * `/api/v1/platform/emails`, and `createPlatformEmailSuppressionRouter`, at
 * `/api/v1/platform/email-suppressions`, both by `createPlatformRouter`
 * behind its router-wide `requireAuth`. Each route names its own role gate
 * and runs it first, before the limiter, so a refused caller gets the
 * plain 404 with no `RateLimit-*` headers.
 */
import { Router } from 'express'
import { platformEmailController } from '@/controllers/platform-email.controller'
import { requirePlatformRole } from '@/middlewares/platform.middleware'
import type { PlatformLimiters } from '@/routes/platform-user.routes'

/**
 * Build the platform email routes. `/health` is registered before `/:id`,
 * so it is never read as an id.
 * @param limiters - The shared `platformSearch` and `platformWrite` limiters.
 * @returns A router mounted at `/api/v1/platform/emails`.
 */
export function createPlatformEmailRouter(limiters: PlatformLimiters): Router {
  const router = Router()
  router.get(
    '/',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformEmailController.searchEmails
  )
  router.get(
    '/health',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformEmailController.getEmailHealth
  )
  router.get(
    '/:id',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformEmailController.getEmail
  )
  router.get(
    '/:id/preview',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformEmailController.previewEmail
  )
  return router
}

/**
 * Build the platform suppression routes.
 * @param limiters - The shared `platformSearch` and `platformWrite` limiters.
 * @returns A router mounted at `/api/v1/platform/email-suppressions`.
 */
export function createPlatformEmailSuppressionRouter(limiters: PlatformLimiters): Router {
  const router = Router()
  router.get(
    '/',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformEmailController.searchSuppressions
  )
  return router
}
