// src/constants/notification.constants.ts
//
// The single source of truth for which in-app notification types exist —
// same "one array, one place" pattern as TOKEN_PURPOSES
// (user-token.model.ts) and EMAIL_LOG_STATUSES (email-log.model.ts).
// Deliberately NOT mirrored into a database CHECK constraint the way those
// two are: this list is meant to grow as new notification-producing
// features ship (see the design spec's own reserved-for-later entries), and
// a CHECK constraint would need its own migration every time it did. The
// TypeScript type below, plus whatever a later task's validator does with
// it, is this list's only enforcement for now.

/**
 * Every in-app notification type this codebase can currently produce.
 * `'verify_email'` (register/resend-verification) and
 * `'password_reset_requested'` (forgot-password) — a type is added here once
 * something in `src/` actually enqueues it, not speculatively. Deliberately
 * not `'email_verified'`/`'password_reset'`: each notification fires when its
 * link is SENT, before the user has clicked it, so a past-tense name would
 * misdescribe an event that has not happened yet.
 */
export const NOTIFICATION_TYPES = ['verify_email', 'password_reset_requested'] as const

/**
 * One of the fixed set of notification types a `notifications` or
 * `notification_preferences` row may carry. Derived from
 * `NOTIFICATION_TYPES` so this type can never list a value the runtime
 * array does not also recognise.
 */
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/**
 * How many notifications `NotificationRepository.list` returns per page
 * when a caller does not specify a limit. Not read by the repository
 * itself — it takes `limit` as a required argument — this is the default a
 * later task's controller/validator applies before calling it.
 */
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20

/**
 * The largest page size a caller may request. Not enforced by the
 * repository itself, the same way `DEFAULT_NOTIFICATION_PAGE_SIZE` is not —
 * this bounds what a later task's validator lets a client ask for, before
 * `limit` ever reaches `NotificationRepository.list`.
 */
export const MAX_NOTIFICATION_PAGE_SIZE = 100
