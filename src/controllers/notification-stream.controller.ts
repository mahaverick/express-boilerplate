// src/controllers/notification-stream.controller.ts
//
// GET /api/v1/notifications/stream — a Server-Sent Events connection that
// pushes the authenticated user's notifications in real time, via
// notification-emitter.service.ts's in-process pub/sub. This is the one
// handler on notification.routes.ts that does NOT sit behind the router-wide
// `requireAuth` (auth.middleware.ts) — see `authenticateStreamRequest`'s own
// comment for why, and notification.routes.ts's header comment for how the
// router is ordered to keep that safe.
//
// A rejected token never opens a stream. `authenticateStreamRequest` throws
// before `response.writeHead` ever runs, so the `catch` below hands the
// rejection to `next(error)` and `errorHandler` (error.middleware.ts)
// answers with this codebase's ordinary JSON 401 envelope — not an
// event-stream response that immediately closes.
import { type NextFunction, type Request, type Response } from 'express'
import { MAX_NOTIFICATION_PAGE_SIZE } from '@/constants/notification.constants'
import type { Notification } from '@/database/models/notification.model'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/middlewares/auth.middleware'
import { HttpError } from '@/middlewares/error.middleware'
import { NotificationRepository } from '@/repositories/notification.repository'
import { UserRepository } from '@/repositories/user.repository'
import { logger } from '@/services/logger.service'
import { offNotification, onNotification } from '@/services/notification-emitter.service'
import { verifyAccessToken } from '@/utilities/token.utilities'

const userRepository = new UserRepository()
const notificationRepository = new NotificationRepository()

// How often a `:ping\n\n` comment line is written to an open connection, to
// keep it alive through an intermediary (a load balancer, an nginx proxy)
// that would otherwise time out an idle-looking socket.
const HEARTBEAT_INTERVAL_MS = 30_000

// Sent once, in the `retry:` field of the initial response — how long the
// browser's own `EventSource` should wait before reconnecting after this
// connection drops.
const SSE_RETRY_MS = 3000

/**
 * The wire shape one notification is serialized to for an SSE `data:` line
 * — a subset of the `notifications` row, matching what `GET
 * /api/v1/notifications` already exposes via `successResponse`. `readAt` is
 * carried as `string | null`, not omitted when unread, for the same reason
 * `deleteNotification` (notification.controller.ts) returns a JSON `null`
 * rather than nothing: an `EventSource` client parses `data:` as JSON text,
 * where "absent" and "explicitly null" are different, and only the second
 * one unambiguously means "this notification is unread" rather than "this
 * server version doesn't send readAt".
 */
interface NotificationStreamPayload {
  id: string
  type: string
  title: string
  body: string
  readAt: string | null
  createdAt: string
}

/**
 * Authenticate an SSE connection from its `?token=` query parameter.
 *
 * Deliberately NOT `requireAuth`: that middleware only ever reads a
 * `Bearer` `Authorization` header, and the browser's own `EventSource` API —
 * the only thing that opens this connection outside a test — cannot set
 * custom request headers at all, so a query parameter is the one place a
 * token can travel for this specific request. Everything else mirrors
 * `requireAuth` exactly: verify the signature via `verifyAccessToken`, then
 * load and confirm the claimed user is still active, so a disabled
 * account's outstanding SSE connections stop working the same way its
 * outstanding bearer tokens do.
 * @param request - The incoming request, carrying the access token as `?token=`.
 * @returns The authenticated user's id.
 * @throws {HttpError} 401, when the token is missing, invalid, expired, or names no active user.
 */
async function authenticateStreamRequest(request: Request): Promise<string> {
  const token = request.query.token
  if (typeof token !== 'string' || token === '') {
    throw new HttpError('Missing access token', 401)
  }

  const verified = verifyAccessToken(token)
  if (!verified.ok) {
    if (verified.reason === 'expired') {
      throw new HttpError('Access token expired', 401, ACCESS_TOKEN_EXPIRED_CODE)
    }
    throw new HttpError('Invalid access token', 401)
  }

  const user = await userRepository.findById(verified.payload.sub)
  if (!user || !user.active) {
    throw new HttpError('Account no longer exists or is inactive', 401)
  }
  return user.id
}

/**
 * Narrow a `notifications` row to `NotificationStreamPayload`.
 * @param notification - The row to serialize.
 * @returns The JSON-ready payload for this notification's `data:` line.
 */
function toStreamPayload(notification: Notification): NotificationStreamPayload {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    // eslint-disable-next-line unicorn/no-null -- the wire format is JSON: an unread notification must serialize readAt as `null`, not omit the key, so a client parsing `data:` can tell "unread" apart from "this server doesn't send readAt" — same reasoning notification.controller.ts's deleteNotification already documents for its own `null` response.
    readAt: notification.readAt ? notification.readAt.toISOString() : null,
    createdAt: notification.createdAt.toISOString(),
  }
}

/**
 * Format one notification as a complete SSE frame — `id:`/`event:`/`data:`
 * lines followed by the blank line that dispatches it — built as a single
 * string so one `response.write` call sends the whole frame atomically
 * rather than three separate writes a slow consumer could see interleaved
 * with another frame.
 * @param notification - The notification to format.
 * @returns The SSE frame text, including its trailing blank line.
 */
