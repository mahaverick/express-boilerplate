// src/services/redis.service.ts
//
// One shared connection for the process, created lazily. Eager connection at
// import time would make every unit test that transitively imports a
// repository open a socket — and fail on a machine with no Redis running.
// `createRedisClient` builds any extra connection with the same reconnect policy.
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
const state: {
  client: RedisClientType | undefined
  connecting: Promise<RedisClientType> | undefined
  closed: boolean
} = {
  client: undefined,
  connecting: undefined,
  closed: false,
}

const CLOSED_MESSAGE = 'Redis client is closed; the process is shutting down'

/**
 * The pre-ready reconnect policy: a few quick retries, then an `Error` so `connect()` rejects.
 * @param retries - How many reconnect attempts have failed so far.
 * @returns The delay before the next attempt, or the error that stops reconnecting.
 */
function failFastDelay(retries: number): number | Error {
  return retries > 3 ? new Error('Redis unreachable') : Math.min(retries * 100, 1000)
}

/**
 * Create an unconnected client that fails fast before its first 'ready' and retries forever after it.
 * @returns The client; the caller connects it.
 */
export function createRedisClient(): RedisClientType {
  const readiness = { hasBeenReady: false }
  const client: RedisClientType = createClient({
    url: getEnv().REDIS_URL,
    // Commands fail fast while reconnecting; otherwise every caller (health, auth, rate limits) hangs for the outage.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5000,
      // Before the first 'ready', give up fast so boot and /health/ready report
      // unreachable (the default retries forever). After it, retry forever.
      reconnectStrategy: (retries) =>
        readiness.hasBeenReady ? Math.min(retries * 200, 5000) : failFastDelay(retries),
    },
  })
  client.on('error', (error: unknown) => logger.error('Redis error', { error }))
  client.on('ready', () => {
    readiness.hasBeenReady = true
  })
  return client
}

/**
 * Create and connect one client.
 * @returns The connected client.
 */
async function connectRedis(): Promise<RedisClientType> {
  const client = createRedisClient()
  await client.connect()
  return client
}

/**
 * Connect the shared client once, publishing it unless the module closed meanwhile.
 * @returns The connected, shared client.
 * @throws {Error} If `closeRedis()` ran while connecting.
 */
async function connectShared(): Promise<RedisClientType> {
  try {
    const client = await connectRedis()
    if (state.closed) {
      await client.close()
      throw new Error(CLOSED_MESSAGE)
    }
    state.client = client
    return client
  } finally {
    // Cleared on failure too, so the next call retries.
    state.connecting = undefined
  }
}

/**
 * Get the shared Redis client, connecting on first use; concurrent first callers share one connect.
 * @returns A connected client.
 * @throws {Error} If the client has already been closed.
 */
export async function getRedis(): Promise<RedisClientType> {
  if (state.closed) {
    throw new Error(CLOSED_MESSAGE)
  }
  if (state.client) return state.client
  state.connecting ??= connectShared()
  return state.connecting
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

/**
 * Build a Redis key or channel name inside this deployment's namespace.
 * @param parts - The segments after the prefix, e.g. `'denylist', 'session', sid`.
 * @returns REDIS_KEY_PREFIX and the parts, joined with ':'.
 */
export function redisKey(...parts: string[]): string {
  return [getEnv().REDIS_KEY_PREFIX, ...parts].join(':')
}
