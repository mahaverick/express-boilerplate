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
import { getEnv } from '@/configs/env.config'
import { MAX_NOTIFICATION_PAGE_SIZE } from '@/constants/notification.constants'
import type { Notification } from '@/database/models/notification.model'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/middlewares/auth.middleware'
import { HttpError } from '@/middlewares/error.middleware'
import { NotificationRepository } from '@/repositories/notification.repository'
import { UserRepository } from '@/repositories/user.repository'
import { logger } from '@/services/logger.service'
import { offNotification, onNotification } from '@/services/notification-emitter.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { verifyAccessToken } from '@/utilities/token.utilities'

const userRepository = new UserRepository()
const notificationRepository = new NotificationRepository()

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
 * Authenticate an SSE connection from an `Authorization: Bearer` header or,
 * failing that, its `?token=` query parameter.
 *
 * The header is read first and wins outright when present. `EventSource` —
 * the only thing that used to open this connection outside a test — cannot
 * set custom request headers at all, which is the whole reason this
 * endpoint ever read a query parameter; the client now opens this
 * connection via `fetch`, which can set one. The query parameter is kept
 * for exactly one release so an old client bundle keeps working while both
 * repos deploy in either order — a later task removes it. Deliberately NOT
 * `requireAuth`: that middleware only ever reads the header, so it alone
 * could never serve a client still reading the query parameter. Everything
 * past "we have a token string" mirrors `requireAuth`'s own steps: verify
 * the signature via `verifyAccessToken`, require a `sid` claim, reject a
 * denied session via `isSessionDenied`, then load and confirm the claimed
 * user is still active — except that, unlike `requireAuth`, there is no
 * tolerance here for a token with no `sid`; see the guard below for why a
 * connect-time rejection is cheap enough that this endpoint does not need
 * one. NOTE: this whole function — including the denylist check — runs
 * ONCE, at connect. The only recurring check on an already-open connection
 * is the heartbeat below, and it checks the session denylist only — it
 * does not re-read `user.active` — so a user deactivated AFTER connecting
 * keeps receiving frames on that already-open stream until it closes for
 * some other reason.
 * @param request - The incoming request, carrying the access token as an `Authorization: Bearer` header or a `?token=` query parameter.
 * @returns The authenticated user's id and the session id its access token carries.
 * @throws {HttpError} 401, when the token is missing, invalid, expired, carries no `sid` claim, its session has been denied, or names no active user.
 */
