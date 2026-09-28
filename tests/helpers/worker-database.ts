/**
 * @file Gives each vitest worker its own physical Postgres database, keyed by
 * `VITEST_POOL_ID`, so two worker processes can never race a unique
 * constraint against the same row from different test files. Truncating
 * between files alone would not do this: it cannot stop two different
 * worker processes colliding at the same moment, only one file's leftovers
 * from breaking the next file in the same worker.
 */

/**
 * How many per-worker test databases exist, all created and migrated once,
 * up front, by `tests/helpers/global-setup.ts`, before any worker starts.
 * `vitest.config.ts` imports this constant for `maxWorkers` rather than
 * repeating the number, so the two values cannot drift apart — a worker
 * assigned a `VITEST_POOL_ID` with no database provisioned for it would
 * otherwise fail as a bare connection error, with nothing pointing at
 * "`maxWorkers` and `WORKER_COUNT` disagree" as the actual cause.
 */
export const WORKER_COUNT = 8

// Test-infrastructure-only, never read by application code: the untouched base DATABASE_URL, stashed before useWorkerDatabase() below overwrites it.
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
