// tests/helpers/lock-probe.ts
//
// Detects a row-lock wait without sleeping on a guess: pg_blocking_pids(pid)
// lists the backends a waiting backend is queued behind. The test pool has
// two connections and a race holds both, so each probe opens its own
// single-connection client and closes it before returning.
import { setTimeout as delay } from 'node:timers/promises'
import { sql as drizzleSql } from 'drizzle-orm'
import postgres from 'postgres'
import { getEnv } from '@/configs/env.config'
import type { DbExecutor } from '@/services/database.service'

const POLL_INTERVAL_MS = 10
const DEFAULT_TIMEOUT_MS = 5000

/**
 * The backend pid of the connection running `executor`.
 * @param executor - A transaction, so the pid names the connection its later statements run on.
 * @returns The Postgres backend pid.
 */
export async function backendPid(executor: DbExecutor): Promise<number> {
  const rows = await executor.execute<{ pid: number }>(drizzleSql`select pg_backend_pid() as pid`)
  const pid = rows[0]?.pid
  if (typeof pid !== 'number') throw new Error('pg_backend_pid() returned no row')
  return pid
}

/**
 * Poll pg_blocking_pids(pid) every 10 ms on a dedicated connection until it
 * is non-empty (true) or `settled` has settled (false).
 * @param pid - The backend to watch, from `backendPid`.
 * @param settled - The work running on that backend; once it settles, the backend was not left waiting.
 * @param options - Bounds on the wait.
 * @param options.timeoutMs - The longest wait, in ms (default 5000).
 * @returns True when the backend was seen waiting on a lock, false when the work finished without waiting.
 * @throws {Error} When neither happens within `timeoutMs`.
 */
// eslint-disable-next-line unicorn/consistent-boolean-name -- reads as the wait it performs, like `await waitForBlocked(pid, work)`
export async function waitForBlocked(
  pid: number,
  settled: Promise<unknown>,
  options: { timeoutMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let hasSettled = false
  const observe = async (): Promise<void> => {
    try {
      await settled
    } catch {
      // The caller awaits `settled` itself and handles its rejection.
    } finally {
      hasSettled = true
    }
  }
  void observe()

  const probe = postgres(getEnv().DATABASE_URL, { max: 1 })
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const [row] = await probe<{ blocked: boolean }[]>`
        select cardinality(pg_blocking_pids(${pid}::int)) > 0 as blocked
      `
      if (row?.blocked) return true
      if (hasSettled) return false
      await delay(POLL_INTERVAL_MS)
    }
    throw new Error(`backend ${pid} neither waited on a lock nor finished within ${timeoutMs} ms`)
  } finally {
    await probe.end({ timeout: 5 })
  }
}

/**
 * A promise with its resolver exposed.
 * @returns The promise and its resolve function.
 */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let settle: ((value: T) => void) | undefined
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- tsconfig.json pins `lib: ["ES2023"]`; `Promise.withResolvers` is ES2024 and untyped under it.
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: (value: T) => settle?.(value) }
}

/**
 * Wait for a seam's signal, failing fast if the work it belongs to settles
 * first, so a seam that is never reached cannot hang the test.
 * @param signal - Resolved by the seam.
 * @param work - The call that should reach the seam.
 * @param label - Names the work in the error.
 * @returns The signal's value.
 * @throws {Error} When `work` settles before `signal` resolves.
 */
export async function untilSignalled<T>(
  signal: Promise<T>,
  work: Promise<unknown>,
  label: string
): Promise<T> {
  const settledFirst = (async (): Promise<never> => {
    try {
      await work
    } catch (error) {
      throw new Error(`${label} failed before reaching its seam`, { cause: error })
    }
    throw new Error(`${label} settled before reaching its seam`)
  })()
  return Promise.race([signal, settledFirst])
}
