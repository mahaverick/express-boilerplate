/**
 * @file The analytics drainer: lease a batch of outbox rows, send it to
 * PostHog, and settle each row by the answer. The lease is one autocommit
 * statement, so no pool connection is held while PostHog is called. A row
 * leaves the outbox only when PostHog acknowledges it, when PostHog has
 * rejected it alone `ANALYTICS_POISON_REJECTIONS` times, or when the
 * retention purge drops it: a PostHog outage of any length, or a hanging
 * PostHog, only delays rows.
 */
import { getEnv } from '@/configs/env.config'
import {
  ANALYTICS_LEASE_SECONDS,
  ANALYTICS_POISON_REJECTIONS,
} from '@/constants/analytics.constants'
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import { analyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { sendBatch, toPosthogBatchEvent } from '@/services/analytics/posthog-batch.service'
import { logger } from '@/services/logger.service'

/**
 * What one drain did, in rows: `sent` were acknowledged and deleted,
 * `retried` stay leased until the lease and their backoff pass, `rejected`
 * were refused alone and counted, and `dropped` reached
 * `ANALYTICS_POISON_REJECTIONS` and were deleted unsent.
 */
export interface DrainResult {
  sent: number
  retried: number
  rejected: number
  dropped: number
}

/**
 * The rows of one drain, sorted by outcome as the sends answer.
 */
interface Tally {
  acked: string[]
  rejected: string[]
  retried: number
  lastRetryStatus: number | undefined
  lastRejectedStatus: number | undefined
}

/**
 * Send `rows` as one batch; when PostHog rejects a batch of more than one
 * row, send each half the same way, so the rows it accepts are delivered and
 * only a row it refuses alone counts as rejected. The first `retry` stops
 * the whole drain: PostHog is down or slow, and every further send would
 * wait out the timeout inside the lease.
 * @param rows - The rows to send, oldest first.
 * @param tally - Accumulates each row's outcome.
 * @returns `'stop'` once a send answered `retry`, otherwise `'continue'`.
 */
async function deliver(rows: AnalyticsOutboxRow[], tally: Tally): Promise<'continue' | 'stop'> {
  const result = await sendBatch(rows.map((row) => toPosthogBatchEvent(row)))
  if (result.kind === 'ack') {
    tally.acked.push(...rows.map((row) => row.id))
    return 'continue'
  }
  if (result.kind === 'retry') {
    tally.retried += rows.length
    tally.lastRetryStatus = result.status
    return 'stop'
  }
  tally.lastRejectedStatus = result.status
  if (rows.length === 1) {
    tally.rejected.push(...rows.map((row) => row.id))
    return 'continue'
  }
  const middle = Math.ceil(rows.length / 2)
  const halves = [rows.slice(0, middle), rows.slice(middle)]
  for (const [index, half] of halves.entries()) {
    if ((await deliver(half, tally)) === 'stop') {
      // The halves not yet sent wait for the lease, like the one that answered retry.
      tally.retried += halves.slice(index + 1).reduce((total, rest) => total + rest.length, 0)
      return 'stop'
    }
  }
  return 'continue'
}

/**
 * Drain one batch of the analytics outbox.
 *
 * Claims up to `ANALYTICS_DRAIN_BATCH_SIZE` rows under a
 * `ANALYTICS_LEASE_SECONDS` lease (`claimBatch`, one autocommit statement
 * with `FOR UPDATE SKIP LOCKED`, so two drainers never claim one row), then
 * sends them with no database connection held. Acknowledged rows are
 * deleted; rows PostHog refused alone get one more rejection, and a row at
 * `ANALYTICS_POISON_REJECTIONS` is deleted with an `error` log naming only
 * its event and id; every other row keeps its lease and is claimed again
 * once the lease and its backoff have passed. `attempts` never deletes a row.
 * @param now - The clock the lease and backoff are measured against. Defaults to now.
 * @returns How many rows were sent, retried, rejected and dropped.
 */
export async function drainAnalyticsOutbox(now: Date = new Date()): Promise<DrainResult> {
  const claimed = await analyticsOutboxRepository.claimBatch(
    getEnv().ANALYTICS_DRAIN_BATCH_SIZE,
    ANALYTICS_LEASE_SECONDS,
    now
  )
  // RETURNING has no order: send oldest first, so a bisect halves in a stable order.
  const rows = claimed.toSorted(
    (left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id)
  )
  const tally: Tally = {
    acked: [],
    rejected: [],
    retried: 0,
    lastRetryStatus: undefined,
    lastRejectedStatus: undefined,
  }
  if (rows.length > 0) await deliver(rows, tally)

  if (tally.acked.length > 0) await analyticsOutboxRepository.deleteByIds(tally.acked)
  if (tally.retried > 0) {
    logger.warn('analytics batch deferred', {
      rows: tally.retried,
      status: tally.lastRetryStatus,
    })
  }

  let dropped = 0
  if (tally.rejected.length > 0) {
    logger.warn('analytics events rejected', {
      rows: tally.rejected.length,
      status: tally.lastRejectedStatus,
    })
    await analyticsOutboxRepository.markRejected(tally.rejected)
    // Only a row this drain rejected can have reached the threshold.
    const poisoned = await analyticsOutboxRepository.deletePoisoned(ANALYTICS_POISON_REJECTIONS)
    for (const row of poisoned) {
      logger.error('analytics event dropped after repeated rejections', {
        event: row.event,
        id: row.id,
      })
    }
    dropped = poisoned.length
  }

  return {
    sent: tally.acked.length,
    retried: tally.retried,
    rejected: tally.rejected.length,
    dropped,
  }
}
