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
 * What `answerByDeadline` and the waits built on it answer when Redis has not
 * answered by the deadline.
 */
export const STILL_PENDING = Symbol('still pending')

/**
 * Wait at most `REDIS_REQUEST_DEADLINE_MS` for a Redis call already started.
 *
 * The verdict waits one more turn of the event loop after the timer fires: a
 * process that was blocked past the deadline (a GC pause, CPU throttling)
 * runs its due timers before it reads the sockets, and a reply already sitting
 * in the socket buffer must win over the timer rather than count as a stall.
 * The timer is cleared on every path and does not keep the process alive.
 * @param pending - The call in flight.
 * @returns Its value, or `STILL_PENDING`. Rejects when the call fails first.
 */
async function answerByDeadline<T>(pending: Promise<T>): Promise<T | typeof STILL_PENDING> {
  const race = { settled: false }
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<typeof STILL_PENDING>((resolve) => {
    timer = setTimeout(() => {
      setImmediate(() => {
        if (!race.settled) resolve(STILL_PENDING)
      })
    }, REDIS_REQUEST_DEADLINE_MS)
    timer.unref()
  })
  try {
    // Promise.race subscribes to `pending`, so its failure after the deadline is handled, never an unhandled rejection.
    return await Promise.race([pending, deadline])
  } finally {
    race.settled = true
    clearTimeout(timer)
  }
}

/**
 * Run one request-path Redis call with a deadline of
 * `REDIS_REQUEST_DEADLINE_MS`. Put `getRedis()` inside `operation`, so a
 * connect in flight counts against the deadline too.
 *
 * Inside a cooldown it rejects at once, without calling `operation`. A call
 * that misses the deadline is abandoned (its later outcome is ignored), opens
 * a cooldown of `REDIS_STALL_COOLDOWN_MS` and rejects. A call that fails
 * rejects with its own error and opens nothing.
 * @param operation - Starts the call; not called during a cooldown.
 * @param label - What is being asked, for the warning.
 * @returns The call's result.
 * @throws {RedisStalledError} When the deadline passes or a cooldown is open.
 */
export async function withRedisDeadline<T>(operation: () => Promise<T>, label: string): Promise<T> {
  if (isCoolingDown()) throw new RedisStalledError(label)
  const result = await answerByDeadline(operation())
  if (result === STILL_PENDING) {
    openCooldown(label)
    throw new RedisStalledError(label)
  }
  closeCooldown(label)
  return result
}

/**
 * Wait at most `REDIS_REQUEST_DEADLINE_MS` for a write whose loss would widen
 * access: a session deny, an audit throttle key's release, a maintenance-mode
 * change. Unlike `withRedisDeadline` it never consults or opens the stall
 * cooldown, so the write is always sent; one still in flight at the deadline
 * is left to land when Redis answers, never abandoned, with one `warn`, and
 * `onLateFailure` runs if it then fails. If the connection drops first,
 * node-redis rejects it and the write is lost; `onLateFailure` reports that.
 * @param write - Starts the write, `getRedis()` included.
 * @param label - What is being written, for the warning.
 * @param onLateFailure - Reports a write that fails after the deadline; must not throw.
 * @param context - Extra fields for the warning, such as the session id.
 * @returns The write's value, or `STILL_PENDING`. Rejects when the write fails before the deadline.
 */
export async function waitForRedisWrite<T>(
  write: () => Promise<T>,
  label: string,
  onLateFailure: (error: unknown) => void,
  context: Record<string, unknown> = {}
): Promise<T | typeof STILL_PENDING> {
  const pending = write()
  const result = await answerByDeadline(pending)
  if (result === STILL_PENDING) {
    logger.warn('Redis write not answered in time; it lands when Redis answers', {
      ...context,
      label,
      timeoutMs: REDIS_REQUEST_DEADLINE_MS,
    })
    void watchLateWrite(pending, onLateFailure)
  }
  return result
}

/**
 * Wait for a write left in flight, reporting a failure.
 * @param pending - The write.
 * @param onLateFailure - Reports its failure.
 * @returns Resolves once the write settles; never rejects.
 */
async function watchLateWrite(
  pending: Promise<unknown>,
  onLateFailure: (error: unknown) => void
): Promise<void> {
  try {
    await pending
  } catch (error) {
    onLateFailure(error)
  }
}

/**
 * Wait at most `REDIS_REQUEST_DEADLINE_MS` for a readiness probe. It neither
 * consults nor opens the stall cooldown: a slow probe makes only that probe
 * answer not-ready, and a request's stall does not take the replica out of
 * rotation.
 * @param probe - Starts the probe, `getRedis()` included.
 * @returns The probe's value, or `STILL_PENDING`. Rejects when the probe fails first.
 */
export async function waitForRedisProbe<T>(
  probe: () => Promise<T>
): Promise<T | typeof STILL_PENDING> {
  return answerByDeadline(probe())
}

/**
 * Close any cooldown, for tests only: the state is per process, and one
 * test's stall would otherwise make the next test's Redis calls fail.
 */
export function resetRedisDeadlineForTests(): void {
  state.stalledUntil = undefined
}
