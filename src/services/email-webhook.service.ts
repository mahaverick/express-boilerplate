/**
 * @file Provider webhooks: the adapter registry and the one place their
 * events reach the tracking tables. Every request is verified, parsed and
 * applied in one transaction: each event is matched to its message by
 * Message-ID header, stored once per provider event id, moves the message's
 * status only upwards (`EmailMessageRepository.advanceStatus`), and a hard
 * bounce or complaint suppresses the address. A provider's retry of a
 * request that failed part-way is therefore applied exactly once.
 */
import type { IncomingHttpHeaders } from 'node:http'
import { getEnv, isFakeEmailWebhookAllowed, type Env } from '@/configs/env.config'
import {
  EMAIL_DETAIL_MAX_LENGTH,
  EMAIL_DETAIL_PATTERN,
  type AdvanceableEmailStatus,
  type EmailEventType,
  type FailureOrigin,
  type SuppressionReason,
} from '@/constants/email.constants'
import { HttpError } from '@/errors/http-error'
import { WebhookPayloadError, WebhookSignatureError } from '@/errors/webhook-errors'
import { EmailEventRepository } from '@/repositories/email-event.repository'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { EmailSuppressionRepository } from '@/repositories/email-suppression.repository'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { createFakeEmailWebhookAdapter } from '@/services/email-webhook-fake.service'
import { logger } from '@/services/logger.service'
import type {
  EmailWebhookAdapter,
  NormalizedEmailEvent,
  ParsedEmailWebhook,
} from '@/types/email-webhook'

/**
 * The error code of a request whose signature does not verify.
 */
export const INVALID_SIGNATURE_CODE = 'INVALID_SIGNATURE'

/**
 * The error code of a verified request whose body is not JSON.
 */
export const INVALID_PAYLOAD_CODE = 'INVALID_PAYLOAD'

const emailEventRepository = new EmailEventRepository()
const emailMessageRepository = new EmailMessageRepository()
const emailSuppressionRepository = new EmailSuppressionRepository()

/**
 * What one webhook request did. `received` is every event in the body;
 * each lands in exactly one of `ignored` (a type this app does not track),
 * `unmatched` (no message has its Message-ID), `duplicate` (this provider
 * event id was stored before) and `processed`. `byType` counts the
 * processed events by type.
 */
export interface EmailWebhookResult {
  received: number
  duplicate: number
  unmatched: number
  ignored: number
  processed: number
  byType: Partial<Record<EmailEventType, number>>
}

/**
 * How an event moves its message's status.
 */
export interface StatusChange {
  status: AdvanceableEmailStatus
  failureOrigin?: FailureOrigin
}

/**
 * The environment the registry reads.
 */
export type EmailWebhookEnv = Pick<Env, 'APP_ENV' | 'FAKE_EMAIL_WEBHOOK_SECRET'>

/**
 * Every adapter this environment registers, enabled or not. The fake adapter
 * is registered only where `isFakeEmailWebhookAllowed` holds.
 * @param env - The validated environment.
 * @returns The registered adapters.
 */
export function emailWebhookAdapters(env: EmailWebhookEnv): EmailWebhookAdapter[] {
  const adapters: EmailWebhookAdapter[] = []
  if (isFakeEmailWebhookAllowed(env)) {
    adapters.push(createFakeEmailWebhookAdapter({ secret: env.FAKE_EMAIL_WEBHOOK_SECRET }))
  }
  return adapters
}

/**
 * The enabled adapter for a `:provider` path segment.
 * @param provider - The path segment.
 * @param env - The validated environment; defaults to `getEnv()`.
 * @returns The adapter, or undefined when the provider is unknown or its secret is not configured.
 */
export function getEmailWebhookAdapter(
  provider: string,
  env: EmailWebhookEnv = getEnv()
): EmailWebhookAdapter | undefined {
  return emailWebhookAdapters(env).find(
    (adapter) => adapter.provider === provider && adapter.isEnabled()
  )
}

/**
 * The status an event moves its message to. A soft bounce is a delay, so it
 * moves the message only to `deferred` and a later `delivered` still lands;
 * opens and clicks move nothing.
 * @param event - The normalised event.
 * @returns The change, or undefined when the event leaves the status alone.
 */
export function statusChangeFor(event: NormalizedEmailEvent): StatusChange | undefined {
  switch (event.type) {
    case 'bounced': {
      return { status: event.bounceKind === 'hard' ? 'bounced' : 'deferred' }
    }
    case 'failed': {
      return { status: 'failed', failureOrigin: 'provider' }
    }
    case 'opened':
    case 'clicked': {
      return undefined
    }
    default: {
      return { status: event.type }
    }
  }
}

/**
 * Why an event suppresses its recipient: a hard bounce or a complaint, and
 * nothing else.
 * @param event - The normalised event.
 * @returns The suppression reason, or undefined.
 */
