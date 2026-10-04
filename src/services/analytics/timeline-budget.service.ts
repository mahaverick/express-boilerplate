/**
 * @file The project-wide budget of PostHog timeline queries: at most
 * `TIMELINE_QUERY_BUDGET_PER_HOUR` in any rolling hour, counted in one Redis
 * sorted set shared by every replica. PostHog allows 2400 query calls an hour
 * for the whole organization, its own UI included, so the default keeps half
 * of that for the UI. Only a cache miss takes from it.
 */
import { randomUUID } from 'node:crypto'
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'

const HOUR_MS = 60 * 60 * 1000
const HOUR_SECONDS = 60 * 60

/**
 * The position of `ZCARD`'s reply in the budget transaction's replies.
 */
const ZCARD_REPLY_INDEX = 2

/**
 * Whether a query got a slot in the hourly budget.
 */
export type TimelineBudgetResult = 'taken' | 'exhausted'

/**
 * Take one query from the hourly budget.
 *
 * One `MULTI` drops entries older than an hour, adds this query's entry,
 * counts the set and refreshes its one-hour expiry. Over the budget, the
 * entry is removed again and the query refused, so a refused query never
 * spends the budget. Two queries racing for the last slot can both be
 * refused; neither can push the count past the budget.
 * @param now - The moment of the query; defaults to now.
 * @returns `taken` when the query may go to PostHog, `exhausted` when it may
 *   not. A Redis failure returns `taken`, logged at `warn`: the budget fails
 *   open, as the limiters do.
 */
export async function takeTimelineQueryBudget(
  now: Date = new Date()
): Promise<TimelineBudgetResult> {
  const key = redisKey('timeline', 'budget')
  const nowMs = now.getTime()
  const member = `${String(nowMs)}:${randomUUID()}`
  let redis: Awaited<ReturnType<typeof getRedis>>
  let count: number
  try {
    redis = await getRedis()
    const replies = await redis
      .multi()
      .zRemRangeByScore(key, '-inf', nowMs - HOUR_MS)
      .zAdd(key, { score: nowMs, value: member })
      .zCard(key)
      .expire(key, HOUR_SECONDS)
      .exec()
    count = Number(replies[ZCARD_REPLY_INDEX])
  } catch (error) {
    logger.warn('Timeline query budget unavailable; allowing the query', { error })
    return 'taken'
  }
  if (count <= getEnv().TIMELINE_QUERY_BUDGET_PER_HOUR) return 'taken'
  try {
    await redis.zRem(key, member)
  } catch (error) {
    // The entry expires with the set, so this over-counts by one for at most an hour.
    logger.warn('Could not return a refused timeline query to the budget', { error })
  }
  return 'exhausted'
}
