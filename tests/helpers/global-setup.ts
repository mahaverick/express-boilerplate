/**
 * @file Creates and migrates every worker's dedicated test database once, in
 * vitest's `globalSetup` hook (the main process, before any worker spawns),
 * and clears leftover Redis rate-limit counters from an earlier run.
 */
import postgres from 'postgres'
import { runMigrations } from '@/database/migrate'
import { clearRedisKeys } from './clear-redis-keys'
import { loadTestEnv } from './env'
import { WORKER_RATE_LIMIT_KEY_PATTERN } from './redis-prefix'
import { testDatabaseUrlForWorker, WORKER_COUNT } from './worker-database'

/**
 * Delete every test worker's rate-limit counters from Redis before the run
 * starts.
 *
 * Redis is one instance shared by all `WORKER_COUNT` workers, and a counter
 * outlives the run that created it for the length of its window (an hour, for
 * registration). Every integration test reaches the API from the same client
 * address, so an IP-keyed limiter accumulates across runs: `pnpm test` twice
 * in a row would spend one budget twice, and the second run would see 429s
 * that have nothing to do with the code under test. The composite login
 * limiter avoids this because its key includes a per-run unique email; the
 * IP-only limiters (registration, logout) cannot.
 *
 * SCAN, not KEYS: KEYS blocks the server for the whole keyspace, and this
 * may be a developer's own Redis with other data in it. For the same reason
 * deletion is scoped to the test workers' `rl:` keyspaces (./redis-prefix),
 * and never FLUSHDB.
 *
 * Non-fatal: if Redis is unreachable, `SharedRateLimitStore` falls back to
 * a per-process in-memory store that cannot accumulate across runs anyway,
 * so there is nothing to clear and nothing to fail for.
 *
 * This runs once per `vitest run`, so a long `vitest watch` session re-running
 * the same file can still accumulate against the production limits; restart
 * the watcher if that surfaces.
 */
async function clearRateLimitCounters(): Promise<void> {
  await clearRedisKeys(WORKER_RATE_LIMIT_KEY_PATTERN, 'global-setup')
}

/**
 * Create and migrate every worker's dedicated test database once, before
 * any worker (and therefore any test file) starts. It runs from vitest's
 * `globalSetup` and not from `tests/helpers/setup-global.ts`'s `setupFiles`
 * hook, which runs once per test file inside every forked worker and would
 * run the migrator again for each file.
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
