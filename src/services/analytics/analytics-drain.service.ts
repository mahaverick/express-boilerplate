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
import {
  ENDPOINT_LEVEL_STATUSES,
  sendBatch,
  toPosthogBatchEvent,
} from '@/services/analytics/posthog-batch.service'
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
  systemicRejection: boolean
}

/**
 * What `sendBatch` answered.
 */
type BatchResult = Awaited<ReturnType<typeof sendBatch>>

/**
 * Send `rows` to PostHog as one batch.
 * @param rows - The rows to send.
 * @returns PostHog's answer.
 */
function send(rows: AnalyticsOutboxRow[]): Promise<BatchResult> {
  return sendBatch(rows.map((row) => toPosthogBatchEvent(row)))
}

/**
 * Probe both halves of a claimed batch PostHog refused: the second is sent
 * only when the first is refused too, because a half that PostHog accepts
 * shows the fault is in a row.
 * @param halves - The two halves of the claimed batch.
 * @returns Each half's answer once sent; `undefined` for a half not sent.
 */
async function probeHalves(
  halves: AnalyticsOutboxRow[][]
): Promise<Array<BatchResult | undefined>> {
  const first = await send(halves[0] ?? [])
  if (first.kind !== 'rejected') return [first, undefined]
  return [first, await send(halves[1] ?? [])]
}

/**
 * Settle the parts of a batch after one ended the drain: a part already
 * acknowledged is delivered, every other part waits for the lease.
 * @param halves - The parts after the one that stopped the drain.
 * @param answers - Each of those parts' answers, if it was already sent.
 * @param tally - Accumulates each row's outcome.
 */
function settleUnsent(
  halves: AnalyticsOutboxRow[][],
  answers: Array<BatchResult | undefined>,
  tally: Tally
): void {
  for (const [index, rest] of halves.entries()) {
    const answer = answers[index]
    if (answer?.kind === 'ack') tally.acked.push(...rest.map((row) => row.id))
    else tally.retried += rest.length
    if (answer?.kind === 'retry') tally.lastRetryStatus = answer.status
  }
}

/**
 * Settle a claimed batch PostHog refused together with both of its halves.
 * Each half's first row is sent alone (a half of one row was already refused
 * alone). If PostHog refuses both, it is refusing everything, which is a fault
 * of the endpoint and not of a row: no row is counted and every row waits for
 * the lease. If it accepts either, the endpoint takes rows: each lone row is
 * settled by its answer and the rest of each half is delivered as usual. A
 * `retry` stops the drain, and every row not yet acknowledged waits for the
 * lease.
 * @param halves - The two halves of the claimed batch.
 * @param answers - Each half's answer, both `rejected`.
 * @param tally - Accumulates each row's outcome.
 * @returns `'stop'` once a send answered `retry` or the endpoint refused every row, otherwise `'continue'`.
 */
async function deliverRefusedHalves(
  halves: AnalyticsOutboxRow[][],
  answers: Array<BatchResult | undefined>,
  tally: Tally
): Promise<'continue' | 'stop'> {
  const leads: BatchResult[] = []
  for (const [index, half] of halves.entries()) {
    const lead = (half.length === 1 ? answers[index] : undefined) ?? (await send(half.slice(0, 1)))
    leads.push(lead)
    if (lead.kind === 'retry') break
  }
  if (leads.length === halves.length && leads.every((lead) => lead.kind === 'rejected')) {
    tally.retried += halves.flat().length
    tally.systemicRejection = true
    return 'stop'
  }
  // Each lone row first, settled by the answer it already has, then the rest of each half.
  const parts = [
    ...halves.map((half) => half.slice(0, 1)),
    ...halves.map((half) => half.slice(1)),
  ].filter((part) => part.length > 0)
  for (const [index, part] of parts.entries()) {
    if ((await deliver(part, tally, false, leads[index])) === 'stop') {
      settleUnsent(parts.slice(index + 1), leads.slice(index + 1), tally)
      return 'stop'
    }
  }
  return 'continue'
}

/**
 * Send `rows` as one batch, or take `known`, the answer already received for
 * exactly these rows. When PostHog rejects a batch of more than one row, send
 * each half the same way, so the rows it accepts are delivered and only a row
 * it refuses alone counts as rejected. The first `retry` stops the whole
 * drain: PostHog is down or slow, and every further send would wait out the
 * timeout inside the lease. A claimed batch refused together with both of its
 * halves goes to `deliverRefusedHalves`, which tells a refused row in each
 * half from an endpoint refusing everything.
 * @param rows - The rows to send, oldest first.
 * @param tally - Accumulates each row's outcome.
 * @param isTopLevel - Whether `rows` is the whole claimed batch.
 * @param known - The answer already received for `rows`, if any.
 * @returns `'stop'` once a send answered `retry` or the whole batch was refused, otherwise `'continue'`.
 */
async function deliver(
  rows: AnalyticsOutboxRow[],
  tally: Tally,
  isTopLevel = false,
  known?: BatchResult
): Promise<'continue' | 'stop'> {
  const result = known ?? (await send(rows))
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
  const answers = isTopLevel ? await probeHalves(halves) : []
  if (answers[1]?.kind === 'retry') {
    // The first half is still unsettled, and bisecting it would only meet the failing endpoint.
    tally.retried += rows.length
    tally.lastRetryStatus = answers[1].status
    return 'stop'
  }
  if (answers[1]?.kind === 'rejected') return deliverRefusedHalves(halves, answers, tally)
  for (const [index, half] of halves.entries()) {
    if ((await deliver(half, tally, false, answers[index])) === 'stop') {
      settleUnsent(halves.slice(index + 1), answers.slice(index + 1), tally)
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
 * its event and id. A claimed batch PostHog refuses together with both of its
 * halves and with the first row of each half sent alone counts against no
 * row; it logs one `error` with the status only.
 * Every other row keeps its lease and is claimed again
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
    systemicRejection: false,
  }
  if (rows.length > 0) await deliver(rows, tally, true)

  if (tally.acked.length > 0) await analyticsOutboxRepository.deleteByIds(tally.acked)
  if (tally.lastRetryStatus !== undefined && ENDPOINT_LEVEL_STATUSES.has(tally.lastRetryStatus)) {
    logger.error(
      'PostHog refused the analytics endpoint; check POSTHOG_PROJECT_KEY and POSTHOG_HOST',
      {
        status: tally.lastRetryStatus,
      }
    )
  }
  if (tally.systemicRejection) {
    logger.error(
      'PostHog rejected every part of a batch; treating it as an endpoint fault and keeping the rows',
      { status: tally.lastRejectedStatus }
    )
  }
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
