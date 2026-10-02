/**
 * @file The entrypoint: validates the environment, then boots the server,
 * signal handling and workers. Excluded from coverage as signal wiring;
 * tests/unit/index.test.ts spawns it to prove boot refuses a bad environment.
 */
import { isAnalyticsEnabled } from '@/configs/analytics.config'
import { assertEnvConsistent } from '@/configs/env-consistency.config'
import { getEnv } from '@/configs/env.config'
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
 * through the same handler with exit code 1.
 * @returns Resolves once exit handlers are wired and any workers have started.
 */
async function boot(): Promise<void> {
  const { startServer, gracefulShutdown } = await import('@/server')
  const { createShutdownHandler, isShuttingDown } = await import('@/services/lifecycle.service')
  const { redactedForLog } = await import('@/errors/postgres-errors')

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

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      handleShutdown((code) => process.exit(code))
    })
  }
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: redactedForLog(reason) })
    handleShutdown((code) => process.exit(code), 1)
  })
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: redactedForLog(error) })
    handleShutdown((code) => process.exit(code), 1)
  })

  if (!getEnv().WORKER_ENABLED) return
  const { startWorkers } = await import('@/services/worker-supervisor.service')
  // Shutdown may have begun during the import above; workers started now would never be closed.
  if (isShuttingDown()) return
  // Throws if a Worker fails to start: boot() rejects, and the unhandledRejection handler exits 1.
  workers.supervised = startWorkers()
  logger.info(
    isAnalyticsEnabled()
      ? 'Workers started (email, notification, maintenance, analytics)'
      : 'Workers started (email, notification, maintenance)'
  )
}

/**
 * Validate the environment and its cross-field rules, then hand off to `boot()`.
 */
function main(): void {
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
