/**
 * @file `withRedisDeadline`: a prompt call passes through, a call that never
 * settles is rejected at `REDIS_REQUEST_DEADLINE_MS` and opens a cooldown of
 * `REDIS_STALL_COOLDOWN_MS` during which calls are rejected without running,
 * one warning per opening, and one `info` when a call succeeds after it.
 * Fake timers; nothing touches Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REDIS_REQUEST_DEADLINE_MS, REDIS_STALL_COOLDOWN_MS } from '@/constants/platform.constants'
import { RedisStalledError } from '@/errors/redis-errors'
import { logger } from '@/services/logger.service'
import {
  resetRedisDeadlineForTests,
  STILL_PENDING,
  trackRedisConnect,
  waitForRedisProbe,
  waitForRedisWrite,
  withRedisDeadline,
} from '@/services/redis-deadline.service'

/**
 * When a stall's verdict lands in fake time: the deadline timer, then one
 * immediate, which fake timers run 1 ms later.
 */
const VERDICT_MS = REDIS_REQUEST_DEADLINE_MS + 1

/**
 * An operation that never settles, the way a command written to a stalled Redis behaves.
 * @returns A promise that stays pending.
 */
function never(): Promise<string> {
  return new Promise<string>(() => {})
}

/**
 * Start a call and note how it settled, without awaiting it.
 * @param call - The call under test.
 * @returns A record filled in once the call settles.
 */
function track(call: Promise<string>): { outcome?: 'resolved' | 'rejected'; error?: unknown } {
  const record: { outcome?: 'resolved' | 'rejected'; error?: unknown } = {}
  void (async () => {
    try {
      await call
      record.outcome = 'resolved'
    } catch (error) {
      record.outcome = 'rejected'
      record.error = error
    }
  })()
  return record
}

/**
 * Stall one call until its deadline passes, opening the cooldown.
 * @returns Resolves once the call has been rejected.
 */
async function openCooldown(): Promise<void> {
  const stalled = track(withRedisDeadline(never, 'stall'))
  await vi.advanceTimersByTimeAsync(VERDICT_MS)
  expect(stalled.outcome).toBe('rejected')
}

/**
 * A reply whose timer is registered after the deadline's, for the same
 * moment: a reply the process reads only after its due timers have run.
 * @returns The reply, `'PONG'`.
 */
function replyAfterTheTimer(): Promise<string> {
  return new Promise<string>((resolve) => {
    queueMicrotask(() => {
      // eslint-disable-next-line no-restricted-syntax -- a fake timer, advanced by the test
      setTimeout(() => {
        resolve('PONG')
      }, REDIS_REQUEST_DEADLINE_MS)
    })
  })
}

/**
 * A call that fails 10 ms after the deadline, once it has been abandoned.
 * @returns A promise rejected then.
 */
function rejectsJustAfterTheDeadline(): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    // eslint-disable-next-line no-restricted-syntax -- a fake timer, advanced by the test
    setTimeout(() => {
      reject(new Error('late'))
    }, REDIS_REQUEST_DEADLINE_MS + 10)
  })
}

/**
 * A write that fails well after the deadline, as a dropped connection does.
 * @returns A promise rejected at twice the deadline.
 */
