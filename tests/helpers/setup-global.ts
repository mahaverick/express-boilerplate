/**
 * @file The `setupFiles` hook vitest runs once per test file, inside every
 * forked worker. Loads the test env at the precedence `./env` applies
 * (loading a developer's own untracked `.env` here would leak local
 * credentials into the suite and pass tests that fail in CI), then points
 * this worker at its own dedicated Postgres database and Redis key prefix
 * before anything else in this test file's module graph can read either.
 *
 * Its hook imports `src/` dynamically, inside the hook: a static import is
 * hoisted above `loadTestEnv()` and would load modules before the test env.
 */
import { beforeEach } from 'vitest'
import { loadTestEnv } from './env'
import { workerRedisKeyPrefix } from './redis-prefix'
import { useWorkerDatabase } from './worker-database'

loadTestEnv()
useWorkerDatabase()

// Per-worker Redis namespace, same mechanism as the per-worker database: without it, a Worker in pool 1 would process pool 2's jobs.
process.env.REDIS_KEY_PREFIX = workerRedisKeyPrefix(process.env.VITEST_POOL_ID ?? '0')

// The stall cooldown is per process: one test's stall must not fail the next test's Redis calls.
beforeEach(async () => {
  const { resetRedisDeadlineForTests } = await import('@/services/redis-deadline.service')
  resetRedisDeadlineForTests()
})
