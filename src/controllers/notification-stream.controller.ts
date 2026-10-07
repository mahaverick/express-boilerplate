/**
 * @file `GET /api/v1/notifications/stream`: a Server-Sent Events connection
 * that pushes the authenticated user's notifications live, via
 * notification-emitter.service.ts's Redis pub/sub, behind `requireAuth`.
 * Every rejection (503 shutting down, 401, 429 `too_many_streams`) is thrown
 * before `writeHead`, so `errorHandler` answers it with the ordinary JSON
 * error envelope, not an event stream that closes at once.
 */
import type { NextFunction, Request, Response } from 'express'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import { SSE_MAX_BUFFERED_BYTES } from '@/constants/notification.constants'
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import type { Notification } from '@/database/models/notification.model'
import { HttpError } from '@/errors/http-error'
import {
  countAllStreams,
  countStreams,
  isShuttingDown,
  registerStream,
} from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import { offNotification, onNotification } from '@/services/notification-emitter.service'
import { fetchMissedNotifications } from '@/services/notification.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { errorResponse } from '@/utilities/response.utilities'

/**
 * The SSE `retry:` reconnect delay sent once at connect. An `EventSource`
 * client honours it; the fetch-based react client reconnects on its own
 * backoff and ignores it.
 */
const SSE_RETRY_MS = 3000

/**
 * The `Retry-After`, in seconds, on a refusal at the server-wide stream cap.
 */
const STREAM_CAPACITY_RETRY_AFTER_SECONDS = 30

/**
 * setTimeout's ceiling (2^31-1 ms). A longer delay fires immediately.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * The wire shape of one notification's SSE `data:` line: a subset of what
 * `GET /api/v1/notifications` returns (which also has `userId` and
 * `metadata`). An unread notification carries `readAt: null`, not an absent
 * key, so a client can tell "unread" from "not sent".
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
 * The connected session id `requireAuth` verified this token carries, or a
 * 401 when it verified a token with none.
 *
 * `requireAuth` admits a verified token without `sid` until it expires; this
 * stream does not. The revocation heartbeat closes an open connection by
 * checking its session id against the denylist, so a sid-less stream would
 * outlive a logout or revocation until token expiry. The 401 carries
 * `ACCESS_TOKEN_EXPIRED_CODE`, so a client refreshes and reconnects, and the
 * refreshed token carries `sid`.
 * @param request - The incoming request, already authenticated by `requireAuth`.
 * @returns The session id.
 * @throws {HttpError} 401, when the verified token carries no `sid` claim.
 */
function requireSessionId(request: Request): string {
  if (!request.sessionId) {
    throw new HttpError('Access token missing session', 401, ACCESS_TOKEN_EXPIRED_CODE)
  }
  return request.sessionId
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
    // eslint-disable-next-line unicorn/no-null -- an unread notification serializes readAt as JSON null, not an absent key
    readAt: notification.readAt ? notification.readAt.toISOString() : null,
    createdAt: notification.createdAt.toISOString(),
  }
}

/**
 * Format one notification as a complete SSE frame: `id:`, `event:` and
 * `data:` lines and the blank line that dispatches it, as one string so a
 * single `response.write` sends the whole frame.
 * @param notification - The notification to format.
 * @returns The SSE frame text, including its trailing blank line.
 */
