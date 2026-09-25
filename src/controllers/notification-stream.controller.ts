// src/controllers/notification-stream.controller.ts
//
// GET /api/v1/notifications/stream — a Server-Sent Events connection that
// pushes the authenticated user's notifications in real time, via
// notification-emitter.service.ts's Redis pub/sub. Sits behind
// `requireAuth` (auth.middleware.ts) like every other route on
// notification.routes.ts — see that file's header comment for the routing
// reason `/stream` still has to precede the `:id`-shaped routes below it.
//
// This handler has no tolerance for a token that verifies but carries no
// `sid` claim, unlike `requireAuth` itself — see `requireSessionId`'s own
// comment below for why, and `ACCESS_TOKEN_EXPIRED_CODE`'s JSDoc
// (auth.constants.ts) for the three-way split of who emits THAT CODE
// specifically. It is not the full split of what can 401 on this route —
// this route reaches six distinct 401s in total: a missing or malformed
// Authorization header and an invalid token (both `requireAuth`, no `code`),
// an inactive or deleted account (`requireAuth`, no `code`), an expired
// token and a denied session (both `requireAuth`, `ACCESS_TOKEN_EXPIRED_CODE`),
// and a sid-less token (`requireSessionId` below, also
// `ACCESS_TOKEN_EXPIRED_CODE`) — see `tests/integration/api/notification-stream.test.ts`
// for one test per case. A rejected request never opens a stream: the
// shutdown check (503), `authenticatedUserId`, a user already at
// SSE_MAX_STREAMS_PER_USER open streams (429 `too_many_streams`) and
// `requireSessionId` all throw before `response.writeHead` ever runs, so
// the `catch` below hands the rejection to `next(error)` and `errorHandler`
// (error.middleware.ts) answers with this codebase's ordinary JSON error
// envelope — not an event-stream response that immediately closes.
import type { NextFunction, Request, Response } from 'express'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import { SSE_MAX_BUFFERED_BYTES } from '@/constants/notification.constants'
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import type { Notification } from '@/database/models/notification.model'
import { HttpError } from '@/errors/http-error'
import { countStreams, isShuttingDown, registerStream } from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import { offNotification, onNotification } from '@/services/notification-emitter.service'
import { fetchMissedNotifications } from '@/services/notification.service'
import { isSessionDenied } from '@/services/session-denylist.service'

// Sent once, in the `retry:` field of the initial response — SSE's own
// reconnect-delay hint, honoured natively by `EventSource`. No current
// client reads it: react-boilerplate's `useNotificationStream`
// (use-notifications.ts) ignores `retry:` entirely and reconnects on its own
// backoff instead — `fetch`, unlike `EventSource`, has no built-in reconnect
// to feed this to. Kept anyway: it costs nothing, it is correct SSE, and a
// future `EventSource`-based consumer would honour it.
const SSE_RETRY_MS = 3000

