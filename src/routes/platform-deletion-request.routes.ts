/**
 * @file The staff list of open account deletion requests, mounted at
 * `/api/v1/platform/deletion-requests` by `createPlatformRouter`, behind its
 * router-wide `requireAuth`. The role gate runs first, before the limiter, so
 * a refused caller gets the plain 404 with no `RateLimit-*` headers.
 */
import { Router } from 'express'
import { platformDeletionRequestController } from '@/controllers/platform-deletion-request.controller'
import { requirePlatformRole } from '@/middlewares/platform.middleware'
import type { PlatformLimiters } from '@/routes/platform-user.routes'

/**
 * Build the platform deletion request routes.
 * @param limiters - The shared `platformSearch` and `platformWrite` limiters.
 * @returns A router mounted at `/api/v1/platform/deletion-requests`.
 */
export function createPlatformDeletionRequestRouter(limiters: PlatformLimiters): Router {
  const router = Router()
  router.get(
    '/',
    requirePlatformRole('admin'),
    limiters.searchLimiter,
    platformDeletionRequestController.searchDeletionRequests
  )
  return router
}
