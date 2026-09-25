// src/index.ts — entrypoint. Fails fast on a bad environment.
//
// Excluded from coverage (vitest.config.ts): this file is signal wiring —
// process.exit, process.on(SIGTERM/SIGINT) — which is not meaningfully unit
// testable. tests/unit/index.test.ts spawns it to prove boot refuses a bad
// environment.
import { assertEnvConsistent } from '@/configs/env-consistency.config'
import { getEnv } from '@/configs/env.config'
// Static, unlike `@/server` below: constructing the logger is lazy, so this
// import calls no getEnv(). It does load env.config, which runs dotenv.
// main() needs it for boot-check warnings.
import { logger } from '@/services/logger.service'
import type { SupervisedWorkers } from '@/services/worker-supervisor.service'

/**
 * Start listening and wire graceful shutdown.
 *
 * The forced-exit backstop and the once-only guard live in
 * `createShutdownHandler` (lifecycle.service.ts). `process.exit` is passed in
 * from inside the `process.on` callback, which `unicorn/no-process-exit` requires.
 * Fatal errors (unhandled rejection, uncaught exception, a server 'error'
 * at bind or after listening) go through the same handler with exit code 1.
 * @returns Resolves once exit handlers are wired and any workers have started.
 */
async function boot(): Promise<void> {
  // `@/server` is imported dynamically, only after `main()` has already
  // validated the environment once. `@/server` -> `@/app` ->
  // `@/services/database.service` calls getEnv() again at MODULE SCOPE
  // (needed there to configure the postgres client) — a static import at the
  // top of this file would load that whole chain during this module's own
  // import phase, before `main()`'s try/catch ever ran (ES module imports
  // always evaluate before the importing module's body does). A bad
  // environment would then surface as an uncaught exception and a raw stack
  // trace from inside database.service.ts — exactly what `main()` exists to
  // avoid. getEnv() is memoised, so the second call this triggers is free.
  const { startServer, gracefulShutdown } = await import('@/server')
  const { createShutdownHandler, isShuttingDown } = await import('@/services/lifecycle.service')
  const { redactedForLog } = await import('@/errors/postgres-errors')

  // Filled in once the workers start; shutdown reads it only when it runs.
  const workers: { supervised?: SupervisedWorkers } = {}

  // One handler for every exit path: signals, fatal errors and a server
  // 'error'. A second call while shutdown runs is ignored. Its backstop is
  // SHUTDOWN_TIMEOUT_MS.
  const handleShutdown = createShutdownHandler(() => gracefulShutdown(server, workers.supervised))

  const server = startServer()
  // Same tick as listen(): a bind failure is emitted on nextTick. This also
  // catches a server error after listening; startServer has logged either.
  server.once('error', () => {
    // eslint-disable-next-line unicorn/no-process-exit -- a server error is fatal; the exit still goes through the shared once-guard
    handleShutdown((code) => process.exit(code), 1)
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      handleShutdown((code) => process.exit(code))
    })
  }
  // The logger has no `fatal`; error is its highest level.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: redactedForLog(reason) })
    handleShutdown((code) => process.exit(code), 1)
  })
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: redactedForLog(error) })
    handleShutdown((code) => process.exit(code), 1)
  })

  // Dynamic, same reasoning as `@/server` above and for the same effect:
  // `@/services/worker-supervisor.service` -> the email/notification workers ->
  // `@/services/queue.service` opens no connection at import time (lazy,
  // like every other service here), but a STATIC import would still pull
  // the whole `bullmq`/`ioredis` module graph into every process that
  // imports index.ts's module scope — including
  // tests/integration/server.test.ts's `startServer(0)` lifecycle test,
  // which never sets WORKER_ENABLED and has no business loading BullMQ at
  // all. Gating the import itself, not just the call, is what keeps that
  // test free of it.
  if (!getEnv().WORKER_ENABLED) return
  const { startWorkers } = await import('@/services/worker-supervisor.service')
  // Shutdown may have begun during the import above; workers started now would never be closed.
  if (isShuttingDown()) return
  // Throws if a Worker fails to start: boot() rejects, and the unhandledRejection handler exits 1.
  workers.supervised = startWorkers()
  logger.info('Workers started (email + notification)')
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
