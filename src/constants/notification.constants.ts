/**
 * @file The in-app notification types and paging limits. The type list has no
 * database CHECK constraint, so a new type needs no migration; the
 * TypeScript type is its only enforcement.
 */

/**
 * Every in-app notification type this codebase produces: `'verify_email'`
 * (register, resend-verification), `'password_reset_requested'`
 * (forgot-password), `'password_changed'` (change-password) and
 * `'tenant_invitation'` (to an existing, verified invitee; in-app only,
 * because the mailed link is the only way to accept). The first two fire when
 * the link is sent, so their names are not past tense; `'password_changed'`
 * fires from `changePassword` (auth.service.ts) after the new hash is stored
 * and the other sessions are revoked. `'maintenance_mode_changed'` goes to
 * every other platform owner and admin when maintenance mode is switched on,
 * escalated or switched off.
 */
export const NOTIFICATION_TYPES = [
  'verify_email',
  'password_reset_requested',
  'password_changed',
  'tenant_invitation',
  'maintenance_mode_changed',
] as const

/**
 * The notification types only platform staff see: a user with no platform
 * membership gets none of them in their preferences list, and an update
 * naming one is refused as for any type that cannot be configured.
 */
export const STAFF_ONLY_NOTIFICATION_TYPES = ['maintenance_mode_changed'] as const

/**
 * One of the fixed set of notification types a `notifications` or
 * `notification_preferences` row may carry.
 */
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/**
 * How many notifications a list request returns when it names no limit.
 * Applied by notification.validators.ts; `NotificationRepository.list`
 * takes `limit` as a required argument.
 */
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20

/**
 * The largest page size a caller may request, enforced by
 * notification.validators.ts before `limit` reaches the repository.
 */
export const MAX_NOTIFICATION_PAGE_SIZE = 100

/**
 * Bytes a notification stream may have queued for a client before the
 * client is treated as stalled and dropped. Bounds per-connection memory.
 */
export const SSE_MAX_BUFFERED_BYTES = 1_048_576
