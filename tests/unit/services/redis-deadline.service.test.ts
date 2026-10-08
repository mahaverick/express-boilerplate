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
import { resetRedisDeadlineForTests, withRedisDeadline } from '@/services/redis-deadline.service'

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
  await vi.advanceTimersByTimeAsync(REDIS_REQUEST_DEADLINE_MS)
  expect(stalled.outcome).toBe('rejected')
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
    await vi.advanceTimersByTimeAsync(REDIS_REQUEST_DEADLINE_MS - 1)
    expect(stalled.outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
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
    await vi.advanceTimersByTimeAsync(REDIS_REQUEST_DEADLINE_MS)
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
    const late = (): Promise<string> =>
      new Promise<string>((_resolve, reject) => {
        // eslint-disable-next-line no-restricted-syntax -- a fake timer, advanced by the test
        setTimeout(() => {
          reject(new Error('late'))
        }, REDIS_REQUEST_DEADLINE_MS + 10)
      })
    const stalled = track(withRedisDeadline(late, 'ping'))
    await vi.advanceTimersByTimeAsync(REDIS_REQUEST_DEADLINE_MS)
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
})
