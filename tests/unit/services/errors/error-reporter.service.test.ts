/**
 * @file The reporter with fake timers, a fake `sendBatch` and fake
 * counters: gating, ids, the throttle windows, the bounded queue, the
 * flush triggers and single flight, back-off and retry exhaustion, refusal,
 * the deadline flush, the never-throw and no-recursion guarantees, and the
 * capture rule. Error tracking is switched on through a mocked
 * `isErrorTrackingEnabled`; no Redis or PostHog.
 */
import { Writable } from 'node:stream'
import { inspect } from 'node:util'
import { ErrorPropertiesBuilder } from '@posthog/core/error-tracking'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import type { PosthogBatchEvent, SendResult } from '@/services/analytics/posthog-batch.service'
import {
  countErrorOutcome,
  recordErrorSendError,
  recordErrorSendOk,
} from '@/services/errors/error-counters.service'
import { scrubbedErrorForSpan } from '@/services/errors/error-event.service'
import {
  flushErrorReports,
  queuedErrorReportCount,
  reportError,
  reportErrorWithSpan,
  resetErrorReporter,
  shouldCaptureHttpError,
  type ErrorContext,
} from '@/services/errors/error-reporter.service'
import { createPinoLogger, logger } from '@/services/logger.service'
import { fakeQueryError, LEAKED_PARAM } from '../../../helpers/query-error'

const tracking = vi.hoisted((): { isEnabled: boolean; shouldThrow: boolean; thrown: unknown } => ({
  isEnabled: true,
  shouldThrow: false,
  thrown: undefined,
}))

const posthog = vi.hoisted(() => ({
  batches: [] as { events: PosthogBatchEvent[]; at: number }[],
  answer: (): Promise<SendResult> => Promise.resolve({ kind: 'ack' }),
}))

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return {
    ...actual,
    isErrorTrackingEnabled: () => {
      if (tracking.shouldThrow) throw new Error('config unreadable')
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a thrown non-Error is the value under test
      if (tracking.thrown !== undefined) throw tracking.thrown
      return tracking.isEnabled
    },
  }
})

vi.mock('@/services/analytics/posthog-batch.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics/posthog-batch.service')>()
  return {
    ...actual,
    sendBatch: (events: PosthogBatchEvent[]) => {
      posthog.batches.push({ events, at: Date.now() })
      return posthog.answer()
    },
  }
})

vi.mock('@/services/errors/error-counters.service', () => ({
  countErrorOutcome: vi.fn(() => Promise.resolve()),
  recordErrorSendOk: vi.fn(() => Promise.resolve()),
  recordErrorSendError: vi.fn(() => Promise.resolve()),
}))

const HTTP: ErrorContext = {
  capturePoint: 'http',
  handled: true,
  http: { method: 'GET', route: '/x', status: 500, requestId: 'req-1' },
}
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Report `count` errors with distinct fingerprints (no stack, distinct messages).
 * @param count - How many.
 * @param label - Keeps one call's messages apart from another's.
 * @returns Their ids, in order.
 */
function reportDistinct(count: number, label = 'e'): string[] {
  return Array.from({ length: count }, (_, index) => reportError(`${label} ${String(index)}`, HTTP))
}

/**
 * An error thrown from one line, so every one has the same fingerprint.
 * @returns The error.
 */
function sameError(): Error {
  return new Error('same')
}

/**
 * How many reports a counter mock was told about for one outcome.
 * @param outcome - The outcome.
 * @returns The sum of the counts passed.
 */
function counted(outcome: string): number {
  return vi
    .mocked(countErrorOutcome)
    .mock.calls.filter(([name]) => name === outcome)
    .reduce((sum, [, count]) => sum + count, 0)
}

/**
 * The epoch milliseconds between consecutive sends.
 * @returns The gaps.
 */
function sendGaps(): number[] {
  return posthog.batches.slice(1).map((batch, index) => batch.at - posthog.batches[index]!.at)
}

/**
 * Answer every send with a promise the test settles by hand.
 * @returns The resolvers, one per send, in send order.
 */
