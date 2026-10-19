/**
 * @file Dropping a throwaway database a migration test created for itself.
 * A plain `DROP DATABASE`, never `WITH (FORCE)`: FORCE terminates every other
 * backend on the database and fails with "permission denied to terminate
 * process" when one of them is not the caller's role, which the autovacuum
 * worker visiting a freshly migrated database is not (the local `test` role
 * is no superuser and lacks `pg_signal_backend`). A plain drop signals the
 * autovacuum workers on that database itself and waits for them, which needs
 * no privilege. It still answers SQLSTATE 55006 while another client of the
 * caller's own is connected, so that is retried for a few seconds.
 */
import { inspect } from 'node:util'
import type { Sql } from 'postgres'
import { settle } from './timing'

/**
 * The shape of every scratch database name: the worker database's name, the
 * migration it tests and the Vitest pool id, as in `<base>_m0029_w3`. The
 * helper refuses any other name, so it can never drop a worker database.
 */
const SCRATCH_NAME_PATTERN = /^\w+_m\d{4}_w\d+$/

/**
 * Postgres's "object in use" code: another session is connected to the database.
 */
const OBJECT_IN_USE = '55006'

/**
 * The pauses between drop attempts, in ms: a short backoff, about 6 s in all.
 */
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1000, 1000, 1000, 1000, 1000] as const

/**
 * Whether a postgres.js error carries a SQLSTATE code.
 * @param error - What the drop threw.
 * @param code - The SQLSTATE to match.
 * @returns True when it is that code.
 */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/**
 * The backends still on a database, for the error a last failed drop throws,
 * so the next occurrence shows which process held it.
 * @param admin - A client on another database.
 * @param name - The scratch database.
 * @returns One row per backend.
 */
async function backendsOn(admin: Sql, name: string): Promise<unknown> {
  try {
    return await admin`
      select pid, backend_type, usesysid, usename, application_name, state
      from pg_stat_activity where datname = ${name}
    `
  } catch (error) {
    return { readFailed: inspect(error) }
  }
}

/**
 * Drop a scratch database this test file created, if it exists. Retries on
 * 55006 with a short bounded backoff; any other error is thrown at once.
 * @param admin - A client connected to another database (the worker's own).
 * @param name - The scratch database's name; must match `<base>_m<NNNN>_w<pool>`.
 * @throws {Error} When the name is not a scratch name, or the database is still in use after the last retry (the message lists its backends).
 */
export async function dropScratchDatabase(admin: Sql, name: string): Promise<void> {
  if (!SCRATCH_NAME_PATTERN.test(name)) {
    throw new Error(`Refusing to drop "${name}": not a scratch database name`)
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.unsafe(`drop database if exists "${name}"`)
      return
    } catch (error) {
      if (!hasCode(error, OBJECT_IN_USE)) throw error
      const pause = RETRY_DELAYS_MS[attempt]
      if (pause === undefined) {
        const backends = await backendsOn(admin, name)
        throw new Error(
          `Scratch database "${name}" still in use after ${String(attempt + 1)} drops; backends: ${inspect(backends)}`,
          { cause: error }
        )
      }
      await settle(pause, 'Postgres signals nothing when the last backend leaves a database')
    }
  }
}
