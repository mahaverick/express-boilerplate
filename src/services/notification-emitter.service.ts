/**
 * @file Live notification fanout across replicas over one Redis channel; each
 * process with an SSE listener runs one subscriber, so the publisher gets its own
 * copy once (twice if a publish's reply is lost and it also delivers locally).
 * Best effort, not durable: after an outage open streams are closed and clients
 * replay the gap from the database via `Last-Event-ID`.
 */
import { EventEmitter } from 'node:events'
import type { RedisClientType } from 'redis'
import { z } from 'zod'
import { NOTIFICATION_TYPES } from '@/constants/notification.constants'
import type { Notification } from '@/database/models/notification.model'
import { closeAllStreams } from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import { createRedisClient, getRedis, redisKey } from '@/services/redis.service'

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
 * @returns The channel name, namespaced by `REDIS_KEY_PREFIX`.
 */
function channelName(): string {
  return redisKey('notifications')
}

/**
 * Dates cross the wire as ISO strings (`Date#toJSON`) and are revived here.
 */
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

/**
 * A failed start is retried after this delay, doubling up to `RETRY_MAX_MS`, while listeners wait.
 */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000

/**
 * This process's subscriber client.
 */
interface Subscriber {
  client: RedisClientType
  /**
   * No socket yet: from creation, and from each 'reconnecting', until 'connect' or 'error'.
   */
  isAwaitingSocket: boolean
}

/**
 * Module state in one object, so no function reassigns a top-level binding.
 */
const state: {
  emitter: EventEmitter | undefined
  subscriber: Subscriber | undefined
  starting: Promise<void> | undefined
  closed: boolean
  isPublishFailing: boolean
  retryTimer: ReturnType<typeof setTimeout> | undefined
  retryCount: number
  /**
   * A start failed while streams were open, so they may have missed messages.
   */
  hasMissedMessages: boolean
} = {
  emitter: undefined,
  subscriber: undefined,
  starting: undefined,
  closed: false,
  isPublishFailing: false,
  retryTimer: undefined,
  retryCount: 0,
  hasMissedMessages: false,
}

/**
 * Get the local emitter, constructing it on first use. It has no listener cap:
 * each open SSE connection adds a listener on its user's event name, and a user
 * with more than ten open streams must not trip Node's leak warning.
 * @returns The process-wide notification emitter.
 */
function getEmitter(): EventEmitter {
  if (!state.emitter) {
    // eslint-disable-next-line unicorn/prefer-event-target -- needs `setMaxListeners(0)` and `listenerCount()`, which EventTarget lacks
    state.emitter = new EventEmitter()
    state.emitter.setMaxListeners(0)
  }
  return state.emitter
}

/**
 * Hand one notification to each of this process's listeners for its owner.
 * @param userId - The notification's owner.
 * @param notification - The notification to deliver.
 */
