/**
 * @file The notification routes, including preferences and the SSE stream,
 * every one behind a router-wide `requireAuth`. `/stream` is registered
 * before the `:id` routes, so `stream` is never captured as an id.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { notificationStreamController } from '@/controllers/notification-stream.controller'
import { notificationController } from '@/controllers/notification.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the notification routes.
 * @returns A router mounted at `/api/v1/notifications` by `index.routes.ts`. Every route sits behind `requireAuth`.
 */
export function createNotificationRouter(): Router {
  const router = Router()

  router.use(requireAuth)

  const writeLimiter = createRateLimiter(RATE_LIMITS.authenticatedWrite)

  router.get('/stream', notificationStreamController.streamNotifications)
  router.get('/', notificationController.listNotifications)
  router.patch('/:id/read', writeLimiter, notificationController.markRead)
  router.patch('/read-all', writeLimiter, notificationController.markAllRead)
  router.delete('/:id', writeLimiter, notificationController.deleteNotification)
  router.get('/preferences', notificationController.getPreferences)
  router.put('/preferences', writeLimiter, notificationController.updatePreferences)

  return router
}
