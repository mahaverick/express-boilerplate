/**
 * @file The entrypoint: validates the environment, then boots the server,
 * signal handling and workers. Excluded from coverage as signal wiring;
 * tests/unit/index.test.ts spawns it to prove boot refuses a bad environment.
 */
import { isAnalyticsEnabled, isTimelineEnabled } from '@/configs/analytics.config'
import { assertEnvConsistent } from '@/configs/env-consistency.config'
import { getEnv } from '@/configs/env.config'
import { ERROR_FRAME_LIMIT } from '@/constants/error-tracking.constants'
// Static, unlike `@/server`: constructing the logger is lazy and calls no getEnv().
import { logger } from '@/services/logger.service'
import type { SupervisedWorkers } from '@/services/worker-supervisor.service'

/**
 * Start listening and wire graceful shutdown.
 *
 * `@/server` and the worker supervisor are imported dynamically: `@/server`
 * reaches database.service.ts, which calls `getEnv()` at module scope, so a
 * static import would throw on a bad environment before `main()` could
 * report it, and a static worker import would load BullMQ into processes
 * that never start workers. The forced-exit backstop and the once-only guard
 * live in `createShutdownHandler` (lifecycle.service.ts). `process.exit` is
 * passed in from inside the `process.on` callback, which
 * `unicorn/no-process-exit` requires. Fatal errors (unhandled rejection,
 * uncaught exception, a server 'error' at bind or after listening) go
 * through the same handler with exit code 1. An unhandled rejection or an
 * uncaught exception is first reported to error tracking and logged with
 * the same `errorId`, and the report queue is flushed for at most
 * `ERROR_FATAL_FLUSH_MS` before shutdown begins.
 * @returns Resolves once exit handlers are wired and any workers have started.
 */
async function boot(): Promise<void> {
  const { startServer, gracefulShutdown } = await import('@/server')
  const { createShutdownHandler, isShuttingDown } = await import('@/services/lifecycle.service')
  const { redactedForLog } = await import('@/errors/postgres-errors')
  const { warnIfDeletionsPending } = await import('@/services/analytics/analytics-deletion.service')
  const { ERROR_FATAL_FLUSH_MS } = await import('@/constants/error-tracking.constants')
  const { flushErrorReports, reportError } =
    await import('@/services/errors/error-reporter.service')

  /**
   * Report a process fault, log it with its id, and flush the report queue.
   * @param message - The log line.
   * @param fault - The rejection reason or the thrown value.
   * @returns Resolves once the flush has finished or hit its deadline; never rejects.
   */
  async function recordProcessFault(message: string, fault: unknown): Promise<void> {
    const errorId = reportError(fault, { capturePoint: 'process', handled: false })
    logger.error(message, { error: redactedForLog(fault), errorId })
    await flushErrorReports(ERROR_FATAL_FLUSH_MS)
  }

  // Filled in once the workers start; shutdown reads it only when it runs.
  const workers: { supervised?: SupervisedWorkers } = {}

  // One handler for every exit path; a second call is ignored, and SHUTDOWN_TIMEOUT_MS backstops it.
  const handleShutdown = createShutdownHandler(() => gracefulShutdown(server, workers.supervised))

  const server = startServer()
  // Same tick as listen(), since a bind failure is emitted on nextTick; startServer has logged it.
  server.once('error', () => {
    // eslint-disable-next-line unicorn/no-process-exit -- a server error is fatal; the exit still goes through the shared once-guard
    handleShutdown((code) => process.exit(code), 1)
  })
  // Never rejects: a failed count is logged at warn.
  void warnIfDeletionsPending()

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      handleShutdown((code) => process.exit(code))
    })
  }
  process.on('unhandledRejection', (reason) => {
    void (async () => {
      await recordProcessFault('Unhandled promise rejection', reason)
      handleShutdown((code) => process.exit(code), 1)
    })()
  })
  process.on('uncaughtException', (error) => {
    void (async () => {
      await recordProcessFault('Uncaught exception', error)
      handleShutdown((code) => process.exit(code), 1)
    })()
  })

  if (!getEnv().WORKER_ENABLED) return
  const { startWorkers } = await import('@/services/worker-supervisor.service')
  // Shutdown may have begun during the import above; workers started now would never be closed.
  if (isShuttingDown()) return
  // Throws if a Worker fails to start: boot() rejects, and the unhandledRejection handler exits 1.
  workers.supervised = startWorkers()
  logger.info(
    isAnalyticsEnabled() || isTimelineEnabled()
      ? 'Workers started (email, notification, maintenance, analytics)'
      : 'Workers started (email, notification, maintenance)'
  )
}

/**
 * Validate the environment and its cross-field rules, then hand off to `boot()`.
 * First it raises V8's stack depth (10 frames by default) to the frames
 * error tracking keeps, so a reported stack is not cut at 10.
 */
function main(): void {
  // eslint-disable-next-line unicorn/no-nonstandard-builtin-properties -- V8's stack depth; Node runs only on V8
  Error.stackTraceLimit = ERROR_FRAME_LIMIT
  try {
    assertEnvConsistent(getEnv(), process.env, (message) => {
      logger.warn(message)
    })
  } catch (error) {
    // One readable list, then exit. Not a stack trace from inside a dependency.
    console.error((error as Error).message)
    process.exitCode = 1
    return
  }

  void boot()
}

main()
