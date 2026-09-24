// src/services/queue.service.ts
//
// The one place anything in this codebase creates a BullMQ Queue or the
// ioredis connections it runs over. Deliberately separate from
// redis.service.ts: that module wraps `redis` (node-redis), BullMQ requires
// `ioredis`, and the two client libraries cannot share a connection — this
// module owns its own, lazily, the same way getEnv()/getRedis() do.
//
// Two connections: Workers need the offline queue (`maxRetriesPerRequest:
// null`) to ride out an outage, but a producer on that connection would hold
// its HTTP caller until Redis returned. Producers get their own connection
// with the offline queue off, so an enqueue during an outage rejects at once.
import { Queue, type Job, type JobsOptions } from 'bullmq'
import IORedis, { type RedisOptions } from 'ioredis'
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'

// Same shape/reasoning as redis.service.ts's own `state`: a mutable property
// on a top-level `const` rather than several top-level `let`s, so every
// function below shares state without any of them reassigning a top-level
// binding (which unicorn/no-top-level-assignment-in-function forbids).
//
// `closed` mirrors redis.service.ts's own flag: once `closeQueue()` runs,
// later calls must report unreachable/refuse to enqueue rather than silently
// opening a brand-new connection during shutdown.
const state: {
  connection: IORedis | undefined
  hasBeenReady: boolean
  producerConnection: IORedis | undefined
  emailQueue: Queue | undefined
  notificationQueue: Queue | undefined
  closed: boolean
} = {
  connection: undefined,
  hasBeenReady: false,
  producerConnection: undefined,
  emailQueue: undefined,
  notificationQueue: undefined,
  closed: false,
}

/**
 * Create one ioredis connection that fails fast before its first 'ready' and retries forever after it.
 * @param label - Names the connection in its error log.
 * @param options - Options on top of the shared URL, timeout and retry strategy.
 * @param onReady - Called on every 'ready'.
 * @returns The connection, already connecting.
 */
function createQueueRedis(
  label: string,
  options: Pick<RedisOptions, 'maxRetriesPerRequest' | 'enableOfflineQueue'>,
  onReady: () => void
): IORedis {
  const readiness = { hasBeenReady: false }
  const connection = new IORedis(getEnv().REDIS_URL, {
    ...options,
    // Before the first 'ready', stop after three retries so isQueueReachable()
    // fails fast; after it, retry forever so BullMQ survives a Redis outage.
    // `undefined` stops reconnecting: ioredis only checks `typeof retryDelay !== 'number'`.
    retryStrategy: (times) => {
      if (readiness.hasBeenReady) return Math.min(times * 200, 5000)
      return times > 3 ? undefined : Math.min(times * 200, 2000)
    },
    connectTimeout: 5000,
  })
  connection.on('ready', () => {
    readiness.hasBeenReady = true
    onReady()
  })
  // Mandatory: an unlistened 'error' event on an EventEmitter crashes the
  // Node.js process. ioredis emits 'error' for every failed connection
  // attempt, not just fatal ones, so this must never be removed.
  connection.on('error', (error: unknown) => {
    logger.error(`${label} error`, { error })
  })
  return connection
}

/**
 * Get the shared ioredis connection BullMQ Workers run on, connecting on first use.
 *
 * Separate from redis.service.ts's node-redis client — different libraries,
 * cannot share. BullMQ requires `maxRetriesPerRequest: null` on a Worker's
 * connection (it manages its own retry/blocking semantics). Queue producers
 * use `getProducerConnection()` instead.
 * @returns The shared Worker connection.
 * @throws {Error} If the connection has already been closed.
 */
export function getQueueConnection(): IORedis {
  if (state.closed) {
    throw new Error('Queue connection is closed; the process is shutting down')
  }
  state.connection ??= createQueueRedis(
    'BullMQ Redis connection',
    {
      // BullMQ requires this to be exactly `null`, not merely absent —
      // verified empirically against the installed ioredis: its own option
      // merging (lodash.defaults) treats an explicit `undefined` as "unset"
      // and silently re-applies its own default of 20, which is exactly the
      // "You are using a non-supported version of Redis" failure this
      // setting exists to prevent. `null`, unlike `undefined`, survives that
      // merge untouched.
      // eslint-disable-next-line unicorn/no-null -- see comment above; undefined does not have the same effect here
      maxRetriesPerRequest: null,
    },
    () => {
      state.hasBeenReady = true
    }
  )
  return state.connection
}

/**
 * Get the ioredis connection Queue producers share, connecting on first use.
 * @returns The shared producer connection.
 * @throws {Error} If the connection has already been closed.
 */
function getProducerConnection(): IORedis {
  if (state.closed) {
    throw new Error('Queue connection is closed; the process is shutting down')
  }
  // No offline queue: while disconnected, an enqueue rejects instead of waiting for Redis.
  state.producerConnection ??= createQueueRedis(
    'BullMQ producer Redis connection',
    { enableOfflineQueue: false },
    () => {}
  )
  return state.producerConnection
}

