/**
 * @file The server error reporter: `reportError` builds, scrubs, throttles
 * and queues one `$exception` synchronously and returns its id; the queue
 * is sent to PostHog through `sendBatch` every `ERROR_FLUSH_INTERVAL_MS`, or
 * at once when `ERROR_FLUSH_BATCH` events wait, one request at a time, and
 * backs off while PostHog asks to retry. It is in memory, not the outbox,
 * because errors often happen while the database is down, and it never
 * depends on Redis, which only counts outcomes. Nothing here throws, and
 * nothing here reports its own failures, so the reporter cannot recurse.
 */
import { uuidv7 } from '@posthog/core/vendor/uuidv7'
import { isErrorTrackingEnabled } from '@/configs/analytics.config'
import { ANALYTICS_SEND_TIMEOUT_MS } from '@/constants/analytics.constants'
import {
  ERROR_FINGERPRINT_PER_MINUTE,
  ERROR_FLUSH_BATCH,
  ERROR_FLUSH_INTERVAL_MS,
  ERROR_GLOBAL_PER_MINUTE,
  ERROR_QUEUE_MAX,
  ERROR_RETRY_BASE_MS,
  ERROR_RETRY_LIMIT,
  ERROR_RETRY_MAX_MS,
  type ErrorDropReason,
} from '@/constants/error-tracking.constants'
import { HttpError } from '@/errors/http-error'
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import {
  sendBatch,
  type PosthogBatchEvent,
  type SendResult,
} from '@/services/analytics/posthog-batch.service'
import {
  countErrorOutcome,
  recordErrorSendError,
  recordErrorSendOk,
} from '@/services/errors/error-counters.service'
import { buildErrorEvent, type ErrorContext } from '@/services/errors/error-event.service'
import { logger } from '@/services/logger.service'

export type { ErrorCapturePoint, ErrorContext } from '@/services/errors/error-event.service'
export { scrubbedErrorForSpan } from '@/services/errors/error-event.service'

const MINUTE_MS = 60_000

/**
 * What one flush did with its batch: PostHog acknowledged it, refused it,
 * asked to retry it, or there was nothing to send.
 */
type FlushOutcome = SendResult['kind'] | 'empty'

/**
 * Module state in one object, so no function reassigns a top-level binding.
 * `retryAt` is the epoch millisecond before which the timer does not send;
 * `batchRetries` counts the current batch's retried sends and `backoffLevel`
 * every consecutive retried send, so the back-off keeps growing across
 * batches while PostHog stays down. `generation` changes on every reset, so
 * a flight started before one never touches the state after it.
 */
const state: {
  generation: number
  queue: PosthogBatchEvent[]
  inFlight: Promise<FlushOutcome> | undefined
  timer: NodeJS.Timeout | undefined
  retryAt: number
  batchRetries: number
  backoffLevel: number
  isReporting: boolean
  sentTimes: number[]
  fingerprintTimes: Map<string, number[]>
  warnedAt: Map<string, number>
} = {
  generation: 0,
  queue: [],
  inFlight: undefined,
  timer: undefined,
  retryAt: 0,
  batchRetries: 0,
  backoffLevel: 0,
  isReporting: false,
  sentTimes: [],
  fingerprintTimes: new Map(),
  warnedAt: new Map(),
}

/**
 * Log at `warn` at most once a minute per topic. Logging never throws out
 * of here.
 * @param topic - What the warning is about: a drop reason or `internal`.
 * @param message - The log message.
 * @param meta - The log fields.
 */
function warnOncePerMinute(topic: string, message: string, meta: Record<string, unknown>): void {
  const now = Date.now()
  const last = state.warnedAt.get(topic)
  if (last !== undefined && now - last < MINUTE_MS) return
  state.warnedAt.set(topic, now)
  try {
    logger.warn(message, meta)
  } catch {
    // A logger failure must not reach the code that reported an error.
  }
}

/**
 * Count dropped reports and warn about them, at most once a minute per reason.
 * @param reason - Why they were dropped.
 * @param count - How many.
 */
function drop(reason: ErrorDropReason, count: number): void {
  void countErrorOutcome(reason, count)
  warnOncePerMinute(reason, 'Error reports dropped', { reason, count })
}

/**
 * The timestamps of a rolling minute that are still inside it.
 * @param times - Epoch milliseconds, oldest first.
 * @param now - The current epoch millisecond.
 * @returns The ones newer than a minute ago.
 */
function withinMinute(times: number[], now: number): number[] {
  return times.filter((time) => now - time < MINUTE_MS)
}

/**
 * Whether one more event with this fingerprint may be sent: at most
 * `ERROR_FINGERPRINT_PER_MINUTE` per fingerprint and `ERROR_GLOBAL_PER_MINUTE`
 * in all in any rolling minute. An allowed event is counted in both windows.
 * A fingerprint with no event in the last minute is forgotten, so the map
 * holds at most `ERROR_GLOBAL_PER_MINUTE` live entries.
 * @param fingerprint - The event's fingerprint.
 * @param now - The current epoch millisecond.
 * @returns True when the event may be queued.
 */
