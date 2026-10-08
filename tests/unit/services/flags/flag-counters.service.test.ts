/**
 * @file `getFlagsStatus` against a Redis that never answers: it resolves at
 * `STATUS_READ_TIMEOUT_MS` with no fetch outcome and zero undeclared
 * variants, one warning, no timer left. Redis is a mock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STATUS_READ_TIMEOUT_MS } from '@/constants/platform.constants'
import { getFlagsStatus } from '@/services/flags/flag-counters.service'
import { logger } from '@/services/logger.service'

const redis = vi.hoisted(() => ({ isHung: false }))

vi.mock('@/services/redis.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/redis.service')>()
  return {
    ...actual,
    getRedis: () =>
      Promise.resolve({
        mGet: (keys: string[]) =>
          redis.isHung
            ? new Promise<never>(() => {})
            : // eslint-disable-next-line unicorn/no-null -- Redis answers null for a missing key
              Promise.resolve(keys.map(() => null)),
      }),
  }
})

afterEach(() => {
  redis.isHung = false
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('getFlagsStatus', () => {
  it('resolves at the bound with the Redis-failure shape when MGET never answers', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    redis.isHung = true
    const settled = vi.fn()
    const pending = (async () => {
      settled(await getFlagsStatus())
    })()
    await vi.advanceTimersByTimeAsync(STATUS_READ_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    const status = settled.mock.calls[0]?.[0] as {
      lastFetchOk: unknown
      lastFetchError: unknown
      counts: { unknownVariant15m: number }
    }
    expect(status.lastFetchOk).toBeNull()
    expect(status.lastFetchError).toBeNull()
    expect(status.counts.unknownVariant15m).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer after a prompt answer', async () => {
    vi.useFakeTimers()
    await getFlagsStatus()
    expect(vi.getTimerCount()).toBe(0)
  })
})