function holdSends(): ((result: SendResult) => void)[] {
  const pending: ((result: SendResult) => void)[] = []
  posthog.answer = () =>
    new Promise((resolve) => {
      pending.push(resolve)
    })
  return pending
}

/**
 * Leave one send hanging, queue 99 events and a fatal one a minute later,
 * start a deadline flush that sends 50 beside the hanging send, then let the
 * hanging send ack, so its end starts a new flight with the last 50
 * (the fatal one among them) while the flush runs.
 * @returns The resolvers, the fatal event's id, and the flush's state.
 */
async function flushWhileAFlightStarts(): Promise<{
  pending: ((result: SendResult) => void)[]
  fatalId: string
  flush: { isDone: boolean; done: Promise<void> }
}> {
  const pending = holdSends()
  reportError(new Error('earlier'), HTTP)
  await vi.advanceTimersByTimeAsync(5000)
  // A minute on, so the throttle's global window has room for 100 more.
  await vi.advanceTimersByTimeAsync(60_000)
  reportDistinct(99, 'storm')
  const fatalId = reportError(new Error('fatal'), { capturePoint: 'process', handled: false })
  const flush = { isDone: false, done: Promise.resolve() }
  flush.done = (async () => {
    await flushErrorReports(2000)
    flush.isDone = true
  })()
  await vi.advanceTimersByTimeAsync(0)
  expect(posthog.batches.map((batch) => batch.events.length)).toEqual([1, 50])
  pending[0]?.({ kind: 'ack' })
  await vi.advanceTimersByTimeAsync(0)
  expect(posthog.batches.map((batch) => batch.events.length)).toEqual([1, 50, 50])
  expect(posthog.batches[2]?.events.map((event) => event.uuid)).toContain(fatalId)
  pending[1]?.({ kind: 'ack' })
  await vi.advanceTimersByTimeAsync(0)
  return { pending, fatalId, flush }
}

/**
 * A Proxy trap that throws a message holding the leak sentinel.
 */
function leakyTrap(): never {
  throw new Error('proxy trap Zx9Kq2Lm')
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-04T12:00:00.000Z') })
  tracking.isEnabled = true
  tracking.shouldThrow = false
  tracking.thrown = undefined
  posthog.batches = []
  posthog.answer = () => Promise.resolve({ kind: 'ack' })
})

