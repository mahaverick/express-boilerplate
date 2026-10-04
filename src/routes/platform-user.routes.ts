/**
 * @file Staff user management, mounted at `/api/v1/platform/users` by
 * `createPlatformRouter`, behind its router-wide `requireAuth`. Each route
 * names its own role gate and runs it first, before the JSON gate, the
 * step-up check (deactivate, delete and purge) and the limiter, so a refused caller
 * gets the plain 404: no 415 and no `RateLimit-*` headers to show the route
 * exists.
 */
import { Router, type RequestHandler } from 'express'
import { platformErrorsController } from '@/controllers/platform-errors.controller'
import { platformTimelineController } from '@/controllers/platform-timeline.controller'
import { platformUserController } from '@/controllers/platform-user.controller'
import { requireRecentAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { requirePlatformRole } from '@/middlewares/platform.middleware'

/**
 * The limiter instances `createPlatformRouter` creates once and shares, so
 * every `/platform` read, and every write, draws on one budget each.
 */
export interface PlatformLimiters {
  searchLimiter: RequestHandler
  writeLimiter: RequestHandler
}

/**
 * The shared limiters plus the one the timeline and Errors routes draw on.
 */
export interface PlatformUserLimiters extends PlatformLimiters {
  timelineLimiter: RequestHandler
}

/**
 * Build the platform user routes.
 * @param limiters - The shared `platformSearch`, `platformWrite` and `platformTimeline` limiters.
 * @returns A router mounted at `/api/v1/platform/users`.
 */
export function createPlatformUserRouter(limiters: PlatformUserLimiters): Router {
  const router = Router()
  router.get(
    '/',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformUserController.searchUsers
  )
  router.get(
    '/:id',
    requirePlatformRole('viewer'),
    limiters.searchLimiter,
    platformUserController.getUser
  )
  router.get(
    '/:id/timeline',
    requirePlatformRole('admin'),
    limiters.timelineLimiter,
    platformTimelineController.getUserTimeline
  )
  router.get(
    '/:id/errors',
    requirePlatformRole('admin'),
    limiters.timelineLimiter,
    platformErrorsController.getUserErrors
  )
  router.post(
    '/',
    requirePlatformRole('admin'),
    requireJsonContentType,
    limiters.writeLimiter,
    platformUserController.createUser
  )
  router.patch(
    '/:id',
    requirePlatformRole('admin'),
    requireJsonContentType,
    limiters.writeLimiter,
    platformUserController.updateUser
  )
  router.post(
    '/:id/password-setup',
    requirePlatformRole('admin'),
    requireJsonContentType,
    limiters.writeLimiter,
    platformUserController.sendPasswordSetup
  )
  router.post(
    '/:id/resend-verification',
    requirePlatformRole('admin'),
    requireJsonContentType,
    limiters.writeLimiter,
    platformUserController.resendVerification
  )
  router.post(
    '/:id/deactivate',
    requirePlatformRole('admin'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformUserController.deactivateUser
  )
  router.post(
    '/:id/reactivate',
    requirePlatformRole('admin'),
    requireJsonContentType,
    limiters.writeLimiter,
    platformUserController.reactivateUser
  )
  router.post(
    '/:id/sign-out',
    requirePlatformRole('admin'),
    requireJsonContentType,
    limiters.writeLimiter,
    platformUserController.signOutUser
  )
  router.delete(
    '/:id',
    requirePlatformRole('admin'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformUserController.deleteUser
  )
  router.post(
    '/:id/purge',
    requirePlatformRole('owner'),
    requireJsonContentType,
    requireRecentAuth(),
    limiters.writeLimiter,
    platformUserController.purgeUser
  )
  return router
}
