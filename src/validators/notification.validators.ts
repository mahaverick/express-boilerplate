/**
 * @file Request shapes for notification.routes.ts: the list query (its cursor
 * decoded here; a malformed one is a 400), the `:id` path parameter and the
 * preferences body, each parsed with `parseBody`.
 */
import { z } from 'zod'
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_TYPES,
  STAFF_ONLY_NOTIFICATION_TYPES,
} from '@/constants/notification.constants'
import { cursorField, isoInstantField } from '@/validators/cursor.validators'

/**
 * The notifications cursor's decoded shape: the last row's `createdAt` (as
 * `encodeNotificationCursor` writes it, from `toISOString()` at millisecond
 * precision) and `id`. `createdAt` must be a real instant in year 0001 or
 * later (see `isoInstantField`), or the `::timestamptz` cast would fail as a
 * 500.
 */
const notificationCursorSchema = z
  .object({
    createdAt: isoInstantField,
    id: z.uuid(),
  })
  .strict()

/**
 * `GET /api/v1/notifications` query string: an optional page size (capped,
 * defaulted) and an optional cursor, decoded.
 */
export const listNotificationsSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_NOTIFICATION_PAGE_SIZE, `limit must be at most ${MAX_NOTIFICATION_PAGE_SIZE}.`)
    .default(DEFAULT_NOTIFICATION_PAGE_SIZE),
  cursor: cursorField(notificationCursorSchema).optional(),
})

/**
 * A notification id path parameter (`PATCH /:id/read`, `DELETE /:id`).
 */
export const notificationIdSchema = z.object({
  id: z.uuid('id must be a valid UUID.'),
})

/**
 * Notification types whose email channel may never be switched off: the
 * write-side mirror of `NON_DISABLEABLE_EMAIL_TYPES`
 * (notification-preference.repository.ts), kept in sync by hand. The
 * repository ignores a stored email toggle for these types when it decides
 * delivery; `updatePreferencesSchemaFor` refuses to store `emailEnabled:
 * false` for them, so the settings UI never shows a toggle the repository
 * would ignore. `verify_email` and `password_reset_requested` would lock the
 * user out if disabled; `password_changed` must not be silenceable by someone
 * who has taken the account over; `maintenance_mode_changed` must reach every
 * platform owner and admin; `tenant_invitation` has no email on the
 * notification path and is listed only to keep the two sets the same. Their
 * in-app channel stays switchable.
 */
const NON_DISABLEABLE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'verify_email',
  'password_reset_requested',
  'password_changed',
  'tenant_invitation',
  'maintenance_mode_changed',
])

/**
 * The notification types that exist for a caller: every type for platform
 * staff, all but the staff-only ones for everyone else.
 * @param isStaff - Whether the caller holds a platform membership.
 */
function notificationTypesFor(isStaff: boolean): readonly string[] {
  const staffOnly: readonly string[] = STAFF_ONLY_NOTIFICATION_TYPES
  return isStaff
    ? NOTIFICATION_TYPES
    : NOTIFICATION_TYPES.filter((type) => !staffOnly.includes(type))
}

/**
 * `PUT /api/v1/notifications/preferences` request body for one caller: one or
 * more per-type channel toggles to upsert. Any type the caller can see may
 * switch `inAppEnabled` either way. `emailEnabled` must be `true` for a type in
 * `NON_DISABLEABLE_NOTIFICATION_TYPES` (all of them today); `false` is a
 * field-scoped 400 (`preferences.<index>.emailEnabled`), so no body, whatever
 * its extra keys or entry order, can store a disabled email channel. A type
 * the caller cannot see (a staff-only one for a non-staff caller) fails on
 * `notificationType`, and a type listed twice fails on its second entry, so one
 * request never races two upserts of the same row. A rejected body writes
 * nothing: the whole body is parsed before the first upsert.
 * `z.enum(NOTIFICATION_TYPES)` keeps the parsed type the `NotificationType`
 * union; unknown keys are stripped by zod.
 * @param isStaff - Whether the caller holds a platform membership.
 */
export function updatePreferencesSchemaFor(isStaff: boolean) {
  const visibleTypes = notificationTypesFor(isStaff)
  const entry = z
    .object({
      notificationType: z.enum(NOTIFICATION_TYPES).refine((type) => visibleTypes.includes(type), {
        message: 'This notification type does not exist.',
      }),
      emailEnabled: z.boolean(),
      inAppEnabled: z.boolean(),
    })
    .superRefine((value, context) => {
      if (!value.emailEnabled && NON_DISABLEABLE_NOTIFICATION_TYPES.has(value.notificationType)) {
        context.addIssue({
          code: 'custom',
          path: ['emailEnabled'],
          message: 'Email for this notification type cannot be turned off.',
        })
      }
    })
  return z.object({
    preferences: z
      .array(entry)
      .min(1, 'preferences must contain at least one entry.')
      .superRefine((entries, context) => {
        const seen = new Set<string>()
        for (const [index, value] of entries.entries()) {
          if (seen.has(value.notificationType)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'notificationType'],
              message: 'Each notification type may appear only once.',
            })
          }
          seen.add(value.notificationType)
        }
      }),
  })
}

/**
 * The validated shape of a `PUT /api/v1/notifications/preferences` request
 * body.
 */
export type UpdatePreferencesInput = z.infer<ReturnType<typeof updatePreferencesSchemaFor>>
