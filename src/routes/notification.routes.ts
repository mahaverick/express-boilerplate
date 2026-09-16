// src/routes/notification.routes.ts
//
// Every route on this router is authenticated — a notification inbox and
// its preferences are always scoped to the caller, never listable or
// mutable for anyone else — so `requireAuth` is mounted once with
// `router.use(...)` ahead of six of these seven routes, the same pattern
// profile.routes.ts already establishes, rather than repeated per route.
//
// `/stream` is the one exception, and it is registered BEFORE
// `router.use(requireAuth)` on purpose, not merely before the `:id`-shaped
// routes below it. `requireAuth` only ever reads a `Bearer`
// `Authorization` header (auth.middleware.ts); an `EventSource` connection
// — the only thing that opens `/stream` outside a test — cannot set one, so
// `notification-stream.controller.ts` authenticates the connection itself,
// from a `?token=` query parameter, using the exact same checks. Mounting
// `requireAuth` ahead of `/stream` as well would reject every such
// connection before `streamNotifications` ever ran, regardless of how
// valid its token was. It is also registered ahead of the `:id`-shaped
// routes (`/:id/read`, `/:id`) for the ordinary Express reason: a literal
// path segment must be matched before a `:id` pattern that would otherwise
// capture it — `stream` becoming `request.params.id === 'stream'`.
//
// `/preferences` sits under this same router, not a separate one: it is
// still "notification settings", addressed relative to
// `/api/v1/notifications`, and splitting it out would buy nothing since
// both halves share the one auth gate and nothing else in this file is
// route-specific enough to warrant its own middleware.
import { Router } from 'express'
import { streamNotifications } from '@/controllers/notification-stream.controller'
import {
  deleteNotification,
  getPreferences,
  listNotifications,
  markAllRead,
  markRead,
  updatePreferences,
} from '@/controllers/notification.controller'
import { requireAuth } from '@/middlewares/auth.middleware'

/**
 * Build the notification routes.
 * @returns A router mounted at `/api/v1/notifications` by `index.routes.ts`. Every route is behind `requireAuth` except `/stream`, which authenticates itself — see this file's header comment.
 */
export function createNotificationRouter(): Router {
  const router = Router()

  router.get('/stream', streamNotifications)

  router.use(requireAuth)

  router.get('/', listNotifications)
  router.patch('/:id/read', markRead)
  router.patch('/read-all', markAllRead)
  router.delete('/:id', deleteNotification)
  router.get('/preferences', getPreferences)
  router.put('/preferences', updatePreferences)

  return router
}