async function authenticateStreamRequest(
  request: Request
): Promise<{ userId: string; sessionId: string }> {
  // Header FIRST. `EventSource` cannot set one, which is the whole reason
  // this endpoint ever read a query parameter — but the client now uses
  // `fetch`, which can. The query path is kept for exactly one release so an
  // old bundle keeps working while both repos deploy; a later task deletes
  // it.
  const header = request.header('Authorization')
  const fromHeader = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : undefined
  const fromQuery = typeof request.query.token === 'string' ? request.query.token : undefined
  // `||`, deliberately not `??`, and this IS reachable — measured, not
  // assumed. `??` would treat a present-but-empty `fromHeader` as the token
  // and never fall through to `fromQuery`; `||` falls through correctly.
  //
  // Node's HTTP parser strips ASCII spaces and tabs from a header value
  // before Express sees it, so `Authorization: Bearer ` really does arrive
  // as `'Bearer'` and never reaches the `startsWith('Bearer ')` branch. It
  // does NOT strip a non-ASCII space. A raw `0xA0` byte (U+00A0) arrives
  // intact, so the value is `'Bearer '` followed by U+00A0 — length 8, and
  // `startsWith('Bearer ')` is true. `.trim()` then removes the U+00A0,
  // because ECMAScript counts it as whitespace where the HTTP grammar does
  // not, leaving `fromHeader` as `''`. Both facts were checked against a
  // throwaway `node:http` server rather than assumed.
  //
  // Failing closed, so the stakes are a spurious 401 for a malformed
  // client rather than a bypass — but the operator is load-bearing, not
  // decoration. Do not "simplify" it to `??`.
  const token = fromHeader || fromQuery

  if (!token) {
    throw new HttpError('Missing access token', 401)
  }

  const verified = verifyAccessToken(token)
  if (!verified.ok) {
    if (verified.reason === 'expired') {
      throw new HttpError('Access token expired', 401, ACCESS_TOKEN_EXPIRED_CODE)
    }
    throw new HttpError('Invalid access token', 401)
  }

  // Unlike requireAuth's tolerance for a token minted before `sid` existed
  // (auth.middleware.ts), this endpoint has none: a sid-less token is
  // refused outright, before isSessionDenied is even called, since there is
  // nothing to deny. ACCESS_TOKEN_EXPIRED_CODE is carried here, the same
  // code requireAuth uses for an expired or denied token, for what the
  // credential MEANS ("stale, refresh and retry") rather than because the
  // browser reads it — an EventSource that fails to connect exposes no
  // response body or status code to the page at all, so nothing here
  // parses `code` off this specific rejection. What actually recovers a
  // sid-less token is the client's own error handling: `useNotificationStream`
  // (react-boilerplate's use-notifications.ts) treats ANY failed connect
  // as `onerror`, closes it, and reconnects through `ensureSession()`
  // (session.ts) — the shared single-flight refresh — which the hook
  // deliberately calls INSTEAD OF the SSE `retry:` directive's own
  // built-in retry, because that built-in retry would re-request this same
  // URL with this same dead token forever. So a sid-less token costs its
  // holder exactly one failed connect and one automatic refresh, and the
  // new token it comes back with carries `sid`.
  if (!verified.payload.sid) {
    throw new HttpError('Access token missing session', 401, ACCESS_TOKEN_EXPIRED_CODE)
  }

  // Mirrors requireAuth's own guard (auth.middleware.ts): same message,
  // same status, same code. No `payload.sid &&` tolerance here — the guard
  // above already guarantees a sid exists by this point.
  if (await isSessionDenied(verified.payload.sid)) {
    throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
  }

  const user = await userRepository.findById(verified.payload.sub)
  if (!user || !user.active) {
    throw new HttpError('Account no longer exists or is inactive', 401)
  }
  return { userId: user.id, sessionId: verified.payload.sid }
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
 * @param request - The incoming request, carrying the access token as an `Authorization: Bearer` header or a `?token=` query parameter and, on reconnect, a `Last-Event-ID` header.
 * @param response - The response, upgraded to an SSE stream once authenticated.
 * @param next - Forwards an authentication failure to the terminal error handler.
 */
export async function streamNotifications(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId, sessionId } = await authenticateStreamRequest(request)

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
    }
    onNotification(userId, handleNotification)

    const heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed) return
      void (async () => {
        // The ONLY recurring check on an open connection.
        // authenticateStreamRequest (including its own sid and denylist
        // checks) ran once, at connect; nothing else revisits it — in
        // particular, nothing here re-reads `user.active`. This heartbeat
        // is the one check that can close an ALREADY-OPEN stream at all.
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
      })()
    }, getEnv().SSE_HEARTBEAT_INTERVAL_MS)
    // Without this, a pending heartbeat timer keeps the Node event loop
    // alive for as long as the connection is open — fine in production,
    // where the process is meant to stay up, but it would otherwise hang a
    // test (or a graceful shutdown) waiting on a timer nothing else needs.
    heartbeat.unref()

    let isClosed = false
    request.on('close', () => {
      isClosed = true
      offNotification(userId, handleNotification)
      clearInterval(heartbeat)
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
      }

      isReplaying = false
      for (const notification of pendingDuringReplay) {
        if (!missedIds.has(notification.id)) {
          writeNotificationEvent(response, notification)
        }
      }
    }
  } catch (error) {
    next(error)
  }
}
