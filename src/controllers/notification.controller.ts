// src/controllers/notification.controller.ts
//
// Six handlers, every one reached only through notification.routes.ts's
// router-wide `requireAuth` (auth.middleware.ts) — the same "authenticated
// routes assume request.user is already populated" contract
// profile.controller.ts establishes. `authenticatedUserId`
// (helpers.controller.ts) is a shared defensive check against a routing
// mistake, not business logic specific to this controller.
//
// Ownership scoping lives in notification.service.ts: every call there goes
// through the repository's userId-scoped methods.
import { type NextFunction, type Request, type Response } from 'express'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import type { Notification } from '@/database/models/notification.model'
import {
  deleteNotification as deleteNotificationRecord,
  getPreferences as getPreferenceMatrix,
  listNotifications as listNotificationPage,
  markAllRead as markAllNotificationsRead,
  markRead as markNotificationRead,
  updatePreferences as upsertPreferences,
} from '@/services/notification.service'
import { successResponse } from '@/utilities/response.utilities'
import {
  listNotificationsSchema,
  notificationIdSchema,
  updatePreferencesSchema,
} from '@/validators/notification.validators'
import { parseBody } from '@/validators/parse.validators'

/**
 * A notification as the REST API returns it.
 */
type NotificationResponse = Omit<Notification, 'dedupeKey'>

/**
 * The fields of a notification row the REST API returns. A whitelist, so an
 * internal column (`dedupeKey`, which embeds a queue job id) never leaks.
 * @param notification - The row as read from the database.
 * @returns The row without internal columns.
 */
function toNotificationResponse(notification: Notification): NotificationResponse {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    metadata: notification.metadata,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  }
}

/**
 * List the authenticated user's notifications, newest first, one page at a
 * time.
 *
 * An invalid or stale `cursor` is never a 400 here: `listNotificationPage`
 * (notification.service.ts) decodes it via `decodeNotificationCursor`
 * (notification.repository.ts), which resolves a malformed value to
 * `undefined` rather than throwing, so this handler always calls the
 * service — no separate no-cursor branch is needed here.
 * @param request - The incoming request, carrying `limit`/`cursor` as query parameters.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function listNotifications(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = authenticatedUserId(request)
    const { limit, cursor } = parseBody(listNotificationsSchema, request.query)
    const page = await listNotificationPage(userId, { limit, cursor })
    successResponse(
      response,
      { ...page, notifications: page.notifications.map((row) => toNotificationResponse(row)) },
      'Notifications retrieved.'
    )
  } catch (error) {
    next(error)
  }
}

/**
 * Mark one notification read.
 *
 * `NotificationRepository.markRead` is a no-op — returns `undefined` — both
 * when the notification does not exist (or belongs to someone else) AND
 * when it was already read (see that method's own comment). Those are
 * different outcomes for a client: the first is a 404, the second is a
 * successful, idempotent no-op that should still return the notification.
 * A second, ownership-scoped lookup disambiguates them, but only on the
 * no-op path — the common case (an unread notification, actually marked
 * read by this call) costs exactly one query, same as before.
 * @param request - The incoming request, carrying the notification id as `:id`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function markRead(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = authenticatedUserId(request)
    const { id } = parseBody(notificationIdSchema, request.params)
    const notification = await markNotificationRead(userId, id)
    successResponse(response, toNotificationResponse(notification), 'Notification marked as read.')
  } catch (error) {
    next(error)
  }
}

/**
 * Mark every one of the authenticated user's currently-unread notifications
 * read, in a single statement.
 * @param request - The incoming request.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function markAllRead(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const count = await markAllNotificationsRead(authenticatedUserId(request))
    successResponse(response, { count }, 'Notifications marked as read.')
  } catch (error) {
    next(error)
  }
}

/**
 * Delete one notification.
 *
 * Unlike `markRead`, `NotificationRepository.deleteOne` needs no
 * disambiguating second lookup: it is a one-shot operation with only two
 * outcomes — a row owned by this user existed and is now gone (`true`), or
 * no such row existed for this user (`false`), which is unambiguously a
 * 404.
 * @param request - The incoming request, carrying the notification id as `:id`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function deleteNotification(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = authenticatedUserId(request)
    const { id } = parseBody(notificationIdSchema, request.params)
    await deleteNotificationRecord(userId, id)
    // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
    successResponse(response, null, 'Notification deleted.')
  } catch (error) {
    next(error)
  }
}

/**
 * Get the authenticated user's full notification preference matrix — every
 * known notification type, with defaults already resolved for any type the
 * user has never explicitly set.
 * @param request - The incoming request.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function getPreferences(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const preferences = await getPreferenceMatrix(authenticatedUserId(request))
    successResponse(response, { preferences }, 'Notification preferences retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * Upsert one or more of the authenticated user's notification preferences.
 *
 * `updatePreferencesSchema` (notification.validators.ts) is the only gate
 * on which `notificationType` values reach `upsert` — a type outside
 * `CONFIGURABLE_NOTIFICATION_TYPES` (today, that is every type: see that
 * constant's own comment) fails validation with a per-field 400 before this
 * handler's body runs at all, so there is no second check to duplicate
 * here.
 * @param request - The incoming request, carrying `{ preferences: [...] }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function updatePreferences(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = authenticatedUserId(request)
    const { preferences } = parseBody(updatePreferencesSchema, request.body)
    const updated = await upsertPreferences(userId, preferences)
    successResponse(response, { preferences: updated }, 'Notification preferences updated.')
  } catch (error) {
    next(error)
  }
}
