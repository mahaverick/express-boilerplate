/**
 * @file The dependency checks behind `GET /health/ready`, each bounded by
 * `READINESS_CHECK_DEADLINE_MS`. A stalled database or queue connection
 * answers nothing and neither driver times the call out, so without a bound
 * the probe would hang. Each check runs at most once at a time: a probe that
 * arrives while one is in flight waits on that one, so a stall holds one pool
 * connection, not one per probe.
 */
import { READINESS_CHECK_DEADLINE_MS } from '@/constants/platform.constants'
import { logger } from '@/services/logger.service'

/**
 * The dependencies readiness checks, in the order the response lists them.
 */
const CHECK_NAMES = ['database', 'redis', 'queue'] as const

/**
 * One of CHECK_NAMES.
 */
type CheckName = (typeof CHECK_NAMES)[number]

/**
 * What a check answers when its deadline passes first.
 */
const TIMED_OUT = Symbol('timed out')

/**
 * One check's state: the run in flight, and whether the last probe timed it out.
 */
interface CheckSlot {
  check: () => Promise<boolean>
  pending: Promise<boolean> | undefined
  isTimingOut: boolean
}

/**
 * What one probe found.
 */
interface ReadinessReport {
  isReady: boolean
  checks: Record<CheckName, boolean>
  timedOut: CheckName[]
}

/**
 * Run a check, or join the run already in flight. The run never rejects: a
 * failure answers false, so a run abandoned at the deadline can't become an
 * unhandled rejection.
 * @param slot - The check's state.
 * @returns Whether the dependency answered.
 */
function runOnce(slot: CheckSlot): Promise<boolean> {
  if (slot.pending) return slot.pending
  const run = (async () => {
    try {
      return await slot.check()
    } catch {
      return false
    }
  })()
  slot.pending = run
  void run.finally(() => {
    if (slot.pending === run) slot.pending = undefined
  })
  return run
}

/**
 * A promise that resolves `TIMED_OUT` once `READINESS_CHECK_DEADLINE_MS` has
 * passed. The verdict waits one more turn of the event loop after the timer,
 * so an answer already in a socket buffer when a blocked process wakes still
 * wins. The timer does not keep the process alive.
 * @returns The deadline, and a function that clears its timer.
 */
function startDeadline(): { expired: Promise<typeof TIMED_OUT>; clear: () => void } {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      setImmediate(() => {
        resolve(TIMED_OUT)
      })
    }, READINESS_CHECK_DEADLINE_MS)
    timer.unref()
  })
  return {
    expired,
    clear: () => {
      clearTimeout(timer)
    },
  }
}

/**
 * Log a check's move into or out of timing out, once per change.
 * @param name - The check.
 * @param slot - Its state.
 * @param hasTimedOut - Whether this probe timed it out.
 */
function noteTimeout(name: CheckName, slot: CheckSlot, hasTimedOut: boolean): void {
  if (hasTimedOut === slot.isTimingOut) return
  slot.isTimingOut = hasTimedOut
  if (hasTimedOut) {
    logger.warn(
      `Readiness check ${name} did not answer in ${String(READINESS_CHECK_DEADLINE_MS)} ms`,
      { check: name, timeoutMs: READINESS_CHECK_DEADLINE_MS }
    )
  } else {
    logger.info(`Readiness check ${name} answers before its deadline again`, { check: name })
  }
}

/**
 * Build the readiness probe over the three dependency checks. Every check
 * runs in parallel; one that has not answered by `READINESS_CHECK_DEADLINE_MS`
 * counts as failed and is named in `timedOut`. A check left running past the
 * deadline is not started again until it settles.
 * @param checks - Answers whether each dependency is reachable; a rejection counts as unreachable.
 * @returns A function that runs one probe and never rejects.
 */
export function createReadinessProbe(
  checks: Record<CheckName, () => Promise<boolean>>
): () => Promise<ReadinessReport> {
  const slots: Record<CheckName, CheckSlot> = {
    database: { check: checks.database, pending: undefined, isTimingOut: false },
    redis: { check: checks.redis, pending: undefined, isTimingOut: false },
    queue: { check: checks.queue, pending: undefined, isTimingOut: false },
  }
  return async () => {
    const deadline = startDeadline()
    try {
      const outcomes = await Promise.all(
        CHECK_NAMES.map(async (name) => Promise.race([runOnce(slots[name]), deadline.expired]))
      )
      const report: ReadinessReport = {
        isReady: true,
        checks: { database: false, redis: false, queue: false },
        timedOut: [],
      }
      for (const [index, name] of CHECK_NAMES.entries()) {
        const outcome = outcomes[index]
        const hasTimedOut = outcome === TIMED_OUT
        noteTimeout(name, slots[name], hasTimedOut)
        if (hasTimedOut) report.timedOut.push(name)
        report.checks[name] = outcome === true
        if (outcome !== true) report.isReady = false
      }
      return report
    } finally {
      deadline.clear()
    }
  }
}