export function suppressionReasonFor(event: NormalizedEmailEvent): SuppressionReason | undefined {
  if (event.type === 'complained') return 'complaint'
  if (event.type === 'bounced' && event.bounceKind === 'hard') return 'hard_bounce'
  return undefined
}

/**
 * An adapter's `detail`, kept only in the shape the `email_events.detail`
 * CHECK accepts, so an adapter bug drops the value instead of failing the
 * insert.
 * @param detail - The adapter's value.
 * @returns The value, or undefined, which the insert writes as NULL.
 */
function storableDetail(detail: string | undefined): string | undefined {
  if (detail === undefined || detail.length > EMAIL_DETAIL_MAX_LENGTH) return undefined
  return EMAIL_DETAIL_PATTERN.test(detail) ? detail : undefined
}

/**
 * Run the adapter's signature check, logging a refusal without the payload.
 * @param adapter - The provider's adapter.
 * @param rawBody - The exact body bytes.
 * @param headers - The request headers.
 * @throws {HttpError} 401 `INVALID_SIGNATURE` when the check fails.
 */
function verifyOrRefuse(
  adapter: EmailWebhookAdapter,
  rawBody: Buffer,
  headers: IncomingHttpHeaders
): void {
  try {
    adapter.verify(rawBody, headers)
  } catch (error) {
    if (!(error instanceof WebhookSignatureError)) throw error
    logger.warn('email webhook signature rejected', {
      provider: adapter.provider,
      reason: error.reason,
    })
    throw new HttpError('Invalid signature', 401, INVALID_SIGNATURE_CODE)
  }
}

/**
 * Parse a verified body.
 * @param adapter - The provider's adapter.
 * @param rawBody - The exact body bytes.
 * @param headers - The request headers.
 * @returns The adapter's events.
 * @throws {HttpError} 400 `INVALID_PAYLOAD` when the body is not JSON.
 */
function parseOrRefuse(
  adapter: EmailWebhookAdapter,
  rawBody: Buffer,
  headers: IncomingHttpHeaders
): ParsedEmailWebhook {
  try {
    return adapter.parse(rawBody, headers)
  } catch (error) {
    if (!(error instanceof WebhookPayloadError)) throw error
    logger.warn('email webhook payload rejected', { provider: adapter.provider })
    throw new HttpError('Invalid payload', 400, INVALID_PAYLOAD_CODE)
  }
}

/**
 * Apply one event inside the request's transaction, counting it in `result`.
 * @param provider - The adapter's provider name.
 * @param event - The event.
 * @param result - The request's counts, updated in place.
 * @param tx - The request's transaction.
 */
async function applyEvent(
  provider: string,
  event: NormalizedEmailEvent,
  result: EmailWebhookResult,
  tx: DbTransaction
): Promise<void> {
  const message = await emailMessageRepository.findByMessageIdHeader(event.messageIdHeader, tx)
  if (!message) {
    result.unmatched += 1
    return
  }
  const stored = await emailEventRepository.insertIfNew(
    {
      messageId: message.id,
      provider,
      providerEventId: event.providerEventId,
      type: event.type,
      bounceKind: event.bounceKind,
      detail: storableDetail(event.detail),
      occurredAt: event.occurredAt,
    },
    tx
  )
  if (!stored) {
    result.duplicate += 1
    return
  }
  const change = statusChangeFor(event)
  if (change) {
    const { status, ...options } = change
    await emailMessageRepository.advanceStatus(message.id, status, options, tx)
  }
  const reason = suppressionReasonFor(event)
  if (reason) {
    await emailSuppressionRepository.suppress(
      { address: message.recipient, reason, sourceEventId: stored.id },
      tx
    )
  }
  result.processed += 1
  result.byType[event.type] = (result.byType[event.type] ?? 0) + 1
}

/**
 * Verify, parse and apply one webhook request, then log one
 * `email webhook processed` line with its counts.
 * @param adapter - The enabled adapter for the request's provider.
 * @param rawBody - The exact body bytes, as the provider signed them.
 * @param headers - The request headers.
 * @returns The request's counts.
 * @throws {HttpError} 401 `INVALID_SIGNATURE`; 400 `INVALID_PAYLOAD`; any database error rolls back every event in the request.
 */
export async function processEmailWebhook(
  adapter: EmailWebhookAdapter,
  rawBody: Buffer,
  headers: IncomingHttpHeaders
): Promise<EmailWebhookResult> {
  verifyOrRefuse(adapter, rawBody, headers)
  const parsed = parseOrRefuse(adapter, rawBody, headers)
  const result = await withTransaction(async (tx) => {
    const counts: EmailWebhookResult = {
      received: parsed.events.length + parsed.ignored,
      duplicate: 0,
      unmatched: 0,
      ignored: parsed.ignored,
      processed: 0,
      byType: {},
    }
    for (const event of parsed.events) await applyEvent(adapter.provider, event, counts, tx)
    return counts
  })
  logger.info('email webhook processed', { provider: adapter.provider, ...result })
  return result
}