afterEach(() => {
  resetErrorReporter()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('reportError gating and ids', () => {
  it('returns a fresh UUIDv7 and queues nothing when error tracking is off', async () => {
    tracking.isEnabled = false
    const first = reportError(new Error('x'), HTTP)
    const second = reportError(new Error('x'), HTTP)
    expect(first).toMatch(UUIDV7)
    expect(second).toMatch(UUIDV7)
    expect(second).not.toBe(first)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(posthog.batches).toHaveLength(0)
    expect(queuedErrorReportCount()).toBe(0)
  })

  it('sends the event under the id it returned', async () => {
    const id = reportError(new Error('x'), HTTP)
    await vi.advanceTimersByTimeAsync(5000)
    expect(posthog.batches[0]?.events.map((event) => event.uuid)).toEqual([id])
  })

  it('never throws, returns an id, and warns once a minute when it fails inside', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    tracking.shouldThrow = true
    expect(reportError(new Error('x'), HTTP)).toMatch(UUIDV7)
    expect(reportError(new Error('y'), HTTP)).toMatch(UUIDV7)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Error reporter failed', expect.anything())
    vi.advanceTimersByTime(60_000)
    reportError(new Error('z'), HTTP)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('an error whose cause getter throws is still reported (without its cause)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const error = new Error('hostile cause')
    Object.defineProperty(error, 'cause', {
      get: () => {
        throw new Error('cause getter exploded')
      },
    })
    expect(reportError(error, HTTP)).toMatch(UUIDV7)
    expect(queuedErrorReportCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    const exceptions = posthog.batches[0]?.events[0]?.properties.$exception_list as unknown[]
    expect(exceptions).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a Proxy whose every access throws gives one deterministic outcome per report', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const trap = (): never => {
      throw new Error('proxy trap')
    }
    const hostile = new Proxy(
      {},
      {
        get: trap,
        has: trap,
        ownKeys: trap,
        getPrototypeOf: trap,
        getOwnPropertyDescriptor: trap,
      }
    )
    expect(reportError(hostile, HTTP)).toMatch(UUIDV7)
    expect(reportError(hostile, HTTP)).toMatch(UUIDV7)
    // Each report is queued, with the fallback value.
    expect(queuedErrorReportCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(5000)
    const values = posthog.batches[0]?.events.map(
      (event) => (event.properties.$exception_list as { value?: string }[])[0]?.value
    )
    expect(values).toEqual(['[unreadable error]', '[unreadable error]'])
    expect(warn).not.toHaveBeenCalled()
    expect(reportError(new Error('after'), HTTP)).toMatch(UUIDV7)
  })

  it('a function Proxy whose every access throws is reported, without a warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const hostile = new Proxy(() => 1, {
      get: leakyTrap,
      has: leakyTrap,
      ownKeys: leakyTrap,
      getPrototypeOf: leakyTrap,
      getOwnPropertyDescriptor: leakyTrap,
    })
    expect(reportError(hostile, HTTP)).toMatch(UUIDV7)
    expect(queuedErrorReportCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(inspect(posthog.batches, { depth: Infinity })).not.toContain('Zx9Kq2Lm')
    expect(warn).not.toHaveBeenCalled()
  })

  it('queues nothing for a report made while building another', () => {
    const error = new Error('outer')
    Object.defineProperty(error, 'message', {
      get: () => {
        reportError(new Error('inner'), HTTP)
        return 'outer'
      },
    })
    expect(reportError(error, HTTP)).toMatch(UUIDV7)
    expect(queuedErrorReportCount()).toBe(1)
  })
})

/**
 * Make `logger.warn` write through a real pino JSON pipeline and return
 * the lines written.
 * @returns The written lines, filled as the logger is called.
 */
function capturedWarnLines(): string[] {
  const lines: string[] = []
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk))
      done()
    },
  })
  const pinoLogger = createPinoLogger({ level: 'warn', format: 'json', destination })
  vi.spyOn(logger, 'warn').mockImplementation((message: string, meta?: Record<string, unknown>) => {
    pinoLogger.warn(meta ?? {}, message)
  })
  return lines
}

describe('internal failure log', () => {
  it('the internal-failure warn line carries no secret from the thrown value', () => {
    const lines = capturedWarnLines()
    tracking.thrown = 'connect failed: password=hunter2 user=jane@example.com'
    reportError(new Error('outer'), HTTP)
    const output = lines.join('')
    expect(output).toContain('Error reporter failed')
    expect(output).not.toContain('hunter2')
    expect(output).not.toContain('jane@example.com')
  })

  it('keeps the scrubbed detail in the line, beside the logger message', () => {
    const lines = capturedWarnLines()
    tracking.thrown = 'connect failed: password=hunter2'
    reportError(new Error('outer'), HTTP)
    const parsed = JSON.parse(lines.join('')) as Record<string, unknown>
    expect(parsed.message).toBe('Error reporter failed')
    expect(parsed.errorType).toBe('string')
    expect(parsed.detail).toBe('connect failed: password=[redacted]')
  })

  it('never throws when the internal failure is a value whose query getter throws', () => {
    const lines = capturedWarnLines()
    tracking.thrown = {
      get query(): never {
        throw new Error('query getter exploded')
      },
    }
    expect(reportError(new Error('outer'), HTTP)).toMatch(UUIDV7)
    const parsed = JSON.parse(lines.join('')) as Record<string, unknown>
    expect(parsed.message).toBe('Error reporter failed')
    expect(parsed.errorType).toBe('unknown')
    expect(parsed.detail).toBe('[unreadable]')
  })

  it('logs a thrown query error without its bound values', () => {
    const lines = capturedWarnLines()
    tracking.thrown = fakeQueryError()
    reportError(new Error('outer'), HTTP)
    const output = lines.join('')
    expect(output).toContain('Error reporter failed')
    expect(output).not.toContain(LEAKED_PARAM)
    expect(output).toContain('"detail":"select $1"')
  })

  it('scrubs a thrown error name', () => {
    const lines = capturedWarnLines()
    class NamedError extends Error {
      override name = `Bearer ${LEAKED_PARAM}`
    }
    tracking.thrown = new NamedError('x')
    reportError(new Error('outer'), HTTP)
    expect(lines.join('')).not.toContain(LEAKED_PARAM)
  })
})

