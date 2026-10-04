/**
 * @file The one call that sends events to PostHog: `POST <POSTHOG_HOST>/batch/`
 * with `fetch`, classified as acknowledged, retryable or rejected. Not
 * posthog-node: its capture resolves on a 500, so it cannot tell the drainer
 * whether a batch landed. It imports no database module, so it opens no pool.
 */
import { getEnv } from '@/configs/env.config'
import {
  ANALYTICS_SEND_TIMEOUT_MS,
  ANALYTICS_SIGNATURE_PROPERTY,
} from '@/constants/analytics.constants'
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import {
  signAnalyticsEvent,
  signedFieldsOf,
} from '@/services/analytics/analytics-signature.service'

/**
 * One event in a PostHog `/batch/` request body. `uuid` is the outbox row id,
 * so a resend after a lost acknowledgement carries the same `uuid`,
 * `timestamp`, `event` and `distinct_id` as the first send, which is what
 * PostHog deduplicates on.
 */
export interface PosthogBatchEvent {
  event: string
  distinct_id: string
  properties: Record<string, unknown>
  uuid: string
  timestamp: string
}

/**
 * How PostHog answered a batch: `ack` (2xx, every event accepted), `retry`
 * (no answer, a timeout, 429, 5xx or an endpoint-level 4xx: send the same events again later) or
 * `rejected` (any other 4xx: the batch itself is refused, and sending it
 * again unchanged would be refused again).
 */
export type SendResult =
  { kind: 'ack' } | { kind: 'retry'; status?: number } | { kind: 'rejected'; status: number }

/**
 * 4xx statuses that describe the endpoint or the credentials, not the batch:
 * unauthorized, forbidden, not found, method not allowed, proxy auth required
 * and request timeout.
 */
export const ENDPOINT_LEVEL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405, 407, 408])

/**
 * The `/batch/` form of an outbox row, signed: `server_sig`
 * (`ANALYTICS_SIGNATURE_PROPERTY`) covers the uuid, event, distinct id,
 * `source`, `access`, `target_type`, `target_id` and `$groups.tenant`
 * (`signAnalyticsEvent`), so a consumer can tell a server event from one a
 * browser forged through the collect proxy. It is added to the wire event
 * only; the outbox row is not changed.
 * @param row - The claimed outbox row, its markers already resolved.
 * @returns The event as PostHog's batch endpoint takes it.
 */
export function toPosthogBatchEvent(
  row: Pick<AnalyticsOutboxRow, 'id' | 'event' | 'distinctId' | 'properties' | 'occurredAt'>
): PosthogBatchEvent {
  const properties = row.properties
  const signature = signAnalyticsEvent(
    signedFieldsOf({ uuid: row.id, event: row.event, distinctId: row.distinctId }, properties)
  )
  return {
    event: row.event,
    distinct_id: row.distinctId,
    properties: { ...properties, [ANALYTICS_SIGNATURE_PROPERTY]: signature },
    uuid: row.id,
    timestamp: row.occurredAt.toISOString(),
  }
}

/**
 * Classify a PostHog response status.
 * @param status - The HTTP status PostHog answered with.
 * @returns `ack` for 2xx; `rejected` for a 4xx that is not endpoint-level
 *   (400, 413, 415, 422 and the like: the batch is at fault); `retry` for
 *   everything else (429, 5xx, a 1xx or 3xx `fetch` did not resolve, and the
 *   endpoint-level 4xx: a bad key or host fails every batch, so it is no
 *   verdict on these rows).
 */
export function classifyStatus(status: number): SendResult {
  if (status >= 200 && status < 300) return { kind: 'ack' }
  if (status !== 429 && status >= 400 && status < 500 && !ENDPOINT_LEVEL_STATUSES.has(status)) {
    return { kind: 'rejected', status }
  }
  return { kind: 'retry', status }
}

/**
 * Send events to PostHog's `/batch/` endpoint and classify the answer.
 *
 * A network error, an abort or the timeout is a `retry`, never a throw, so a
 * PostHog outage never fails the caller. The response body is discarded
 * unread, so the connection returns to `fetch`'s pool.
 * @param events - The events, at most `ANALYTICS_DRAIN_BATCH_SIZE`.
 * @param options - Request options.
 * @param options.signal - Aborts the request; defaults to a `ANALYTICS_SEND_TIMEOUT_MS` timeout.
 * @returns How PostHog answered.
 * @throws {Error} When `POSTHOG_PROJECT_KEY` is not set: only code that checked
 *   `isAnalyticsEnabled()` may send.
 */
export async function sendBatch(
  events: PosthogBatchEvent[],
  options: { signal?: AbortSignal } = {}
): Promise<SendResult> {
  const env = getEnv()
  const apiKey = env.POSTHOG_PROJECT_KEY
  if (apiKey === undefined) throw new Error('POSTHOG_PROJECT_KEY is not set')
  const host = env.POSTHOG_HOST.endsWith('/') ? env.POSTHOG_HOST.slice(0, -1) : env.POSTHOG_HOST
  let response: Response
  try {
    response = await fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, batch: events }),
      signal: options.signal ?? AbortSignal.timeout(ANALYTICS_SEND_TIMEOUT_MS),
    })
  } catch {
    return { kind: 'retry' }
  }
  try {
    await response.body?.cancel()
  } catch {
    // The status is already known; a body that cannot be cancelled changes nothing.
  }
  return classifyStatus(response.status)
}
