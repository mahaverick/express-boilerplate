// tests/helpers/global-setup.ts
//
// WHY THIS RUNS HERE, NOT IN setup-global.ts. setup-global.ts is wired via
// vitest.config.ts's `setupFiles`, which runs once PER TEST FILE, inside
// EVERY forked worker (`pool: 'forks'`, `maxWorkers: 8`). Migrating a
// database from a `setupFiles` hook would mean up to 8 worker processes
// racing to run the same `CREATE TABLE`/`CREATE UNIQUE INDEX` against the
// same database concurrently. drizzle's migrator takes no cross-process
// lock, so the failure mode is not an obvious "already migrating" error —
// it's a duplicate-object error ("relation \"users\" already exists") on
// whichever worker loses the race, which reads like a flaky, unrelated bug
// rather than what it actually is.
//
// vitest's `globalSetup` runs exactly once, in the main process, before any
// worker is spawned — the right hook for a once-per-run side effect.
//
// This now provisions WORKER_COUNT separate databases, not one — see
// ./worker-database for why each worker needs its own. Postgres has no
// `CREATE DATABASE IF NOT EXISTS`; the compose stack's Postgres volume (and
// CI's ephemeral one, freshly created every run) may or may not already
// have these from a previous run, so a duplicate-database error (42P04) is
// caught and ignored rather than treated as failure.
import postgres from 'postgres'
import { runMigrations } from '@/database/migrate'
import { loadTestEnv } from './env'
import { testDatabaseUrlForWorker, WORKER_COUNT } from './worker-database'

/**
 * Create and migrate every worker's dedicated test database once, before
 * any worker (and therefore any test file) starts.
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
        // CREATE DATABASE takes no placeholder parameter; `name` is one of
        // WORKER_COUNT fixed, code-generated identifiers, never user input.
        await admin.unsafe(`CREATE DATABASE "${name}"`)
      } catch (error) {
        const code = (error as { code?: string }).code
        // 42P04 = duplicate_database: already created by a previous run
        // against this same (persistent) Postgres volume.
        if (code !== '42P04') throw error
      }
    }
  } finally {
    await admin.end({ timeout: 5 })
  }

  await Promise.all(workerUrls.map((workerUrl) => runMigrations(workerUrl)))
}
