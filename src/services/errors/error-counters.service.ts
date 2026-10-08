/**
 * @file What the error reporter delivered and dropped, counted in Redis so
 * the staff status endpoint sees every API and worker process at once:
 * one counter per outcome per minute (`<prefix>:errors:<outcome>:<epochMinute>`,
 * expiring after `ERROR_COUNTER_TTL_SECONDS`), the time of the last
 * acknowledged send and the status of the last failed one (each kept a day).
 * Error tracking never depends on Redis: a failed write is ignored and a
 * failed read reports zeros.
 */
import { isErrorTrackingEnabled } from '@/configs/analytics.config'
import {
  ERROR_COUNTER_TTL_SECONDS,
  ERROR_DROP_REASONS,
  ERROR_STATUS_WINDOW_MINUTES,
  type ErrorDropReason,
} from '@/constants/error-tracking.constants'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'

/**
 * What became of a report: sent, or dropped for one of `ERROR_DROP_REASONS`.
 */
export type ErrorOutcome = 'sent' | ErrorDropReason

/**
 * The error-tracking section of the system status: whether this process
 * reports errors, and every process's outcomes over the last
 * `ERROR_STATUS_WINDOW_MINUTES` minutes.
 */
export interface ErrorTrackingStatus {
  enabled: boolean
  window: '15m'
  sent: number
  dropped: Record<ErrorDropReason, number>
  /**
   * When PostHog last acknowledged a batch, as ISO 8601; null when not in
   * the last day.
   */
  lastSendOkAt: string | null
  /**
   * The HTTP status of the last batch PostHog answered with an error; null
   * when there was none in the last day, or a batch was acknowledged since.
   */
  lastSendError: number | null
}

const MINUTE_MS = 60_000

/**
 * How long the last-send keys live.
 */
const LAST_SEND_TTL_SECONDS = 24 * 60 * 60

const OUTCOMES: readonly ErrorOutcome[] = ['sent', ...ERROR_DROP_REASONS]

/**
 * The minute bucket a moment falls in.
 * @param at - The moment.
 * @returns Whole minutes since the Unix epoch.
 */
function epochMinuteOf(at: Date): number {
  return Math.floor(at.getTime() / MINUTE_MS)
}

/**
 * The counter key of one outcome in one minute.
 * @param outcome - The outcome.
 * @param epochMinute - The minute bucket.
 * @returns The Redis key.
 */
function counterKey(outcome: ErrorOutcome, epochMinute: number): string {
  return redisKey('errors', outcome, String(epochMinute))
}

const LAST_SEND_OK_KEY = ['errors', 'last_send_ok_at'] as const
const LAST_SEND_ERROR_KEY = ['errors', 'last_send_error'] as const

/**
 * Add to an outcome's counter for the current minute. Never rejects.
 * @param outcome - What became of the reports.
 * @param count - How many reports.
 * @param at - When; defaults to now.
 * @returns Resolves once written, or once the write failed.
 */
export async function countErrorOutcome(
  outcome: ErrorOutcome,
  count: number,
  at: Date = new Date()
): Promise<void> {
  try {
    const key = counterKey(outcome, epochMinuteOf(at))
    const redis = await getRedis()
    await redis.multi().incrBy(key, count).expire(key, ERROR_COUNTER_TTL_SECONDS).exec()
  } catch {
    // Error tracking never depends on Redis; the reporter keeps its own warn log per drop reason.
  }
}

/**
 * Record an acknowledged batch: its time becomes `lastSendOkAt`, and
 * `lastSendError` is cleared. Never rejects.
 * @param at - When; defaults to now.
 * @returns Resolves once written, or once the write failed.
 */
export async function recordErrorSendOk(at: Date = new Date()): Promise<void> {
  try {
    const redis = await getRedis()
    await redis
      .multi()
      .set(redisKey(...LAST_SEND_OK_KEY), at.toISOString(), { EX: LAST_SEND_TTL_SECONDS })
      .del(redisKey(...LAST_SEND_ERROR_KEY))
      .exec()
  } catch {
    // Error tracking never depends on Redis.
  }
}

/**
 * Record the HTTP status of a batch PostHog answered with an error. Never rejects.
 * @param status - The status.
 * @returns Resolves once written, or once the write failed.
 */
export async function recordErrorSendError(status: number): Promise<void> {
  try {
    const redis = await getRedis()
    await redis.set(redisKey(...LAST_SEND_ERROR_KEY), String(status), {
      EX: LAST_SEND_TTL_SECONDS,
    })
  } catch {
    // Error tracking never depends on Redis.
  }
}

/**
 * A counter's value as Redis returned it.
 * @param value - The reply: a decimal string, or null for a missing key.
 * @returns The count; 0 for a missing or unreadable one.
 */
function countOf(value: unknown): number {
  const count = Number(value ?? 0)
  return Number.isFinite(count) ? count : 0
}

/**
 * This process's error-tracking switch, read so it cannot throw: a failed
 * read (an unreadable configuration) reports the switch off, logged at `warn`.
 * @returns Whether error tracking is on.
 */
function isTrackingSwitchOn(): boolean {
  try {
    return isErrorTrackingEnabled()
  } catch (error) {
    logger.warn('Error tracking switch unreadable; reporting it off', { error })
    return false
  }
}

/**
 * Zero counts for every drop reason.
 * @returns The record.
 */
function noDrops(): Record<ErrorDropReason, number> {
  return { throttled: 0, buffer_full: 0, rejected: 0, retry_exhausted: 0 }
}

/**
 * The error-tracking status: this process's switch, and the outcomes of
 * every process summed over the current minute and the
 * `ERROR_STATUS_WINDOW_MINUTES - 1` before it, read in one `MGET`. Never
 * rejects: when Redis fails it reports zero counts and no last send, and
 * when the switch cannot be read it reports it off, each logged at `warn`.
 * @param at - The end of the window; defaults to now.
 * @returns The status.
 */
export async function getErrorTrackingStatus(at: Date = new Date()): Promise<ErrorTrackingStatus> {
  const status: ErrorTrackingStatus = {
    enabled: isTrackingSwitchOn(),
    window: '15m',
    sent: 0,
    dropped: noDrops(),
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null
    lastSendOkAt: null,
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null
    lastSendError: null,
  }
  const current = epochMinuteOf(at)
  const minutes = Array.from({ length: ERROR_STATUS_WINDOW_MINUTES }, (_, index) => current - index)
  const keys = OUTCOMES.flatMap((outcome) => minutes.map((minute) => counterKey(outcome, minute)))
  try {
    const redis = await getRedis()
    const values = await redis.mGet([
      ...keys,
      redisKey(...LAST_SEND_OK_KEY),
      redisKey(...LAST_SEND_ERROR_KEY),
    ])
    for (const [index, outcome] of OUTCOMES.entries()) {
      const slice = values.slice(index * minutes.length, (index + 1) * minutes.length)
      const total = slice.reduce((sum, value) => sum + countOf(value), 0)
      if (outcome === 'sent') status.sent = total
      else status.dropped[outcome] = total
    }
    const [lastOk, lastError] = values.slice(keys.length)
    if (typeof lastOk === 'string') status.lastSendOkAt = lastOk
    if (typeof lastError === 'string' && Number.isSafeInteger(Number(lastError))) {
      status.lastSendError = Number(lastError)
    }
    return status
  } catch (error) {
    logger.warn('Error tracking counters unavailable; reporting zeros', { error })
    return status
  }
}
