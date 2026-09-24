// src/services/notification-emitter.service.ts
//
// Live notification fanout across every replica. `emitNotification`
// publishes to one Redis channel, `${QUEUE_PREFIX}:notifications`. Each
// process with an SSE listener runs one subscriber connection and hands every
// message to its local EventEmitter, keyed per user, so the publishing process
// receives its own copy exactly once, like every other replica.
//
// Best effort, not durable: the row is already in the database. When the
// subscriber reconnects after an outage, every open stream is closed, and its
// client replays the gap from the database via `Last-Event-ID`.
import { EventEmitter } from 'node:events'
import type { RedisClientType } from 'redis'
import { z } from 'zod'
import { getEnv } from '@/configs/env.config'
import { NOTIFICATION_TYPES } from '@/constants/notification.constants'
import type { Notification } from '@/database/models/notification.model'
import { closeAllStreams } from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import { createRedisClient, getRedis } from '@/services/redis.service'

/**
 * The event name one user's notifications are delivered under locally.
 * @param userId - The notification owner's id.
 * @returns The per-user event name.
 */
function eventNameFor(userId: string): string {
  return `notification:${userId}`
}

/**
 * The Redis channel every replica publishes and subscribes on.
 * @returns The channel name, namespaced by `QUEUE_PREFIX`.
 */
function channelName(): string {
  return `${getEnv().QUEUE_PREFIX}:notifications`
}

// Dates cross the wire as ISO strings (`Date#toJSON`) and are revived here.
const isoDate = z.iso.datetime().transform((value) => new Date(value))
const metadataSchema = z.record(z.string(), z.unknown())

const messageSchema = z.object({
  userId: z.string().min(1),
  notification: z.object({
    id: z.string(),
    userId: z.string(),
    type: z.enum(NOTIFICATION_TYPES),
    title: z.string(),
    body: z.string(),
    metadata: metadataSchema.nullable(),
    readAt: isoDate.nullable(),
    createdAt: isoDate,
    dedupeKey: z.string().nullable(),
  }),
})

// Mutable properties on a top-level const, so these functions share state
// without reassigning a top-level binding (unicorn/no-top-level-assignment-in-function).
const state: {
  emitter: EventEmitter | undefined
  subscriber: RedisClientType | undefined
  starting: Promise<void> | undefined
  closed: boolean
  isPublishFailing: boolean
} = {
  emitter: undefined,
  subscriber: undefined,
  starting: undefined,
  closed: false,
  isPublishFailing: false,
}

/**
 * Get the local emitter, constructing it on first use.
 * @returns The process-wide notification emitter.
 */
function getEmitter(): EventEmitter {
  if (!state.emitter) {
    // eslint-disable-next-line unicorn/prefer-event-target -- needs `setMaxListeners(0)` (no per-event-name listener cap) and `listenerCount()` (this module's own export, used by notification-stream.test.ts to prove cleanup) — plain `EventEmitter` features `EventTarget` has no equivalent for.
    state.emitter = new EventEmitter()
    // Every listener sits on its own per-user event name, one per open SSE
    // connection, so Node's default 10-listener warning has nothing to flag.
    state.emitter.setMaxListeners(0)
  }
  return state.emitter
}

/**
 * Hand one notification to this process's listeners for its owner.
 * @param userId - The notification's owner.
 * @param notification - The notification to deliver.
 */
function deliverLocally(userId: string, notification: Notification): void {
  try {
    getEmitter().emit(eventNameFor(userId), notification)
  } catch (error) {
    // A throwing listener must not break the subscriber or the caller.
    logger.error('A notification listener threw', { error, notificationId: notification.id })
  }
}

/**
 * Validate one channel message and deliver it locally; a malformed one is logged and dropped.
 * @param message - The raw message from the channel.
 */
function handleMessage(message: string): void {
  let payload: unknown
  try {
    payload = JSON.parse(message)
  } catch {
    logger.warn('Dropped a notification message that is not JSON')
    return
  }
  const parsed = messageSchema.safeParse(payload)
  if (!parsed.success) {
    logger.warn('Dropped an invalid notification message', {
      paths: parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
    })
    return
  }
  const notification: Notification = parsed.data.notification
  deliverLocally(parsed.data.userId, notification)
}

/**
 * Connect and subscribe; on failure, forget the client so the next `onNotification` retries.
 * @param subscriber - The client to start.
 * @returns Resolves once subscribed or given up; never rejects.
 */