function isWithinThrottle(fingerprint: string, now: number): boolean {
  state.sentTimes = withinMinute(state.sentTimes, now)
  if (state.fingerprintTimes.size > ERROR_GLOBAL_PER_MINUTE) {
    for (const [key, times] of state.fingerprintTimes) {
      if (withinMinute(times, now).length === 0) state.fingerprintTimes.delete(key)
    }
  }
  const times = withinMinute(state.fingerprintTimes.get(fingerprint) ?? [], now)
  if (
    times.length >= ERROR_FINGERPRINT_PER_MINUTE ||
    state.sentTimes.length >= ERROR_GLOBAL_PER_MINUTE
  ) {
    state.fingerprintTimes.set(fingerprint, times)
    return false
  }
  state.fingerprintTimes.set(fingerprint, [...times, now])
  state.sentTimes.push(now)
  return true
}

/**
 * Drop the oldest queued events beyond `ERROR_QUEUE_MAX` as `buffer_full`.
 */
function trimQueue(): void {
  const overflow = state.queue.length - ERROR_QUEUE_MAX
  if (overflow <= 0) return
  state.queue.splice(0, overflow)
  drop('buffer_full', overflow)
}

/**
 * The back-off after a retried send.
 * @param level - How many consecutive sends were retried, this one included.
 * @returns `ERROR_RETRY_BASE_MS` doubled per earlier retry, at most `ERROR_RETRY_MAX_MS`.
 */
function backoffMs(level: number): number {
  return Math.min(ERROR_RETRY_BASE_MS * 2 ** (level - 1), ERROR_RETRY_MAX_MS)
}

/**
 * Act on PostHog's answer to a batch: count it, and on a retry put it back
 * at the front of the queue and back off, or drop it as `retry_exhausted`
 * after `ERROR_RETRY_LIMIT` retried sends. A status PostHog answered with
 * that was not an acknowledgement becomes `lastSendError`.
 * @param batch - The events sent.
 * @param result - How PostHog answered.
 */
function settle(batch: PosthogBatchEvent[], result: SendResult): void {
  if (result.kind === 'ack') {
    state.batchRetries = 0
    state.backoffLevel = 0
    state.retryAt = 0
    void countErrorOutcome('sent', batch.length)
    void recordErrorSendOk()
    return
  }
  if (result.status !== undefined) void recordErrorSendError(result.status)
  if (result.kind === 'rejected') {
    state.batchRetries = 0
    state.backoffLevel = 0
    state.retryAt = 0
    drop('rejected', batch.length)
    return
  }
  state.batchRetries += 1
  state.backoffLevel += 1
  state.retryAt = Date.now() + backoffMs(state.backoffLevel)
  if (state.batchRetries >= ERROR_RETRY_LIMIT) {
    state.batchRetries = 0
    drop('retry_exhausted', batch.length)
    return
  }
  state.queue.unshift(...batch)
  trimQueue()
}

/**
 * One sent batch and PostHog's answer to it.
 */
interface SentBatch {
  batch: PosthogBatchEvent[]
  result: SendResult
}

/**
 * Send the oldest `ERROR_FLUSH_BATCH` queued events. Never rejects:
 * `sendBatch` failing to send at all counts as a retry.
 * @param timeoutMs - How long the request may take.
 * @returns The batch and the answer, or undefined when the queue was empty.
 */
