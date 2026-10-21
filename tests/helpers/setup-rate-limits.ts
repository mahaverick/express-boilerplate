/**
 * @file A `setupFiles` hook, registered only on vite.config.ts's
 * `integration` project (never on `unit`, which may run with Docker down).
 * Before each file's own hooks, it clears this worker's rate-limit counters,
 * so a per-IP budget an earlier file in the same worker spent cannot answer
 * 429 here. Only this worker's prefix: another worker's files are counting
 * under theirs right now. It runs after setup-global.ts, which loads REDIS_URL.
 */
import { beforeAll } from 'vite-plus/test'
import { clearRedisKeys } from './clear-redis-keys'
import { workerRedisKeyPrefix } from './redis-prefix'

// beforeAll: setup-file hooks are registered before the file's own, so this runs before any of them spends a budget.
beforeAll(async () => {
  const prefix = workerRedisKeyPrefix(process.env.VITEST_POOL_ID ?? '0')
  await clearRedisKeys(`${prefix}:rl:*`, 'setup-rate-limits')
})
