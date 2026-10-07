/**
 * @file Process-wide shutdown state, and the registry of open SSE streams: an SSE
 * response never ends by itself, so without this `server.close()` never resolves.
 */
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'

const state: { isShuttingDown: boolean; streams: Map<string, Set<() => void>> } = {
  isShuttingDown: false,
  streams: new Map(),
}

/**
 * Whether graceful shutdown has begun.
 * @returns True once `markShuttingDown` has run.
 */
export function isShuttingDown(): boolean {
  return state.isShuttingDown
}

/**
 * Record that graceful shutdown has begun. Idempotent.
 */
export function markShuttingDown(): void {
  state.isShuttingDown = true
}

/**
 * Register an open stream's closer so shutdown can end it.
 * @param userId - The user the stream belongs to.
 * @param close - Ends the stream.
 * @returns A function that unregisters the stream; safe to call more than once.
 */
export function registerStream(userId: string, close: () => void): () => void {
  const closers = state.streams.get(userId) ?? new Set<() => void>()
  closers.add(close)
  state.streams.set(userId, closers)
  return () => {
    closers.delete(close)
    if (closers.size === 0 && state.streams.get(userId) === closers) {
      state.streams.delete(userId)
    }
  }
}

/**
 * How many streams one user currently has open.
 * @param userId - The user to count.
 * @returns The number of registered streams for that user.
 */
export function countStreams(userId: string): number {
  return state.streams.get(userId)?.size ?? 0
}

/**
 * How many streams are open in this process, across every user: the count
 * `SSE_MAX_STREAMS_TOTAL` caps.
 * @returns The number of registered streams.
 */
export function countAllStreams(): number {
  let total = 0
  for (const closers of state.streams.values()) total += closers.size
  return total
}

/**
 * End every registered stream and empty the registry.
 */
export function closeAllStreams(): void {
  // Snapshot and clear first, so a late 'close' handler's unregister is a no-op.
  const closers = Array.from(state.streams.values(), (set) => [...set]).flat()
  state.streams.clear()
  for (const close of closers) {
    try {
      close()
    } catch (error) {
      logger.error('Failed to close a notification stream', { error })
    }
  }
}

/**
 * Reset shutdown state and the stream registry, for tests only.
 */
export function resetLifecycleForTests(): void {
  state.isShuttingDown = false
  state.streams.clear()
}

/**
 * Build the process shutdown handler: the first call runs shutdown and exits;
 * a later call starts nothing, but raises the exit code to its own when
 * higher, so a fault during a signal-started shutdown still exits 1.
 * @param shutdown - Runs graceful shutdown.
 * @param timeoutMs - Backstop after which the process exits 1 even if shutdown hangs. Defaults to `SHUTDOWN_TIMEOUT_MS`.
 * @returns A handler taking the exit function, and the code to exit with once shutdown succeeds (default 0).
 */
export function createShutdownHandler(
  shutdown: () => Promise<void>,
  timeoutMs: number = getEnv().SHUTDOWN_TIMEOUT_MS
): (exit: (code: number) => void, exitCode?: number) => void {
  const guard = { hasStarted: false, exitCode: 0 }
  return (exit, exitCode = 0) => {
    guard.exitCode = Math.max(guard.exitCode, exitCode)
    if (guard.hasStarted) return
    guard.hasStarted = true
    const forced = setTimeout(() => exit(1), timeoutMs)
    void (async () => {
      try {
        await shutdown()
      } catch (error) {
        logger.error('Graceful shutdown failed', { error })
        guard.exitCode = 1
      }
      clearTimeout(forced)
      exit(guard.exitCode)
    })()
  }
}

/**
 * Build the process-fault handlers. A fault (an unhandled rejection or an
 * uncaught exception) marks shutdown first, so readiness answers 503 while
 * the fault is recorded and flushed, then shuts down with exit code 1 even
 * if recording rejects. A signal shuts down with 0, or with 1 once a fault
 * has begun, so a SIGTERM that arrives during the fatal flush still exits 1.
 * @param record - Reports, logs and flushes one fault.
 * @param shutdown - Begins shutdown with an exit code (the once-only handler).
 * @returns `onFault`, which resolves or rejects as `record` did once shutdown has begun, and `onSignal`.
 */
export function createProcessFaultHandler(
  record: (message: string, fault: unknown) => Promise<void>,
  shutdown: (exitCode: number) => void
): {
  onFault: (message: string, fault: unknown) => Promise<void>
  onSignal: () => void
} {
  const fault = { hasFaulted: false }
  return {
    onFault: async (message, error) => {
      markShuttingDown()
      fault.hasFaulted = true
      try {
        await record(message, error)
      } finally {
        shutdown(1)
      }
    },
    onSignal: () => {
      shutdown(fault.hasFaulted ? 1 : 0)
    },
  }
}