function formatNotificationFrame(notification: Notification): string {
  const payload = toStreamPayload(notification)
  return `id: ${notification.id}\nevent: notification\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Write one notification to an open SSE response, doing nothing when the
 * connection has already ended: a write racing the client's disconnect is
 * expected, not an error.
 * @param response - The open SSE response.
 * @param notification - The notification to deliver.
 */
function writeNotificationEvent(response: Response, notification: Notification): void {
  if (response.writableEnded || response.destroyed) return
  response.write(formatNotificationFrame(notification))
}

/**
 * Decide, before a stream opens, whether to refuse it. A client already gone
 * (it aborted during `requireAuth`'s awaits, before any `'close'` listener
 * exists here) gets nothing, since no listener would ever unregister its
 * stream. Otherwise apply the two stream caps. Over the per-user cap
 * (`SSE_MAX_STREAMS_PER_USER`) throws 429 `too_many_streams`; at the
 * process-wide cap (`SSE_MAX_STREAMS_TOTAL`) answers 503 `stream_capacity`
 * with `Retry-After`, written here rather than thrown: `errorHandler` would
 * mask a 503's message and log it as a fault.
 * @param userId - The authenticated caller.
 * @param request - The incoming request.
 * @param response - The response, still unwritten.
 * @returns True when no stream may open: the client is gone, or the 503 was written.
 * @throws {HttpError} 429 `too_many_streams` over the per-user cap.
 */
function didRefuseStream(userId: string, request: Request, response: Response): boolean {
  if (request.destroyed || response.destroyed) return true
  if (countStreams(userId) >= getEnv().SSE_MAX_STREAMS_PER_USER) {
    throw new HttpError('Too many open notification streams', 429, 'too_many_streams')
  }
  if (countAllStreams() < getEnv().SSE_MAX_STREAMS_TOTAL) return false
  response.setHeader('Retry-After', String(STREAM_CAPACITY_RETRY_AFTER_SECONDS))
  errorResponse(
    response,
    'The server is at its notification stream capacity. Try again shortly.',
    503,
    'stream_capacity'
  )
  return true
}

/**
 * The SSE handler for `GET /api/v1/notifications/stream`.
 */
class NotificationStreamController extends BaseController {
  /**
   * `GET /api/v1/notifications/stream` — open a Server-Sent Events connection
   * for the authenticated user's notifications.
   *
   * The live listener, heartbeat and close handler are registered before the
   * one `await` (the `Last-Event-ID` replay query), not after it. Registered
   * later, a notification emitted during the query would be in neither the
   * replay nor the live stream, and a disconnect during it would fire
   * `'close'` before its listener existed, leaking the subscription and the
   * heartbeat timer. While the query runs, `isReplaying` queues live
   * notifications in `pendingDuringReplay`; after the replay is written the
   * queue is flushed, skipping ids the replay already sent.
   *
   * Only the heartbeat's denylist check recurs on an open connection;
   * `user.active` is not re-read, and the stream ends at access-token expiry,
   * which bounds that gap to one token lifetime.
   *
   * Not wrapped in `handle()`: its own `catch` sits beside the `writeHead`
   * it guards, and every rejection still reaches `next`.
   * @param request - The incoming request, already authenticated by `requireAuth`, and, on reconnect, carrying a `Last-Event-ID` header.
   * @param response - The response, upgraded to an SSE stream once authenticated.
   * @param next - Forwards an authentication failure to the terminal error handler.
   */
  streamNotifications = async (
    request: Request,
    response: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (isShuttingDown()) {
        throw new HttpError('Server is shutting down', 503)
      }
      const userId = authenticatedUserId(request)
      // No await between this and registerStream, so the counts are exact in this process.
      if (didRefuseStream(userId, request, response)) return
      const sessionId = requireSessionId(request)

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // nginx buffers proxied responses by default, which would hold every frame.
        'X-Accel-Buffering': 'no',
      })
      response.flushHeaders()
      response.write(`retry: ${SSE_RETRY_MS}\n`)

      // An unlistened 'error' (a write racing a disconnect) would crash the process.
      response.on('error', (error: unknown) => {
        logger.debug('Notification stream connection error', { error })
      })

      const lastEventId = request.get('Last-Event-ID')

      let isReplaying = Boolean(lastEventId)
      const pendingDuringReplay: Notification[] = []
      // A live copy of a replayed notification can still arrive after the replay.
      const missedIds = new Set<string>()

      const handleNotification = (notification: Notification): void => {
        if (isReplaying) {
          pendingDuringReplay.push(notification)
          return
        }
        if (missedIds.has(notification.id)) return
        writeNotificationEvent(response, notification)
        dropIfStalled()
      }
      onNotification(userId, handleNotification)

      const heartbeat = setInterval(() => {
        if (response.writableEnded || response.destroyed) return
        void (async () => {
          if (await isSessionDenied(sessionId)) {
            clearInterval(heartbeat)
            offNotification(userId, handleNotification)
            response.end()
            return
          }
          // The client may have disconnected during the Redis round trip.
          if (response.writableEnded || response.destroyed) return
          response.write(':ping\n\n')
          dropIfStalled()
        })()
      }, getEnv().SSE_HEARTBEAT_INTERVAL_MS)
      // A referenced timer would hold a test or a graceful shutdown open.
      heartbeat.unref()

      /**
       * The teardown for every server-initiated close: shutdown (registry),
       * token expiry and a stalled client. Safe to call after the stall path
       * has destroyed the response. Unregisters itself, so it needs no
       * request `'close'` to free its registry slot.
       */
      const closeStream = (): void => {
        unregisterStream()
        clearInterval(heartbeat)
        offNotification(userId, handleNotification)
        if (!response.writableEnded && !response.destroyed) response.end()
      }
      const unregisterStream = registerStream(userId, closeStream)

      /**
       * Run after every write: a client over `SSE_MAX_BUFFERED_BYTES` has
       * stopped reading. Destroy, never end: `end()` queues behind the
       * stalled buffer and keeps the socket open. Destroyed first, so
       * `closeStream` skips `end()`; the destroy still fires request
       * `'close'`, which unregisters.
       */
      const dropIfStalled = (): void => {
        if (response.writableLength <= SSE_MAX_BUFFERED_BYTES) return
        response.destroy()
        closeStream()
      }

      // At token expiry the client reconnects, and requireAuth re-checks active and denylist.
      const expiresAt = request.accessTokenExpiresAt
      const msUntilExpiry = expiresAt ? expiresAt.getTime() - Date.now() : 0
      const expiryTimer = expiresAt
        ? setTimeout(closeStream, Math.min(Math.max(0, msUntilExpiry), MAX_TIMER_DELAY_MS))
        : undefined
      expiryTimer?.unref()

      let isClosed = false
      request.on('close', () => {
        isClosed = true
        unregisterStream()
        offNotification(userId, handleNotification)
        clearInterval(heartbeat)
        clearTimeout(expiryTimer)
      })

      if (lastEventId) {
        const missed = await fetchMissedNotifications(userId, lastEventId)
        // Disconnected during the query: the 'close' handler already tore down.
        if (isClosed) return

        for (const notification of missed) {
          missedIds.add(notification.id)
          writeNotificationEvent(response, notification)
          dropIfStalled()
        }

        isReplaying = false
        for (const notification of pendingDuringReplay) {
          if (missedIds.has(notification.id)) continue
          writeNotificationEvent(response, notification)
          dropIfStalled()
        }
      }
    } catch (error) {
      next(error)
    }
  }
}

/**
 * The notification-stream controller the notification routes mount.
 */
export const notificationStreamController = new NotificationStreamController()
