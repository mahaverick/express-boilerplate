/**
 * @file The single mount point for every versioned feature router; app.ts
 * mounts it under `/api/v1`. It builds a router rather than re-exporting, so
 * it is not a barrel.
 */
import { Router } from 'express'
import { createAuthRouter } from '@/routes/auth.routes'
import { createInvitationRouter } from '@/routes/invitation.routes'
import { createNotificationRouter } from '@/routes/notification.routes'
import { createPlatformRouter } from '@/routes/platform.routes'
import { createProfileRouter } from '@/routes/profile.routes'
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
  return router
}