function deliverLocally(userId: string, notification: Notification): void {
  // One at a time: EventEmitter#emit stops at the first listener that throws.
  const listeners = getEmitter().listeners(eventNameFor(userId)) as ((
    notification: Notification
  ) => void)[]
  for (const listener of listeners) {
    try {
      listener(notification)
    } catch (error) {
      logger.error('A notification listener threw', { error, notificationId: notification.id })
    }
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
 * Destroy a subscriber client once shutdown has asked for it, if it is still open.
 * @param client - The subscriber client.
 */
function destroyIfClosed(client: RedisClientType): void {
  if (state.closed && client.isOpen) client.destroy()
}

/**
 * Connect and subscribe; on failure, forget the client and, while streams are open, schedule a retry.
 * @param client - The client to start.
 * @returns Resolves once subscribed, given up or closed; never rejects.
 */
async function startSubscriber(client: RedisClientType): Promise<void> {
  try {
    await client.connect()
    // A close during connect's retries resolves connect() unconnected; subscribe() would never settle.
    if (state.closed || !client.isReady) throw new Error('Closed while connecting')
    await client.subscribe(channelName(), handleMessage)
    state.retryCount = 0
    if (state.hasMissedMessages) {
      state.hasMissedMessages = false
      logger.warn('Notification subscriber started late; closing open streams so clients replay')
      closeAllStreams()
    }
  } catch (error) {
    if (state.subscriber?.client === client) state.subscriber = undefined
    if (client.isOpen) client.destroy()
    if (state.closed) return
    logger.error('Notification subscriber failed to start', { error })
    if (hasLocalListeners()) {
      state.hasMissedMessages = true
      scheduleRetry()
    }
  }
}

/**
 * Whether any SSE connection in this process is listening.
 * @returns True while at least one listener is registered.
 */
function hasLocalListeners(): boolean {
  return getEmitter().eventNames().length > 0
}

/**
 * Retry a failed start after a backoff, unless a retry is already pending.
 */
function scheduleRetry(): void {
  if (state.retryTimer) return
  const delay = Math.min(RETRY_BASE_MS * 2 ** state.retryCount, RETRY_MAX_MS)
  state.retryCount += 1
  state.retryTimer = setTimeout(() => {
    state.retryTimer = undefined
    if (hasLocalListeners()) ensureSubscriber()
  }, delay)
  state.retryTimer.unref()
}

/**
 * Drop a pending retry and its backoff.
 */
function cancelRetry(): void {
  clearTimeout(state.retryTimer)
  state.retryTimer = undefined
  state.retryCount = 0
}

/**
 * Open this process's subscriber unless it exists or shutdown has closed it.
 */
function ensureSubscriber(): void {
  if (state.closed || state.subscriber) return
  const client = createRedisClient()
  const subscriber: Subscriber = { client, isAwaitingSocket: true }
  const readiness = { hasBeenReady: false }
  client.on('ready', () => {
    // Messages published during the outage are lost, so end every stream and let its client replay them.
    if (readiness.hasBeenReady) {
      logger.warn('Notification subscriber reconnected; closing open streams so clients replay')
      closeAllStreams()
    }
    readiness.hasBeenReady = true
  })
  // A close while no socket exists is carried out here, once one attempt has one or has failed.
  client.on('reconnecting', () => {
    subscriber.isAwaitingSocket = true
  })
  client.on('connect', () => {
    subscriber.isAwaitingSocket = false
    destroyIfClosed(client)
  })
  client.on('error', () => {
    subscriber.isAwaitingSocket = false
    destroyIfClosed(client)
  })
  state.subscriber = subscriber
  state.starting = startSubscriber(client)
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
 * Must be called with the same function reference `onNotification` was
 * given: `EventEmitter#off` removes a listener by reference, not by user id.
 * @param userId - The user this handler was subscribed to.
 * @param handler - The exact function reference passed to the matching `onNotification` call.
 */
export function offNotification(
  userId: string,
  handler: (notification: Notification) => void
): void {
  getEmitter().off(eventNameFor(userId), handler)
  if (hasLocalListeners()) return
  cancelRetry()
  state.hasMissedMessages = false
}

/**
 * How many local listeners one user's live notification stream has.
 *
 * Exists for tests, to prove `offNotification` ran when a client disconnected.
 * @param userId - The user to check.
 * @returns The number of currently-registered listeners for this user in this process.
 */
export function listenerCount(userId: string): number {
  return getEmitter().listenerCount(eventNameFor(userId))
}

/**
 * Close this process's subscriber and cancel any retry, for shutdown; a later `onNotification` never reopens it. Safe to call twice.
 *
 * Resolves once a first connect in progress has ended; a reconnect after
 * `ready` ends in the background, as soon as its current attempt has a socket or fails.
 * A client with no socket yet is not destroyed here, because destroy() would not
 * stop the socket being opened; its 'connect' or 'error' listener destroys it.
 * @returns Resolves once the subscriber's start attempt has settled.
 */
export async function closeNotificationSubscriber(): Promise<void> {
  state.closed = true
  cancelRetry()
  const subscriber = state.subscriber
  state.subscriber = undefined
  // destroy, not close: close() waits for queued commands, which a silent Redis never answers.
  if (subscriber && !subscriber.isAwaitingSocket && subscriber.client.isOpen) {
    subscriber.client.destroy()
  }
  if (state.starting) await state.starting
}
