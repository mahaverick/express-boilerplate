/**
 * @file The single mount point for every versioned feature router; app.ts
 * mounts it under `/api/v1`. The two exceptions are the email webhook router
 * and the analytics proxy (`/api/v1/collect`), which app.ts mounts itself
 * ahead of the global JSON parser. It builds a
 * router rather than re-exporting, so it is not a barrel.
 */
import { Router } from 'express'
import { createAuthRouter } from '@/routes/auth.routes'
import { createFlagsRouter } from '@/routes/flags.routes'
import { createInvitationRouter } from '@/routes/invitation.routes'
import { createNotificationRouter } from '@/routes/notification.routes'
import { createPlatformRouter } from '@/routes/platform.routes'
import { createProfileRouter } from '@/routes/profile.routes'
import { createStatusRouter } from '@/routes/status.routes'
import { createTenantRouter } from '@/routes/tenant.routes'

/**
 * Build the versioned API router.
 * @returns A router with every feature router mounted, ready for
 * `app.use('/api/v1', ...)`.
 */
export function createApiRouter(): Router {
  const router = Router()
  router.use('/auth', createAuthRouter())
  router.use('/profile', createProfileRouter())
  router.use('/notifications', createNotificationRouter())
  router.use('/tenants', createTenantRouter())
  router.use('/invitations', createInvitationRouter())
  router.use('/platform', createPlatformRouter())
  router.use('/flags', createFlagsRouter())
  router.use('/status', createStatusRouter())
  return router
}