describe('throttle', () => {
  it('sends at most 10 per fingerprint per rolling minute', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    for (let index = 0; index < 12; index++) reportError(sameError(), HTTP)
    expect(queuedErrorReportCount()).toBe(10)
    expect(counted('throttled')).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(59_999)
    reportError(sameError(), HTTP)
    expect(counted('throttled')).toBe(3)
    expect(warn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    for (let index = 0; index < 11; index++) reportError(sameError(), HTTP)
    expect(counted('throttled')).toBe(4)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('sends at most 100 in all per rolling minute', async () => {
    reportDistinct(101)
    await vi.advanceTimersByTimeAsync(0)
    const sent = posthog.batches.reduce((sum, batch) => sum + batch.events.length, 0)
    expect(sent + queuedErrorReportCount()).toBe(100)
    expect(counted('throttled')).toBe(1)
  })
})

describe('throttle before build', () => {
  it('a report past the 100-per-minute global cap does no build work', () => {
    const build = vi.spyOn(ErrorPropertiesBuilder.prototype, 'buildFromUnknown')
    reportDistinct(100)
    expect(counted('throttled')).toBe(0)
    const before = build.mock.calls.length
    reportError('one more past the cap', HTTP)
    expect(counted('throttled')).toBe(1)
    expect(build.mock.calls).toHaveLength(before)
  })
})

describe('reportErrorWithSpan', () => {
  it('takes the span stand-in from the built event, scrubbed like the event', () => {
    const error = fakeQueryError()
    const build = vi.spyOn(ErrorPropertiesBuilder.prototype, 'buildFromUnknown')
    const { spanError } = reportErrorWithSpan(error, HTTP)
    const stand = spanError()
    expect(queuedErrorReportCount()).toBe(1)
    expect(build).toHaveBeenCalledTimes(1)
    expect(inspect(stand, { depth: Infinity })).not.toContain(LEAKED_PARAM)
    expect(stand).toEqual(scrubbedErrorForSpan(error))
  })

  it('builds a scrubbed stand-in from the error when the report built none', () => {
    tracking.isEnabled = false
    const error = fakeQueryError()
    const stand = reportErrorWithSpan(error, HTTP).spanError()
    expect(queuedErrorReportCount()).toBe(0)
    expect(inspect(stand, { depth: Infinity })).not.toContain(LEAKED_PARAM)
    expect(stand).toEqual(scrubbedErrorForSpan(error))
  })

  it('past the global cap, builds the stand-in of a query error once, without its parameters', () => {
    reportDistinct(100)
    const build = vi.spyOn(ErrorPropertiesBuilder.prototype, 'buildFromUnknown')
    const stand = reportErrorWithSpan(fakeQueryError(), HTTP).spanError()
    expect(counted('throttled')).toBe(1)
    expect(build).toHaveBeenCalledTimes(1)
    expect(inspect(stand, { depth: Infinity })).not.toContain(LEAKED_PARAM)
  })

  it('a getter that reports while the fallback stand-in is built adds no report', () => {
    reportDistinct(100)
    const error = new Error('outer')
    Object.defineProperty(error, 'message', {
      get: () => {
        reportError(new Error('re-entrant'), HTTP)
        return 'outer'
      },
    })
    const { spanError } = reportErrorWithSpan(error, HTTP)
    expect(counted('throttled')).toBe(1)
    spanError()
    expect(counted('throttled')).toBe(1)
  })
})

describe('queue and flush', () => {
  it('flushes a non-empty queue after 5 s', async () => {
    reportDistinct(3)
    await vi.advanceTimersByTimeAsync(4999)
    expect(posthog.batches).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(posthog.batches.map((batch) => batch.events.length)).toEqual([3])
    expect(counted('sent')).toBe(3)
    expect(recordErrorSendOk).toHaveBeenCalledTimes(1)
  })

  it('flushes at once when 50 are queued', async () => {
    reportDistinct(50)
    await vi.advanceTimersByTimeAsync(0)
    expect(posthog.batches.map((batch) => batch.events.length)).toEqual([50])
  })

  it('keeps one send in flight at a time', async () => {
    const pending: ((result: SendResult) => void)[] = []
    posthog.answer = () =>
      new Promise((resolve) => {
        pending.push(resolve)
      })
    reportDistinct(50)
    await vi.advanceTimersByTimeAsync(0)
    reportDistinct(50, 'f')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(posthog.batches).toHaveLength(1)
    pending[0]?.({ kind: 'ack' })
    await vi.advanceTimersByTimeAsync(0)
    expect(posthog.batches).toHaveLength(2)
  })

  it('drops the oldest beyond 500 as buffer_full', async () => {
    posthog.answer = () => new Promise<SendResult>(() => {})
    const ids: string[] = []
    for (let minute = 0; minute < 6; minute++) {
      ids.push(...reportDistinct(100, `m${String(minute)}`))
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(posthog.batches).toHaveLength(1)
    expect(queuedErrorReportCount()).toBe(500)
    expect(counted('buffer_full')).toBe(50)
    resetErrorReporter()
    posthog.answer = () => Promise.resolve({ kind: 'ack' })
    expect(posthog.batches[0]?.events[0]?.uuid).toBe(ids[0])
  })
})

describe('retry, back-off and refusal', () => {
  it('backs off 5, 10, 20 and 40 s, then drops the event as retry_exhausted', async () => {
    posthog.answer = () => Promise.resolve({ kind: 'retry', status: 503 })
    reportError(new Error('x'), HTTP)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(75_000)
    expect(sendGaps()).toEqual([5000, 10_000, 20_000, 40_000])
    expect(posthog.batches.every((batch) => batch.events.length === 1)).toBe(true)
    expect(counted('retry_exhausted')).toBe(1)
    expect(queuedErrorReportCount()).toBe(0)
    expect(recordErrorSendError).toHaveBeenCalledWith(503)
  })

  it('an event that joins a retried batch late is not dropped after a single send', async () => {
    posthog.answer = () => Promise.resolve({ kind: 'retry', status: 503 })
    reportError(new Error('early'), HTTP)
    // Sends at +5 s, +10 s, +20 s, +40 s fail (4 of the 5 allowed).
    await vi.advanceTimersByTimeAsync(5000 + 5000 + 10_000 + 20_000)
    expect(posthog.batches).toHaveLength(4)
    const lateId = reportError(new Error('late'), HTTP)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(posthog.batches).toHaveLength(5)
    const lateSends = posthog.batches.filter((batch) =>
      batch.events.some((event) => event.uuid === lateId)
    ).length
    expect(lateSends).toBe(1)
    // The late event has had one try, not ERROR_RETRY_LIMIT; it must still be queued.
    expect(counted('retry_exhausted')).toBe(1)
    expect(queuedErrorReportCount()).toBe(1)
  })

  it('keeps doubling across batches while PostHog stays down, up to 5 minutes', async () => {
    posthog.answer = () => Promise.resolve({ kind: 'retry' })
    reportError(new Error('first'), HTTP)
    await vi.advanceTimersByTimeAsync(80_000)
    expect(posthog.batches).toHaveLength(5)
    reportError(new Error('second'), HTTP)
    await vi.advanceTimersByTimeAsync(80_000 + 160_000 + 300_000 + 300_000 + 300_000)
    expect(posthog.batches).toHaveLength(10)
    expect(sendGaps().slice(4)).toEqual([80_000, 160_000, 300_000, 300_000, 300_000])
    expect(counted('retry_exhausted')).toBe(2)
  })

  it('resends a retried batch first, ahead of newer events', async () => {
    const answers: SendResult[] = [{ kind: 'retry' }, { kind: 'ack' }]
    posthog.answer = () => Promise.resolve(answers.shift() ?? { kind: 'ack' })
    const [first] = reportDistinct(1, 'old')
    await vi.advanceTimersByTimeAsync(5000)
    const [second] = reportDistinct(1, 'new')
    await vi.advanceTimersByTimeAsync(5000)
    expect(posthog.batches[1]?.events.map((event) => event.uuid)).toEqual([first, second])
  })

  it('counts a sendBatch that throws as a retry', async () => {
    posthog.answer = () => Promise.reject(new Error('POSTHOG_PROJECT_KEY is not set'))
    reportError(new Error('x'), HTTP)
    await vi.advanceTimersByTimeAsync(5000)
    expect(queuedErrorReportCount()).toBe(1)
  })

  it('drops a refused batch as rejected and records the status', async () => {
    posthog.answer = () => Promise.resolve({ kind: 'rejected', status: 400 })
    reportDistinct(2)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(posthog.batches).toHaveLength(1)
    expect(counted('rejected')).toBe(2)
    expect(recordErrorSendError).toHaveBeenCalledWith(400)
  })

  it('records an endpoint-level status PostHog asked to retry', async () => {
    posthog.answer = () => Promise.resolve({ kind: 'retry', status: 401 })
    reportError(new Error('x'), HTTP)
    await vi.advanceTimersByTimeAsync(5000)
    expect(recordErrorSendError).toHaveBeenCalledWith(401)
  })
})

describe('flushErrorReports', () => {
  it('sends everything queued, ignoring the back-off', async () => {
    const answers: SendResult[] = [{ kind: 'retry' }]
    posthog.answer = () => Promise.resolve(answers.shift() ?? { kind: 'ack' })
    reportDistinct(3)
    await vi.advanceTimersByTimeAsync(5000)
    expect(queuedErrorReportCount()).toBe(3)
    reportDistinct(60, 'more')
    await flushErrorReports(2000)
    expect(queuedErrorReportCount()).toBe(0)
    expect(posthog.batches.map((batch) => batch.events.length)).toEqual([3, 50, 13])
  })

  it('waits for a send in flight', async () => {
    const pending: ((result: SendResult) => void)[] = []
    posthog.answer = () =>
      new Promise((resolve) => {
        pending.push(resolve)
      })
    reportDistinct(50)
    await vi.advanceTimersByTimeAsync(0)
    const flushed = flushErrorReports(2000)
    pending[0]?.({ kind: 'ack' })
    await flushed
    expect(posthog.batches).toHaveLength(1)
    expect(counted('sent')).toBe(50)
  })

  it('resolves at the deadline when PostHog hangs', async () => {
    posthog.answer = () => new Promise<SendResult>(() => {})
    reportDistinct(2)
    const state = { isDone: false }
    const flushed = (async () => {
      await flushErrorReports(2000)
      state.isDone = true
    })()
    await vi.advanceTimersByTimeAsync(1999)
    expect(state.isDone).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(state.isDone).toBe(true)
    await flushed
  })

  it('stops when PostHog asks to retry, and never rejects', async () => {
    posthog.answer = () => Promise.reject(new Error('down'))
    reportDistinct(2)
    await expect(flushErrorReports(2000)).resolves.toBeUndefined()
    expect(posthog.batches).toHaveLength(1)
    expect(queuedErrorReportCount()).toBe(2)
  })

  it('sends a newly queued fatal event even while an earlier send hangs', async () => {
    // The hanging send never settles; the reset in afterEach fences it off.
    posthog.answer = () => new Promise<SendResult>(() => {})
    reportError(new Error('earlier'), HTTP)
    await vi.advanceTimersByTimeAsync(5000)
    expect(posthog.batches).toHaveLength(1)
    posthog.answer = () => Promise.resolve({ kind: 'ack' })
    const fatalId = reportError(new Error('fatal'), { capturePoint: 'process', handled: false })
    const flushed = flushErrorReports(2000)
    await vi.advanceTimersByTimeAsync(2000)
    await flushed
    expect(posthog.batches.flatMap((batch) => batch.events.map((event) => event.uuid))).toContain(
      fatalId
    )
  })

  it('waits for a flight that started during the flush, with the fatal event in it', async () => {
    const { pending, flush } = await flushWhileAFlightStarts()
    expect(flush.isDone).toBe(false)
    pending[2]?.({ kind: 'ack' })
    await vi.advanceTimersByTimeAsync(0)
    expect(flush.isDone).toBe(true)
    await flush.done
    expect(counted('sent')).toBe(101)
    expect(queuedErrorReportCount()).toBe(0)
  })

  it('resolves at the deadline when a flight that started during the flush hangs', async () => {
    const { flush } = await flushWhileAFlightStarts()
    await vi.advanceTimersByTimeAsync(1999)
    expect(flush.isDone).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(flush.isDone).toBe(true)
    await flush.done
  })

  it('stops sending when the reporter is reset during the flush', async () => {
    const pending = holdSends()
    reportError(new Error('earlier'), HTTP)
    await vi.advanceTimersByTimeAsync(5000)
    reportError(new Error('beside'), HTTP)
    const flushed = flushErrorReports(2000)
    await vi.advanceTimersByTimeAsync(0)
    expect(posthog.batches).toHaveLength(2)
    resetErrorReporter()
    reportDistinct(51, 'after')
    await vi.advanceTimersByTimeAsync(0)
    expect(posthog.batches).toHaveLength(3)
    pending[1]?.({ kind: 'ack' })
    await vi.advanceTimersByTimeAsync(0)
    // The reset reporter's last event waits for its own flush, not the old one.
    expect(posthog.batches).toHaveLength(3)
    expect(queuedErrorReportCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    await flushed
  })

  it('resolves at once with nothing queued', async () => {
    await expect(flushErrorReports(2000)).resolves.toBeUndefined()
    expect(posthog.batches).toHaveLength(0)
  })
})

describe('resetErrorReporter', () => {
  it('a flight started before reset does not put its batch into the reset reporter', async () => {
    const pending: ((result: SendResult) => void)[] = []
    posthog.answer = () =>
      new Promise((resolve) => {
        pending.push(resolve)
      })
    reportError(new Error('before reset'), HTTP)
    await vi.advanceTimersByTimeAsync(5000)
    expect(posthog.batches).toHaveLength(1)
    resetErrorReporter()
    posthog.answer = () => Promise.resolve({ kind: 'ack' })
    reportError(new Error('after reset'), HTTP)
    pending[0]?.({ kind: 'retry', status: 503 })
    await vi.advanceTimersByTimeAsync(0)
    // Only the post-reset event belongs to the fresh reporter.
    expect(queuedErrorReportCount()).toBe(1)
  })

  it('a flight started before reset does not end the flight started after it', async () => {
    const pending = holdSends()
    reportError(new Error('before reset'), HTTP)
    await vi.advanceTimersByTimeAsync(5000)
    resetErrorReporter()
    reportDistinct(50)
    await vi.advanceTimersByTimeAsync(0)
    expect(posthog.batches).toHaveLength(2)
    pending[0]?.({ kind: 'ack' })
    await vi.advanceTimersByTimeAsync(0)
    reportDistinct(50, 'f')
    await vi.advanceTimersByTimeAsync(0)
    // The post-reset flight is still out, so the next 50 wait for it.
    expect(posthog.batches).toHaveLength(2)
  })
})

describe('shouldCaptureHttpError', () => {
  it('captures an unexpected error at 500', () => {
    expect(shouldCaptureHttpError(new Error('boom'), 500)).toBe(true)
  })

  it('skips a deliberate HttpError at 503 without a cause', () => {
    expect(shouldCaptureHttpError(new HttpError('Server is shutting down', 503), 503)).toBe(false)
  })

  it('captures an HttpError at 503 that wraps a cause', () => {
    const error = new HttpError('Upstream failed', 503)
    Object.assign(error, { cause: new Error('socket hang up') })
    expect(shouldCaptureHttpError(error, 503)).toBe(true)
  })

  it('never captures TimelineUnavailableError, even with a cause', () => {
    const error = new TimelineUnavailableError()
    Object.assign(error, { cause: new Error('PostHog 500') })
    expect(shouldCaptureHttpError(error, 502)).toBe(false)
  })

  it('never captures below 500', () => {
    expect(shouldCaptureHttpError(new Error('boom'), 499)).toBe(false)
    expect(shouldCaptureHttpError(new HttpError('Not found', 404), 404)).toBe(false)
  })
})
