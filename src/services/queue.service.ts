/**
 * @file The one place that creates a BullMQ Queue or the ioredis connections it
 * runs over, lazily. Workers and producers get separate connections: Workers need
 * the offline queue to ride out an outage, while a producer with it off rejects
 * an enqueue at once instead of holding its HTTP caller until Redis returns.
 */
import { Queue, type Job, type JobsOptions } from 'bullmq'
import IORedis, { type RedisOptions } from 'ioredis'
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import {
  RECONNECT_DELAY_CAP_MS,
  REDIS_CONNECT_TIMEOUT_MS,
  redisKey,
} from '@/services/redis.service'

/**
 * One ioredis connection and whether it has ever reached 'ready'.
 */
interface QueueRedis {
  connection: IORedis
  readiness: { hasBeenReady: boolean }
}

/**
 * Module state in one object, so no function reassigns a top-level binding.
 * Once `closed` is set by `closeQueue()`, later calls report unreachable or
 * refuse to enqueue instead of opening a new connection during shutdown.
 */
const state: {
  worker: QueueRedis | undefined
  producer: QueueRedis | undefined
  emailQueue: Queue | undefined
  notificationQueue: Queue | undefined
  maintenanceQueue: Queue | undefined
  closed: boolean
  workerConnectionLost: Set<(dead: IORedis) => void>
  haveWorkersFailed: boolean
} = {
  worker: undefined,
  producer: undefined,
  emailQueue: undefined,
  notificationQueue: undefined,
  maintenanceQueue: undefined,
  closed: false,
  workerConnectionLost: new Set(),
  haveWorkersFailed: false,
}

/**
 * Create one ioredis connection that fails fast before its first 'ready' and retries forever after it.
 * Before 'ready' it stops after three retries, so `isQueueReachable()` answers
 * quickly; after it, retrying forever lets BullMQ survive a Redis outage.
 * @param label - Names the connection in its logs.
 * @param options - Options on top of the shared URL, timeout and retry strategy.
 * @param onDeadBeforeReady - Called when the connection gives up without ever being ready, unless the module is closed.
 * @returns The connection, already connecting, and its readiness.
 */
function createQueueRedis(
  label: string,
  options: Pick<RedisOptions, 'maxRetriesPerRequest' | 'enableOfflineQueue'>,
  onDeadBeforeReady: (dead: IORedis) => void
): QueueRedis {
  const readiness = { hasBeenReady: false }
  const connection = new IORedis(getEnv().REDIS_URL, {
    ...options,
    // `undefined` stops reconnecting: ioredis only checks `typeof retryDelay !== 'number'`.
    retryStrategy: (times) => {
      if (readiness.hasBeenReady) return Math.min(times * 200, RECONNECT_DELAY_CAP_MS)
      return times > 3 ? undefined : Math.min(times * 200, 2000)
    },
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
  })
  connection.on('ready', () => {
    readiness.hasBeenReady = true
  })
  // 'end' is final in ioredis: without this, the module would hand out a dead connection forever.
  connection.on('end', () => {
    if (readiness.hasBeenReady || state.closed) return
    logger.warn(`${label} gave up before its first ready; the next use reconnects`)
    onDeadBeforeReady(connection)
  })
  // Never remove: an unlistened 'error' crashes the process, and ioredis emits one per failed attempt.
  connection.on('error', (error: unknown) => {
    logger.error(`${label} error`, { error })
  })
  return { connection, readiness }
}

/**
 * Close a Queue built on a dead producer connection, ignoring its errors.
 * @param queue - The orphaned queue, if one was built.
 */
async function discardQueue(queue: Queue | undefined): Promise<void> {
  try {
    await queue?.close()
  } catch (error) {
    logger.warn('Closing a queue on a dead connection failed', { error })
  }
}

