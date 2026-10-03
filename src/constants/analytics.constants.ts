/**
 * @file Fixed values of the analytics pipeline: the event names the server
 * sends, the renames and overlaps the builder's collision rule allows, the
 * property keys the PII guard drops, and the drainer's limits.
 */
import type { AuditAction } from '@/constants/audit.constants'

/**
 * A posthog-js session id: a UUID (posthog-js mints UUIDv7). An
 * `X-POSTHOG-SESSION-ID` header of any other shape is dropped.
 */
export const POSTHOG_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Audit actions whose mechanical event name (`.` to `_`) would mislead, and
 * the name each is sent under instead. A staff-forced sign-out must not
 * share a name with a user signing themselves out (`user_signed_out`).
 */
export const AUDIT_EVENT_RENAMES = {
  'user.signed_out': 'user_sessions_revoked',
} as const satisfies Partial<Record<AuditAction, string>>

/**
 * The product events: things worth counting that the audit log does not
 * record, emitted as domain events after commit.
 */
export const PRODUCT_EVENTS = [
  'user_signed_up',
  'user_signed_in',
  'user_signed_out',
  'password_changed',
  'password_reset_completed',
  'email_verified',
  'onboarding_step_completed',
] as const

/**
 * One of `PRODUCT_EVENTS`.
 */
export type ProductEventName = (typeof PRODUCT_EVENTS)[number]

/**
 * The prefix of every email tracking event: `email_` then the
 * `email_events.type`.
 */
export const EMAIL_EVENT_PREFIX = 'email_'

/**
 * Event names both a product (or email) event and a mapped audit action may
 * use. `onboarding_step_completed` is deliberate: a staff completion is
 * audited and forwards from the audit log, every other completion is a
 * product event, and both carry the same properties.
 */
export const ALLOWED_EVENT_NAME_OVERLAPS = ['onboarding_step_completed'] as const

/**
 * Property keys never sent to PostHog, whatever their value: a backstop
 * behind the builder's typed mappings.
 */
export const PII_PROPERTY_KEYS = [
  'email',
  'name',
  'reason',
  'recipient',
  'subject',
  'detail',
] as const

/**
 * How many times PostHog may refuse a row sent on its own before the drainer
 * deletes it.
 */
export const ANALYTICS_POISON_REJECTIONS = 3

/**
 * How long a drainer's claim holds its rows.
 */
export const ANALYTICS_LEASE_SECONDS = 60

/**
 * How long one PostHog batch request may take.
 */
export const ANALYTICS_SEND_TIMEOUT_MS = 10_000

/**
 * The `distinct_id` of an event no person caused. Its events carry
 * `$process_person_profile: false`, so PostHog creates no person for it.
 */
export const SYSTEM_DISTINCT_ID = 'system'
