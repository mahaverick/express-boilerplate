// src/services/queue.service.ts
//
// The one place anything in this codebase creates a BullMQ Queue or the
// ioredis connection it runs over. Deliberately separate from
// redis.service.ts: that module wraps `redis` (node-redis), BullMQ requires
// `ioredis`, and the two client libraries cannot share a connection — this
// module owns its own, lazily, the same way getEnv()/getRedis() do.
import { Queue, type Job, type JobsOptions } from 'bullmq'
import IORedis from 'ioredis'
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
  emailQueue: Queue | undefined
  closed: boolean
} = { connection: undefined, emailQueue: undefined, closed: false }

/**
 * Get the shared ioredis connection used by every BullMQ Queue/Worker,
 * connecting on first use.
 *
 * Separate from redis.service.ts's node-redis client — different libraries,
 * cannot share. BullMQ requires `maxRetriesPerRequest: null` on this
 * connection (it manages its own retry/blocking semantics); setting it here,
 * on the one shared connection, satisfies every Queue and Worker built on
 * top of it.
 * @returns The shared ioredis connection.
 * @throws {Error} If the connection has already been closed.
 */
export function getQueueConnection(): IORedis {
  if (state.closed) {
    throw new Error('Queue connection is closed; the process is shutting down')
  }
  if (!state.connection) {
    state.connection = new IORedis(getEnv().REDIS_URL, {
      // BullMQ requires this to be exactly `null`, not merely absent —
      // verified empirically against the installed ioredis: its own option
      // merging (lodash.defaults) treats an explicit `undefined` as "unset"
      // and silently re-applies its own default of 20, which is exactly the
      // "You are using a non-supported version of Redis" failure this
      // setting exists to prevent. `null`, unlike `undefined`, survives that
      // merge untouched.
      // eslint-disable-next-line unicorn/no-null -- see comment above; undefined does not have the same effect here
      maxRetriesPerRequest: null,
      // Bounded retries — same reasoning as redis.service.ts's own
      // reconnectStrategy — so isQueueReachable() reports unreachable within
      // a few seconds instead of ioredis's default of retrying forever.
      // `undefined`, unlike maxRetriesPerRequest above, is fine to return
      // here: ioredis only checks `typeof retryDelay !== 'number'` to decide
      // "stop reconnecting", so null and undefined behave identically as a
      // callback return value (there is no default-merging involved).
      retryStrategy: (times) => (times > 3 ? undefined : Math.min(times * 200, 2000)),
      connectTimeout: 5000,
    })
    // Mandatory: an unlistened 'error' event on an EventEmitter crashes the
    // Node.js process. ioredis emits 'error' for every failed connection
    // attempt, not just fatal ones, so this must never be removed.
    state.connection.on('error', (error: unknown) => {
      logger.error('BullMQ Redis connection error', { error })
    })
  }
  return state.connection
}

/**
 * Get the shared "email" queue, creating it on first use.
 * @returns The email queue.
 */
export function getEmailQueue(): Queue {
  if (!state.emailQueue) {
    state.emailQueue = new Queue('email', {
      connection: getQueueConnection(),
      prefix: getEnv().QUEUE_PREFIX,
    })
    state.emailQueue.on('error', (error: unknown) => {
      logger.error('Email queue error', { error })
    })
  }
  return state.emailQueue
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
 * Check that the queue's Redis connection answers.
 * @returns True when PING succeeds; false once closed or unreachable,
 *   without hanging — bounded by `getQueueConnection()`'s `retryStrategy`.
 */
export async function isQueueReachable(): Promise<boolean> {
  if (state.closed) return false
  try {
    const connection = getQueueConnection()
    const reply = await connection.ping()
    return reply === 'PONG'
  } catch {
    return false
  }
}

/**
 * Close every queue and the shared connection. Called by graceful shutdown;
 * safe to call twice.
 * @returns Resolves once everything is closed.
 */
export async function closeQueue(): Promise<void> {
  // Set unconditionally, before either close below, so a second call — or a
  // first call when nothing was ever created — still records shutdown.
  state.closed = true
  if (state.emailQueue) {
    const emailQueue = state.emailQueue
    state.emailQueue = undefined
    // Does NOT touch state.connection below — verified empirically (and
    // against node_modules/bullmq/dist/cjs/utils/create-backend.js's
    // `shared: isRedisInstance(opts.connection)`): BullMQ marks a Queue
    // built from an already-constructed ioredis INSTANCE (as opposed to
    // connection options) as using a "shared" connection, and its own
    // RedisConnection#close() skips quitting/disconnecting whenever
    // `shared` is true. So `getQueueConnection()`'s connection outlives
    // this call — good, since Worker/QueueEvents (Task 2/3) reuse it too.
    await emailQueue.close()
  }
  if (state.connection) {
    const connection = state.connection
    state.connection = undefined
    // Still guarded, not an unconditional quit(): even though Queue#close()
    // above never touches this connection (see its own comment), ioredis's
    // OWN retryStrategy can independently drive it to 'end' before this
    // point — e.g. when Redis was unreachable and the bounded retryStrategy
    // above gave up. ioredis rejects any command, quit() included, sent to a
    // connection already in 'end' status, so calling quit() unconditionally
    // here would turn that shutdown path into a thrown "Connection is
    // closed." instead of a clean close.
    if (connection.status !== 'end') {
      await connection.quit()
    }
  }
}
