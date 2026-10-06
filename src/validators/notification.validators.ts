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
  STAFF_ONLY_NOTIFICATION_TYPES,
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
 * account over; `tenant_invitation` has no email on the notification path
 * and is listed to keep the two sets the same; and `maintenance_mode_changed`
 * must reach every owner and admin.
 */
const NON_DISABLEABLE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'verify_email',
  'password_reset_requested',
  'password_changed',
  'tenant_invitation',
  'maintenance_mode_changed',
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
 * The notification types that exist for a caller: every type for platform
 * staff, all but the staff-only ones for everyone else.
 * @param isStaff - Whether the caller holds a platform membership.
 * @returns The types.
 */
function notificationTypesFor(isStaff: boolean): readonly string[] {
  const staffOnly: readonly string[] = STAFF_ONLY_NOTIFICATION_TYPES
  return isStaff
    ? NOTIFICATION_TYPES
    : NOTIFICATION_TYPES.filter((type) => !staffOnly.includes(type))
}

/**
 * `PUT /api/v1/notifications/preferences` request body for one caller: one or
 * more per-type channel toggles to upsert. `z.enum(NOTIFICATION_TYPES)` keeps
 * the parsed type the `NotificationType` union, and the `.refine()` turns
 * "not configurable" into a per-field message
 * (`preferences.<index>.notificationType`) instead of zod's generic
 * invalid-enum text. A staff-only type is not configurable for a caller who
 * cannot see it, whatever `CONFIGURABLE_NOTIFICATION_TYPES` holds.
 * @param isStaff - Whether the caller holds a platform membership.
 * @returns The schema.
 */
export function updatePreferencesSchemaFor(isStaff: boolean) {
  const visibleTypes = notificationTypesFor(isStaff)
  const isConfigurable = (type: string): boolean =>
    visibleTypes.includes(type) &&
    (CONFIGURABLE_NOTIFICATION_TYPES as readonly string[]).includes(type)
  const entry = z.object({
    notificationType: z.enum(NOTIFICATION_TYPES).refine(isConfigurable, {
      message: 'This notification type does not support a configurable preference.',
    }),
    emailEnabled: z.boolean(),
    inAppEnabled: z.boolean(),
  })
  return z.object({
    preferences: z.array(entry).min(1, 'preferences must contain at least one entry.'),
  })
}

/**
 * The validated shape of a `PUT /api/v1/notifications/preferences` request
 * body.
 */
export type UpdatePreferencesInput = z.infer<ReturnType<typeof updatePreferencesSchemaFor>>