/**
 * Get the shared "email" queue, creating it on first use.
 * @returns The email queue.
 */
export function getEmailQueue(): Queue {
  if (!state.emailQueue) {
    state.emailQueue = new Queue('email', {
      connection: getProducerConnection(),
      prefix: getEnv().QUEUE_PREFIX,
    })
    state.emailQueue.on('error', (error: unknown) => {
      logger.error('Email queue error', { error })
    })
  }
  return state.emailQueue
}

/**
 * Get the shared "notification" queue, creating it on first use. Same
 * lazy-singleton shape as `getEmailQueue()` — a separate BullMQ Queue,
 * over the same producer connection.
 * @returns The notification queue.
 */
export function getNotificationQueue(): Queue {
  if (!state.notificationQueue) {
    state.notificationQueue = new Queue('notification', {
      connection: getProducerConnection(),
      prefix: getEnv().QUEUE_PREFIX,
    })
    state.notificationQueue.on('error', (error: unknown) => {
      logger.error('Notification queue error', { error })
    })
  }
  return state.notificationQueue
}

/**
 * Enqueue a job. A thin, generically-typed wrapper over `Queue#add` so
 * callers depend on this module's surface rather than importing BullMQ's
 * `Queue` type directly everywhere a job is enqueued.
 * @param queue - The BullMQ queue to enqueue onto, e.g. `getEmailQueue()`.
 * @param jobName - The job's name, read by whichever worker processes this queue.
 * @param data - The job's payload.
 * @param options - BullMQ job options (priority, delay, attempts, ...).
 * @returns The created job.
 */
export async function addJob<T extends object>(
  queue: Queue,
  jobName: string,
  data: T,
  options?: JobsOptions
): Promise<Job<T>> {
  // Explicit assertion, not an implicit any-return: `queue: Queue` (BullMQ's
  // own default type parameters) makes `queue.add()`'s return type
  // `Promise<Job<any, ...>>`, and bullmq's own `ExtractDataType<T, T>`
  // conditional type (queue.d.ts) does not simplify back to `T` for an
  // unresolved generic — typing this parameter `Queue<T>` instead trips
  // exactOptionalPropertyTypes over that same unresolved conditional. An
  // explicit assertion says plainly what both attempts could only imply:
  // the caller's own `T` is what this queue actually stores.
  return queue.add(jobName, data, options) as Promise<Job<T>>
}

/**
 * Check that the Worker connection answers.
 * @returns True when PING succeeds; false once closed or unreachable, without
 *   hanging: before the first 'ready' the connect gives up after a few retries,
 *   and after it any status other than 'ready' is reported at once.
 */
export async function isQueueReachable(): Promise<boolean> {
  if (state.closed) return false
  try {
    const connection = getQueueConnection()
    // BullMQ needs the offline queue, so a ping while not ready would wait out the whole outage.
    if (state.hasBeenReady && connection.status !== 'ready') return false
    const reply = await connection.ping()
    return reply === 'PONG'
  } catch {
    return false
  }
}

/**
 * Close every queue and both connections without waiting on Redis. Called by
 * graceful shutdown; safe to call twice.
 * @returns Resolves once everything is closed.
 */
export async function closeQueue(): Promise<void> {
  // Set unconditionally, before either close below, so a second call — or a
  // first call when nothing was ever created — still records shutdown.
  state.closed = true
  if (state.emailQueue) {
    const emailQueue = state.emailQueue
    state.emailQueue = undefined
    // Does NOT touch the producer connection — verified empirically (and
    // against node_modules/bullmq/dist/cjs/utils/create-backend.js's
    // `shared: isRedisInstance(opts.connection)`): BullMQ marks a Queue
    // built from an already-constructed ioredis INSTANCE (as opposed to
    // connection options) as using a "shared" connection, and its own
    // RedisConnection#close() skips quitting/disconnecting whenever
    // `shared` is true. So the producer connection outlives this call and
    // is ended below, once, for both queues.
    await emailQueue.close()
  }
  if (state.notificationQueue) {
    const notificationQueue = state.notificationQueue
    state.notificationQueue = undefined
    // Same "shared connection" reasoning as the emailQueue.close() call
    // above — this queue was also built from the already-constructed
    // ioredis instance, so this does not touch the producer connection either.
    await notificationQueue.close()
  }
  const connections = [state.connection, state.producerConnection]
  state.connection = undefined
  state.producerConnection = undefined
  await Promise.all(connections.map((connection) => endConnection(connection)))
}

/**
 * End one connection without waiting on Redis: `quit()` when ready, `disconnect()` otherwise.
 * @param connection - The connection to end, if it was ever created.
 * @returns Resolves once the connection is ended.
 */
async function endConnection(connection: IORedis | undefined): Promise<void> {
  if (!connection) return
  // quit() is a command: while not ready it would queue behind the offline
  // queue until Redis returned. disconnect() fails pending commands instead.
  // A connection already in 'end' also rejects quit(), so it takes this path too.
  if (connection.status === 'ready') {
    await connection.quit()
  } else {
    connection.disconnect()
  }
}
