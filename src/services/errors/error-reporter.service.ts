/**
 * @file The server error reporter: `reportError` builds, scrubs, throttles
 * and queues one `$exception` synchronously and returns its id; the queue
 * is sent to PostHog through `sendBatch` every `ERROR_FLUSH_INTERVAL_MS`, or
 * at once when `ERROR_FLUSH_BATCH` events wait, one request at a time
 * outside a deadline flush (`flushErrorReports`), and
 * backs off while PostHog asks to retry. It is in memory, not the outbox,
 * because errors often happen while the database is down, and it never
 * depends on Redis, which only counts outcomes. Nothing here throws, and
 * nothing here reports its own failures, so the reporter cannot recurse.
 */
import type { Exception } from '@posthog/core/error-tracking'
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
import { isQueryError, redactedForLog } from '@/errors/postgres-errors'
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
import {
  buildErrorEvent,
  scrubbedErrorForSpan,
  spanErrorOf,
  type ErrorContext,
  type SpanError,
} from '@/services/errors/error-event.service'
import { scrubText } from '@/services/errors/error-scrubber.service'
import { logger } from '@/services/logger.service'

export type {
  ErrorCapturePoint,
  ErrorContext,
  SpanError,
} from '@/services/errors/error-event.service'

const MINUTE_MS = 60_000

/**
 * What one flush did with its batch: PostHog acknowledged it, refused it,
 * asked to retry it, or there was nothing to send.
 */
type FlushOutcome = SendResult['kind'] | 'empty'

/**
 * Module state in one object, so no function reassigns a top-level binding.
 * `retryAt` is the epoch millisecond before which the timer does not send;
 * `attempts` counts each queued event's retried sends, and `backoffLevel`
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
  attempts: WeakMap<PosthogBatchEvent, number>
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
  attempts: new WeakMap(),
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
 * A thrown value as text, `[unreadable]` when even that throws (a hostile
 * `toString`).
 * @param value - Anything thrown.
 * @returns The text.
 */
function textOf(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[unreadable]'
  }
}

/**
 * A thrown value's kind: an `Error`'s name, else its `typeof`.
 * @param value - Anything thrown.
 * @returns The kind.
 */
function kindOf(value: unknown): string {
  try {
    return value instanceof Error ? value.name : typeof value
  } catch {
    return typeof value
  }
}

/**
 * The log fields for a failure inside the reporter: the thrown value's kind
 * and its text, scrubbed like an event (`scrubText`). The value itself is
 * never logged: a non-Error would reach the log, and through it Slack, as
 * it is. A database query error is reduced to its query first
 * (`redactedForLog`), as the logger does, so its bound values are never
 * stringified. The text goes under `detail`, not `message`: `message` is the
 * logger's own message key and would be shadowed by the log line's message.
 * @param error - What was thrown.
 * @returns `{ errorType, detail }`.
 */
