/**
 * @file The fixed value sets of email tracking (`email_messages`,
 * `email_events`, `email_suppressions`), mirrored into those tables' CHECK
 * constraints, and the status ranks every status writer obeys.
 */

/**
 * Every status an `email_messages` row can hold. `EmailMessageStatus` and
 * `email_messages_status_check` are both built from it.
 */
export const EMAIL_MESSAGE_STATUSES = [
  'queued',
  'sent',
  'deferred',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'suppressed',
] as const

/**
 * One of `EMAIL_MESSAGE_STATUSES`.
 */
export type EmailMessageStatus = (typeof EMAIL_MESSAGE_STATUSES)[number]

/**
 * How far along a message is. A writer moves a message only to a strictly
 * higher rank (`EmailMessageRepository.advanceStatus`), so a `delivered`
 * event that lands before the worker records `sent` is never overwritten.
 * `suppressed` shares rank 0 with `queued` but is written only from `queued`
 * by `markSuppressed`, and nothing advances a suppressed message.
 */
export const EMAIL_STATUS_RANK: Readonly<Record<EmailMessageStatus, number>> = {
  queued: 0,
  sent: 1,
  deferred: 2,
  delivered: 3,
  bounced: 4,
  failed: 4,
  complained: 5,
  suppressed: 0,
}

/**
 * The statuses `advanceStatus` may write: every status but the two a message
 * starts in.
 */
export type AdvanceableEmailStatus = Exclude<EmailMessageStatus, 'queued' | 'suppressed'>

/**
 * Every provider event type `email_events.type` can hold.
 */
export const EMAIL_EVENT_TYPES = [
  'delivered',
  'deferred',
  'bounced',
  'complained',
  'opened',
  'clicked',
  'failed',
] as const

/**
 * One of `EMAIL_EVENT_TYPES`.
 */
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number]

/**
 * A bounce is hard (the mailbox does not exist) or soft (a delay).
 */
export const BOUNCE_KINDS = ['hard', 'soft'] as const

/**
 * One of `BOUNCE_KINDS`.
 */
export type BounceKind = (typeof BOUNCE_KINDS)[number]

/**
 * Which sender a template mails from: `transactional` (a domain with click
 * tracking off) for every template whose links carry a token, `general` for
 * the rest.
 */
export const SENDER_CLASSES = ['transactional', 'general'] as const

/**
 * One of `SENDER_CLASSES`.
 */
export type SenderClass = (typeof SENDER_CLASSES)[number]

/**
 * Who set a message `failed`: the send (every attempt failed), the provider
 * (a webhook event), or the enqueue (the job never reached the queue).
 */
export const FAILURE_ORIGINS = ['send', 'provider', 'enqueue'] as const

/**
 * One of `FAILURE_ORIGINS`.
 */
export type FailureOrigin = (typeof FAILURE_ORIGINS)[number]

/**
 * Why an address is suppressed. Only our own hard-bounce and complaint
 * events add one.
 */
export const SUPPRESSION_REASONS = ['hard_bounce', 'complaint'] as const

/**
 * One of `SUPPRESSION_REASONS`.
 */
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

/**
 * One of the five disjoint groups the stats and the health page count
 * messages in.
 */
export type EmailMessageGroup = 'delivered' | 'sent' | 'undelivered' | 'complained' | 'suppressed'

/**
 * The statuses each group counts, by current status. `queued` is in none:
 * it has not been attempted.
 */
export const EMAIL_MESSAGE_GROUPS: Readonly<
  Record<EmailMessageGroup, readonly EmailMessageStatus[]>
> = {
  delivered: ['delivered'],
  sent: ['sent', 'deferred'],
  undelivered: ['bounced', 'failed'],
  complained: ['complained'],
  suppressed: ['suppressed'],
}

/**
 * The only shape `email_events.detail` may take: upper snake case, which a
 * raw token (lowercase hex or base64url) can never match. Shared with
 * `email_events_detail_check`.
 */
export const EMAIL_DETAIL_PATTERN = /^[A-Z][A-Z0-9_]*$/

/**
 * The widest an `email_events.detail` value may be.
 */
export const EMAIL_DETAIL_MAX_LENGTH = 32

/**
 * The widest `email_suppressions.lift_reason` may be: `MAX_REASON_LENGTH`
 * (platform.validators.ts), which bounds a staff reason before it gets here.
 */
export const LIFT_REASON_MAX_LENGTH = 500

/**
 * A key that names a secret in a template's variables: every link that
 * carries a token ends in `Url`, and nothing else is named `…Token`.
 * `EmailMessageRepository.createQueued` refuses to store one.
 */
export const SECRET_VARIABLE_PATTERN = /(?:Url|Token)$/
