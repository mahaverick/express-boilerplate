/**
 * @file takeTimelineQueryBudget with a Redis that fails (no real Redis): the
 * budget fails open with a `warn`, and a refused query whose entry cannot be
 * removed is still refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { takeTimelineQueryBudget } from '@/services/analytics/timeline-budget.service'
import { logger } from '@/services/logger.service'
import { resetRedisDeadlineForTests } from '@/services/redis-deadline.service'
import { answerWithinBound, stalledCommand } from '../../../helpers/redis-stall'

const redis = vi.hoisted(() => ({
  isUnreachable: false,
  isStalled: false,
  count: 0,
  zRem: vi.fn<(key: string, member: string) => Promise<number>>(),
}))

vi.mock('@/services/redis.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/redis.service')>()),
  getRedis: () =>
    redis.isUnreachable
      ? Promise.reject(new Error('Redis unreachable'))
      : Promise.resolve({
          multi: () => {
            const chain = {
              zRemRangeByScore: () => chain,
              zAdd: () => chain,
              zCard: () => chain,
              expire: () => chain,
              exec: () =>
                redis.isStalled
                  ? new Promise<never>(() => {})
                  : Promise.resolve([0, 1, redis.count, 1]),
            }
            return chain
          },
          zRem: redis.zRem,
        }),
}))

beforeEach(() => {
  vi.restoreAllMocks()
  redis.zRem.mockReset()
  redis.isUnreachable = false
  redis.isStalled = false
  resetRedisDeadlineForTests()
  redis.count = 0
  redis.zRem.mockResolvedValue(1)
})

describe('takeTimelineQueryBudget', () => {
  it('allows the query, logging at warn, when Redis is unreachable', async () => {
    redis.isUnreachable = true
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await takeTimelineQueryBudget()).toBe('taken')
    expect(warn).toHaveBeenCalledWith(
      'Timeline query budget unavailable; allowing the query',
      expect.objectContaining({ error: expect.any(Error) as unknown })
    )
  })

  it('allows up to the budget and refuses past it, removing the refused entry', async () => {
    // The test environment leaves TIMELINE_QUERY_BUDGET_PER_HOUR at its default, 1200.
    redis.count = 1200
    expect(await takeTimelineQueryBudget()).toBe('taken')
    expect(redis.zRem).not.toHaveBeenCalled()

    redis.count = 1201
    expect(await takeTimelineQueryBudget()).toBe('exhausted')
    expect(redis.zRem).toHaveBeenCalledTimes(1)
  })

  it('still refuses when the refused entry cannot be removed', async () => {
    redis.count = 1201
    redis.zRem.mockRejectedValue(new Error('connection reset'))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await takeTimelineQueryBudget()).toBe('exhausted')
    expect(warn).toHaveBeenCalledWith(
      'Could not return a refused timeline query to the budget',
      expect.objectContaining({ error: expect.any(Error) as unknown })
    )
  })

  it('allows the query within the deadline when Redis does not answer', async () => {
    redis.isStalled = true
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(await answerWithinBound(takeTimelineQueryBudget())).toBe('taken')
  })

  it('still refuses, within the deadline, when removing the refused entry does not answer', async () => {
    redis.count = 1201
    redis.zRem.mockImplementation(stalledCommand)
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(await answerWithinBound(takeTimelineQueryBudget())).toBe('exhausted')
  })
})
