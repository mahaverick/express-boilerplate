// tests/helpers/worker-database.ts
//
// WHY THIS EXISTS. Before this file, every vitest worker shared ONE test
// database (`.env.test`'s DATABASE_URL). database.service.test.ts's own
// header comment named the trigger this repo was watching for: "the first
// test that mutates rows is the trigger for a per-worker schema or
// transaction-rollback strategy" — migrate.test.ts's uniqueness test was
// that trigger. With `pool: 'forks'` and `maxWorkers: 8` (vitest.config.ts),
// two tests in different files racing to insert the same fixed email from
// two different worker PROCESSES would hit a real, cross-test
// unique-constraint violation — indistinguishable, from the failure
// message alone, from an application bug. Task 3's repository-layer tests
// insert users routinely; this is deliberately fixed before that lands.
//
// The chosen mechanism: each worker gets its OWN physical database, keyed
// off VITEST_POOL_ID (vitest's own worker-slot id — "value is between
// 1-maxWorkers", verified against the installed vitest package's source:
// node_modules/vitest/dist/chunks/index.B89dZ0-N.js). All WORKER_COUNT
// databases are created and migrated once, up front, in
// tests/helpers/global-setup.ts (the main process, before any worker
// spawns) — never lazily from inside a worker, which would reintroduce the
// exact concurrent-migration race tests/helpers/global-setup.ts's own
// header already explains.
//
// Truncating between test FILES was considered and rejected as the sole
// mechanism: it stops one file's leftover rows from breaking the next file
// in the SAME worker, but does nothing for two DIFFERENT workers running at
// the same moment — the actual failure mode this file exists to prevent.
// Per-worker databases solve that directly; per-test cleanup (already this
// repo's convention — see migrate.test.ts) still matters for files sharing
// one worker sequentially, and is unchanged by this file.
//
// WORKER_COUNT mirrors vitest.config.ts's `maxWorkers`. Kept as a
// cross-referencing comment rather than a shared import, the same way this
// repo already keeps docker-compose's ports, .env.test, and CI's env block
// in sync — see that file's own comment for why 8 was chosen.
export const WORKER_COUNT = 8

// Test-infrastructure-only process.env key: the untouched base DATABASE_URL
// (from .env.test), stashed before useWorkerDatabase() below overwrites
// process.env.DATABASE_URL for this worker. Never read by application code.
const BASE_DATABASE_URL_KEY = 'TEST_DATABASE_BASE_URL'

/**
 * The dedicated test-database URL for one worker slot, derived from the
 * shared base `DATABASE_URL` by suffixing the database name.
 * @param baseUrl - The shared base `DATABASE_URL` (from `.env.test`).
 * @param workerId - The worker slot number (1-`WORKER_COUNT`).
 * @returns The worker-specific database URL.
 */
export function testDatabaseUrlForWorker(baseUrl: string, workerId: number): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname}_w${workerId}`
  return url.href
}

/**
 * Point `process.env.DATABASE_URL` at this worker's own dedicated test
 * database, so every module that reads it (`database.service.ts`, via
 * `getEnv()`) connects to a database no other worker ever touches.
 *
 * Idempotent across multiple test files in the same worker PROCESS:
 * `process.env` persists across files in one worker (only the module
 * registry resets between files — see `tests/helpers/setup-global.ts`), so
 * this stashes the untouched base URL once, under a fixed key, and always
 * recomputes `DATABASE_URL` from that stashed base. Recomputing from
 * whatever `DATABASE_URL` currently holds would double-suffix it on the
 * second file in the same worker.
 */
export function useWorkerDatabase(): void {
  if (process.env[BASE_DATABASE_URL_KEY] === undefined && process.env.DATABASE_URL !== undefined) {
    process.env[BASE_DATABASE_URL_KEY] = process.env.DATABASE_URL
  }
  const base = process.env[BASE_DATABASE_URL_KEY]
  const poolId = process.env.VITEST_POOL_ID
  if (base === undefined || poolId === undefined) return
  process.env.DATABASE_URL = testDatabaseUrlForWorker(base, Number(poolId))
}

/**
 * The base URL every per-worker database is derived from — the value
 * `useWorkerDatabase()` stashed before remapping `DATABASE_URL`. A test that
 * needs to reach a SPECIFIC worker's database directly (not just "whichever
 * one this worker uses") reads this instead of `DATABASE_URL`.
 * @returns The stashed base URL, or `undefined` before `useWorkerDatabase()` has run.
 */
export function baseDatabaseUrl(): string | undefined {
  return process.env[BASE_DATABASE_URL_KEY]
}
