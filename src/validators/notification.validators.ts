/**
 * @file Request shapes for notification.routes.ts: the list query, the `:id` path parameter and the preferences body, each parsed with `parseBody`.
 */
import { z } from 'zod'
import {
  NOTIFICATION_TYPES,
  STAFF_ONLY_NOTIFICATION_TYPES,
} from '@/constants/notification.constants'
import { booleanFilter, listParamsSchema } from '@/validators/list.validators'

/**
 * `GET /api/v1/notifications` query: the shared list params, newest first
 * only, `search` matching the title and body, `unread` picking read or unread ones.
 */
export const notificationListSchema = listParamsSchema({
  sorts: ['-created'],
  defaultSort: '-created',
  filters: { unread: booleanFilter.optional() },
})

/**
 * A parsed notification list query.
 */
export type NotificationListQuery = z.output<typeof notificationListSchema>

/**
 * A notification id path parameter (`PATCH /:id/read`, `DELETE /:id`).
 */
export const notificationIdSchema = z.object({
  id: z.uuid('id must be a 36-character ID.'),
})

/**
 * Notification types whose email channel may never be switched off: the
 * write-side mirror of `NON_DISABLEABLE_EMAIL_TYPES`
 * (notification-preference.repository.ts), kept in sync by hand. The
 * repository ignores a stored email toggle for these types when it decides
 * delivery; `updatePreferencesSchemaFor` refuses to store `emailEnabled:
 * false` for them, so the settings UI never shows a toggle the repository
 * would ignore. `maintenance_mode_changed` must reach every
 * platform owner and admin; `tenant_invitation` has no email on the
 * notification path and is listed only to keep the two sets the same. Their
 * in-app channel stays switchable.
 */
const NON_DISABLEABLE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
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
          message:
            "You can't turn off email for this notification type. You can turn off its in-app notifications.",
        })
      }
    })
  return z.object({
    preferences: z
      .array(entry)
      .min(1, 'preferences must contain at least one entry.')
      .max(
        NOTIFICATION_TYPES.length,
        `preferences must contain at most ${NOTIFICATION_TYPES.length} entries.`
      )
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
