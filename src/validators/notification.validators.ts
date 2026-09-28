/**
 * @file Request shapes for notification.routes.ts: the list query, the `:id`
 * path parameter and the preferences body, each parsed with `parseBody`.
 * Cursor decoding is not here: notification.service.ts uses the repository's
 * `decodeNotificationCursor`, the one place that knows the format.
 */
import { z } from 'zod'
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_TYPES,
} from '@/constants/notification.constants'

/**
 * `GET /api/v1/notifications` query string: an optional page size (capped,
 * defaulted) and an optional opaque cursor.
 */
export const listNotificationsSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_NOTIFICATION_PAGE_SIZE, `limit must be at most ${MAX_NOTIFICATION_PAGE_SIZE}.`)
    .default(DEFAULT_NOTIFICATION_PAGE_SIZE),
  cursor: z.string().optional(),
})

/**
 * The validated shape of a `GET /api/v1/notifications` query string.
 */
export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>

/**
 * A notification id path parameter (`PATCH /:id/read`, `DELETE /:id`).
 */
export const notificationIdSchema = z.object({
  id: z.uuid('id must be a valid UUID.'),
})

/**
 * The validated shape of a notification id path parameter.
 */
export type NotificationIdParameters = z.infer<typeof notificationIdSchema>

/**
 * Notification types no preference may be written for: the write-side mirror
 * of `NON_DISABLEABLE_EMAIL_TYPES` (notification-preference.repository.ts),
 * kept in sync by hand. That set is module-private and decides delivery at
 * read time whatever a row says; this one stops a `PUT` from storing a toggle
 * the settings UI would show but the repository would ignore. Two reasons
 * apply, plus a listing-only third: `verify_email` and
 * `password_reset_requested` would lock the user out if disabled;
 * `password_changed` must not be silenceable by someone who has taken the
 * account over; and `tenant_invitation` has no email on the notification path
 * and is listed to keep the two sets the same.
 */
const NON_DISABLEABLE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'verify_email',
  'password_reset_requested',
  'password_changed',
  'tenant_invitation',
])

/**
 * Notification types whose preferences `PUT /api/v1/notifications/preferences`
 * accepts. Every type is non-disableable, so the list is empty and that route
 * answers 400 for every entry; `preferenceEntrySchema` is its only reader.
 */
export const CONFIGURABLE_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter(
  (type) => !NON_DISABLEABLE_NOTIFICATION_TYPES.has(type)
)

/**
 * One preference entry. `z.enum(NOTIFICATION_TYPES)` keeps the parsed type the
 * `NotificationType` union, and the `.refine()` turns "not configurable" into
 * a per-field message (`preferences.<index>.notificationType`) instead of
 * zod's generic invalid-enum text.
 */
const preferenceEntrySchema = z.object({
  notificationType: z
    .enum(NOTIFICATION_TYPES)
    .refine((type) => CONFIGURABLE_NOTIFICATION_TYPES.includes(type), {
      message: 'This notification type does not support a configurable preference.',
    }),
  emailEnabled: z.boolean(),
  inAppEnabled: z.boolean(),
})

/**
 * `PUT /api/v1/notifications/preferences` request body: one or more
 * per-type channel toggles to upsert.
 */
export const updatePreferencesSchema = z.object({
  preferences: z
    .array(preferenceEntrySchema)
    .min(1, 'preferences must contain at least one entry.'),
})

/**
 * The validated shape of a `PUT /api/v1/notifications/preferences` request
 * body.
 */
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>
