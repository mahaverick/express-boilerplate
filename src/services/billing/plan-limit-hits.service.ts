/**
 * @file How often the plan refused a workspace in the last 30 days, for the
 * tenant group's `limit_hits_30d`. Each `plan_limit_reached` or
 * `plan_feature_blocked` event sent adds one entry to a Redis sorted set per
 * workspace, scored by its time; the drain counts the entries of the window
 * when it resolves a group marker. The outbox cannot answer it, since a row
 * leaves it once PostHog has it. Analytics only: a lost entry or a failed
 * read changes no request, and a failed read sends no count rather than a
 * wrong one. Both calls wait at most the Redis request deadline.
 */
import { randomUUID } from 'node:crypto'
import { redactedForLog } from '@/errors/postgres-errors'
import { logger } from '@/services/logger.service'
import { withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'

/**
 * The window `limit_hits_30d` counts over.
 */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long a workspace's set lives after its last entry: one day past the window.
 */
const TTL_SECONDS = 31 * 24 * 60 * 60

/**
 * A workspace's set of refusal times.
 * @param tenantId - The workspace.
 * @returns The Redis key.
 */
function hitsKey(tenantId: string): string {
  return redisKey('billing', 'limit-hits', tenantId)
}

/**
 * Count one refusal sent to analytics, dropping entries older than the
 * window. Never rejects; a failure is logged with the workspace id.
 * @param tenantId - The workspace.
 * @param now - When it was refused.
 */
export async function recordLimitHit(tenantId: string, now = new Date()): Promise<void> {
  try {
    const key = hitsKey(tenantId)
    await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis
        .multi()
        .zAdd(key, { score: now.getTime(), value: randomUUID() })
        .zRemRangeByScore(key, '-inf', now.getTime() - WINDOW_MS)
        .expire(key, TTL_SECONDS)
        .exec()
    }, 'plan refusal count')
  } catch (error) {
    logger.warn('Could not count a plan refusal', { error: redactedForLog(error), tenantId })
  }
}

/**
 * The refusals each workspace had in the window ending now, in one round trip.
 * @param tenantIds - The workspaces.
 * @param now - The window's end.
 * @returns Each workspace's count; empty when Redis could not answer, so no count is sent.
 */
export async function countLimitHits(
  tenantIds: readonly string[],
  now = new Date()
): Promise<Map<string, number>> {
  if (tenantIds.length === 0) return new Map()
  try {
    const replies = await withRedisDeadline(async () => {
      const redis = await getRedis()
      const transaction = redis.multi()
      for (const tenantId of tenantIds) {
        transaction.zCount(hitsKey(tenantId), now.getTime() - WINDOW_MS, '+inf')
      }
      return transaction.exec()
    }, 'plan refusal counts')
    const counts = new Map<string, number>()
    for (const [index, tenantId] of tenantIds.entries()) {
      const reply = replies[index]
      // A reply that is not a count sends no count for that workspace.
      if (typeof reply === 'number') counts.set(tenantId, reply)
    }
    return counts
  } catch (error) {
    logger.warn('Could not read the plan refusal counts', { error: redactedForLog(error) })
    return new Map()
  }
}
