// src/services/notification-emitter.service.ts
//
// The in-process publish/subscribe bridge between the notification worker
// (notification.worker.ts, a BullMQ Worker that by default runs inside this
// same process — WORKER_ENABLED defaults true, see CLAUDE.md's "Job queue"
// section) and notification-stream.controller.ts's SSE endpoint. One
// `EventEmitter` singleton, keyed per-user via `notification:${userId}`
// event names, so one worker insert reaches every tab a user currently has
// open on `GET /api/v1/notifications/stream` — and only that user's tabs,
// since each SSE connection subscribes to its own user id's event name
// alone.
//
// SINGLE PROCESS ONLY. This does not fan out across pods: a multi-pod
// deployment with `WORKER_ENABLED=false` API pods and a separate worker pod
// (the split CLAUDE.md already documents) inserts the notification row from
// one process and emits the event in that SAME process — an SSE connection
// held open on a DIFFERENT API pod never sees it, and only learns of the
// new notification on its next `GET /api/v1/notifications` poll or
// reconnect. Upgrading this to Redis Pub/Sub (over the ioredis connection
// queue.service.ts already owns — PUBLISH/SUBSCRIBE, not BullMQ) is the
// documented path for that deployment shape. It is not built here: this
// boilerplate's default topology runs the worker in the same process as the
// API, which is exactly the case this singleton already covers correctly.
import { EventEmitter } from 'node:events'
import type { Notification } from '@/database/models/notification.model'

/**
 * The event name one user's notifications are published and subscribed
 * under.
 * @param userId - The notification owner's id.
 * @returns The per-user event name.
 */
function eventNameFor(userId: string): string {
  return `notification:${userId}`
}

// Lazy singleton — same shape/reasoning as queue.service.ts's own `state`: a
// mutable property on a top-level `const` rather than a top-level `let`, so
// `getEmitter()` shares state without reassigning a top-level binding
// (which unicorn/no-top-level-assignment-in-function forbids) — and
// constructed on first use, not at module-import time, matching
// getEnv()/getLogger()/getQueueConnection()'s own lazy-singleton convention
// (unicorn/no-top-level-side-effects would otherwise flag both `new
// EventEmitter()` and the `setMaxListeners(0)` call that must follow it,
// run as a bare statement at module scope).
const state: { emitter: EventEmitter | undefined } = { emitter: undefined }

/**
 * Get the shared emitter, constructing it on first use.
 * @returns The process-wide notification emitter.
 */
function getEmitter(): EventEmitter {
  if (!state.emitter) {
    // eslint-disable-next-line unicorn/prefer-event-target -- needs `setMaxListeners(0)` (no per-event-name listener cap) and `listenerCount()` (this module's own export, used by notification-stream.test.ts to prove cleanup) — plain `EventEmitter` features `EventTarget` has no equivalent for. This module's own design (per-user dynamic event names over `node:events`) is specified by the task it implements, not merely a stylistic default.
    state.emitter = new EventEmitter()
    // `setMaxListeners(0)` removes Node's default 10-listener warning
    // threshold: a real deployment can have far more than 10 concurrent SSE
    // connections across all users combined. Unlike a genuine leak — many
    // listeners piling up on the SAME event name — every listener here sits
    // on its own per-user event name, one per open SSE connection
    // (`onNotification`, below), so there is no fixed "this many is always
    // too many" figure the default warning could usefully flag.
    state.emitter.setMaxListeners(0)
  }
  return state.emitter
}

/**
 * Publish one notification to every SSE connection currently subscribed to
 * its owner.
 *
 * A no-op when the user has no open connection — `EventEmitter#emit`
 * returns `false` and does nothing else. That is never data loss: the
 * notification already exists in the database by the time a caller reaches
 * this function (notification.worker.ts calls it only after
 * `NotificationRepository.create` has resolved), so it still reaches the
 * user the next time they load their inbox or open a stream. Live delivery
 * here is additive, not the row's only durable record.
 * @param userId - The notification's owner. Only listeners subscribed to this exact id are notified.
 * @param notification - The notification row, exactly as `NotificationRepository.create` returned it.
 */
export function emitNotification(userId: string, notification: Notification): void {
  getEmitter().emit(eventNameFor(userId), notification)
}

/**
 * Subscribe to one user's live notification stream.
 * @param userId - The user to subscribe to.
 * @param handler - Called once per notification, with the row exactly as `emitNotification` published it.
 */
export function onNotification(
  userId: string,
  handler: (notification: Notification) => void
): void {
  getEmitter().on(eventNameFor(userId), handler)
}

/**
 * Unsubscribe a handler previously passed to `onNotification`.
 *
 * Must be called with the SAME function reference `onNotification` was
 * given — `EventEmitter#off` removes a listener by reference equality, not
 * by user id alone — which is why notification-stream.controller.ts keeps
 * its listener in a named `const` rather than passing a fresh inline arrow
 * function to each call.
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
 * How many SSE connections are currently subscribed to one user's live
 * notification stream.
 *
 * Exists for tests: `tests/integration/api/notification-stream.test.ts`
 * uses it to prove `offNotification` actually ran when a client
 * disconnected, rather than only trusting that no error was thrown and no
 * further frame happened to arrive within a test's own timeout. Costs
 * nothing in production — `EventEmitter#listenerCount` is O(1) and nothing
 * else in this codebase calls it.
 * @param userId - The user to check.
 * @returns The number of currently-registered listeners for this user.
 */
export function listenerCount(userId: string): number {
  return getEmitter().listenerCount(eventNameFor(userId))
}
