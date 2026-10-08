/**
 * @file The error a request-path Redis call fails with when Redis did not
 * answer in time. Every caller already handles a Redis failure (fail open,
 * fall back to memory, skip a dedupe), so a stall takes that same path.
 */

/**
 * Redis did not answer within `REDIS_REQUEST_DEADLINE_MS`, or a recent call
 * did not and the stall cooldown is still open, so Redis was not asked.
 */
export class RedisStalledError extends Error {
  /**
   * @param label - What was being asked of Redis.
   */
  constructor(label: string) {
    super(`Redis did not answer (${label})`)
    this.name = 'RedisStalledError'
  }
}