/**
 * Get the shared ioredis connection BullMQ Workers run on, connecting on first use.
 *
 * Separate from redis.service.ts's node-redis client: BullMQ requires ioredis,
 * and the two libraries cannot share a connection. BullMQ requires
 * `maxRetriesPerRequest: null` on a Worker's connection, since it manages its
 * own retry and blocking. Queue producers use `getProducerConnection()`.
 * @returns The shared Worker connection.
 * @throws {Error} If the connection has already been closed.
 */
export function getQueueConnection(): IORedis {
  if (state.closed) {
    throw new Error('Queue connection is closed; the process is shutting down')
  }
  state.worker ??= createQueueRedis(
    'BullMQ Redis connection',
    {
      // eslint-disable-next-line unicorn/no-null -- ioredis's option merge replaces undefined with its default of 20; BullMQ needs null
      maxRetriesPerRequest: null,
    },
    (dead) => {
      if (state.worker?.connection === dead) state.worker = undefined
      // Synchronous, inside 'end': a Worker on `dead` can spin once its init rejects, a microtask later.
      for (const listener of state.workerConnectionLost) listener(dead)
    }
  )
  return state.worker.connection
}

/**
 * Subscribe to the Worker connection giving up before its first ready.
 * @param listener - Called with the dead connection, synchronously within its 'end' event; the next getQueueConnection() builds a new one.
 * @returns A function that unsubscribes.
 */
export function onWorkerConnectionLost(listener: (dead: IORedis) => void): () => void {
  state.workerConnectionLost.add(listener)
  return () => {
    state.workerConnectionLost.delete(listener)
  }
}

/**
 * Record whether this process's Workers failed to restart, so readiness can't pass without them.
 * In the application only the supervisor's restart path calls it (worker-supervisor.service.ts);
 * a failed first start at boot throws instead, so the flag starts false.
 * @param haveFailed - True when the last restart failed; false once a restart succeeds.
 */
export function setWorkersFailed(haveFailed: boolean): void {
  state.haveWorkersFailed = haveFailed
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
  state.producer ??= createQueueRedis(
    'BullMQ producer Redis connection',
    { enableOfflineQueue: false },
    (dead) => {
      if (state.producer?.connection !== dead) return
      state.producer = undefined
      // Every queue holds the dead instance, so each is rebuilt on next use.
      const orphans = [state.emailQueue, state.notificationQueue, state.maintenanceQueue]
      state.emailQueue = undefined
      state.notificationQueue = undefined
      state.maintenanceQueue = undefined
      for (const orphan of orphans) void discardQueue(orphan)
    }
  )
  return state.producer.connection
}

/**
 * Get the shared "email" queue, creating it on first use.
 * @returns The email queue.
 */
export function getEmailQueue(): Queue {
  if (!state.emailQueue) {
    state.emailQueue = new Queue('email', {
      connection: getProducerConnection(),
      prefix: redisKey('bull'),
    })
    state.emailQueue.on('error', (error: unknown) => {
      logger.error('Email queue error', { error })
    })
  }
  return state.emailQueue
}

/**
 * Get the shared "notification" queue, creating it on first use, over the
 * same producer connection as the others.
 * @returns The notification queue.
 */
export function getNotificationQueue(): Queue {
  if (!state.notificationQueue) {
    state.notificationQueue = new Queue('notification', {
      connection: getProducerConnection(),
      prefix: redisKey('bull'),
    })
    state.notificationQueue.on('error', (error: unknown) => {
      logger.error('Notification queue error', { error })
    })
  }
  return state.notificationQueue
}

/**
 * Get the shared "maintenance" queue, creating it on first use. It carries
 * the retention purge, over the same producer connection as the others.
 * @returns The maintenance queue.
 */
export function getMaintenanceQueue(): Queue {
  if (!state.maintenanceQueue) {
    state.maintenanceQueue = new Queue('maintenance', {
      connection: getProducerConnection(),
      prefix: redisKey('bull'),
    })
    state.maintenanceQueue.on('error', (error: unknown) => {
      logger.error('Maintenance queue error', { error })
    })
  }
  return state.maintenanceQueue
}

