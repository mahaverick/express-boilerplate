/**
 * @file `withStatusTimeout`: a prompt read passes through, a read that
 * never settles is answered with the fallback after `STATUS_READ_TIMEOUT_MS`
 * and one warning, a failed read still rejects, and the timer is always
 * cleared. Fake timers; nothing touches Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STATUS_READ_TIMEOUT_MS } from '@/constants/platform.constants'
import { logger } from '@/services/logger.service'
import { withStatusTimeout } from '@/services/status-read.service'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('withStatusTimeout', () => {
  it('passes a prompt read through and leaves no timer', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await expect(withStatusTimeout(Promise.resolve('read'), 'fallback', 'x')).resolves.toBe('read')
    expect(warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers the fallback at the bound with one warning when the read never settles', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const settled = vi.fn()
    const never = new Promise<string>(() => {})
    const pending = (async () => {
      settled(await withStatusTimeout(never, 'fallback', 'Flag counters'))
    })()
    await vi.advanceTimersByTimeAsync(STATUS_READ_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(settled).toHaveBeenCalledWith('fallback')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      section: 'Flag counters',
      timeoutMs: STATUS_READ_TIMEOUT_MS,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects when the read fails, and leaves no timer', async () => {
    const failing = Promise.reject(new Error('down'))
    await expect(withStatusTimeout(failing, 'fallback', 'x')).rejects.toThrow('down')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not leave an unhandled rejection when a late read fails after the bound', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const late = new Promise<string>((_resolve, reject) => {
      // eslint-disable-next-line no-restricted-syntax -- a fake timer, advanced by the test
      setTimeout(() => {
        reject(new Error('late'))
      }, STATUS_READ_TIMEOUT_MS + 10)
    })
    const pending = withStatusTimeout(late, 'fallback', 'x')
    await vi.advanceTimersByTimeAsync(STATUS_READ_TIMEOUT_MS)
    await expect(pending).resolves.toBe('fallback')
    await vi.advanceTimersByTimeAsync(10)
  })
})
