/**
 * @file `getMaintenanceModeStatus` against a Redis whose `get` never
 * answers: the section resolves at `STATUS_READ_TIMEOUT_MS` with no pending
 * notices, one warning, no timer left. Redis and the queues are mocks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STATUS_READ_TIMEOUT_MS } from '@/constants/platform.constants'
import { logger } from '@/services/logger.service'
import { getMaintenanceModeStatus } from '@/services/maintenance-mode/maintenance-mode.service'

const redis = vi.hoisted(() => ({ isHung: false }))

vi.mock('@/services/redis.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/redis.service')>()
  return {
    ...actual,
    getRedis: () =>
      Promise.resolve({
        get: () =>
          redis.isHung
            ? new Promise<never>(() => {})
            : // eslint-disable-next-line unicorn/no-null -- Redis answers null for a missing key
              Promise.resolve(null),
      }),
  }
})

vi.mock('@/services/queue.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/queue.service')>()
  return { ...actual, getAllQueues: () => [] }
})

afterEach(() => {
  redis.isHung = false
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('getMaintenanceModeStatus', () => {
  it('resolves at the bound with no pending notices and one warning when GET never answers', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    redis.isHung = true
    const settled = vi.fn()
    const pending = (async () => {
      settled(await getMaintenanceModeStatus())
    })()
    await vi.advanceTimersByTimeAsync(STATUS_READ_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ noticesPending: false }))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer after a prompt answer', async () => {
    vi.useFakeTimers()
    await getMaintenanceModeStatus()
    expect(vi.getTimerCount()).toBe(0)
  })
})
