/**
 * @file The `fake` email webhook adapter, for local development and the test
 * suite: an HMAC-SHA256 hex digest of the raw body, keyed by
 * `FAKE_EMAIL_WEBHOOK_SECRET`, in `x-fake-signature`. The registry
 * (email-webhook.service.ts) serves it only where `isFakeEmailWebhookAllowed`
 * holds. `pnpm email:fire-event` builds and signs its requests.
 */
import { createHmac } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { z } from 'zod'
import { BOUNCE_KINDS, EMAIL_EVENT_TYPES } from '@/constants/email.constants'
import { WebhookPayloadError, WebhookSignatureError } from '@/errors/webhook-errors'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import type {
  EmailWebhookAdapter,
  NormalizedEmailEvent,
  ParsedEmailWebhook,
} from '@/types/email-webhook'
import { isSameSignature, normalizedMessageIdHeader } from '@/utilities/email-webhook.utilities'

/**
 * The fake adapter's `:provider` segment.
 */
export const FAKE_EMAIL_WEBHOOK_PROVIDER = 'fake'

/**
 * The header carrying the fake adapter's signature.
 */
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature'

const HEX_SIGNATURE = /^[\da-f]{64}$/

const emailMessageRepository = new EmailMessageRepository()

/**
 * One fake event as `pnpm email:fire-event` sends it. `messageId` is the
 * Message-ID header in `<…>` form, as Resend's `data.message_id` is.
 * Anything that fails this shape is counted as ignored.
 */
const fakeEventSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(EMAIL_EVENT_TYPES),
  messageId: z.string().min(1),
  bounceKind: z.enum(BOUNCE_KINDS).optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
})

/**
 * The fake adapter's signature over a body.
 * @param rawBody - The exact request body bytes.
 * @param secret - `FAKE_EMAIL_WEBHOOK_SECRET`.
 * @returns The lowercase hex HMAC-SHA256 digest.
 */
export function fakeEmailWebhookSignature(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

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
 * One payload item as a normalised event.
 * @param item - One element of the body.
 * @param now - The time an item without `occurredAt` is stamped with.
 * @returns The event, or undefined when the item is not a fake event this adapter reads.
 */
function normalizedFakeEvent(item: unknown, now: Date): NormalizedEmailEvent | undefined {
  const parsed = fakeEventSchema.safeParse(item)
  if (!parsed.success) return undefined
  const messageIdHeader = normalizedMessageIdHeader(parsed.data.messageId)
  if (messageIdHeader === undefined) return undefined
  const { id, type, bounceKind, occurredAt } = parsed.data
  return {
    providerEventId: id,
    messageIdHeader,
    type,
    ...(type === 'bounced' && { bounceKind: bounceKind ?? 'hard' }),
    occurredAt: occurredAt === undefined ? now : new Date(occurredAt),
  }
}

/**
 * Build the fake adapter.
 * @param options - Its configuration.
 * @param options.secret - `FAKE_EMAIL_WEBHOOK_SECRET`.
 * @param options.now - The clock; injectable for tests.
 * @returns The adapter.
 */
export function createFakeEmailWebhookAdapter(options: {
  secret: string
  now?: () => Date
}): EmailWebhookAdapter {
  const now = options.now ?? (() => new Date())
  return {
    provider: FAKE_EMAIL_WEBHOOK_PROVIDER,
    isEnabled: () => options.secret.length > 0,
    verify(rawBody: Buffer, headers: IncomingHttpHeaders): void {
      const signature = singleHeader(headers, FAKE_SIGNATURE_HEADER)
      if (signature === undefined) throw new WebhookSignatureError('missing_headers')
      if (!HEX_SIGNATURE.test(signature)) throw new WebhookSignatureError('malformed_headers')
      const expected = Buffer.from(fakeEmailWebhookSignature(rawBody, options.secret), 'hex')
      if (!isSameSignature(expected, Buffer.from(signature, 'hex'))) {
        throw new WebhookSignatureError('signature_mismatch')
      }
    },
    parse(rawBody: Buffer): ParsedEmailWebhook {
      let body: unknown
      try {
        body = JSON.parse(rawBody.toString('utf8'))
      } catch {
        throw new WebhookPayloadError()
      }
      const items = Array.isArray(body) ? (body as unknown[]) : [body]
      const at = now()
      const events: NormalizedEmailEvent[] = []
      for (const item of items) {
        const event = normalizedFakeEvent(item, at)
        if (event) events.push(event)
      }
      return { events, ignored: items.length - events.length }
    },
  }
}

/**
 * The Message-ID header of a stored message, for `pnpm email:fire-event`,
 * which is given the message's id.
 * @param messageId - An `email_messages.id`.
 * @returns Its `message_id_header`, or undefined when no such message exists.
 */
export async function messageIdHeaderFor(messageId: string): Promise<string | undefined> {
  const message = await emailMessageRepository.findById(messageId)
  return message?.messageIdHeader
}
