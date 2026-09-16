// src/services/redis.service.ts
//
// One connection for the process, created lazily. Eager connection at import
// time would make every unit test that transitively imports a repository open
// a socket — and fail on a machine with no Redis running.
import { createClient, type RedisClientType } from 'redis'
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'

// A mutable property on a top-level `const` (rather than a top-level `let`)
// so getRedis()/closeRedis() can share state without either function
// reassigning a top-level binding — that reassignment is what
// unicorn/no-top-level-assignment-in-function forbids; mutating a property
// on an object the module still holds by the same reference is not a
// reassignment and is unaffected by the rule.
//
// `closed` exists because `getRedis()` reconnects lazily: without it, a
// ping issued after `closeRedis()` would silently open a brand-new socket
// and report healthy instead of reporting that the service is shut down.
// Postgres gets this for free — `sql.end()` makes every later query on that
// pool reject — but node-redis's client has no equivalent "permanently
// dead" state of its own, so the module tracks it. Once true it never
// resets: this mirrors a real process, where "closed" means shutting down,
// not "reconnect on demand".
const state: { client: RedisClientType | undefined; closed: boolean } = {
  client: undefined,
  closed: false,
}

/**
 * Get the shared Redis client, connecting on first use.
 * @returns A connected client.
 * @throws {Error} If the client has already been closed.
 */
export async function getRedis(): Promise<RedisClientType> {
  if (state.closed) {
    throw new Error('Redis client is closed; the process is shutting down')
  }
  if (!state.client) {
    const client = createClient({
      url: getEnv().REDIS_URL,
      // node-redis's default reconnectStrategy retries forever and never
      // rejects `connect()` — so with Redis unreachable, `isRedisReachable()`
      // (and therefore `/health/ready`) would hang indefinitely instead of
      // reporting unhealthy. Returning an Error from the strategy after a
      // few attempts is what makes `connect()` actually reject.
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) =>
          retries > 3 ? new Error('Redis unreachable') : Math.min(retries * 100, 1000),
      },
    })
    client.on('error', (error: unknown) => logger.error('Redis error', { error }))
    await client.connect()
    state.client = client
  }
  return state.client
}

/**
 * Check that Redis answers.
 * @returns True when PING succeeds; false once the client has been closed,
 *   without attempting to reconnect.
 */
export async function isRedisReachable(): Promise<boolean> {
  if (state.closed) return false
  try {
    const client = await getRedis()
    const reply = await client.ping()
    return reply === 'PONG'
  } catch {
    return false
  }
}

/**
 * Close the connection. Called by graceful shutdown; safe to call twice.
 * @returns Resolves once closed.
 */
export async function closeRedis(): Promise<void> {
  // Set unconditionally, before the early return below, so a second call —
  // or a first call when no client was ever created — still records that
  // the process is shutting down.
  state.closed = true
  if (!state.client) return
  const current = state.client
  state.client = undefined
  await current.close()
}
