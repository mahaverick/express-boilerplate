/**
 * @file The Resend email webhook adapter. Resend signs with Svix: the
 * signed content is `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256
 * keyed by the base64 part of `RESEND_WEBHOOK_SECRET` (after `whsec_`),
 * and `svix-signature` holds one or more space-separated `v1,<base64>`
 * entries, any of which may match (Svix sends several while a secret
 * rotates). Implemented with node:crypto rather than the `svix` package:
 * the scheme is these few lines, and a dependency would bring its own tree
 * under the repository's 3-day release-age rule. The timestamp must be within
 * five minutes either side of now, which bounds a replay; `svix-id` is the
 * event's deduplication key.
 */
import { createHmac } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { z } from 'zod'
import type { EmailEventType } from '@/constants/email.constants'
import { WebhookPayloadError, WebhookSignatureError } from '@/errors/webhook-errors'
import type {
  EmailWebhookAdapter,
  NormalizedEmailEvent,
  ParsedEmailWebhook,
} from '@/types/email-webhook'
import {
  isSameSignature,
  normalizedMessageIdHeader,
  upperSnakeDetail,
} from '@/utilities/email-webhook.utilities'

/**
 * The Resend adapter's `:provider` segment.
 */
const RESEND_EMAIL_WEBHOOK_PROVIDER = 'resend'

/**
 * How far `svix-timestamp` may be from now, in either direction.
 */
export const RESEND_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000

/**
 * The prefix Resend's signing secrets carry; the rest is base64.
 */
const RESEND_SECRET_PREFIX = 'whsec_'

/**
 * The detail stored for `email.suppressed`: Resend refused the send itself,
 * because the address is on Resend's own suppression list.
 */
const PROVIDER_SUPPRESSED_DETAIL = 'PROVIDER_SUPPRESSED'

// The width of email_events.provider_event_id; Svix ids are `msg_` and base62.
const SVIX_ID_PATTERN = /^[\w-]{1,128}$/
const SVIX_TIMESTAMP_PATTERN = /^\d{1,12}$/
const SIGNATURE_VERSION = 'v1'

/**
 * The Resend event types this app tracks. Every other type is counted as
 * ignored: `email.sent`, `email.scheduled`, `email.received`, and every
 * family that is not `email.*` (`domain.*`, `contact.*`, `suppression.*`,
 * `topic.*`, `inbox.*`). `email.suppressed` is a failed send, not a local
 * suppression: Resend already blocked it, and the local list is fed only by
 * hard bounces and complaints.
 */
const RESEND_EVENT_TYPES: ReadonlyMap<string, EmailEventType> = new Map([
  ['email.delivered', 'delivered'],
  ['email.delivery_delayed', 'deferred'],
  ['email.bounced', 'bounced'],
  ['email.complained', 'complained'],
  ['email.opened', 'opened'],
  ['email.clicked', 'clicked'],
  ['email.failed', 'failed'],
  ['email.suppressed', 'failed'],
])

/**
 * The fields of a Resend email event this adapter reads. `data.click`
 * (the clicked URL) and every free-text message are never read.
 */
const bounceSchema = z.object({ type: z.string().optional(), subType: z.string().optional() })
const dataSchema = z.object({ message_id: z.string(), bounce: bounceSchema.optional() })
const resendEventSchema = z.object({
  type: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  data: dataSchema,
})

/**
 * One header's single value.
 * @param headers - The request headers.
 * @param name - A lowercase header name.
 * @returns The value, or undefined when absent or repeated.
 */
function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * The HMAC key in a `whsec_` secret.
 * @param secret - `RESEND_WEBHOOK_SECRET`.
 * @returns The decoded key bytes.
 */
function signingKey(secret: string): Buffer {
  const encoded = secret.startsWith(RESEND_SECRET_PREFIX)
    ? secret.slice(RESEND_SECRET_PREFIX.length)
    : secret
  return Buffer.from(encoded, 'base64')
}

/**
 * The `v1` signatures a `svix-signature` header carries, decoded.
 * @param header - The header value.
 * @returns Each `v1` signature's bytes; entries of other versions are skipped.
 */