/**
 * Enqueue a job. A generic wrapper over `Queue#add`, typed so the job's data
 * is the caller's `T`: with BullMQ's default type parameters `queue.add()`
 * returns `Job<any>`, and typing the parameter `Queue<T>` trips
 * exactOptionalPropertyTypes on BullMQ's unresolved `ExtractDataType`.
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
  return queue.add(jobName, data, options) as Promise<Job<T>>
}

/**
 * Check that one connection answers, without waiting out an outage.
 * @param queueRedis - The connection and its readiness.
 * @returns True when it is ready and PING succeeds.
 */
async function isConnectionReachable(queueRedis: QueueRedis): Promise<boolean> {
  const { connection, readiness } = queueRedis
  if (readiness.hasBeenReady) {
    // A ping while not ready would wait in the offline queue, or reject with it off.
    if (connection.status !== 'ready') return false
  } else if (!(await hasBecomeReady(connection))) {
    return false
  }
  const reply = await connection.ping()
  return reply === 'PONG'
}

/**
 * Wait for a connection's first 'ready', or for it to give up (bounded by the pre-ready retries).
 * @param connection - A connection that has never been ready.
 * @returns True once ready; false once it has ended.
 */
async function hasBecomeReady(connection: IORedis): Promise<boolean> {
  if (connection.status === 'ready') return true
  if (connection.status === 'end') return false
  return new Promise((resolve) => {
    const onReady = (): void => {
      connection.off('end', onEnd)
      resolve(true)
    }
    const onEnd = (): void => {
      connection.off('ready', onReady)
      resolve(false)
    }
    connection.once('ready', onReady).once('end', onEnd)
  })
}

/**
 * Check that both queue connections, the Workers' and the producers', answer.
 * @returns True when both are ready and answer PING; false once closed, after
 *   a failed Worker restart until a later one succeeds (`setWorkersFailed`), or
 *   when unreachable, without hanging: before the first 'ready' a connection
 *   gives up after a few retries, and after it any status other than 'ready'
 *   is reported at once.
 */
export async function isQueueReachable(): Promise<boolean> {
  if (state.closed || state.haveWorkersFailed) return false
  try {
    getQueueConnection()
    getProducerConnection()
    if (!state.worker || !state.producer) return false
    const results = await Promise.all([
      isConnectionReachable(state.worker),
      isConnectionReachable(state.producer),
    ])
    return results.every(Boolean)
  } catch {
    return false
  }
}

/**
 * Close every queue and both connections without waiting on Redis. Called by
 * graceful shutdown; safe to call twice. Closing a Queue leaves the producer
 * connection open, because BullMQ marks a Queue built from an ioredis instance
 * as sharing it and skips the quit, so the connection is ended once, below.
 * `closed` is set first, so shutdown is recorded even when nothing was created.
 * @returns Resolves once everything is closed.
 */
export async function closeQueue(): Promise<void> {
  state.closed = true
  if (state.emailQueue) {
    const emailQueue = state.emailQueue
    state.emailQueue = undefined
    await emailQueue.close()
  }
  if (state.notificationQueue) {
    const notificationQueue = state.notificationQueue
    state.notificationQueue = undefined
    await notificationQueue.close()
  }
  if (state.maintenanceQueue) {
    const maintenanceQueue = state.maintenanceQueue
    state.maintenanceQueue = undefined
    await maintenanceQueue.close()
  }
  const connections = [state.worker?.connection, state.producer?.connection]
  state.worker = undefined
  state.producer = undefined
  await Promise.all(connections.map((connection) => endConnection(connection)))
}

/**
 * End one connection without waiting on Redis: `quit()` when ready, `disconnect()` otherwise.
 * `quit()` is a command, so while not ready it would wait in the offline queue
 * until Redis returned, and a connection in 'end' rejects it.
 * @param connection - The connection to end, if it was ever created.
 * @returns Resolves once the connection is ended.
 */
async function endConnection(connection: IORedis | undefined): Promise<void> {
  if (!connection) return
  if (connection.status === 'ready') {
    await connection.quit()
  } else {
    connection.disconnect()
  }
}