async function sendNextBatch(timeoutMs: number): Promise<SentBatch | undefined> {
  const batch = state.queue.splice(0, ERROR_FLUSH_BATCH)
  if (batch.length === 0) return undefined
  let result: SendResult
  try {
    result = await sendBatch(batch, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    result = { kind: 'retry' }
  }
  return { batch, result }
}

/**
 * Settle a sent batch, unless the reporter was reset since it was sent.
 * Never throws: a failure is logged at `warn` at most once a minute.
 * @param sent - The batch and the answer, or undefined for an empty flush.
 * @param generation - `state.generation` when the batch was sent.
 * @returns What became of the batch.
 */
function settleSent(sent: SentBatch | undefined, generation: number): FlushOutcome {
  if (sent === undefined) return 'empty'
  if (generation !== state.generation) return sent.result.kind
  try {
    settle(sent.batch, sent.result)
  } catch (error) {
    warnOncePerMinute('internal', 'Error reporter failed', { error })
  }
  return sent.result.kind
}

/**
 * Start one flush unless one is in flight, the single flight every other
 * send waits on.
 * @param timeoutMs - How long its request may take.
 * @param shouldScheduleNext - Whether to schedule the next flush when it
 *   ends; a deadline flush schedules its own.
 * @returns The flight.
 */
function startFlush(timeoutMs: number, shouldScheduleNext: boolean): Promise<FlushOutcome> {
  if (state.inFlight !== undefined) return state.inFlight
  if (state.timer !== undefined) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
  const { generation } = state
  const flight = (async (): Promise<FlushOutcome> => {
    const outcome = settleSent(await sendNextBatch(timeoutMs), generation)
    if (generation !== state.generation) return outcome
    state.inFlight = undefined
    if (shouldScheduleNext) scheduleFlush()
    return outcome
  })()
  state.inFlight = flight
  return flight
}

/**
 * Plan the next flush: at once when a full batch waits and no back-off is
 * running, otherwise on an unref'd timer after `ERROR_FLUSH_INTERVAL_MS` or
 * when the back-off ends, whichever is later. Does nothing while a flush is
 * in flight (its end plans the next) or the queue is empty, and keeps a
 * timer already set.
 */
function scheduleFlush(): void {
  if (state.inFlight !== undefined || state.queue.length === 0) return
  const waitMs = state.retryAt - Date.now()
  if (state.queue.length >= ERROR_FLUSH_BATCH && waitMs <= 0) {
    void startFlush(ANALYTICS_SEND_TIMEOUT_MS, true)
    return
  }
  if (state.timer !== undefined) return
  state.timer = setTimeout(
    () => {
      state.timer = undefined
      if (Date.now() < state.retryAt) scheduleFlush()
      else void startFlush(ANALYTICS_SEND_TIMEOUT_MS, true)
    },
    Math.max(ERROR_FLUSH_INTERVAL_MS, waitMs)
  )
  state.timer.unref()
}

/**
 * Report an unexpected error to PostHog Error Tracking. Synchronous: it
 * builds, scrubs, throttles and queues the event and returns before any
 * I/O. The id is minted first, so it is returned also when error tracking
 * is off, the event is throttled, or building it failed; it then names a
 * log line, not an event. Never throws: a failure inside is logged at `warn`
 * at most once a minute and never reported. A call made while another is
 * running (a getter on the error that reports) returns an id and queues nothing.
 * @param error - Anything thrown.
 * @param context - Where it was caught.
 * @returns The event uuid (UUIDv7): the `errorId` logs and responses carry.
 */
export function reportError(error: unknown, context: ErrorContext): string {
  const errorId = uuidv7()
  if (state.isReporting) return errorId
  state.isReporting = true
  try {
    if (!isErrorTrackingEnabled()) return errorId
    const at = new Date()
    const { event, fingerprint } = buildErrorEvent(error, context, errorId, at)
    if (!isWithinThrottle(fingerprint, at.getTime())) {
      drop('throttled', 1)
      return errorId
    }
    state.queue.push(event)
    trimQueue()
    scheduleFlush()
  } catch (error_) {
    warnOncePerMinute('internal', 'Error reporter failed', { error: error_ })
  } finally {
    state.isReporting = false
  }
  return errorId
}

/**
 * Send every queued report, ignoring any back-off, until the queue is empty,
 * PostHog asks to retry (a send that fails outright counts as that), or
 * `deadlineMs` passes. A batch PostHog refuses is dropped and the flush goes
 * on. For process
 * faults and graceful shutdown. The deadline timer is not unref'd, so the
 * process stays up until the flush ends or the deadline passes. Never rejects.
 * @param deadlineMs - The most milliseconds to spend.
 * @returns Resolves when done or at the deadline.
 */
export async function flushErrorReports(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  const run = { isExpired: false }
  const drain = async (): Promise<void> => {
    while (!run.isExpired && state.queue.length > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      const outcome = await startFlush(Math.min(remaining, ANALYTICS_SEND_TIMEOUT_MS), false)
      if (outcome === 'retry') return
    }
  }
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadlineMs))
      }),
    ])
  } catch (error) {
    warnOncePerMinute('internal', 'Error reporter failed', { error })
  } finally {
    run.isExpired = true
    clearTimeout(timer)
    scheduleFlush()
  }
}

/**
 * Whether `errorHandler` reports an error it answers with a 5xx. A
 * non-`HttpError` (an unexpected throw) always is. An `HttpError` is a
 * deliberate response, reported only when it wraps a `cause`, the fault
 * behind it. A `TimelineUnavailableError` never is: PostHog is the thing
 * that is down, and its thrower already logged why. Below 500, nothing is.
 * @param error - The error `errorHandler` received.
 * @param status - The status it resolved.
 * @returns True when the error is reported.
 */
export function shouldCaptureHttpError(error: unknown, status: number): boolean {
  if (status < 500 || error instanceof TimelineUnavailableError) return false
  if (error instanceof HttpError) return error.cause !== undefined && error.cause !== null
  return true
}

/**
 * Empty the queue, cancel the timer and forget every throttle window,
 * back-off and warning. A flight still in progress is fenced off: its batch
 * is neither settled nor put back, and it schedules nothing. For tests.
 */
export function resetErrorReporter(): void {
  if (state.timer !== undefined) clearTimeout(state.timer)
  state.generation += 1
  state.queue = []
  state.inFlight = undefined
  state.timer = undefined
  state.retryAt = 0
  state.batchRetries = 0
  state.backoffLevel = 0
  state.isReporting = false
  state.sentTimes = []
  state.fingerprintTimes = new Map()
  state.warnedAt = new Map()
}

/**
 * How many reports wait to be sent. For tests.
 * @returns The queue length.
 */
export function queuedErrorReportCount(): number {
  return state.queue.length
}
