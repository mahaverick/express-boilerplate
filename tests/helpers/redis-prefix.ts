// tests/helpers/redis-prefix.ts
//
// Each vitest worker namespaces its Redis keys under its own
// REDIS_KEY_PREFIX, the same way it gets its own database. setup-global.ts
// sets it per worker; global-setup.ts clears rate-limit counters under it.

const WORKER_PREFIX_BASE = 'test-w'

/**
 * The REDIS_KEY_PREFIX one vitest worker runs under.
 * @param poolId - vitest's VITEST_POOL_ID for the worker.
 * @returns The worker's prefix, e.g. `test-w3`.
 */
export function workerRedisKeyPrefix(poolId: string): string {
  return `${WORKER_PREFIX_BASE}${poolId}`
}

/**
 * SCAN pattern for every test worker's rate-limit counters, and for nothing
 * outside the test prefixes.
 */
export const WORKER_RATE_LIMIT_KEY_PATTERN = `${WORKER_PREFIX_BASE}*:rl:*`
