// src/routes/notification.routes.ts
//
// Every route on this router is authenticated — a notification inbox and
// its preferences are always scoped to the caller, never listable or
// mutable for anyone else — so `requireAuth` is mounted once with
// `router.use(...)` ahead of all seven of these routes, the same pattern
// profile.routes.ts already establishes, rather than repeated per route.
//
// `/stream` is registered ahead of the `:id`-shaped routes below it
// (`/:id/read`, `/:id`) for the ordinary Express reason: a literal path
// segment must be matched before a `:id` pattern that would otherwise
// capture it — `stream` becoming `request.params.id === 'stream'`. It used
// to also have to precede `router.use(requireAuth)` itself: `requireAuth`
// only ever reads a `Bearer` `Authorization` header (auth.middleware.ts),
// and `EventSource` — the only thing that opened `/stream` before this
// codebase switched the client to `fetch` — cannot set one, so
// `notification-stream.controller.ts` used to authenticate the connection
// itself, from a `?token=` query parameter. Now that the client sends a
// `Bearer` header like every other request, `/stream` sits behind
// `requireAuth` the same as the rest of this router.
//
// `/preferences` sits under this same router, not a separate one: it is
// still "notification settings", addressed relative to
// `/api/v1/notifications`, and splitting it out would buy nothing since
// both halves share the one auth gate, and every write shares one
// `authenticatedWrite` limiter.
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
