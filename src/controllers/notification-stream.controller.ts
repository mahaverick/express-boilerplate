// src/controllers/notification-stream.controller.ts
//
// GET /api/v1/notifications/stream — a Server-Sent Events connection that
// pushes the authenticated user's notifications in real time, via
// notification-emitter.service.ts's in-process pub/sub. Sits behind
// `requireAuth` (auth.middleware.ts) like every other route on
// notification.routes.ts — see that file's header comment for the routing
// reason `/stream` still has to precede the `:id`-shaped routes below it.
//
// This handler has no tolerance for a token that verifies but carries no
// `sid` claim, unlike `requireAuth` itself — see `requireSessionId`'s own
// comment below for why, and `ACCESS_TOKEN_EXPIRED_CODE`'s JSDoc
// (auth.middleware.ts) for the three-way split of who emits THAT CODE
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
import { type NextFunction, type Request, type Response } from 'express'
import { getEnv } from '@/configs/env.config'
import {
  MAX_NOTIFICATION_PAGE_SIZE,
  SSE_MAX_BUFFERED_BYTES,
} from '@/constants/notification.constants'
import type { Notification } from '@/database/models/notification.model'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/middlewares/auth.middleware'
import { HttpError } from '@/middlewares/error.middleware'
import { NotificationRepository } from '@/repositories/notification.repository'
import { countStreams, isShuttingDown, registerStream } from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import { offNotification, onNotification } from '@/services/notification-emitter.service'
import { isSessionDenied } from '@/services/session-denylist.service'

const notificationRepository = new NotificationRepository()

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
 * The authenticated principal's id, guarding against a routing mistake that
 * reaches this controller without `requireAuth` ahead of it. Copied from
 * `notification.controller.ts` (which copies it from `profile.controller.ts`
 * in turn) rather than imported — see that file's header comment for why a
 * three-line defensive check is repeated per controller instead of shared.
 * @param request - The incoming request.
 * @returns The authenticated user's id.
 * @throws {HttpError} 401, when `request.user` was never populated.
 */
function authenticatedUserId(request: Request): string {
  if (!request.user) {
    throw new HttpError('Authentication required', 401)
  }
  return request.user.id
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
 * a sid-less connection — so tolerating one here would mean its only
 * exit is the client disconnecting or nginx's own 24-hour read timeout,
 * not `ACCESS_TOKEN_TTL`. A connect-time 401 is cheap enough that this
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
 * Fetch every notification the client missed while disconnected — the pure
 * query half of the `Last-Event-ID` replay.
 *
 * Deliberately split from writing the frames out (that happens in
 * `streamNotifications` itself, not here): this function performs the ONLY
 * `await` in the reconnect path, and `streamNotifications` needs its live
 * listener, heartbeat, and close handler already registered before that
 * await starts — see its own comment for why a version that awaited this
 * query before registering them was a real bug, not a hypothetical one.
 *
 * Bounded to the single most-recent page `NotificationRepository.list`
 * returns (`MAX_NOTIFICATION_PAGE_SIZE` — the same cap
 * `notification.validators.ts`'s own `listNotificationsSchema` already
 * enforces for `GET /api/v1/notifications`): a client that missed more
 * notifications than that in one disconnect still gets caught up on the
 * most recent ones, and can page through the rest via the ordinary REST
 * endpoint, rather than this issuing an unbounded number of `list()` calls
 * before the live stream can even start.
 *
 * Resolves to an empty array — not a 400/404 — when `lastEventId` does not
 * resolve to a notification this user still owns: it may have been deleted
 * (`DELETE /api/v1/notifications/:id`) since the client last saw it, and a
 * reconnect is exactly the moment that should recover gracefully.
 * @param userId - The authenticated connection's owner.
 * @param lastEventId - The `Last-Event-ID` header value the client sent on reconnect.
 * @returns The missed notifications, oldest first — the order they should be replayed in, matching the order the live stream itself delivers in.
 */
async function fetchMissedNotifications(
  userId: string,
  lastEventId: string
): Promise<Notification[]> {
  const cursor = await notificationRepository.findByIdAndUser(lastEventId, userId)
  if (!cursor) return []

  const { notifications } = await notificationRepository.list(userId, {
    limit: MAX_NOTIFICATION_PAGE_SIZE,
  })

  // list() returns newest-first; the caller replays oldest-first.
  return notifications.filter((notification) => isNewerThan(notification, cursor)).toReversed()
}

/**
 * `GET /api/v1/notifications/stream` — open a Server-Sent Events connection
 * for the authenticated user's notifications.
 *
 * EVERYTHING SYNCHRONOUS-UP-FRONT, THE REPLAY QUERY LAST — not the more
 * obvious "replay, then subscribe" order. `fetchMissedNotifications`
 * (above) awaits the database twice; if the live listener, heartbeat, and
 * close handler were registered only after that awaits resolved, two things
 * could go wrong in that window:
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
 * @param request - The incoming request, already authenticated by `requireAuth`, and, on reconnect, carrying a `Last-Event-ID` header.
 * @param response - The response, upgraded to an SSE stream once authenticated.
 * @param next - Forwards an authentication failure to the terminal error handler.
 */
export async function streamNotifications(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
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

    const handleNotification = (notification: Notification): void => {
      if (isReplaying) {
        pendingDuringReplay.push(notification)
        return
      }
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
    // reading. Destroy, not just end: end() queues behind the stalled buffer
    // and keeps the socket open. Destroy still fires request 'close', which
    // unregisters.
    const dropIfStalled = (): void => {
      if (response.writableLength <= SSE_MAX_BUFFERED_BYTES) return
      closeStream()
      response.destroy()
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

      const missedIds = new Set(missed.map((notification) => notification.id))
      for (const notification of missed) {
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
