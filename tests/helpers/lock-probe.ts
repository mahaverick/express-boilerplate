// tests/helpers/lock-probe.ts
//
// Detects a row-lock wait without sleeping on a guess: pg_blocking_pids(pid)
// lists the backends a waiting backend is queued behind, which answers both
// 'is this backend waiting' and 'is anything waiting on this one'. The test pool has
// two connections and a race holds both, so each probe opens its own
// single-connection client and closes it before returning.
import { sql as drizzleSql } from 'drizzle-orm'
import postgres from 'postgres'
import { getEnv } from '@/configs/env.config'
import type { DbExecutor } from '@/services/database.service'
import { settle } from './timing'

const POLL_INTERVAL_MS = 10
const DEFAULT_TIMEOUT_MS = 5000
// SQLSTATE query_canceled: what statement_timeout raises.
const QUERY_CANCELED = '57014'

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
 * Run one probe query in its own transaction, under a statement_timeout of the time left.
 * @param probe - The dedicated probe connection.
 * @param isObserved - The probe query.
 * @param remainingMs - Time left before the caller's deadline.
 * @param label - Names the wait in the error.
 * @returns What `isObserved` answered.
 * @throws {Error} When the probe query was cancelled at the deadline.
 */
async function isObservedOnce(
  probe: postgres.Sql,
  isObserved: (probe: postgres.TransactionSql) => Promise<boolean>,
  remainingMs: number,
  label: string
): Promise<boolean> {
  try {
    return await probe.begin(async (tx) => {
      // 0 would mean no limit at all, so never send less than 1 ms.
      await tx`select set_config('statement_timeout', ${String(Math.max(1, remainingMs))}, true)`
      return isObserved(tx)
    })
  } catch (error) {
    if (error instanceof postgres.PostgresError && error.code === QUERY_CANCELED) {
      throw new Error(`${label}: a probe query was still running at the deadline`, {
        cause: error,
      })
    }
    throw error
  }
}

/**
 * When a poll's deadline starts counting.
 */
export interface ProbeClock {
  /**
   * Starts the `timeoutMs` deadline when it resolves; polling runs from the start either way.
   * A rejection leaves the clock unstarted.
   */
  startsOn: Promise<unknown>
  /**
   * The longest whole poll, counted from its start, whether or not the clock has started.
   */
  withinMs: number
}

/**
 * Poll `isObserved` every 10 ms on a dedicated connection until it answers true
 * (true) or `settled` has settled (false). Each probe query runs under a
 * statement_timeout of the time left, so a hung probe fails at the deadline
 * in force when it was issued.
 * @param isObserved - One probe query answering whether the wait is seen.
 * @param settled - The work being watched.
 * @param timeoutMs - The longest wait, counted from the start or, with `clock`, from when it starts (and never past `clock.withinMs`).
 * @param label - Names the wait in the timeout error.
 * @param clock - Starts the deadline late, for work that runs a while before it can wait.
 * @returns True when `isObserved` answered true first.
 * @throws {Error} When neither happens in time, the clock does not start in time, or a probe query is still running at the deadline.
 */
// eslint-disable-next-line unicorn/consistent-boolean-name -- reads as the wait it performs, like the two exports below
export async function pollUntil(
  isObserved: (probe: postgres.TransactionSql) => Promise<boolean>,
  settled: Promise<unknown>,
  timeoutMs: number,
  label: string,
  clock?: ProbeClock
): Promise<boolean> {
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

  // Connecting can't outlast the helper's own timeout either.
  const probe = postgres(getEnv().DATABASE_URL, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
  })
  const pollStart = Date.now()
  const timing = {
    hasStarted: !clock,
    deadline: pollStart + (clock?.withinMs ?? timeoutMs),
    limitMs: clock?.withinMs ?? timeoutMs,
  }
  const startClock = async (startsOn: Promise<unknown>, withinMs: number): Promise<void> => {
    try {
      await startsOn
    } catch {
      // Unstarted, the poll fails at `withinMs`.
      return
    }
    timing.hasStarted = true
    const clockDeadline = Date.now() + timeoutMs
    if (clockDeadline >= pollStart + withinMs) return
    timing.deadline = clockDeadline
    timing.limitMs = timeoutMs
  }
  if (clock) void startClock(clock.startsOn, clock.withinMs)
  try {
    while (Date.now() < timing.deadline) {
      if (await isObservedOnce(probe, isObserved, timing.deadline - Date.now(), label)) return true
      if (hasSettled) return false
      await settle(POLL_INTERVAL_MS, 'poll interval')
    }
    if (!timing.hasStarted) {
      throw new Error(`${label}: the clock did not start within ${timing.limitMs} ms`)
    }
    throw new Error(`${label}: no lock wait and no finish within ${timing.limitMs} ms`)
  } finally {
    await probe.end({ timeout: 5 })
  }
}

/**
 * Poll pg_blocking_pids(pid) until it is non-empty (true) or `settled`
 * has settled (false).
 * @param pid - The backend to watch, from `backendPid`.
 * @param settled - The work running on that backend.
 * @param options - Bounds on the wait.
 * @param options.timeoutMs - The longest wait, in ms (default 5000).
 * @returns True when the backend was seen waiting on a lock.
 * @throws {Error} When neither happens within `timeoutMs`.
 */
// eslint-disable-next-line unicorn/consistent-boolean-name -- reads as the wait it performs, like `await waitForBlocked(pid, work)`
export async function waitForBlocked(
  pid: number,
  settled: Promise<unknown>,
  options: { timeoutMs?: number } = {}
): Promise<boolean> {
  return pollUntil(
    async (probe) => {
      const [row] = await probe<{ blocked: boolean }[]>`
        select cardinality(pg_blocking_pids(${pid}::int)) > 0 as blocked
      `
      return row?.blocked === true
    },
    settled,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    `backend ${pid}`
  )
}

/**
 * Poll until some backend is queued behind `holderPid` (true), or `settled`
 * has settled (false). Use it when the waiting side runs on a connection
 * whose pid the test cannot capture.
 * @param holderPid - The backend holding the lock, from `backendPid`.
 * @param settled - The work expected to queue behind it.
 * @param options - Bounds on the wait.
 * @param options.timeoutMs - The longest wait, in ms (default 5000).
 * @param options.clock - Starts that wait late (see `pollUntil`).
 * @returns True when a backend was seen waiting on the holder.
 * @throws {Error} When neither happens within `timeoutMs`, or the clock does not start in time.
 */
// eslint-disable-next-line unicorn/consistent-boolean-name -- reads as the wait it performs, like `await waitForWaiter(pid, work)`
export async function waitForWaiter(
  holderPid: number,
  settled: Promise<unknown>,
  options: { timeoutMs?: number; clock?: ProbeClock } = {}
): Promise<boolean> {
  return pollUntil(
    async (probe) => {
      const [row] = await probe<{ waiting: boolean }[]>`
        select exists (
          select 1 from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))
        ) as waiting
      `
      return row?.waiting === true
    },
    settled,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    `waiters on backend ${holderPid}`,
    options.clock
  )
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
