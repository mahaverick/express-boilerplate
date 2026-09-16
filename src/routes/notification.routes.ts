// src/routes/notification.routes.ts
//
// Every route on this router is authenticated — a notification inbox and
// its preferences are always scoped to the caller, never listable or
// mutable for anyone else — so `requireAuth` is mounted once with
// `router.use(...)` ahead of all six routes, the same pattern
// profile.routes.ts already establishes, rather than repeated per route.
//
// `/preferences` sits under this same router, not a separate one: it is
// still "notification settings", addressed relative to
// `/api/v1/notifications`, and splitting it out would buy nothing since
// both halves share the one auth gate and nothing else in this file is
// route-specific enough to warrant its own middleware.
import { Router } from 'express'
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
 * @returns A router mounted at `/api/v1/notifications` by `index.routes.ts`, every route behind `requireAuth`.
 */
export function createNotificationRouter(): Router {
  const router = Router()
  router.use(requireAuth)

  router.get('/', listNotifications)
  router.patch('/:id/read', markRead)
  router.patch('/read-all', markAllRead)
  router.delete('/:id', deleteNotification)
  router.get('/preferences', getPreferences)
  router.put('/preferences', updatePreferences)

  return router
}
