/**
 * @file The provider-neutral seam between an email provider's webhook and
 * the tracking tables. Each provider is one adapter
 * (`services/email-webhook-*.service.ts`); `processEmailWebhook`
 * (email-webhook.service.ts) applies what any adapter returns.
 */
import type { IncomingHttpHeaders } from 'node:http'
import type { BounceKind, EmailEventType } from '@/constants/email.constants'

/**
 * One provider event, reduced to what the tracking tables store. Never a
 * raw payload, a clicked URL or a provider's free-text message.
 */
export interface NormalizedEmailEvent {
  /**
   * The provider's own id for this delivery of the event; with the provider
   * name it is the deduplication key (`email_events` unique index).
   */
  providerEventId: string
  /**
   * The RFC 5322 Message-ID the message was sent with, trimmed, angle
   * brackets kept: `<id@domain>`.
   */
  messageIdHeader: string
  type: EmailEventType
  /**
   * Set only on a `bounced` event.
   */
  bounceKind?: BounceKind
  /**
   * An UPPER_SNAKE reason code (`EMAIL_DETAIL_PATTERN`), or absent.
   */
  detail?: string
  occurredAt: Date
}

/**
 * What an adapter read from one verified request body: the events it
 * understood, and how many it skipped: a type this app does not track, or a
 * malformed event (a missing field, a non-object item, an unusable
 * Message-ID header).
 */
export interface ParsedEmailWebhook {
  events: NormalizedEmailEvent[]
  ignored: number
}

/**
 * One email provider's webhook: how to authenticate a request and how to
 * read its events.
 */
export interface EmailWebhookAdapter {
  /**
   * The `:provider` path segment, and the value stored in `email_events.provider`.
   */
  provider: string
  /**
   * Whether the adapter's signing secret is configured. A disabled adapter
   * answers 404, like an unknown provider.
   */
  isEnabled(): boolean
  /**
   * Check the request's signature over the exact body bytes. Throws a
   * `WebhookSignatureError` (errors/webhook-errors.ts) when the provider did
   * not sign it, or signed it outside the adapter's tolerance.
   */
  verify(rawBody: Buffer, headers: IncomingHttpHeaders): void
  /**
   * Read the events from a body `verify` accepted. Throws a
   * `WebhookPayloadError` when the body is not JSON; an event of a type the
   * adapter does not map, or malformed (missing a field it needs, not an
   * object, or with an unusable Message-ID header), is counted in `ignored`.
   */
  parse(rawBody: Buffer, headers: IncomingHttpHeaders): ParsedEmailWebhook
}
