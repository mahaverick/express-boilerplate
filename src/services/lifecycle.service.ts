// src/services/lifecycle.service.ts
//
// Process-wide shutdown state, and the registry of open SSE streams: an SSE
// response never ends by itself, so without this `server.close()` never resolves.
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
 * Build the process shutdown handler: the first call runs shutdown and exits; later calls are ignored.
 * @param shutdown - Runs graceful shutdown.
 * @param timeoutMs - Backstop after which the process exits 1 even if shutdown hangs.
 * @returns A handler taking the exit function, and the code to exit with once shutdown succeeds (default 0).
 */
export function createShutdownHandler(
  shutdown: () => Promise<void>,
  timeoutMs: number
): (exit: (code: number) => void, exitCode?: number) => void {
  const guard = { hasStarted: false }
  return (exit, exitCode = 0) => {
    if (guard.hasStarted) return
    guard.hasStarted = true
    const forced = setTimeout(() => exit(1), timeoutMs)
    void (async () => {
      let code = exitCode
      try {
        await shutdown()
      } catch (error) {
        logger.error('Graceful shutdown failed', { error })
        code = 1
      }
      clearTimeout(forced)
      exit(code)
    })()
  }
}