async function startSubscriber(subscriber: RedisClientType): Promise<void> {
  try {
    await subscriber.connect()
    await subscriber.subscribe(channelName(), handleMessage)
  } catch (error) {
    if (state.subscriber === subscriber) state.subscriber = undefined
    if (subscriber.isOpen) subscriber.destroy()
    if (!state.closed) logger.error('Notification subscriber failed to start', { error })
  }
}

/**
 * Open this process's subscriber unless it exists or shutdown has closed it.
 */
function ensureSubscriber(): void {
  if (state.closed || state.subscriber) return
  const subscriber = createRedisClient()
  const readiness = { hasBeenReady: false }
  subscriber.on('ready', () => {
    // node-redis resubscribes before 'ready'. Messages published during the
    // outage are gone, so end every stream and let its client replay them.
    if (readiness.hasBeenReady) {
      logger.warn('Notification subscriber reconnected; closing open streams so clients replay')
      closeAllStreams()
    }
    readiness.hasBeenReady = true
  })
  state.subscriber = subscriber
  state.starting = startSubscriber(subscriber)
}

/**
 * Publish one message; when that fails, deliver it to this process's listeners only.
 * @param userId - The notification's owner.
 * @param notification - The notification, for the local fallback.
 * @param message - The serialised channel message.
 * @returns Resolves once published or delivered locally; never rejects.
 */
async function publishOrDeliverLocally(
  userId: string,
  notification: Notification,
  message: string
): Promise<void> {
  try {
    const client = await getRedis()
    await client.publish(channelName(), message)
    state.isPublishFailing = false
  } catch (error) {
    if (!state.isPublishFailing) {
      state.isPublishFailing = true
      logger.warn(
        'Notification publish failed; delivering to this process only until Redis recovers',
        { error }
      )
    }
    deliverLocally(userId, notification)
  }
}

/**
 * Publish one notification to every replica's SSE connections for its owner.
 *
 * Returns before delivery: the publish runs in the background. The row is
 * already in the database (notification.worker.ts calls this only after the
 * insert), so a missed live delivery reaches the user on their next load or
 * reconnect.
 * @param userId - The notification's owner. Only listeners subscribed to this exact id are notified.
 * @param notification - The notification row, exactly as `NotificationRepository.create` returned it.
 */
export function emitNotification(userId: string, notification: Notification): void {
  const message = JSON.stringify({ userId, notification })
  void publishOrDeliverLocally(userId, notification, message)
}

/**
 * Subscribe to one user's live notification stream, opening this process's subscriber on first use.
 * @param userId - The user to subscribe to.
 * @param handler - Called once per notification, with its dates revived.
 */
export function onNotification(
  userId: string,
  handler: (notification: Notification) => void
): void {
  getEmitter().on(eventNameFor(userId), handler)
  ensureSubscriber()
}

/**
 * Unsubscribe a handler previously passed to `onNotification`.
 *
 * Must be called with the SAME function reference `onNotification` was
 * given — `EventEmitter#off` removes a listener by reference equality, not
 * by user id alone — which is why notification-stream.controller.ts keeps
 * its listener in a named `const`.
 * @param userId - The user this handler was subscribed to.
 * @param handler - The exact function reference passed to the matching `onNotification` call.
 */
export function offNotification(
  userId: string,
  handler: (notification: Notification) => void
): void {
  getEmitter().off(eventNameFor(userId), handler)
}

/**
 * How many local listeners one user's live notification stream has.
 *
 * Exists for tests: notification-stream.test.ts uses it to prove
 * `offNotification` ran when a client disconnected.
 * @param userId - The user to check.
 * @returns The number of currently-registered listeners for this user in this process.
 */
export function listenerCount(userId: string): number {
  return getEmitter().listenerCount(eventNameFor(userId))
}

/**
 * Close this process's subscriber for shutdown; a later `onNotification` never reopens it. Safe to call twice.
 * @returns Resolves once the subscriber is closed and its start attempt has settled.
 */
export async function closeNotificationSubscriber(): Promise<void> {
  state.closed = true
  const subscriber = state.subscriber
  state.subscriber = undefined
  // destroy, not close: close() waits for queued commands, which a silent Redis never answers.
  if (subscriber?.isOpen) subscriber.destroy()
  if (state.starting) await state.starting
}
