// src/services/notification.service.ts
//
// The caller's notification inbox and preferences, and the SSE stream's
// Last-Event-ID backlog read. Every lookup and mutation goes through the
// repository's userId-scoped methods, never a lookup by id alone, so a
// caller cannot act on or learn of another user's notification.
import { MAX_NOTIFICATION_PAGE_SIZE } from '@/constants/notification.constants'
import type { Notification, NotificationPreference } from '@/database/models/notification.model'
import { HttpError } from '@/errors/http-error'
import {
  NotificationPreferenceRepository,
  type PreferenceMatrix,
} from '@/repositories/notification-preference.repository'
import {
  decodeNotificationCursor,
  NotificationRepository,
} from '@/repositories/notification.repository'
import type { UpdatePreferencesInput } from '@/validators/notification.validators'

const notificationRepository = new NotificationRepository()
const notificationPreferenceRepository = new NotificationPreferenceRepository()

/**
 * One page of the user's notifications, newest first. An invalid or stale
 * cursor reads as no cursor and returns the first page, never a 400.
 * @param userId - The owner.
 * @param options - The page request.
 * @param options.limit - The page size.
 * @param options.cursor - The opaque cursor from the previous page, if any.
 * @returns The page, and `nextCursor` when more rows remain.
 */
export async function listNotifications(
  userId: string,
  options: { limit: number; cursor?: string | undefined }
): Promise<{ notifications: Notification[]; nextCursor?: string }> {
  const decodedCursor =
    options.cursor === undefined ? undefined : decodeNotificationCursor(options.cursor)
  return notificationRepository.list(
    userId,
    decodedCursor === undefined
      ? { limit: options.limit }
      : { limit: options.limit, cursor: decodedCursor }
  )
}

/**
 * Mark one notification read. Idempotent: an already-read notification is
 * returned as it is. `markRead` returns nothing both for a missing row and
 * for an already-read one, so only that path pays a second lookup.
 * @param userId - The owner.
 * @param notificationId - The notification.
 * @returns The notification, read.
 * @throws {HttpError} 404, when the user has no such notification.
 */
export async function markRead(userId: string, notificationId: string): Promise<Notification> {
  const updated = await notificationRepository.markRead(notificationId, userId)
  if (updated) return updated

  const existing = await notificationRepository.findByIdAndUser(notificationId, userId)
  if (!existing) throw new HttpError('Notification not found', 404)
  return existing
}

/**
 * Mark every unread notification of the user read, in one statement.
 * @param userId - The owner.
 * @returns How many rows changed.
 */
export async function markAllRead(userId: string): Promise<number> {
  return notificationRepository.markAllRead(userId)
}

/**
 * Delete one notification.
 * @param userId - The owner.
 * @param notificationId - The notification.
 * @throws {HttpError} 404, when the user has no such notification.
 */
export async function deleteNotification(userId: string, notificationId: string): Promise<void> {
  const wasDeleted = await notificationRepository.deleteOne(notificationId, userId)
  if (!wasDeleted) throw new HttpError('Notification not found', 404)
}

/**
 * The user's full preference matrix, defaults resolved for unset types.
 * @param userId - The user.
 * @returns One entry per notification type.
 */
export async function getPreferences(userId: string): Promise<PreferenceMatrix> {
  return notificationPreferenceRepository.getFullMatrix(userId)
}

/**
 * Upsert the given preference entries.
 * @param userId - The user.
 * @param preferences - The validated entries; the schema admits configurable types only.
 * @returns The resulting rows, in input order.
 */
export async function updatePreferences(
  userId: string,
  preferences: UpdatePreferencesInput['preferences']
): Promise<NotificationPreference[]> {
  // Not transactional: a failure partway through leaves earlier upserts
  // committed. Today no type is configurable, so the array is always empty.
  return Promise.all(
    preferences.map((entry) =>
      notificationPreferenceRepository.upsert(userId, entry.notificationType, {
        emailEnabled: entry.emailEnabled,
        inAppEnabled: entry.inAppEnabled,
      })
    )
  )
}

/**
 * Whether `candidate` is newer than `cursor` under the `(createdAt, id)`
 * order `NotificationRepository.list` uses: a same-millisecond tie goes to
 * the larger (time-ordered uuidv7) id.
 * @param candidate - The notification being tested.
 * @param cursor - The last notification the client already has.
 * @returns True when `candidate` is newer.
 */
function isNewerThan(candidate: Notification, cursor: Notification): boolean {
  const candidateTime = candidate.createdAt.getTime()
  const cursorTime = cursor.createdAt.getTime()
  if (candidateTime !== cursorTime) return candidateTime > cursorTime
  return candidate.id > cursor.id
}

/**
 * The notifications a reconnecting SSE client missed after `lastEventId`,
 * bounded to the newest `MAX_NOTIFICATION_PAGE_SIZE`. An id the user no
 * longer owns (deleted since) yields an empty list, not an error.
 * @param userId - The stream's owner.
 * @param lastEventId - The `Last-Event-ID` header value.
 * @returns The missed notifications, oldest first.
 */
export async function fetchMissedNotifications(
  userId: string,
  lastEventId: string
): Promise<Notification[]> {
  const cursor = await notificationRepository.findByIdAndUser(lastEventId, userId)
  if (!cursor) return []

  const { notifications } = await notificationRepository.list(userId, {
    limit: MAX_NOTIFICATION_PAGE_SIZE,
  })

  // list() returns newest-first; the caller replays oldest-first.
  return notifications.filter((notification) => isNewerThan(notification, cursor)).toReversed()
}
