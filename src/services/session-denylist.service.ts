import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { getRedis } from '@/services/redis.service'
import { requireDurationMs } from '@/utilities/duration.utilities'

const MS_PER_SECOND = 1000
const KEY_PREFIX = 'denylist:session:'

/**
 * Mark a session's access tokens as no longer honoured.
 *
 * The TTL is the whole design. An entry only has to outlive the tokens it
 * invalidates, so it is set to `ACCESS_TOKEN_TTL` and expires exactly when
 * it stops mattering — which is why this needs no sweeper and cannot grow
 * without bound.
 *
 * BEST-EFFORT, and deliberately so. A Redis outage or a FLUSHALL drops every
 * entry, and there is no database fallback because the database does not
 * know a given access token exists. What this closes is the ordinary case:
 * a logout should not leave a usable credential behind for fifteen minutes.
 * @param sessionId - The session whose access tokens should stop working.
 * @returns Resolves once the entry is written, or once the failure is logged.
 */
export async function denySession(sessionId: string): Promise<void> {
  try {
    const seconds = Math.ceil(requireDurationMs(getEnv().ACCESS_TOKEN_TTL) / MS_PER_SECOND)
    const redis = await getRedis()
    await redis.set(`${KEY_PREFIX}${sessionId}`, '1', { EX: seconds })
  } catch (error) {
    // Never rethrow. This runs inside logout, refresh-token reuse detection
    // (both via revokeAllForSession), and password reset (via
    // revokeAllForUser) — a Redis blip must not turn any of them into a
    // 500, because the database revocation is the half that actually ends
    // the session.
    logger.warn('Could not deny session; access tokens stay valid until they expire', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Whether a session's access tokens have been revoked.
 * @param sessionId - The session claimed by the token being checked.
 * @returns True when the token must be rejected.
 */
export async function isSessionDenied(sessionId: string): Promise<boolean> {
  try {
    const redis = await getRedis()
    return (await redis.exists(`${KEY_PREFIX}${sessionId}`)) === 1
  } catch (error) {
    // FAIL OPEN. Failing closed would make every authenticated request fail
    // whenever Redis hiccups — a far larger outage than the window this
    // exists to close. The warning is what stops that being silent.
    logger.warn('Denylist unreachable; allowing the request', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
