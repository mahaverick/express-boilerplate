import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { MS_PER_SECOND, requireDurationMs } from '@/utilities/duration.utilities'

/**
 * The key one session's denial is stored under. Built per call, because
 * getEnv() must not run at module scope.
 * @param sessionId - The denied session.
 * @returns The namespaced key.
 */
function denylistKey(sessionId: string): string {
  return redisKey('denylist', 'session', sessionId)
}

/**
 * Whether a denial was written.
 */
export type DenyOutcome = 'denied' | 'failed'

/**
 * Mark a session's access tokens as no longer honoured.
 *
 * The entry's TTL is `ACCESS_TOKEN_TTL`, starting at denial, so it needs no
 * sweeper and always outlives the token it targets, which was minted earlier.
 *
 * Best-effort: a Redis outage or FLUSHALL drops every entry, and the database
 * has no record of access tokens to fall back on. It closes the ordinary case,
 * a logout leaving a usable credential behind for up to `ACCESS_TOKEN_TTL`.
 *
 * It never rethrows. Every revocation in session.service.ts calls this after
 * its database write, and a Redis blip must not turn one into a 500: the
 * database revocation is the half that ends the session.
 * @param sessionId - The session whose access tokens should stop working.
 * @returns 'denied' once the entry is written; 'failed' once a failure is logged. Never rejects.
 */
export async function denySession(sessionId: string): Promise<DenyOutcome> {
  try {
    const seconds = Math.ceil(requireDurationMs(getEnv().ACCESS_TOKEN_TTL) / MS_PER_SECOND)
    const redis = await getRedis()
    // `{ EX: seconds }` is `@deprecated` in `@redis/client@6.2.1` in favour of `expiration`.
    await redis.set(denylistKey(sessionId), '1', {
      expiration: { type: 'EX', value: seconds },
    })
    return 'denied'
  } catch (error) {
    logger.warn('Could not deny session; access tokens stay valid until they expire', {
      sessionId,
      error,
    })
    return 'failed'
  }
}

/**
 * Whether a session's access tokens have been revoked.
 *
 * Fails open: when Redis is unreachable it logs a warning and returns false.
 * Failing closed would fail every authenticated request whenever Redis
 * hiccups, a far larger outage than the window the denylist closes.
 * @param sessionId - The session claimed by the token being checked.
 * @returns True when the token must be rejected.
 */
export async function isSessionDenied(sessionId: string): Promise<boolean> {
  try {
    const redis = await getRedis()
    const exists = await withRedisDeadline(
      () => redis.exists(denylistKey(sessionId)),
      'session denylist read'
    )
    return exists === 1
  } catch (error) {
    logger.warn('Denylist unreachable; allowing the request', {
      sessionId,
      error,
    })
    return false
  }
}
