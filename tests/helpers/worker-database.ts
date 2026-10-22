/**
 * @file Gives each vitest worker its own physical Postgres database, keyed by
 * `VITEST_POOL_ID`, so two worker processes can never race a unique
 * constraint against the same row from different test files. Truncating
 * between files alone would not do this: it cannot stop two different
 * worker processes colliding at the same moment, only one file's leftovers
 * from breaking the next file in the same worker.
 */

/**
 * The worker count for an environment: `VITEST_WORKERS` when set, else 8.
 * CI sets it per runner; a local run takes the default.
 * @param env - The environment to read (`process.env` outside tests).
 * @returns An integer from 1 to 16.
 * @throws {Error} When `VITEST_WORKERS` is set and is not an integer from 1 to 16.
 */
export function workerCountFrom(env: Record<string, string | undefined>): number {
  const raw = env.VITEST_WORKERS
  if (raw === undefined) return 8
  const count = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new Error(`VITEST_WORKERS must be an integer from 1 to 16, got "${raw}"`)
  }
  return count
}

/**
 * How many per-worker test databases exist, all created and migrated once,
 * up front, by `tests/helpers/global-setup.ts`, before any worker starts.
 * `vite.config.ts` imports this constant for `maxWorkers` rather than
 * repeating the number, so the two values cannot drift apart — a worker
 * assigned a `VITEST_POOL_ID` with no database provisioned for it would
 * otherwise fail as a bare connection error, with nothing pointing at
 * "`maxWorkers` and `WORKER_COUNT` disagree" as the actual cause.
 */
export const WORKER_COUNT = workerCountFrom(process.env)

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
 * Safe to call twice in one process: it stashes the untouched base URL once,
 * under a fixed key, and always recomputes `DATABASE_URL` from that stash.
 * Recomputing from whatever `DATABASE_URL` holds would suffix the name twice
 * if a process ran the setup again, as one that shares a worker across test
 * files would.
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