function formatNotificationFrame(notification: Notification): string {
  const payload = toStreamPayload(notification)
  return `id: ${notification.id}\nevent: notification\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Write one notification to an open SSE response, doing nothing when the
 * connection has already ended — a write racing the client's own
 * disconnect is expected, not an error to surface.
 * @param response - The open SSE response.
 * @param notification - The notification to deliver.
 */
function writeNotificationEvent(response: Response, notification: Notification): void {
  if (response.writableEnded || response.destroyed) return
  response.write(formatNotificationFrame(notification))
}

/**
 * Whether `candidate` was created strictly after `cursor`, under the same
 * `(createdAt, id)` ordering `notifications_user_created_idx`
 * (notification.model.ts) and `NotificationRepository.list`'s own keyset
 * cursor already use: `createdAt` decides it, and for two rows created in
 * the same millisecond the larger `id` wins — uuidv7 is time-ordered, and
 * `list`'s own `ORDER BY created_at DESC, id DESC` already treats a larger
 * id as "newer" for a tie, so this matches that one existing definition of
 * "newer" rather than inventing a second.
 * @param candidate - The notification being tested.
 * @param cursor - The last notification the client already has, from `Last-Event-ID`.
 * @returns True when `candidate` is newer than `cursor`.
 */
function isNewerThan(candidate: Notification, cursor: Notification): boolean {
  const candidateTime = candidate.createdAt.getTime()
  const cursorTime = cursor.createdAt.getTime()
  if (candidateTime !== cursorTime) return candidateTime > cursorTime
  return candidate.id > cursor.id
}

/**
 * Replay every notification the client missed while disconnected, on
 * reconnect.
 *
 * Bounded to the single most-recent page `NotificationRepository.list`
 * returns (`MAX_NOTIFICATION_PAGE_SIZE` — the same cap
 * `notification.validators.ts`'s own `listNotificationsSchema` already
 * enforces for `GET /api/v1/notifications`): a client that missed more
 * notifications than that in one disconnect still gets caught up on the
 * most recent ones, and can page through the rest via the ordinary REST
 * endpoint, rather than this burst issuing an unbounded number of `list()`
 * calls before the live stream can even start.
 *
 * A silent no-op — not a 400/404 — when `lastEventId` does not resolve to a
 * notification this user still owns: it may have been deleted (`DELETE
 * /api/v1/notifications/:id`) since the client last saw it, and a reconnect
 * is exactly the moment that should recover gracefully. The live stream
 * below still starts either way.
 * @param response - The open SSE response to write the replay burst to.
 * @param userId - The authenticated connection's owner.
 * @param lastEventId - The `Last-Event-ID` header value the client sent on reconnect.
 */
async function replayMissedNotifications(
  response: Response,
  userId: string,
  lastEventId: string
): Promise<void> {
  const cursor = await notificationRepository.findByIdAndUser(lastEventId, userId)
  if (!cursor) return

  const { notifications } = await notificationRepository.list(userId, {
    limit: MAX_NOTIFICATION_PAGE_SIZE,
  })

  // list() returns newest-first; replay oldest-first so each frame's `id:`
  // line only ever advances, matching the order the live stream itself
  // delivers in.
  const missed = notifications
    .filter((notification) => isNewerThan(notification, cursor))
    .toReversed()

  for (const notification of missed) {
    writeNotificationEvent(response, notification)
  }
}

/**
 * `GET /api/v1/notifications/stream` — open a Server-Sent Events connection
 * for the authenticated user's notifications.
 * @param request - The incoming request, carrying the access token as `?token=` and, on reconnect, a `Last-Event-ID` header.
 * @param response - The response, upgraded to an SSE stream once authenticated.
 * @param next - Forwards an authentication failure to the terminal error handler.
 */
export async function streamNotifications(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = await authenticateStreamRequest(request)

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // nginx buffers a proxied response by default, which would hold every
      // frame below until the buffer fills or the connection closes —
      // defeating "real-time" entirely. This header is nginx-specific and
      // harmless to send through anything else.
      'X-Accel-Buffering': 'no',
    })
    response.flushHeaders()
    response.write(`retry: ${SSE_RETRY_MS}\n`)

    // A write racing the client's own disconnect (see writeNotificationEvent)
    // can still surface as an 'error' event on the response itself — an
    // unlistened 'error' event on a Node stream throws and crashes the
    // process, so this must never be removed.
    response.on('error', (error: unknown) => {
      logger.debug('Notification stream connection error', { error })
    })

    const lastEventId = request.get('Last-Event-ID')
    if (lastEventId) {
      await replayMissedNotifications(response, userId, lastEventId)
    }

    const handleNotification = (notification: Notification): void => {
      writeNotificationEvent(response, notification)
    }
    onNotification(userId, handleNotification)

    const heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed) return
      response.write(':ping\n\n')
    }, HEARTBEAT_INTERVAL_MS)
    // Without this, a pending heartbeat timer keeps the Node event loop
    // alive for as long as the connection is open — fine in production,
    // where the process is meant to stay up, but it would otherwise hang a
    // test (or a graceful shutdown) waiting on a timer nothing else needs.
    heartbeat.unref()

    request.on('close', () => {
      offNotification(userId, handleNotification)
      clearInterval(heartbeat)
    })
  } catch (error) {
    next(error)
  }
}
