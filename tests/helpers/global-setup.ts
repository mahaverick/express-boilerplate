/**
 * @file Creates and migrates every worker's dedicated test database once, in
 * vitest's `globalSetup` hook (the main process, before any worker spawns),
 * and clears leftover Redis rate-limit counters from an earlier run.
 */
import postgres from 'postgres'
import { createClient } from 'redis'
import { runMigrations } from '@/database/migrate'
import { loadTestEnv } from './env'
import { WORKER_RATE_LIMIT_KEY_PATTERN } from './redis-prefix'
import { testDatabaseUrlForWorker, WORKER_COUNT } from './worker-database'

/**
 * Delete every rate-limit counter left in Redis before the run starts.
 *
 * Unlike Postgres, Redis is NOT per-worker: all `WORKER_COUNT` workers share
 * the one compose instance, and a counter outlives the run that created it
 * for the length of its window (an hour, for registration). Every integration test
 * also reaches the API from the same client address, so an IP-keyed limiter
 * accumulates across runs — `pnpm test` twice in a row would spend one
 * budget twice and the second run would start seeing 429s that have nothing
 * to do with the code under test. The login limiter never hit this only
 * because its key includes a per-run unique email; the registration and
 * logout limiters are keyed on IP alone and cannot dodge it that way.
 *
 * SCAN, not KEYS: KEYS blocks the server for the whole keyspace, and this
 * may be a developer's own Redis with other data in it. Deletion is scoped
 * to the test workers' `rl:` keyspaces (./redis-prefix) for the same reason:
 * a dev server's keys on this Redis are never touched, and never FLUSHDB.
 *
 * Non-fatal: if Redis is unreachable, `SharedRateLimitStore` falls back to
 * a per-process in-memory store that cannot accumulate across runs anyway,
 * so there is nothing to clear and nothing to fail for.
 *
 * Note this runs once per `vitest run`, so a long `vitest watch` session
 * re-running the same file many times can still accumulate against the
 * production limits; restart the watcher if that ever surfaces.
 */
async function clearRateLimitCounters(): Promise<void> {
  const url = process.env.REDIS_URL
  if (url === undefined) return

  const client = createClient({
    url,
    // Bounded like redis.service.ts's own client: an unbounded connect() would hang the whole suite instead of falling through to the warning below.
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (retries) => (retries > 1 ? new Error('Redis unreachable') : 100),
    },
  })
  // Without a listener, EventEmitter throws node-redis's emitted 'error' and crashes the process.
  client.on('error', () => {})

  try {
    await client.connect()
    const batches = client.scanIterator({ MATCH: WORKER_RATE_LIMIT_KEY_PATTERN, COUNT: 500 })
    for await (const keys of batches) {
      if (keys.length > 0) await client.del(keys)
    }
  } catch (error) {
    console.warn(
      'global-setup: could not clear rate-limit counters in Redis; continuing.',
      (error as Error).message
    )
  } finally {
    if (client.isOpen) client.destroy()
  }
}

/**
 * Create and migrate every worker's dedicated test database once, before
 * any worker (and therefore any test file) starts. This must run from
 * vitest's `globalSetup`, not from `tests/helpers/setup-global.ts`'s
 * `setupFiles` hook: that hook runs once per test file inside every forked
 * worker, so migrating from there would race up to `WORKER_COUNT` processes
 * against the same `CREATE TABLE`/`CREATE UNIQUE INDEX`, and drizzle's
 * migrator holds no cross-process lock — the loser sees a duplicate-object
 * error that reads like an unrelated flake, not a migration race.
 */
export default async function setup(): Promise<void> {
  // Populate process.env from .env.test(.local) before reading DATABASE_URL.
  loadTestEnv()
  const baseUrl = process.env.DATABASE_URL
  if (baseUrl === undefined) {
    throw new Error('DATABASE_URL is not set — check .env.test')
  }

  const workerUrls = Array.from({ length: WORKER_COUNT }, (_unused, index) =>
    testDatabaseUrlForWorker(baseUrl, index + 1)
  )

  const admin = postgres(baseUrl, { max: 1 })
  try {
    for (const workerUrl of workerUrls) {
      const name = new URL(workerUrl).pathname.slice(1)
      try {
        // CREATE DATABASE takes no placeholder parameter; `name` is one of WORKER_COUNT fixed, code-generated identifiers, never user input.
        await admin.unsafe(`CREATE DATABASE "${name}"`)
      } catch (error) {
        const code = (error as { code?: string }).code
        // 42P04 = duplicate_database: already created by a previous run against this same (persistent) Postgres volume.
        if (code !== '42P04') throw error
      }
    }
  } finally {
    await admin.end({ timeout: 5 })
  }

  await Promise.all(workerUrls.map((workerUrl) => runMigrations(workerUrl)))
  await clearRateLimitCounters()
}
