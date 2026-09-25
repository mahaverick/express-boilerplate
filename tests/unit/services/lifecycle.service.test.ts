// tests/unit/services/lifecycle.service.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import {
  closeAllStreams,
  countStreams,
  createShutdownHandler,
  isShuttingDown,
  markShuttingDown,
  registerStream,
  resetLifecycleForTests,
} from '@/services/lifecycle.service'

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: vi.fn(actual.getEnv) }
})

const realEnv = getEnv()

describe('lifecycle.service', () => {
  afterEach(() => {
    resetLifecycleForTests()
    vi.useRealTimers()
    vi.mocked(getEnv).mockReturnValue(realEnv)
  })

  it('reports shutting down only once markShuttingDown has run, idempotently', () => {
    expect(isShuttingDown()).toBe(false)
    markShuttingDown()
    markShuttingDown()
    expect(isShuttingDown()).toBe(true)
  })

  it('counts registered streams per user and forgets unregistered ones', () => {
    const unregisterFirst = registerStream('user-a', vi.fn())
    registerStream('user-a', vi.fn())
    registerStream('user-b', vi.fn())
    expect(countStreams('user-a')).toBe(2)
    expect(countStreams('user-b')).toBe(1)

    unregisterFirst()
    unregisterFirst()
    expect(countStreams('user-a')).toBe(1)
    expect(countStreams('nobody')).toBe(0)
  })

  it('closeAllStreams calls every closer exactly once and empties the registry', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unregisterFirst = registerStream('user-a', first)
    // A closer that unregisters another stream mid-loop must not skip or repeat it.
    registerStream('user-b', () => {
      second()
      unregisterFirst()
    })

    closeAllStreams()
    closeAllStreams()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(countStreams('user-a')).toBe(0)
    expect(countStreams('user-b')).toBe(0)
  })

  it('closeAllStreams keeps closing the rest when one closer throws', () => {
    const survivor = vi.fn()
    registerStream('user-a', () => {
      throw new Error('boom')
    })
    registerStream('user-b', survivor)

    closeAllStreams()

    expect(survivor).toHaveBeenCalledTimes(1)
  })

  describe('createShutdownHandler', () => {
    it('runs shutdown once however many signals arrive, then exits 0', async () => {
      const shutdown = vi.fn(async () => {})
      const exit = vi.fn()
      const handle = createShutdownHandler(shutdown, 25_000)

      handle(exit)
      handle(exit)
      await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1))
      handle(exit)

      expect(shutdown).toHaveBeenCalledTimes(1)
      expect(exit).toHaveBeenCalledTimes(1)
      expect(exit).toHaveBeenCalledWith(0)
    })

    it('exits with the caller’s code once shutdown completes', async () => {
      const exit = vi.fn()
      createShutdownHandler(async () => {}, 25_000)(exit, 1)
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    })

    it('exits 1 when shutdown rejects', async () => {
      const exit = vi.fn()
      createShutdownHandler(() => Promise.reject(new Error('close failed')), 25_000)(exit)
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    })

    it('exits 1 when shutdown outlives the backstop', async () => {
      vi.useFakeTimers()
      const exit = vi.fn()
      createShutdownHandler(() => new Promise<void>(() => {}), 25_000)(exit)

      await vi.advanceTimersByTimeAsync(24_999)
      expect(exit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(exit).toHaveBeenCalledWith(1)
    })

    it('defaults the backstop to SHUTDOWN_TIMEOUT_MS', async () => {
      vi.useFakeTimers()
      vi.mocked(getEnv).mockReturnValue({ ...realEnv, SHUTDOWN_TIMEOUT_MS: 1234 })
      const exit = vi.fn()
      createShutdownHandler(() => new Promise<void>(() => {}))(exit)

      await vi.advanceTimersByTimeAsync(1233)
      expect(exit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(exit).toHaveBeenCalledWith(1)
    })
  })
})
