/**
 * @file takeTimelineQueryBudget against the real Redis: the hour slides, a
 * refused query spends nothing, and the set expires. The budget is 3 for this
 * file, through a mocked `getEnv()`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { takeTimelineQueryBudget } from '@/services/analytics/timeline-budget.service'
import { getRedis, redisKey } from '@/services/redis.service'

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({ ...actual.getEnv(), TIMELINE_QUERY_BUDGET_PER_HOUR: 3 }),
  }
})

const MINUTE_MS = 60 * 1000
const START = new Date('2026-10-04T10:00:00.000Z')

/**
 * A moment some time after START.
 * @param minutes - How many minutes later.
 * @param extraMs - Milliseconds on top of that.
 * @returns The moment.
 */
function at(minutes: number, extraMs = 0): Date {
  return new Date(START.getTime() + minutes * MINUTE_MS + extraMs)
}

beforeEach(async () => {
  const redis = await getRedis()
  await redis.del(redisKey('timeline', 'budget'))
})

afterAll(async () => {
  const redis = await getRedis()
  await redis.del(redisKey('timeline', 'budget'))
})

describe('takeTimelineQueryBudget', () => {
  it('allows the budget within an hour, then refuses without spending', async () => {
    const taken = [
      await takeTimelineQueryBudget(at(0)),
      await takeTimelineQueryBudget(at(1)),
      await takeTimelineQueryBudget(at(2)),
      await takeTimelineQueryBudget(at(3)),
      await takeTimelineQueryBudget(at(4)),
    ]

    expect(taken).toEqual(['taken', 'taken', 'taken', 'exhausted', 'exhausted'])
    const redis = await getRedis()
    expect(await redis.zCard(redisKey('timeline', 'budget'))).toBe(3)
  })

  it('frees a slot once its query is an hour old', async () => {
    for (const minute of [0, 10, 20]) {
      expect(await takeTimelineQueryBudget(at(minute))).toBe('taken')
    }
    expect(await takeTimelineQueryBudget(at(59))).toBe('exhausted')

    // At exactly one hour the first query's slot is free; a millisecond later no other is.
    expect(await takeTimelineQueryBudget(at(60))).toBe('taken')
    expect(await takeTimelineQueryBudget(at(60, 1))).toBe('exhausted')
  })

  it('never counts past the budget when queries race for the last slots', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => takeTimelineQueryBudget(at(0, index)))
    )

    expect(results.filter((result) => result === 'taken').length).toBeLessThanOrEqual(3)
    const redis = await getRedis()
    expect(await redis.zCard(redisKey('timeline', 'budget'))).toBeLessThanOrEqual(3)
  })

  it('gives the set a one-hour expiry', async () => {
    await takeTimelineQueryBudget(at(0))

    const redis = await getRedis()
    const ttl = await redis.ttl(redisKey('timeline', 'budget'))
    expect(ttl).toBeGreaterThan(3500)
    expect(ttl).toBeLessThanOrEqual(3600)
  })
})
