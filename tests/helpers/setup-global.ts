/**
 * @file The `setupFiles` hook vitest runs once per test file, inside every
 * forked worker. Loads the test env at the precedence `./env` applies
 * (loading a developer's own untracked `.env` here would leak local
 * credentials into the suite and pass tests that fail in CI), then points
 * this worker at its own dedicated Postgres database and Redis key prefix
 * before anything else in this test file's module graph can read either.
 *
 * Its hooks import `src/` dynamically, inside the hook: a static import is
 * hoisted above `loadTestEnv()` and would load modules before the test env.
 */
import path from 'node:path'
import { beforeEach, expect } from 'vitest'
import { loadTestEnv } from './env'
import { workerRedisKeyPrefix } from './redis-prefix'
import { useWorkerDatabase } from './worker-database'

loadTestEnv()
useWorkerDatabase()

// Per-worker Redis namespace, same mechanism as the per-worker database: without it, a Worker in pool 1 would process pool 2's jobs.
process.env.REDIS_KEY_PREFIX = workerRedisKeyPrefix(process.env.VITEST_POOL_ID ?? '0')

const INTEGRATION_DIRECTORY = `${path.sep}tests${path.sep}integration${path.sep}`

/**
 * Whether this file has connected the shared Redis client yet.
 */
const redisWarmUp = { isDone: false }

/**
 * Connect the shared Redis client before an integration file's first test.
 * Request-path Redis calls count the connect against their 300 ms deadline,
 * and a cold connect on a loaded machine can miss it, opening the stall
 * cooldown and turning a Redis-backed assertion into fail-open behaviour.
 * In the first `beforeEach`, not a `beforeAll`: `getEnv()` memoises, and
 * several files `vi.stubEnv` in their own `beforeAll`, which runs after this
 * file's. Skipped where the file points `REDIS_URL` elsewhere through its own
 * `getEnv()` mock (an outage proxy, a dead port): that file owns its connect.
 */
async function connectRedisOnce(): Promise<void> {
  if (redisWarmUp.isDone) return
  redisWarmUp.isDone = true
  if (!expect.getState().testPath?.includes(INTEGRATION_DIRECTORY)) return
  const { getEnv } = await import('@/configs/env.config')
  if (getEnv().REDIS_URL !== process.env.REDIS_URL) return
  const { getRedis } = await import('@/services/redis.service')
  try {
    await getRedis()
  } catch {
    // The file's own tests report an unreachable or closed Redis.
  }
}

beforeEach(async () => {
  await connectRedisOnce()
  // The stall cooldown is per process: one test's stall must not fail the next test's Redis calls.
  const { resetRedisDeadlineForTests } = await import('@/services/redis-deadline.service')
  resetRedisDeadlineForTests()
})
