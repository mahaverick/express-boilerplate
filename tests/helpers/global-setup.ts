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
import { loadTestEnv } from './env'

/**
 * Migrate the test database once, before any worker (and therefore any test
 * file) starts.
 */
export default async function setup(): Promise<void> {
  // Populate process.env from .env.test(.local) before importing anything
  // that reads it. This has to be a dynamic import, not a static one: a
  // static `import { runMigrations } from '@/database/migrate'` at the top
  // of this file would be hoisted and evaluated before this function body
  // — and therefore before loadTestEnv() runs — so
  // src/services/database.service.ts would call getEnv() against an empty
  // process.env and throw before DATABASE_URL ever gets set.
  loadTestEnv()
  const { runMigrations } = await import('@/database/migrate')
  await runMigrations()
}
