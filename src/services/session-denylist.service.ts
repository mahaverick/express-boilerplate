import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import {
  STILL_PENDING,
  waitForRedisWrite,
  withRedisDeadline,
} from '@/services/redis-deadline.service'
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
 * Whether a denial was written: `pending` when Redis had not answered by the
 * deadline and the write is still in flight, to land when Redis answers.
 */
export type DenyOutcome = 'denied' | 'pending' | 'failed'

const DENY_FAILED_MESSAGE = 'Could not deny session; access tokens stay valid until they expire'

/**
 * Stop honouring a session's access tokens.
 *
 * The entry's TTL is `ACCESS_TOKEN_TTL`, starting at denial, so it needs no
 * sweeper and outlives every token of the session minted before it.
 *
 * Best-effort: a flush or a restart without persistence drops every entry,
 * the read fails open while Redis is down or stalled, and the database has no
 * record of access tokens to fall back on. It closes the ordinary case, a
 * logout leaving a usable credential behind for up to `ACCESS_TOKEN_TTL`.
 *
 * It never rethrows. Every revocation in session.service.ts reaches it after
 * its database write, directly or through `denySessionsAfterCommit`, and a
 * Redis blip must not turn one into a 500: the database revocation is the
 * half that ends the session.
 *
 * It waits at most `REDIS_REQUEST_DEADLINE_MS`, connect included, and
 * ignores the stall cooldown (`waitForRedisWrite`): a deny is always sent. A
 * write that fails before the deadline is logged at warn. One Redis has not
 * answered by the deadline stays in flight, logged at warn, to land when
 * Redis answers on the same connection. If it then fails (the connection
 * dropped, say), the loss is logged at `error` as
 * `session denylist write failed after revocation`, with the user id when the
 * caller gave one.
 * @param sessionId - The session whose access tokens should stop working.
 * @param userId - The session's user, when the caller knows it, for the late-failure log.
 * @returns 'denied' once the entry is written; 'pending' when it is still in flight at the deadline; 'failed' when it failed before the deadline, logged at warn. Never rejects.
 */
export async function denySession(sessionId: string, userId?: string): Promise<DenyOutcome> {
  try {
    const seconds = Math.ceil(requireDurationMs(getEnv().ACCESS_TOKEN_TTL) / MS_PER_SECOND)
    const outcome = await waitForRedisWrite(
      async () => {
        const redis = await getRedis()
        // `{ EX: seconds }` is `@deprecated` in `@redis/client@6.2.1` in favour of `expiration`.
        return redis.set(denylistKey(sessionId), '1', {
          expiration: { type: 'EX', value: seconds },
        })
      },
      'session deny',
      (error) => {
        logger.error('session denylist write failed after revocation', {
          userId,
          sessionId,
          sessionCount: 1,
          error,
        })
      },
      { sessionId }
    )
    return outcome === STILL_PENDING ? 'pending' : 'denied'
  } catch (error) {
    logger.warn(DENY_FAILED_MESSAGE, { sessionId, error })
    return 'failed'
  }
}

/**
 * Whether a session's access tokens have been revoked.
 *
 * Fails open: when Redis is unreachable, stalled past the deadline or in its
 * stall cooldown (`withRedisDeadline`), it logs a warning and returns false.
 * Failing closed would fail every authenticated request whenever Redis
 * hiccups, a far larger outage than the window the denylist closes.
 * @param sessionId - The session claimed by the token being checked.
 * @returns True when the token must be rejected.
 */
export async function isSessionDenied(sessionId: string): Promise<boolean> {
  try {
    const exists = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.exists(denylistKey(sessionId))
    }, 'session denylist read')
    return exists === 1
  } catch (error) {
    logger.warn('Denylist unreachable; allowing the request', {
      sessionId,
      error,
    })
    return false
  }
}