function failureFields(error: unknown): { errorType: string; detail: string } {
  if (isQueryError(error)) {
    const redacted = redactedForLog(error) as { query: string }
    return { errorType: 'QueryError', detail: scrubText(redacted.query) }
  }
  return { errorType: scrubText(kindOf(error)), detail: scrubText(textOf(error)) }
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
 * Whether `ERROR_GLOBAL_PER_MINUTE` events were already allowed in the
 * rolling minute, so the next is throttled whatever its fingerprint. Read
 * before an event is built, so a flood past the cap costs no build work.
 * @param now - The current epoch millisecond.
 * @returns True when the global cap is reached.
 */
function isGlobalCapReached(now: number): boolean {
  state.sentTimes = withinMinute(state.sentTimes, now)
  return state.sentTimes.length >= ERROR_GLOBAL_PER_MINUTE
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
 * Act on PostHog's answer to a batch: count it, and on a retry back off and
 * put each event back at the front of the queue, or drop it as
 * `retry_exhausted` once it has been sent `ERROR_RETRY_LIMIT` times. Each
 * event counts its own sends, so one that joined a retried batch late still
 * gets every try. A status PostHog answered with that was not an
 * acknowledgement becomes `lastSendError`.
 * @param batch - The events sent.
 * @param result - How PostHog answered.
 */
function settle(batch: PosthogBatchEvent[], result: SendResult): void {
  if (result.kind === 'ack') {
    state.backoffLevel = 0
    state.retryAt = 0
    void countErrorOutcome('sent', batch.length)
    void recordErrorSendOk()
    return
  }
  if (result.status !== undefined) void recordErrorSendError(result.status)
  if (result.kind === 'rejected') {
    state.backoffLevel = 0
    state.retryAt = 0
    drop('rejected', batch.length)
    return
  }
  state.backoffLevel += 1
  state.retryAt = Date.now() + backoffMs(state.backoffLevel)
  const kept: PosthogBatchEvent[] = []
  for (const event of batch) {
    const sends = (state.attempts.get(event) ?? 0) + 1
    if (sends >= ERROR_RETRY_LIMIT) continue
    state.attempts.set(event, sends)
    kept.push(event)
  }
  if (kept.length < batch.length) drop('retry_exhausted', batch.length - kept.length)
  state.queue.unshift(...kept)
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
    warnOncePerMinute('internal', 'Error reporter failed', failureFields(error))
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
 * What one report did: its id, and the scrubbed exception list when it
 * built one.
 */
interface Report {
  errorId: string
  exceptions?: Exception[]
}

/**
 * Build, scrub, throttle and queue one event (`reportError`), keeping the
 * exception list it built. Past the global cap nothing is built.
 * @param error - Anything thrown.
 * @param context - Where it was caught.
 * @returns The id, and the exception list when one was built.
 */
function report(error: unknown, context: ErrorContext): Report {
  const errorId = uuidv7()
  if (state.isReporting) return { errorId }
  state.isReporting = true
  try {
    if (!isErrorTrackingEnabled()) return { errorId }
    const at = new Date()
    if (isGlobalCapReached(at.getTime())) {
      drop('throttled', 1)
      return { errorId }
    }
    const { event, exceptions, fingerprint } = buildErrorEvent(error, context, errorId, at)
    if (!isWithinThrottle(fingerprint, at.getTime())) {
      drop('throttled', 1)
      return { errorId, exceptions }
    }
    state.queue.push(event)
    trimQueue()
    scheduleFlush()
    return { errorId, exceptions }
  } catch (error_) {
    warnOncePerMinute('internal', 'Error reporter failed', failureFields(error_))
    return { errorId }
  } finally {
    state.isReporting = false
  }
}

/**
 * Report an unexpected error to PostHog Error Tracking. Synchronous: it
 * builds, scrubs, throttles and queues the event and returns before any
 * I/O. The id is minted first, so it is returned also when error tracking
 * is off, the event is throttled, or building it failed; it then names a
 * log line, not an event. Past the global cap the event is not even built.
 * Never throws: a failure inside is logged at `warn`
 * at most once a minute and never reported. A call made while another is
 * running (a getter on the error that reports) returns an id and queues nothing.
 * @param error - Anything thrown.
 * @param context - Where it was caught.
 * @returns The event uuid (UUIDv7): the `errorId` logs and responses carry.
 */
export function reportError(error: unknown, context: ErrorContext): string {
  return report(error, context).errorId
}

/**
 * `reportError`, and the scrubbed stand-in the active span records, taken
 * from the exception list the report built, so a 5xx builds it once. When
 * the report built none (error tracking off, throttled before the build, a
 * failure inside), the stand-in is built from the error (`scrubbedErrorForSpan`).
 * Never throws.
 * @param error - Anything thrown.
 * @param context - Where it was caught.
 * @returns The event uuid, and a function giving the span stand-in, called only when there is a span.
 */
export function reportErrorWithSpan(
  error: unknown,
  context: ErrorContext
): { errorId: string; spanError: () => SpanError } {
  const { errorId, exceptions } = report(error, context)
  return {
    errorId,
    spanError: () =>
      exceptions === undefined ? scrubbedErrorForSpan(error) : spanErrorOf(exceptions),
  }
}

/**
 * Send every queued report, ignoring any back-off, until the queue is empty,
 * PostHog asks to retry (a send that fails outright counts as that), or
 * `deadlineMs` passes. A batch PostHog refuses is dropped and the flush goes
 * on. A flight already out when the flush starts, or started while it runs
 * (the end of one schedules the next), is waited for, also once the queue
 * is empty, since it may carry the fatal event; a flight that ends asking to
 * retry ends the flush too. It is not queued behind: while it is out, the
 * queued events go in batches of their own beside it, so a fatal event is
 * never stuck behind a hung request. A reset ends the flush. For process
 * faults and graceful shutdown. The deadline timer is not unref'd, so the
 * process stays up until the flush ends or the deadline passes. Never rejects.
 * @param deadlineMs - The most milliseconds to spend.
 * @returns Resolves when done or at the deadline.
 */
export async function flushErrorReports(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  const run = { isExpired: false }
  const { generation } = state
  const drain = async (): Promise<void> => {
    while (!run.isExpired && generation === state.generation) {
      const { inFlight } = state
      if (state.queue.length === 0) {
        if (inFlight === undefined || (await inFlight) === 'retry') return
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      const timeoutMs = Math.min(remaining, ANALYTICS_SEND_TIMEOUT_MS)
      const outcome =
        inFlight === undefined
          ? await startFlush(timeoutMs, false)
          : settleSent(await sendNextBatch(timeoutMs), generation)
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
    warnOncePerMinute('internal', 'Error reporter failed', failureFields(error))
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
  state.attempts = new WeakMap()
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
