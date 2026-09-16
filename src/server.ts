// src/server.ts — owns the socket and the shutdown sequence.
import { type Server } from 'node:http'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { closeDatabase } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { closeRedis } from '@/services/redis.service'

/**
 * Start listening.
 *
 * The port is a parameter, not read straight from the environment, because
 * `getEnv()` memoises: `database.service.ts` calls it at module scope, so
 * importing this module has already frozen the parsed environment before any
 * test body runs. A test that sets `process.env.APP_PORT` and then calls
 * `startServer()` would silently bind the configured port instead of an
 * ephemeral one, and would pass while testing the wrong thing.
 * @param port - Port to bind. Defaults to the configured one. Pass 0 to let the
 *   OS pick a free port, which is what makes the lifecycle test safe in parallel.
 * @returns The listening server.
 */
export function startServer(port: number = getEnv().APP_PORT): Server {
  return createApp().listen(port, () => {
    logger.info(`Listening on :${port}`)
  })
}

/**
 * Stop accepting connections, drain, then close dependencies.
 *
 * Order matters: the socket closes first so no new request can arrive and
 * find a closed pool. `server.close()`'s callback does not fire until every
 * in-flight connection has ended (on Node's HTTP server, closing also stops
 * accepting new connections on idle keep-alive sockets), so by the time
 * `closeDatabase()`/`closeRedis()` run here, no handler is still mid-request.
 *
 * The forced-exit backstop for a connection that never drains is NOT here —
 * `unicorn/no-process-exit` only allows `process.exit()` inside a
 * `process.on`/`process.once` callback, and this function is called directly,
 * not from one. The backstop timer lives in index.ts's signal handler
 * instead, which both satisfies the lint rule and keeps this function fully
 * testable (it can safely resolve without ever touching `process.exit`).
 * @param server - The server returned by `startServer`.
 * @returns Resolves once everything is closed.
 */
export async function gracefulShutdown(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await Promise.allSettled([closeDatabase(), closeRedis()])
}
