// src/index.ts — entrypoint. Fails fast on a bad environment.
//
// Excluded from coverage (vitest.config.ts): this file is signal wiring —
// process.exit, process.on(SIGTERM/SIGINT) — which is not meaningfully unit
// testable, and it is exercised for real by the boot check in the task brief.
import type { Worker } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import { GRACEFUL_SHUTDOWN_TIMEOUT_MS } from '@/constants/global.constants'

/**
 * Start listening and wire graceful shutdown.
 *
 * The forced-exit backstop lives in the signal handler below, not inside
 * `gracefulShutdown` itself: `unicorn/no-process-exit` only allows
 * `process.exit()` inside a `process.on`/`process.once` callback, which this
 * is and a plain exported function is not. Putting the backstop here also
 * keeps `server.ts` free of `process.exit`, so its whole lifecycle is
 * testable without ever needing to fork a process.
 * @returns Resolves once the server is listening and signal handlers are wired.
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
  const server = startServer()

  // Dynamic, same reasoning as `@/server` above and for the same effect:
  // `@/workers/email.worker` -> `@/services/queue.service` opens no
  // connection at import time (lazy, like every other service here), but a
  // STATIC import would still pull the whole `bullmq`/`ioredis` module graph
  // into every process that imports index.ts's module scope — including
  // tests/integration/server.test.ts's `startServer(0)` lifecycle test,
  // which never sets WORKER_ENABLED and has no business loading BullMQ at
  // all. Gating the import itself, not just the call, is what keeps that
  // test free of it.
  let worker: Worker | undefined
  if (getEnv().WORKER_ENABLED) {
    const { startEmailWorker } = await import('@/workers/email.worker')
    worker = startEmailWorker()
    // logger is available here — getEnv() already succeeded in main().
    const { logger } = await import('@/services/logger.service')
    logger.info('Email worker started')
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      const forced = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_TIMEOUT_MS)
      void gracefulShutdown(server, worker).then(() => {
        clearTimeout(forced)
        process.exit(0)
      })
    })
  }
}

/**
 * Validate the environment, then hand off to `boot()`.
 */
function main(): void {
  try {
    getEnv()
  } catch (error) {
    // One readable list, then exit. Not a stack trace from inside a dependency.
    console.error((error as Error).message)
    process.exitCode = 1
    return
  }

  void boot()
}

main()
