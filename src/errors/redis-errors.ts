/**
 * @file The error a request-path Redis call fails with when Redis did not
 * answer in time. It is thrown in place of a Redis failure, so a caller
 * handles a stall as it handles any other Redis error.
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
