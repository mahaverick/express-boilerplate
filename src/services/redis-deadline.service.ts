/**
 * @file The deadline on a request-path Redis call, and the cooldown after a
 * stall. node-redis rejects at once while it reconnects
 * (`disableOfflineQueue`), but once a command is written it never times it
 * out: a server that is connected and does not answer would hold every
 * request that touches it. Each caller already handles a Redis failure, so
 * this only turns a stall into a failure. Its own module, not
 * redis.service.ts, so a test that replaces that module whole keeps it.
 */
import { REDIS_REQUEST_DEADLINE_MS, REDIS_STALL_COOLDOWN_MS } from '@/constants/platform.constants'
import { RedisStalledError } from '@/errors/redis-errors'
import { logger } from '@/services/logger.service'

/**
 * Per process. `stalledUntil` is when the current cooldown ends; it stays
 * set after that, until a call succeeds, so the recovery is logged once.
 */
const state: { stalledUntil: number | undefined } = { stalledUntil: undefined }

/**
 * Whether a cooldown is open now.
 * @returns True until `stalledUntil` passes.
 */
function isCoolingDown(): boolean {
  return state.stalledUntil !== undefined && Date.now() < state.stalledUntil
}

/**
 * Open a cooldown after a missed deadline, warning once per opening: a call
 * that misses the deadline while one is already open changes nothing.
 * @param label - What the call that missed it was asking for.
 */
function openCooldown(label: string): void {
  if (isCoolingDown()) return
  state.stalledUntil = Date.now() + REDIS_STALL_COOLDOWN_MS
  logger.warn(
    `Redis did not answer in ${String(REDIS_REQUEST_DEADLINE_MS)} ms; request-path Redis calls fail at once for ${String(REDIS_STALL_COOLDOWN_MS)} ms`,
    { label, timeoutMs: REDIS_REQUEST_DEADLINE_MS, cooldownMs: REDIS_STALL_COOLDOWN_MS }
  )
}

/**
 * Close a cooldown that has run out, on the first call that succeeds after
 * it, logging the recovery once. A success while one is open (a call that
 * started before it opened) leaves it open.
 * @param label - What the call that succeeded was asking for.
 */
function closeCooldown(label: string): void {
  if (state.stalledUntil === undefined || isCoolingDown()) return
  state.stalledUntil = undefined
  logger.info('Redis recovered after a stall; request-path Redis calls use it again', { label })
}

/**
 * Run one request-path Redis call with a deadline of
 * `REDIS_REQUEST_DEADLINE_MS`.
 *
 * Inside a cooldown it rejects at once, without calling `operation`. A call
 * that misses the deadline is abandoned (its later outcome is ignored), opens
 * a cooldown of `REDIS_STALL_COOLDOWN_MS` and rejects. A call that fails
 * rejects with its own error and opens nothing. The timer is cleared on every
 * path and does not keep the process alive.
 * @param operation - Starts the call; not called during a cooldown.
 * @param label - What is being asked, for the warning.
 * @returns The call's result.
 * @throws {RedisStalledError} When the deadline passes or a cooldown is open.
 */
export async function withRedisDeadline<T>(operation: () => Promise<T>, label: string): Promise<T> {
  if (isCoolingDown()) throw new RedisStalledError(label)
  // Promise.race subscribes to it, so its failure after the deadline is handled, never an unhandled rejection.
  const pending = operation()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      openCooldown(label)
      reject(new RedisStalledError(label))
    }, REDIS_REQUEST_DEADLINE_MS)
    timer.unref()
  })
  try {
    const result = await Promise.race([pending, deadline])
    closeCooldown(label)
    return result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What `waitForRedisWrite` answers when the write has not settled by the deadline.
 */
export const STILL_PENDING = Symbol('still pending')

/**
 * Wait at most `REDIS_REQUEST_DEADLINE_MS` for a write whose loss would widen
 * access, such as a session deny. It is not `withRedisDeadline`: it never
 * consults or opens the stall cooldown, so a deny is always sent, and a
 * write still in flight at the deadline is left to land when Redis answers,
 * never abandoned. The caller logs that and watches the write's outcome. The
 * timer is cleared on every path and does not keep the process alive.
 * @param write - The write, already sent.
 * @returns Its value, or `STILL_PENDING` at the deadline. Rejects when the write fails first.
 */
export async function waitForRedisWrite<T>(write: Promise<T>): Promise<T | typeof STILL_PENDING> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<typeof STILL_PENDING>((resolve) => {
    timer = setTimeout(() => resolve(STILL_PENDING), REDIS_REQUEST_DEADLINE_MS)
    timer.unref()
  })
  try {
    return await Promise.race([write, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Close any cooldown, for tests only: the state is per process, and one
 * test's stall would otherwise make the next test's Redis calls fail.
 */
export function resetRedisDeadlineForTests(): void {
  state.stalledUntil = undefined
}
