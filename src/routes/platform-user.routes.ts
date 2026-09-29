/**
 * @file Staff user management, mounted at `/api/v1/platform/users` by
 * `createPlatformRouter`, behind its router-wide `requireAuth`. Each route
 * names its own role gate and runs it first, before the JSON gate and the
 * limiter, so a refused caller gets the plain 404: no 415 and no
 * `RateLimit-*` headers to show the route exists.
 */
import { Router, type RequestHandler } from 'express'
import { platformUserController } from '@/controllers/platform-user.controller'
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
 * Build the platform user routes.
 * @param limiters - The shared `platformSearch` and `platformWrite` limiters.
 * @returns A router mounted at `/api/v1/platform/users`.
 */
export function createPlatformUserRouter(limiters: PlatformLimiters): Router {
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
  return router
}
