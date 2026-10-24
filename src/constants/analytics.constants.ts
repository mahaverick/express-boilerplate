/**
 * @file Fixed values of the analytics pipeline: the event names the server
 * sends, the audit-action renames, the property keys the PII guard drops, and
 * the limits of the outbox drainer and the PostHog person-deletion job.
 */
import type { AuditAction } from '@/constants/audit.constants'

/**
 * The shape of a posthog-js session id: a UUID (posthog-js mints UUIDv7). An
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
  'user.passkey_created': 'passkey_created',
  'user.passkey_deleted': 'passkey_deleted',
  'user.passkeys_cleared_on_claim': 'passkeys_cleared_on_claim',
} as const satisfies Partial<Record<AuditAction, string>>

/**
 * The product events: things worth counting that the audit log does not
 * record, emitted as domain events after commit. From `trial_started` on
 * they are the billing events, each in its workspace's group with the
 * workspace's `plan` and `billing_state` after the change.
 */
export const PRODUCT_EVENTS = [
  'user_signed_up',
  'user_signed_in',
  'user_signed_out',
  'other_sessions_revoked',
  'email_verified',
  'onboarding_step_completed',
  'trial_started',
  'trial_reminder_sent',
  'trial_extended',
  'trial_ended',
  'plan_limit_approaching',
  'plan_limit_reached',
  'plan_feature_blocked',
  'upgrade_requested',
  'upgrade_request_fulfilled',
  'checkout_started',
  'checkout_confirmed',
  'subscription_activated',
  'subscription_renewed',
  'payment_failed',
  'subscription_recovered',
  'subscription_halted',
  'subscription_cancel_scheduled',
  'subscription_interval_change_scheduled',
  'downgraded_to_free',
  'payer_left',
  'duplicate_subscription_refunded',
  'billing_reconciled',
  'dispute_opened',
] as const

/**
 * The prefix of every email tracking event: `email_` then the
 * `email_events.type`.
 */
export const EMAIL_EVENT_PREFIX = 'email_'

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
 * deletes it unsent.
 */
export const ANALYTICS_POISON_REJECTIONS = 3

/**
 * How long a drainer's claim holds its rows.
 */
export const ANALYTICS_LEASE_SECONDS = 60

/**
 * How long one request to PostHog's ingestion may take: a batch send or an
 * error-report flush.
 */
export const ANALYTICS_SEND_TIMEOUT_MS = 10_000

/**
 * The `distinct_id` of an event no person caused. Its events carry
 * `$process_person_profile: false`, so PostHog creates no person for it.
 */
export const SYSTEM_DISTINCT_ID = 'system'

/**
 * The event property that carries a server event's signature
 * (analytics-signature.service.ts). The drainer adds it at send time; a reader
 * of PostHog's events trusts a row's server fields only when it verifies.
 */
export const ANALYTICS_SIGNATURE_PROPERTY = 'server_sig'

/**
 * How long one call to PostHog's private API may take.
 */
export const POSTHOG_API_TIMEOUT_MS = 15_000

/**
 * How long after a user purge their PostHog deletion is first sent. PostHog
 * deletes only events it ingested before the request, so the delay lets
 * events already on their way land first.
 */
export const ANALYTICS_DELETION_DELAY_MS = 60 * 60 * 1000

/**
 * The most purged users one deletion tick sends to PostHog, in one
 * `persons/bulk_delete/` request (PostHog takes up to 1000).
 */
export const ANALYTICS_DELETION_BATCH_SIZE = 10

/**
 * How long a deletion tick's claim holds its rows: it covers one batch
 * request plus one request per claimed row, each at the
 * `POSTHOG_API_TIMEOUT_MS` (15 s) timeout (11 x 15 s = 165 s at the
 * batch size), so a tick that crashes mid-request releases them and a live
 * one keeps them.
 */
export const ANALYTICS_DELETION_LEASE_SECONDS = 180

/**
 * Milliseconds between deletion ticks.
 */
export const ANALYTICS_DELETION_INTERVAL_MS = 60_000

/**
 * How long after a purge a failed deletion starts logging at `error`
 * instead of `warn`: 24 hours.
 */
export const ANALYTICS_DELETION_OVERDUE_MS = 24 * 60 * 60 * 1000
