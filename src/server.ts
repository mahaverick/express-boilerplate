/**
 * @file The HTTP socket and the shutdown sequence.
 */
import { type Server } from 'node:http'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { SERVER_DRAIN_TIMEOUT_MS } from '@/constants/global.constants'
import { shutdownOtel } from '@/observability/tracing'
import { closeDatabase } from '@/services/database.service'
import { closeAllStreams, markShuttingDown } from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import { closeNotificationSubscriber } from '@/services/notification-emitter.service'
import { closeQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import type { SupervisedWorkers } from '@/services/worker-supervisor.service'

/**
 * Start listening.
 *
 * The port is a parameter because `getEnv()` is memoised and already parsed
 * by the time a test runs, so setting `process.env.APP_PORT` would not
 * change it. A bind failure (EADDRINUSE, EACCES) logs one line and sets exit
 * code 1; index.ts owns the exit, since `unicorn/no-process-exit` allows
 * `process.exit` only inside a `process.on` callback.
 * @param port - Port to bind. Defaults to the configured one. Pass 0 to let the
 *   OS pick a free port, which is what makes the lifecycle test safe in parallel.
 * @returns The server, listening once its 'listening' event fires.
 */
export function startServer(port: number = getEnv().APP_PORT): Server {
  // Express 5 calls this on a bind failure too, with the error; the 'error' listener below logs that.
  const server = createApp().listen(port, (error) => {
    if (error === undefined) logger.info(`Listening on :${port}`)
  })
  server.once('error', (error) => {
    if (server.listening) {
      logger.error('Server error', { error })
      return
    }
    logger.error('Server failed to start', { error })
    process.exitCode = 1
  })
  return server
}

/**
 * Stop accepting connections, drain, then close dependencies.
 *
 * Order matters. Readiness flips to 503 first, then open SSE streams are
 * ended, since they would otherwise hold `server.close()` open forever. Then
 * the socket closes, so no new request finds a closed pool. Connections still
 * open after `SERVER_DRAIN_TIMEOUT_MS` are force-closed.
 *
 * The Workers close next, before the shared dependencies, because
 * `Worker#close()` lets the in-flight job finish and that job needs the
 * database and Redis. `workers` is read at shutdown, so Workers replaced
 * after a Redis outage are the ones closed; it is absent on a
 * `WORKER_ENABLED=false` pod. `shutdownOtel()` runs last so it flushes the
 * spans the earlier steps produce. The forced-exit backstop is
 * `createShutdownHandler` (lifecycle.service.ts), so this never calls
 * `process.exit`.
 * @param server - The server returned by `startServer`.
 * @param workers - The supervised Workers, if this process started them (`WORKER_ENABLED`).
 * @returns Resolves once everything is closed.
 */
export async function gracefulShutdown(server: Server, workers?: SupervisedWorkers): Promise<void> {
  markShuttingDown()
  closeAllStreams()
  await closeServer(server)
  await Promise.allSettled(workers ? [workers.close()] : [])
  await Promise.allSettled([
    closeDatabase(),
    closeRedis(),
    closeQueue(),
    closeNotificationSubscriber(),
  ])
  await shutdownOtel()
}

/**
 * Stop accepting connections and wait for open ones, force-closing any left after SERVER_DRAIN_TIMEOUT_MS.
 * @param server - The server to close.
 * @returns Resolves once the server has closed, or immediately if it was not listening.
 */
async function closeServer(server: Server): Promise<void> {
  // Resolves on ERR_SERVER_NOT_RUNNING too, so a second shutdown still completes.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeIdleConnections()
  // An in-flight keep-alive request leaves an idle socket; sweep so the drain ends with it, not at the force-close.
  const sweep = setInterval(() => server.closeIdleConnections(), 250)
  const forceClose = setTimeout(() => server.closeAllConnections(), SERVER_DRAIN_TIMEOUT_MS)
  sweep.unref()
  forceClose.unref()
  await closed
  clearInterval(sweep)
  clearTimeout(forceClose)
}
