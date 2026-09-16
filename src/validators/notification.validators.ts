// src/validators/notification.validators.ts
//
// Three request shapes for notification.routes.ts: a list query
// (pagination), a path `:id` (mark-read/delete), and a preferences update
// body. `parseBody` (auth.validators.ts) is reused for all three — it takes
// `unknown` and only cares that its argument is a plain object a zod schema
// can walk, so it works identically for `request.query`/`request.params` as
// it does for `request.body`, and this file does not need a second,
// parallel "parseQuery"/"parseParams" helper that would just be this one
// under a different name.
//
// Cursor DECODING deliberately does NOT live here. NotificationRepository
// already exports `decodeNotificationCursor` (notification.repository.ts),
// which never throws — a malformed cursor resolves to `undefined` (first
// page), the same "safest available behaviour" that repository's own header
// comment argues for at the exact boundary this validator sits on (a client-
// supplied query parameter). This file's `listNotificationsSchema` therefore
// only checks that `cursor`, if present, is a string — reusing that decoder
// in the controller is what keeps cursor-format knowledge in the one place
// that already has it, instead of a second implementation here that could
// disagree with it about what counts as a valid cursor.
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

// Notification types a user is allowed to configure a preference for.
// `'verify_email'` and `'password_reset_requested'` are deliberately
// excluded — see notification-preference.repository.ts's
// `NON_DISABLEABLE_EMAIL_TYPES` for the full reasoning on both (a user who
// disabled either would lock themselves out of their own account, one way
// or the other). That set is module-private to the repository and stays
// that way: it governs what `isChannelEnabled` resolves at READ time
// regardless of what any row says, which is a stronger, unconditional
// guarantee than this list. This is the WRITE-side mirror of the same rule
// — narrower in principle (today it happens to match exactly) but
// independently necessary, because without it a client could still
// successfully `PUT` a `{ notificationType: 'verify_email', emailEnabled:
// false }` row; the repository would silently keep honouring email delivery
// regardless, but the settings UI this endpoint serves would show the user
// a toggle that lies about its own effect. KEPT IN SYNC BY HAND with that
// repository set — see its own comment.
//
// NOTIFICATION_TYPES has exactly two entries today and both are excluded
// here, so this filter still produces an EMPTY array — there is nothing
// left to configure until a notification type with a genuinely disableable
// channel ships. That is not a bug to special-case away: `preferenceEntrySchema`
// below rejects every `notificationType` with the same clear, per-field
// message whether the configurable list has one entry, two, or none, so
// `PUT /preferences` already answers 400 correctly — see the "PUT
// /api/v1/notifications/preferences" describe block in
// tests/integration/api/notification.test.ts, which exercises exactly this
// (a `verify_email` update, an empty array, and an unknown type all landing
// on the same clear-message 400) — without this module needing a separate
// branch for "zero configurable types" versus "some, but not this one".
const NON_DISABLEABLE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'verify_email',
  'password_reset_requested',
])

/**
 * Notification types whose preferences a caller may currently update via
 * `PUT /api/v1/notifications/preferences` — today, none (see this file's
 * header comment for why). Not consumed anywhere yet: `preferenceEntrySchema`
 * below is the only reader, via its own `.refine()`. Exported anyway, as the
 * one place this membership is computed, for whichever future consumer needs
 * to know the list ahead of a write — a settings UI wanting to render only
 * the toggles a `PUT` would actually accept, say — rather than recomputing
 * the same filter a second time.
 */
export const CONFIGURABLE_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter(
  (type) => !NON_DISABLEABLE_NOTIFICATION_TYPES.has(type)
)

// `z.enum(NOTIFICATION_TYPES)` first, so the parsed type stays the full
// `NotificationType` literal union — not widened to `string` — letting the
// controller hand `entry.notificationType` straight to
// `NotificationPreferenceRepository.upsert` with no cast. The configurable-
// subset check is then a `.refine()` on top, which is what turns "not
// configurable" into a per-field message a client can act on
// (`preferences.<index>.notificationType`, via `parseBody`'s
// `flattenError`) instead of zod's own generic "invalid enum value" text
// that `z.enum(CONFIGURABLE_NOTIFICATION_TYPES)` alone would produce for
// every rejected type — including, right now, EVERY type, since that list
// is empty.
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
