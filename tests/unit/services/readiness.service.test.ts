/**
 * @file `createReadinessProbe`: every check answers within
 * `READINESS_CHECK_DEADLINE_MS`, a check still running is joined rather than
 * started again, nothing rejects or leaves a timer behind, and a check's move
 * into and out of timing out is logged once. Fake timers; the checks are
 * stand-ins, so nothing touches Postgres or Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READINESS_CHECK_DEADLINE_MS } from '@/constants/platform.constants'
import { logger } from '@/services/logger.service'
import { createReadinessProbe } from '@/services/readiness.service'

/**
 * When a timed-out check's verdict lands in fake time: the deadline timer,
 * then one immediate, which fake timers run 1 ms later.
 */
const VERDICT_MS = READINESS_CHECK_DEADLINE_MS + 1

/**
 * A check whose answer the test gives when it chooses, the way a stalled
 * dependency answers once the stall ends.
 * @returns The check, how often it ran, and functions that settle the current run.
 */
function heldCheck(): {
  check: () => Promise<boolean>
  runs: () => number
  answer: (isReachable: boolean) => void
  fail: (error: Error) => void
} {
  const held: { resolve?: (isReachable: boolean) => void; reject?: (error: Error) => void } = {}
  let count = 0
  return {
    check: async () => {
      count += 1
      return new Promise<boolean>((resolve, reject) => {
        held.resolve = resolve
        held.reject = reject
      })
    },
    runs: () => count,
    answer: (isReachable) => {
      held.resolve?.(isReachable)
    },
    fail: (error) => {
      held.reject?.(error)
    },
  }
}

/**
 * A check that answers at once.
 * @returns Resolves true.
 */
function answersAtOnce(): Promise<boolean> {
  return Promise.resolve(true)
}

/**
 * Start a probe and note its report once it settles, without awaiting it.
 * @param probe - The probe under test.
 * @returns A record filled in once the probe settles.
 */
function track<T>(probe: Promise<T>): { report?: T } {
  const record: { report?: T } = {}
  void (async () => {
    record.report = await probe
  })()
  return record
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createReadinessProbe', () => {
  it('reports every check ready when all answer, and leaves no timer', async () => {
    const probe = createReadinessProbe({
      database: answersAtOnce,
      redis: answersAtOnce,
      queue: answersAtOnce,
    })
    await expect(probe()).resolves.toEqual({
      isReady: true,
      checks: { database: true, redis: true, queue: true },
      timedOut: [],
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts a check that rejects as unreachable, not timed out', async () => {
    const probe = createReadinessProbe({
      database: () => Promise.reject(new Error('connection refused')),
      redis: answersAtOnce,
      queue: answersAtOnce,
    })
    await expect(probe()).resolves.toEqual({
      isReady: false,
      checks: { database: false, redis: true, queue: true },
      timedOut: [],
    })
  })

  it('answers at the deadline, not before, naming the check that has not answered', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const queue = heldCheck()
    const probe = createReadinessProbe({
      database: answersAtOnce,
      redis: answersAtOnce,
      queue: queue.check,
    })
    const pending = track(probe())
    await vi.advanceTimersByTimeAsync(READINESS_CHECK_DEADLINE_MS - 1)
    expect(pending.report).toBeUndefined()
    await vi.advanceTimersByTimeAsync(VERDICT_MS - (READINESS_CHECK_DEADLINE_MS - 1))
    expect(pending.report).toEqual({
      isReady: false,
      checks: { database: true, redis: true, queue: false },
      timedOut: ['queue'],
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins a check still running instead of starting another', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    const database = heldCheck()
    const probe = createReadinessProbe({
      database: database.check,
      redis: answersAtOnce,
      queue: answersAtOnce,
    })
    const first = track(probe())
    const second = track(probe())
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    const third = track(probe())
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    expect(database.runs()).toBe(1)
    for (const record of [first, second, third]) {
      expect(record.report).toMatchObject({ isReady: false, timedOut: ['database'] })
    }

    // The stall ends: the run in flight answers, and the next probe starts a fresh one.
    database.answer(true)
    await vi.advanceTimersByTimeAsync(0)
    const after = track(probe())
    await vi.advanceTimersByTimeAsync(0)
    expect(database.runs()).toBe(2)
    database.answer(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(after.report).toEqual({
      isReady: true,
      checks: { database: true, redis: true, queue: true },
      timedOut: [],
    })
  })

  it('leaves no unhandled rejection when an abandoned check fails later', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const database = heldCheck()
    const probe = createReadinessProbe({
      database: database.check,
      redis: answersAtOnce,
      queue: answersAtOnce,
    })
    const pending = track(probe())
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    expect(pending.report).toMatchObject({ timedOut: ['database'] })
    database.fail(new Error('connection reset'))
    // Vitest fails the run on an unhandled rejection: this must pass quietly.
    await vi.advanceTimersByTimeAsync(10)
    // The failed run is over, so the next probe starts the check again.
    const after = track(probe())
    await vi.advanceTimersByTimeAsync(0)
    expect(database.runs()).toBe(2)
    database.answer(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(after.report).toMatchObject({ isReady: true })
  })

  it('logs one warn when a check starts timing out and one info when it answers in time again', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const database = heldCheck()
    const probe = createReadinessProbe({
      database: database.check,
      redis: answersAtOnce,
      queue: answersAtOnce,
    })
    track(probe())
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    track(probe())
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      `Readiness check database did not answer in ${String(READINESS_CHECK_DEADLINE_MS)} ms`,
      { check: 'database', timeoutMs: READINESS_CHECK_DEADLINE_MS }
    )
    expect(info).not.toHaveBeenCalled()

    database.answer(true)
    await vi.advanceTimersByTimeAsync(0)
    const after = track(probe())
    await vi.advanceTimersByTimeAsync(0)
    database.answer(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(after.report).toMatchObject({ isReady: true })
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith('Readiness check database answers in time again', {
      check: 'database',
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