// setTimeout's ceiling (2^31-1 ms). A longer delay fires immediately.
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * The wire shape one notification is serialized to for an SSE `data:` line
 * — a subset of the `notifications` row, and of what `GET
 * /api/v1/notifications` returns (which also has `userId` and `metadata`). `readAt` is
 * carried as `string | null`, not omitted when unread, for the same reason
 * `deleteNotification` (notification.controller.ts) returns a JSON `null`
 * rather than nothing: a client parses `data:` as JSON text, where "absent"
 * and "explicitly null" are different, and only the second
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
 * The connected session id `requireAuth` verified this token carries, or a
 * 401 when it verified a token with none.
 *
 * Unlike `requireAuth` itself, which tolerates a token minted before `sid`
 * existed and admits it until it naturally expires (`auth.middleware.ts`'s
 * `payload.sid &&` guard), this stream has no such tolerance. The
 * revocation heartbeat below can only close an ALREADY-OPEN connection by
 * checking a session id against the denylist — it has nothing to check for
 * a sid-less connection — so tolerating one here would let a logged-out or
 * revoked session keep its stream until token expiry, instead of until the
 * next heartbeat. A connect-time 401 is cheap enough that this
 * endpoint does not need the tolerance `requireAuth` grants everywhere
 * else: `useNotificationStream` (react-boilerplate's use-notifications.ts)
 * opens the connection with `fetch`, not `EventSource`, so there is no
 * `onerror` to lean on — it throws when the response is not `ok`, which its
 * own `catch` turns into a call to `scheduleReconnect`, which in turn calls
 * `ensureSession()` (session.ts) — the shared single-flight refresh — before
 * retrying. So a sid-less token costs its holder exactly one failed connect
 * and one automatic refresh, and the new token it comes back with carries
 * `sid`.
 *
 * Message, status and code are unchanged from this codebase's previous
 * `authenticateStreamRequest`, which ran this same check before `/stream`
 * moved behind `requireAuth` — a client that has already learned to treat
 * this rejection as "refresh and retry" keeps working without a client-side
 * change.
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
    // eslint-disable-next-line unicorn/no-null -- the wire format is JSON: an unread notification must serialize readAt as `null`, not omit the key, so a client parsing `data:` can tell "unread" apart from "this server doesn't send readAt" — same reasoning messageResponse (response.utilities.ts) documents for the envelope's `null` data.
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
 * The SSE handler for `GET /api/v1/notifications/stream`.
 */
class NotificationStreamController extends BaseController {
  /**
   * `GET /api/v1/notifications/stream` — open a Server-Sent Events connection
   * for the authenticated user's notifications.
   *
   * EVERYTHING SYNCHRONOUS-UP-FRONT, THE REPLAY QUERY LAST — not the more
   * obvious "replay, then subscribe" order. `fetchMissedNotifications`
   * (notification.service.ts) awaits the database twice; if the live
   * listener, heartbeat, and close handler were registered only after that
   * awaits resolved, two things could go wrong in that window:
   *
   *   - A notification emitted while the query was in flight would be in
   *     neither the replay burst (already queried) nor the live stream (not
   *     subscribed yet) — silently lost until the next reconnect, which is
   *     the exact gap `Last-Event-ID` exists to close.
   *   - A client that disconnects while the query is in flight would fire
   *     `request`'s `'close'` event before this function ever attached a
   *     listener for it — `offNotification`/`clearInterval` would never run,
   *     leaking the subscription and a heartbeat timer for as long as the
   *     process lives.
   *
   * `onNotification`/the heartbeat/`request.on('close')` are registered
   * first, unconditionally, before the one `await` on the reconnect path.
   * While that query is in flight, `isReplaying` routes any live notification
   * into `pendingDuringReplay` instead of writing it immediately; once the
   * queried burst is written, the pending queue is flushed, deduplicated
   * against ids the burst already covered (the two windows can legitimately
   * overlap by one notification).
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
      // Before writeHead, so the rejection is an ordinary JSON 429. There is no
      // await between this and registerStream below, so the count is exact
      // within this process.
      if (countStreams(userId) >= getEnv().SSE_MAX_STREAMS_PER_USER) {
        throw new HttpError('Too many open notification streams', 429, 'too_many_streams')
      }
      const sessionId = requireSessionId(request)

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

      // See this function's own comment for why this is `true` from the
      // start on a reconnect, and why registration below cannot wait for
      // `fetchMissedNotifications` to resolve first.
      let isReplaying = Boolean(lastEventId)
      const pendingDuringReplay: Notification[] = []
      // Ids the replay burst wrote: a live copy can still arrive after it.
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
          // The ONLY recurring check on an open connection.
          // `requireAuth` (denylist and sid tolerance) and `requireSessionId`
          // above ran once, at connect; nothing else revisits them — in
          // particular, nothing here re-reads `user.active`. The stream also
          // ends at token expiry (below), which bounds that gap to one
          // access-token lifetime.
          if (await isSessionDenied(sessionId)) {
            clearInterval(heartbeat)
            // Belt-and-braces: `request.on('close')` below also unsubscribes
            // this handler and would fire shortly after `response.end()`
            // regardless, but calling it here too makes this branch's
            // teardown self-contained rather than depending on a race with
            // an event this same code path is the one triggering.
            offNotification(userId, handleNotification)
            response.end()
            return
          }
          // Re-checked after the `await` above: the client may have
          // disconnected while that Redis round trip was in flight.
          if (response.writableEnded || response.destroyed) return
          response.write(':ping\n\n')
          dropIfStalled()
        })()
      }, getEnv().SSE_HEARTBEAT_INTERVAL_MS)
      // Without this, a pending heartbeat timer keeps the Node event loop
      // alive for as long as the connection is open — fine in production,
      // where the process is meant to stay up, but it would otherwise hang a
      // test (or a graceful shutdown) waiting on a timer nothing else needs.
      heartbeat.unref()

      // One teardown for every server-initiated close: shutdown (registry),
      // token expiry and a stalled client. The destroyed check makes it safe to
      // call after the stall path has destroyed the response.
      const closeStream = (): void => {
        clearInterval(heartbeat)
        offNotification(userId, handleNotification)
        if (!response.writableEnded && !response.destroyed) response.end()
      }
      const unregisterStream = registerStream(userId, closeStream)

      // Run after every write. A client over SSE_MAX_BUFFERED_BYTES has stopped
      // reading. Destroy, never end: end() queues behind the stalled buffer and
      // keeps the socket open, and its closing chunk can still reach the client.
      // Destroyed first, so closeStream() skips end(). Destroy still fires
      // request 'close', which unregisters.
      const dropIfStalled = (): void => {
        if (response.writableLength <= SSE_MAX_BUFFERED_BYTES) return
        response.destroy()
        closeStream()
      }

      // End at token expiry: the client reconnects with a fresh token, and
      // requireAuth re-checks active/denylist. Unref'd so it never holds the
      // process open.
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
        // The client disconnected while that query was in flight — the
        // `'close'` handler above already unsubscribed and cleared the
        // heartbeat; there is nothing left to write.
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
