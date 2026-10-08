/**
 * @file One shared node-redis connection for the process, created lazily so that
 * importing this module opens no socket. `createRedisClient` builds any extra
 * connection with the same reconnect policy.
 */
import { createClient, type RedisClientType } from 'redis'
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { waitForRedisProbe } from '@/services/redis-deadline.service'

/**
 * Module state in one object, so no function reassigns a top-level binding.
 * `closed` is set by `closeRedis()` and never resets: node-redis has no
 * permanently-closed state, and without it `getRedis()` would open a new
 * socket after shutdown and report healthy.
 */
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
 * How long each Redis client here waits for one connection attempt to
 * establish, and how long `getRedis()` waits for the shared client's whole
 * connect, handshake included.
 */
export const REDIS_CONNECT_TIMEOUT_MS = 5000

/**
 * The longest a client here waits between reconnect attempts once it has been ready.
 */
export const RECONNECT_DELAY_CAP_MS = 5000

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
 * Giving up before 'ready' lets boot and `/health/ready` report unreachable;
 * node-redis's default retries forever.
 * @returns The client; the caller connects it.
 */
export function createRedisClient(): RedisClientType {
  const readiness = { hasBeenReady: false }
  const client: RedisClientType = createClient({
    url: getEnv().REDIS_URL,
    // Commands fail fast while reconnecting; otherwise every caller (health, auth, rate limits) hangs for the outage.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) =>
        readiness.hasBeenReady
          ? Math.min(retries * 200, RECONNECT_DELAY_CAP_MS)
          : failFastDelay(retries),
    },
  })
  client.on('error', (error: unknown) => logger.error('Redis error', { error }))
  client.on('ready', () => {
    readiness.hasBeenReady = true
  })
  return client
}

/**
 * Create and connect one client, giving up after `REDIS_CONNECT_TIMEOUT_MS`.
 * node-redis's `connectTimeout` stops at the TCP connect; the handshake after
 * it (HELLO, CLIENT SETINFO) has no timer and raises no error, so a server
 * that accepts and never answers would leave `connect()` pending forever. A
 * client that runs out of time is destroyed, closing its socket.
 * @returns The connected client.
 * @throws {Error} When the connect fails or runs out of time.
 */
async function connectRedis(): Promise<RedisClientType> {
  const client = createRedisClient()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), REDIS_CONNECT_TIMEOUT_MS)
    timer.unref()
  })
  try {
    // Promise.race subscribes to connect(), so its rejection after a destroy is handled.
    const outcome = await Promise.race([client.connect(), timeout])
    if (outcome === 'timed-out') {
      client.destroy()
      throw new Error(`Redis did not finish connecting in ${String(REDIS_CONNECT_TIMEOUT_MS)} ms`)
    }
    return client
  } finally {
    clearTimeout(timer)
  }
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
 *   without attempting to reconnect, and false when the connect and PING
 *   together miss `REDIS_REQUEST_DEADLINE_MS` (`waitForRedisProbe`, which
 *   neither consults nor opens the request-path stall cooldown).
 */
export async function isRedisReachable(): Promise<boolean> {
  if (state.closed) return false
  try {
    const reply = await waitForRedisProbe(async () => {
      const client = await getRedis()
      return client.ping()
    })
    return reply === 'PONG'
  } catch {
    return false
  }
}

/**
 * Close the connection. Called by graceful shutdown; safe to call twice.
 * `closed` is set first, so shutdown is recorded even when no client was created.
 * @returns Resolves once closed.
 */
export async function closeRedis(): Promise<void> {
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
