/**
 * @file The in-app notification types and paging limits. The type list has no
 * database CHECK constraint, so adding a type needs no migration; the
 * TypeScript type is its only enforcement.
 */

/**
 * Every in-app notification type this codebase produces:
 * `'tenant_invitation'` (to an existing, verified invitee; in-app only,
 * because the mailed link is the only way to accept), and
 * `'maintenance_mode_changed'`, which goes to every other platform owner and
 * admin when maintenance mode is switched on, escalated or switched off. The
 * billing types go to a workspace's owners: its trial ends in a few days, its
 * payment failed, Paid was cancelled before its first charge, a member asked
 * to upgrade, the owner who paid left, or a join was refused because the
 * workspace is full. Each billing type carries
 * its email when it has one, so the email is never sent twice. Every type
 * starts with both channels on: a user's preference row only turns one off.
 */
export const NOTIFICATION_TYPES = [
  'tenant_invitation',
  'maintenance_mode_changed',
  'billing_trial_ending',
  'billing_payment_failed',
  'billing_paid_cancelled',
  'billing_upgrade_requested',
  'billing_payer_left',
  'workspace_full',
] as const

/**
 * The notification types only platform staff see: a user with no platform
 * membership gets none of them in their preferences list, and an update
 * naming one is refused as a nonexistent type.
 */
export const STAFF_ONLY_NOTIFICATION_TYPES = ['maintenance_mode_changed'] as const

/**
 * One of the fixed set of notification types a `notifications` or
 * `notification_preferences` row may carry.
 */
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/**
 * The most notifications the SSE replay sends a reconnecting client
 * (`fetchMissedNotifications`); the list endpoint's page size comes from
 * `listParamsSchema`.
 */
export const SSE_REPLAY_LIMIT = 100

/**
 * Bytes a notification stream may have queued for a client before the
 * client is treated as stalled and dropped. Bounds per-connection memory.
 */
export const SSE_MAX_BUFFERED_BYTES = 1_048_576
