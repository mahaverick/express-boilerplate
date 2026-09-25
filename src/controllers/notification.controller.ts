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
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import type { Notification } from '@/database/models/notification.model'
import {
  deleteNotification,
  getPreferences,
  listNotifications,
  markAllRead,
  markRead,
  updatePreferences,
} from '@/services/notification.service'
import { messageResponse, successResponse } from '@/utilities/response.utilities'
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
 * Handlers for `/api/v1/notifications`, except the SSE stream.
 */
class NotificationController extends BaseController {
  /**
   * `GET /notifications`: the authenticated user's notifications, newest
   * first, one page at a time.
   *
   * An invalid or stale `cursor` is never a 400 here: `listNotifications`
   * (notification.service.ts) decodes it via `decodeNotificationCursor`
   * (notification.repository.ts), which resolves a malformed value to
   * `undefined` rather than throwing, so this handler always calls the
   * service — no separate no-cursor branch is needed here.
   */
  listNotifications = this.handle(async (request, response) => {
    const userId = authenticatedUserId(request)
    const { limit, cursor } = parseBody(listNotificationsSchema, request.query)
    const page = await listNotifications(userId, { limit, cursor })
    successResponse(
      response,
      { ...page, notifications: page.notifications.map((row) => toNotificationResponse(row)) },
      'Notifications retrieved.'
    )
  })

  /**
   * `PATCH /notifications/:id/read`: mark one notification read.
   *
   * See `notification.service.ts`'s `markRead` for how a not-found
   * notification is told apart from one that was already read.
   */
  markRead = this.handle(async (request, response) => {
    const userId = authenticatedUserId(request)
    const { id } = parseBody(notificationIdSchema, request.params)
    const notification = await markRead(userId, id)
    successResponse(response, toNotificationResponse(notification), 'Notification marked as read.')
  })

  /**
   * `PATCH /notifications/read-all`: mark every one of the authenticated
   * user's currently-unread notifications read, in a single statement.
   */
  markAllRead = this.handle(async (request, response) => {
    const count = await markAllRead(authenticatedUserId(request))
    successResponse(response, { count }, 'Notifications marked as read.')
  })

  /**
   * `DELETE /notifications/:id`: delete one notification.
   *
   * Unlike `markRead`, `NotificationRepository.deleteOne` needs no
   * disambiguating second lookup: it is a one-shot operation with only two
   * outcomes — a row owned by this user existed and is now gone (`true`), or
   * no such row existed for this user (`false`), which is unambiguously a
   * 404.
   */
  deleteNotification = this.handle(async (request, response) => {
    const userId = authenticatedUserId(request)
    const { id } = parseBody(notificationIdSchema, request.params)
    await deleteNotification(userId, id)
    messageResponse(response, 'Notification deleted.')
  })

  /**
   * `GET /notifications/preferences`: the authenticated user's full
   * notification preference matrix — every known notification type, with
   * defaults already resolved for any type the user has never explicitly set.
   */
  getPreferences = this.handle(async (request, response) => {
    const preferences = await getPreferences(authenticatedUserId(request))
    successResponse(response, { preferences }, 'Notification preferences retrieved.')
  })

  /**
   * `PUT /notifications/preferences`: upsert one or more of the
   * authenticated user's notification preferences.
   *
   * `updatePreferencesSchema` (notification.validators.ts) is the only gate
   * on which `notificationType` values reach `upsert` — a type outside
   * `CONFIGURABLE_NOTIFICATION_TYPES` (today, that is every type: see that
   * constant's own comment) fails validation with a per-field 400 before this
   * handler's body runs at all, so there is no second check to duplicate
   * here.
   */
  updatePreferences = this.handle(async (request, response) => {
    const userId = authenticatedUserId(request)
    const { preferences } = parseBody(updatePreferencesSchema, request.body)
    const updated = await updatePreferences(userId, preferences)
    successResponse(response, { preferences: updated }, 'Notification preferences updated.')
  })
}

/**
 * The notification controller the notification routes mount.
 */
export const notificationController = new NotificationController()