function failsLate(): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    // eslint-disable-next-line no-restricted-syntax -- a fake timer, advanced by the test
    setTimeout(() => {
      reject(new Error('connection reset'))
    }, REDIS_REQUEST_DEADLINE_MS * 2)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetRedisDeadlineForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('withRedisDeadline', () => {
  it('passes a prompt answer through and leaves no timer', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await expect(withRedisDeadline(() => Promise.resolve('PONG'), 'ping')).resolves.toBe('PONG')
    expect(warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes a failure through unchanged, without opening a cooldown', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('The client is offline')))
    await expect(withRedisDeadline(failing, 'ping')).rejects.toThrow('The client is offline')
    expect(vi.getTimerCount()).toBe(0)
    await expect(withRedisDeadline(() => Promise.resolve('PONG'), 'ping')).resolves.toBe('PONG')
  })

  it('rejects a call that never settles at the deadline, not before', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const stalled = track(withRedisDeadline(never, 'denylist read'))
    await vi.advanceTimersByTimeAsync(REDIS_REQUEST_DEADLINE_MS)
    expect(stalled.outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(VERDICT_MS - REDIS_REQUEST_DEADLINE_MS)
    expect(stalled.outcome).toBe('rejected')
    expect(stalled.error).toBeInstanceOf(RedisStalledError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects at once, without running the operation, inside the cooldown', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await openCooldown()

    await vi.advanceTimersByTimeAsync(REDIS_STALL_COOLDOWN_MS - 1)
    const operation = vi.fn(() => Promise.resolve('PONG'))
    await expect(withRedisDeadline(operation, 'ping')).rejects.toBeInstanceOf(RedisStalledError)
    expect(operation).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tries Redis again once the cooldown has passed, and a success closes it with one info', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    await openCooldown()

    await vi.advanceTimersByTimeAsync(REDIS_STALL_COOLDOWN_MS)
    const operation = vi.fn(() => Promise.resolve('PONG'))
    await expect(withRedisDeadline(operation, 'ping')).resolves.toBe('PONG')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/recovered/i), { label: 'ping' })

    await expect(withRedisDeadline(operation, 'ping')).resolves.toBe('PONG')
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('warns once per cooldown opening, however many calls time out with it', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const first = track(withRedisDeadline(never, 'denylist read'))
    const second = track(withRedisDeadline(never, 'rate limit'))
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    expect([first.outcome, second.outcome]).toEqual(['rejected', 'rejected'])
    await expect(withRedisDeadline(never, 'ping')).rejects.toBeInstanceOf(RedisStalledError)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      label: 'denylist read',
      timeoutMs: REDIS_REQUEST_DEADLINE_MS,
      cooldownMs: REDIS_STALL_COOLDOWN_MS,
    })

    // Still stalled after the cooldown: the retry opens a second one, and warns again.
    await vi.advanceTimersByTimeAsync(REDIS_STALL_COOLDOWN_MS)
    await openCooldown()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('leaves no unhandled rejection when the abandoned operation fails later', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const stalled = track(withRedisDeadline(rejectsJustAfterTheDeadline, 'ping'))
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    expect(stalled.error).toBeInstanceOf(RedisStalledError)
    // Vitest fails the run on an unhandled rejection: this must pass quietly.
    await vi.advanceTimersByTimeAsync(10)
  })

  it('opens no new cooldown on a late success from a call already abandoned', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const late = (): Promise<string> =>
      new Promise<string>((resolve) => {
        // eslint-disable-next-line no-restricted-syntax -- a fake timer, advanced by the test
        setTimeout(() => {
          resolve('PONG')
        }, REDIS_REQUEST_DEADLINE_MS + 10)
      })
    const stalled = track(withRedisDeadline(late, 'ping'))
    await vi.advanceTimersByTimeAsync(REDIS_REQUEST_DEADLINE_MS + 10)
    expect(stalled.outcome).toBe('rejected')
    expect(info).not.toHaveBeenCalled()
    await expect(withRedisDeadline(never, 'ping')).rejects.toBeInstanceOf(RedisStalledError)
  })

  it('lets a reply that arrives in the same turn the deadline timer fires win, opening nothing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const answered = track(withRedisDeadline(replyAfterTheTimer, 'ping'))
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    expect(answered.outcome).toBe('resolved')
    expect(warn).not.toHaveBeenCalled()
    await expect(withRedisDeadline(() => Promise.resolve('PONG'), 'ping')).resolves.toBe('PONG')
  })
})

describe('waitForRedisWrite', () => {
  it('sends the write even while a cooldown is open', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await openCooldown()
    const write = vi.fn(() => Promise.resolve('OK'))
    await expect(waitForRedisWrite(write, 'deny', () => {})).resolves.toBe('OK')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('answers STILL_PENDING at the deadline with one warn, opens no cooldown, and reports a later failure', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const onLateFailure = vi.fn()
    const pending = waitForRedisWrite(failsLate, 'deny', onLateFailure, { sessionId: 's-1' })
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    await expect(pending).resolves.toBe(STILL_PENDING)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/lands when Redis answers/),
      expect.objectContaining({ label: 'deny', sessionId: 's-1' })
    )
    expect(onLateFailure).not.toHaveBeenCalled()
    await expect(withRedisDeadline(() => Promise.resolve('PONG'), 'ping')).resolves.toBe('PONG')

    await vi.advanceTimersByTimeAsync(REDIS_REQUEST_DEADLINE_MS)
    expect(onLateFailure).toHaveBeenCalledWith(expect.any(Error))
  })
})

describe('waitForRedisProbe', () => {
  it('answers STILL_PENDING at the deadline without opening a cooldown', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const probe = waitForRedisProbe(never)
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    await expect(probe).resolves.toBe(STILL_PENDING)
    expect(warn).not.toHaveBeenCalled()
    await expect(withRedisDeadline(() => Promise.resolve('PONG'), 'ping')).resolves.toBe('PONG')
  })

  it('is not skipped by an open cooldown', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await openCooldown()
    await expect(waitForRedisProbe(() => Promise.resolve('PONG'))).resolves.toBe('PONG')
  })
})

describe('trackRedisConnect', () => {
  it('lets a call that misses the deadline during a connect fall back without opening the cooldown', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const connect = { finish: () => {} }
    const tracked = trackRedisConnect(
      new Promise<void>((resolve) => {
        connect.finish = resolve
      })
    )

    const slow = track(withRedisDeadline(never, 'denylist read'))
    await vi.advanceTimersByTimeAsync(VERDICT_MS)
    expect(slow.error).toBeInstanceOf(RedisStalledError)
    const next = vi.fn(() => Promise.resolve('PONG'))
    await expect(withRedisDeadline(next, 'ping')).resolves.toBe('PONG')
    expect(next).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()

    connect.finish()
    await tracked
    // Connected: a stall is a stall again.
    await openCooldown()
    await expect(withRedisDeadline(next, 'ping')).rejects.toBeInstanceOf(RedisStalledError)
    expect(next).toHaveBeenCalledTimes(1)
  })
})