function v1Signatures(header: string): Buffer[] {
  return header
    .split(' ')
    .map((entry) => entry.split(','))
    .filter(([version, value]) => version === SIGNATURE_VERSION && value !== undefined)
    .map(([, value]) => Buffer.from(value ?? '', 'base64'))
}

/**
 * The event type and details of a Resend bounce, suppression or other
 * tracked event.
 * @param type - The tracked type the Resend type maps to.
 * @param resendType - Resend's own type.
 * @param bounce - `data.bounce`, when present.
 * @returns The bounce kind and detail to store, if any.
 */
function detailsFor(
  type: EmailEventType,
  resendType: string,
  bounce: z.infer<typeof bounceSchema> | undefined
): Pick<NormalizedEmailEvent, 'bounceKind' | 'detail'> {
  if (resendType === 'email.suppressed') return { detail: PROVIDER_SUPPRESSED_DETAIL }
  if (type !== 'bounced') return {}
  const detail = upperSnakeDetail(bounce?.subType)
  return {
    // Only Permanent is a hard bounce; Transient and Undetermined may still deliver.
    bounceKind: bounce?.type === 'Permanent' ? 'hard' : 'soft',
    ...(detail !== undefined && { detail }),
  }
}

/**
 * Build the Resend adapter.
 * @param options - Its configuration.
 * @param options.secret - `RESEND_WEBHOOK_SECRET`; undefined disables the adapter.
 * @param options.now - The clock, in milliseconds; injectable for tests.
 * @returns The adapter.
 */
export function createResendEmailWebhookAdapter(options: {
  secret: string | undefined
  now?: () => number
}): EmailWebhookAdapter {
  const now = options.now ?? Date.now
  return {
    provider: RESEND_EMAIL_WEBHOOK_PROVIDER,
    isEnabled: () => options.secret !== undefined && options.secret.length > 0,
    verify(rawBody: Buffer, headers: IncomingHttpHeaders): void {
      const id = singleHeader(headers, 'svix-id')
      const timestamp = singleHeader(headers, 'svix-timestamp')
      const signature = singleHeader(headers, 'svix-signature')
      if (id === undefined || timestamp === undefined || signature === undefined) {
        throw new WebhookSignatureError('missing_headers')
      }
      if (!SVIX_ID_PATTERN.test(id) || !SVIX_TIMESTAMP_PATTERN.test(timestamp)) {
        throw new WebhookSignatureError('malformed_headers')
      }
      if (Math.abs(now() - Number(timestamp) * 1000) > RESEND_SIGNATURE_TOLERANCE_MS) {
        throw new WebhookSignatureError('stale_timestamp')
      }
      const expected = createHmac('sha256', signingKey(options.secret ?? ''))
        .update(`${id}.${timestamp}.`)
        .update(rawBody)
        .digest()
      if (v1Signatures(signature).every((candidate) => !isSameSignature(expected, candidate))) {
        throw new WebhookSignatureError('signature_mismatch')
      }
    },
    parse(rawBody: Buffer, headers: IncomingHttpHeaders): ParsedEmailWebhook {
      let body: unknown
      try {
        body = JSON.parse(rawBody.toString('utf8'))
      } catch {
        throw new WebhookPayloadError()
      }
      const ignored: ParsedEmailWebhook = { events: [], ignored: 1 }
      const parsed = resendEventSchema.safeParse(body)
      const providerEventId = singleHeader(headers, 'svix-id')
      if (providerEventId === undefined || !parsed.success) return ignored
      const type = RESEND_EVENT_TYPES.get(parsed.data.type)
      const messageIdHeader = normalizedMessageIdHeader(parsed.data.data.message_id)
      if (type === undefined || messageIdHeader === undefined) return ignored
      return {
        events: [
          {
            providerEventId,
            messageIdHeader,
            type,
            ...detailsFor(type, parsed.data.type, parsed.data.data.bounce),
            occurredAt: new Date(parsed.data.created_at),
          },
        ],
        ignored: 0,
      }
    },
  }
}
