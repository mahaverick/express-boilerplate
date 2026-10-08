/**
 * @file The error-tracking counters against a fake Redis client: the keys
 * and expiries each write uses, the 15-minute sum, and that a Redis failure
 * is ignored on write and reads as zeros. The real-Redis round trip is in
 * tests/integration/services/errors/error-counters.service.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_GLOBAL_PER_MINUTE } from '@/constants/error-tracking.constants'
import {
  countErrorOutcome,
  getErrorTrackingStatus,
  recordErrorSendError,
  recordErrorSendOk,
} from '@/services/errors/error-counters.service'
import {
  queuedErrorReportCount,
  reportError,
  resetErrorReporter,
  type ErrorContext,
} from '@/services/errors/error-reporter.service'
import { logger } from '@/services/logger.service'
import { redisKey } from '@/services/redis.service'

const tracking = vi.hoisted(() => ({ isEnabled: false, shouldThrow: false }))

const fake = vi.hoisted(() => {
  const state = {
    isDown: false,
    commands: [] as unknown[][],
    values: new Map<string, string>(),
  }
  const record = (name: string, parameters: unknown[]): void => {
    state.commands.push([name, ...parameters])
  }
  const chain = {
    incrBy: (...parameters: unknown[]) => {
      record('incrBy', parameters)
      return chain
    },
    expire: (...parameters: unknown[]) => {
      record('expire', parameters)
      return chain
    },
    set: (...parameters: unknown[]) => {
      record('set', parameters)
      return chain
    },
    del: (...parameters: unknown[]) => {
      record('del', parameters)
      return chain
    },
    exec: () => Promise.resolve([]),
  }
  const client = {
    multi: () => chain,
    set: (...parameters: unknown[]) => {
      record('set', parameters)
      return Promise.resolve('OK')
    },
    mGet: (keys: string[]) => {
      record('mGet', [keys])
      // eslint-disable-next-line unicorn/no-null -- Redis answers null for a missing key
      return Promise.resolve(keys.map((key) => state.values.get(key) ?? null))
    },
  }
  return { state, client }
})

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return {
    ...actual,
    isErrorTrackingEnabled: () => {
      if (tracking.shouldThrow) throw new Error('config unreadable')
      return tracking.isEnabled
    },
  }
})

vi.mock('@/services/analytics/posthog-batch.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics/posthog-batch.service')>()
  return { ...actual, sendBatch: () => new Promise<never>(() => {}) }
})

vi.mock('@/services/redis.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/redis.service')>()
  return {
    ...actual,
    getRedis: () =>
      fake.state.isDown
        ? Promise.reject(new Error('Redis unreachable'))
        : Promise.resolve(fake.client),
  }
})

const AT = new Date('2026-10-04T12:00:30.000Z')
const MINUTE = Math.floor(AT.getTime() / 60_000)

afterEach(() => {
  tracking.isEnabled = false
  tracking.shouldThrow = false
  resetErrorReporter()
  vi.useRealTimers()
  fake.state.isDown = false
  fake.state.commands = []
  fake.state.values.clear()
  vi.restoreAllMocks()
})

describe('countErrorOutcome', () => {
  it('adds to the minute bucket and refreshes its 20-minute expiry', async () => {
    await countErrorOutcome('throttled', 3, AT)
    const key = redisKey('errors', 'throttled', String(MINUTE))
    expect(fake.state.commands).toEqual([
      ['incrBy', key, 3],
      ['expire', key, 1200],
    ])
  })

  it('ignores a Redis failure', async () => {
    fake.state.isDown = true
    await expect(countErrorOutcome('sent', 1, AT)).resolves.toBeUndefined()
  })
})

describe('recordErrorSendOk and recordErrorSendError', () => {
  it('keeps each for a day, and an acknowledged send clears the last error', async () => {
    await recordErrorSendError(401)
    await recordErrorSendOk(AT)
    expect(fake.state.commands).toEqual([
      ['set', redisKey('errors', 'last_send_error'), '401', { EX: 86_400 }],
      ['set', redisKey('errors', 'last_send_ok_at'), '2026-10-04T12:00:30.000Z', { EX: 86_400 }],
      ['del', redisKey('errors', 'last_send_error')],
    ])
  })

  it('ignores a Redis failure', async () => {
    fake.state.isDown = true
    await expect(recordErrorSendOk(AT)).resolves.toBeUndefined()
    await expect(recordErrorSendError(500)).resolves.toBeUndefined()
  })
})

describe('getErrorTrackingStatus', () => {
  it('sums the current minute and the 14 before it, in one MGET', async () => {
    fake.state.values.set(redisKey('errors', 'sent', String(MINUTE)), '4')
    fake.state.values.set(redisKey('errors', 'sent', String(MINUTE - 14)), '2')
    fake.state.values.set(redisKey('errors', 'sent', String(MINUTE - 15)), '100')
    fake.state.values.set(redisKey('errors', 'buffer_full', String(MINUTE - 3)), '7')
    fake.state.values.set(redisKey('errors', 'last_send_ok_at'), '2026-10-04T11:59:00.000Z')
    fake.state.values.set(redisKey('errors', 'last_send_error'), '400')
    await expect(getErrorTrackingStatus(AT)).resolves.toEqual({
      enabled: false,
      window: '15m',
      sent: 6,
      dropped: { throttled: 0, buffer_full: 7, rejected: 0, retry_exhausted: 0 },
      lastSendOkAt: '2026-10-04T11:59:00.000Z',
      lastSendError: 400,
    })
    expect(fake.state.commands.filter(([name]) => name === 'mGet')).toHaveLength(1)
  })

  it('reports zeros and no last send when Redis fails, logged at warn', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    fake.state.isDown = true
    await expect(getErrorTrackingStatus(AT)).resolves.toEqual({
      enabled: false,
      window: '15m',
      sent: 0,
      dropped: { throttled: 0, buffer_full: 0, rejected: 0, retry_exhausted: 0 },
      // eslint-disable-next-line unicorn/no-null -- the contract's JSON null
      lastSendOkAt: null,
      // eslint-disable-next-line unicorn/no-null -- the contract's JSON null
      lastSendError: null,
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('getErrorTrackingStatus "never rejects"', () => {
  it('resolves even when the switch read throws', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    tracking.shouldThrow = true
    await expect(getErrorTrackingStatus(AT)).resolves.toMatchObject({
      enabled: false,
      window: '15m',
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('resolves with zeros when the switch read throws and Redis is down', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    tracking.shouldThrow = true
    fake.state.isDown = true
    await expect(getErrorTrackingStatus(AT)).resolves.toMatchObject({
      enabled: false,
      sent: 0,
    })
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('a 5xx storm while Redis is down', () => {
  const HTTP: ErrorContext = {
    capturePoint: 'http',
    handled: true,
    http: { method: 'GET', route: '/x', status: 500, requestId: 'req-1' },
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: AT })
    tracking.isEnabled = true
    fake.state.isDown = true
  })

  it('bounds the queue, warns once per drop reason, and still answers the status', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const ids = Array.from({ length: 300 }, (_, index) =>
      reportError(`storm ${String(index)}`, HTTP)
    )
    expect(new Set(ids).size).toBe(300)
    expect(queuedErrorReportCount()).toBeLessThanOrEqual(ERROR_GLOBAL_PER_MINUTE)
    // The first 50 are in flight (PostHog never answers), the other 50 wait: 100 admitted, 200 throttled.
    expect(queuedErrorReportCount()).toBe(ERROR_GLOBAL_PER_MINUTE - 50)
    await vi.advanceTimersByTimeAsync(0)
    const drops = warn.mock.calls.filter(([message]) => message === 'Error reports dropped')
    expect(drops.map(([, meta]) => (meta as { reason: string }).reason)).toEqual(['throttled'])
    expect(warn.mock.calls.filter(([message]) => message === 'Error reporter failed')).toHaveLength(
      0
    )
    const status = await getErrorTrackingStatus(AT)
    expect(status).toEqual({
      enabled: true,
      window: '15m',
      sent: 0,
      dropped: { throttled: 0, buffer_full: 0, rejected: 0, retry_exhausted: 0 },
      // eslint-disable-next-line unicorn/no-null -- the contract's JSON null
      lastSendOkAt: null,
      // eslint-disable-next-line unicorn/no-null -- the contract's JSON null
      lastSendError: null,
    })
  })
})
