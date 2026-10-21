/**
 * @file Integration test against this worker's real Postgres database (see
 * tests/helpers/worker-database.ts), with the same cleanup convention as
 * tests/integration/api/notification.test.ts: every user created here is deleted in afterEach, and
 * notifications cascade off that delete (ON DELETE CASCADE, notification.model.ts). It cannot use
 * `request(app)` (supertest) end to end, which never resolves for a response that never ends; see
 * `SseConnection`.
 */

import { randomUUID } from 'node:crypto'
import http, { type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import { SSE_MAX_BUFFERED_BYTES } from '@/constants/notification.constants'
import type { Notification } from '@/database/models/notification.model'
import type { User } from '@/database/models/user.model'
import { NotificationRepository } from '@/repositories/notification.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import {
  countAllStreams,
  countStreams,
  markShuttingDown,
  registerStream,
  resetLifecycleForTests,
} from '@/services/lifecycle.service'
import {
  closeNotificationSubscriber,
  emitNotification,
  listenerCount,
  offNotification,
  onNotification,
} from '@/services/notification-emitter.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { getRedis } from '@/services/redis.service'
import { denySession, isSessionDenied } from '@/services/session-denylist.service'
import {
  issueRefreshToken,
  revokeOtherSessions,
  revokeRefreshToken,
  signAccessToken,
} from '@/services/session.service'
import { startNotificationWorker } from '@/workers/notification.worker'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { deferred } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'
import { waitForNotificationSubscriber } from '../../helpers/notification-subscriber'
import { settle, waitUntil } from '../../helpers/timing'

const userRepository = new UserRepository()
const notificationRepository = new NotificationRepository()
const tenantRepository = new TenantRepository()

/**
 * One parsed SSE event: the `id`, `event` and `data` fields of a block. Other fields, such as
 * `retry`, are parsed but not kept.
 */
interface SseFrame {
  id?: string
  event?: string
  data?: string
}

/**
 * Parses one `\n`-joined block of SSE field lines (everything between two `\n\n` boundaries) into
 * an `SseFrame`. Lines starting with `:` (the `:ping` heartbeat) and lines with no `:` are skipped.
 * The first block a connection parses is the server's `retry: 3000\n`, which is sent with a single
 * trailing newline and so merges with whatever the next write is; parsing field by field keeps
 * that harmless.
 * @param raw - The raw block, without its trailing blank line.
 */
function parseSseBlock(raw: string): SseFrame {
  const frame: SseFrame = {}
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue
    const field = line.slice(0, separatorIndex)
    const value = line.slice(separatorIndex + 1).trimStart()
    applyField(frame, field, value)
  }
  return frame
}

/**
 * Applies one parsed `field: value` pair to `frame`. A standalone function because
 * `unicorn/prefer-switch` wants a `switch` here while `unicorn/no-break-in-nested-loop` forbids a
 * `break` in a `switch` inside `parseSseBlock`'s loop.
 * @param frame - The frame being built. Mutated in place.
 * @param field - The field name, e.g. `id`, `event`, `data` or `retry`.
 */
function applyField(frame: SseFrame, field: string, value: string): void {
  switch (field) {
    case 'id': {
      frame.id = value
      break
    }
    case 'event': {
      frame.event = value
      break
    }
    case 'data': {
      frame.data = value
      break
    }
    // Any other field (e.g. retry) is parsed but not captured: nothing in this file asserts on it.
    default:
  }
}

/**
 * A raw `node:http` connection to `/api/v1/notifications/stream` that buffers and parses the SSE
 * byte stream as it arrives. supertest resolves a request only once its response has ended, and an
 * SSE response never ends on its own, so this file also opens its own `http.Server` (see
 * `beforeAll`) instead of using `request(app)`.
 */
class SseConnection {
  private buffer = ''
  private readonly ready: Promise<IncomingMessage>
  private readonly ended: Promise<void>
  /**
   * How many of `frames` `nextFrame` has already handed out, so repeated calls advance instead of
   * returning the first frame again.
   */
  private nextFrameIndex = 0
  readonly request: http.ClientRequest
  response: IncomingMessage | undefined
  /**
   * Every frame parsed so far, in arrival order.
   */
  readonly frames: SseFrame[] = []
  /**
   * The full, unparsed byte stream received so far, for assertions (the heartbeat test) that only
   * care about a raw substring, not framing.
   */
  rawText = ''

  /**
   * Open the connection.
   * @param baseUrl - The test server's own `http://127.0.0.1:<port>` origin.
   * @param path - The request path, including any query string.
   * @param headers - Extra request headers, e.g. `Last-Event-ID`.
   */
  constructor(baseUrl: string, path: string, headers: Record<string, string> = {}) {
    let resolveReady: (response: IncomingMessage) => void
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- tsconfig.json pins `lib: ["ES2023"]`; `Promise.withResolvers` is ES2024 and untyped under it.
    this.ready = new Promise((resolve) => {
      resolveReady = resolve
    })
    let resolveEnded: () => void
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- see the disable above.
    this.ended = new Promise((resolve) => {
      resolveEnded = resolve
    })

    this.request = http.get(`${baseUrl}${path}`, { headers }, (response) => {
      this.response = response
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        this.rawText += chunk
        this.buffer += chunk
        let boundary = this.buffer.indexOf('\n\n')
        while (boundary !== -1) {
          this.frames.push(parseSseBlock(this.buffer.slice(0, boundary)))
          this.buffer = this.buffer.slice(boundary + 2)
          boundary = this.buffer.indexOf('\n\n')
        }
      })
      response.on('end', () => resolveEnded())
      resolveReady(response)
    })

    // Destroying an in-flight request can surface as an 'error' event on the request itself, and an unlistened 'error' event on a Node stream throws.
    this.request.on('error', () => {
      // Expected on a deliberate destroy(); nothing to act on.
    })
  }

  /**
   * Waits for the response's headers and returns the response, with `.statusCode` and `.headers`
   * populated.
   */
  async waitForResponse(): Promise<IncomingMessage> {
    return this.ready
  }

  /**
   * Waits for a non-streaming response (the 401 rejections) to finish.
   */
  async collectBody(): Promise<string> {
    await this.ended
    return this.rawText
  }

  /**
   * Closes the connection. Idempotent, so a test's assertions and `afterEach` can both call it.
   */
  destroy(): void {
    this.request.destroy()
  }

  /**
   * Waits for the next frame this connection has not yet handed out, which proves the stream is
   * delivering and not merely that headers arrived.
   * @param timeoutMs - How long to wait before giving up. Defaults to 5000ms.
   * @throws {Error} When no new frame arrives within `timeoutMs`.
   */
  async nextFrame(timeoutMs = 5000): Promise<SseFrame> {
    await waitUntil(() => this.frames.length > this.nextFrameIndex, {
      message: `SSE frame ${String(this.nextFrameIndex)} arrives`,
      timeout: timeoutMs,
    })
    const frame = this.frames[this.nextFrameIndex]
    this.nextFrameIndex += 1
    if (!frame) {
      throw new Error('unreachable: waitUntil already guaranteed a frame at this index')
    }
    return frame
  }

  /**
   * Whether the server ended this response within `timeoutMs`. Resolves `false` on a timeout
   * instead of rejecting, so a test asserting a stream stays open needs no catch.
   */
  async closed(timeoutMs: number): Promise<boolean> {
    // The losing settle keeps its timer until it fires; nothing waits on it.
    const timedOut = (async (): Promise<boolean> => {
      await settle(timeoutMs, 'timeout arm: a stream that stays open has no event')
      return false
    })()
    const endPromise = (async (): Promise<boolean> => {
      await this.ended
      return true
    })()
    return Promise.race([endPromise, timedOut])
  }
}

/**
 * A disposable email unique to this call, so it cannot collide with rows other
 * tests in this worker's database hold.
 */
function uniqueEmail(): string {
  return `notification-stream-${randomUUID()}@example.test`
}

/**
 * Inserts one `tenant_invitation` notification through the repository, as `processNotificationJob`
 * (notification.worker.ts) does before it calls `emitNotification`, without running BullMQ or the
 * worker.
 */
async function seedNotification(
  userId: string,
  title = 'You have an invitation'
): Promise<Notification> {
  return notificationRepository.create({
    userId,
    type: 'tenant_invitation',
    title,
    body: 'Click the link to verify your email address.',
  })
}

/**
 * Emit a never-persisted sentinel and wait for its frame. It crosses the same
 * Redis channel, handler and response as every earlier emit, in order, so
 * once it arrives nothing emitted before it is still in flight.
 * @returns The notification frames that arrived before the sentinel.
 */
async function framesBeforeSentinel(
  connection: SseConnection,
  userId: string
): Promise<SseFrame[]> {
  const sentinelId = randomUUID()
  emitNotification(userId, {
    id: sentinelId,
    userId,
    type: 'tenant_invitation',
    title: 'Sentinel',
    body: 'Marks the end of what was emitted before it.',
    // oxlint-disable-next-line unicorn/no-null -- Notification.metadata/readAt are `T | null` columns
    metadata: null,
    // oxlint-disable-next-line unicorn/no-null -- see above
    readAt: null,
    // oxlint-disable-next-line unicorn/no-null -- see above
    dedupeKey: null,
    createdAt: new Date(),
  })
  const sentinelIndex = await waitUntil(
    () => {
      const index = connection.frames.findIndex((frame) => frame.id === sentinelId)
      return index === -1 ? undefined : index + 1
    },
    { message: 'the sentinel frame arrives' }
  )
  return connection.frames
    .slice(0, sentinelIndex - 1)
    .filter((frame) => frame.event === 'notification')
}

/**
 * `emitNotification` is called directly in several tests below instead of through a real
 * `NotificationWorker` job: this file tests the SSE endpoint, not the whole pipeline.
 * tests/unit/workers/notification.worker.test.ts covers that `processNotificationJob` calls
 * `emitNotification` after a successful insert.
 */
describe('GET /api/v1/notifications/stream', () => {
  let server: http.Server
  let baseUrl: string
  const createdUserIds: string[] = []
  const openConnections: SseConnection[] = []

  /**
   * A dedicated server, not tests/integration/server.test.ts's `startServer`/`gracefulShutdown`:
   * this file's cleanup must destroy every open SSE connection before the server can close (an SSE
   * response never ends on its own, so `server.close()`'s callback would otherwise never fire), and
   * `gracefulShutdown` also closes the database pool this file's cleanup still needs.
   */
  beforeAll(async () => {
    server = createApp().listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
    // Live delivery crosses Redis: wait until this process's subscriber is listening.
    await waitForNotificationSubscriber({ onNotification, offNotification }, getRedis)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeNotificationSubscriber()
    // The invitation test's jobs: its Worker is closed by then, and nothing consumes the email.
    await getEmailQueue().obliterate({ force: true })
    await getAuthEmailQueue().obliterate({ force: true })
    await getNotificationQueue().obliterate({ force: true })
    await closeQueue()
  })

  afterEach(async () => {
    resetLifecycleForTests()
    for (const connection of openConnections) connection.destroy()
    openConnections.length = 0

    await truncateAuditLogs()
    if (createdUserIds.length === 0) {
      return
    }

    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Opens an SSE connection and tracks it, so `afterEach` destroys it even if the test never does.
   * Takes a raw `path` (with optional `headers`), or `{ header?, query? }` to request the fixed
   * stream path with an `Authorization` header and/or a `?token=` query parameter, so the Bearer
   * tests don't each assemble a URL and header.
   * @param pathOrAuth - The request path (including any query string), or `{ header?, query? }` to build a request against the stream endpoint.
   * @param headers - Extra request headers, e.g. `Last-Event-ID`. Only used when `pathOrAuth` is a path string.
   */
  function openStream(
    pathOrAuth: string | { header?: string; query?: string },
    headers: Record<string, string> = {}
  ): SseConnection {
    let path: string
    let requestHeaders: Record<string, string>
    if (typeof pathOrAuth === 'string') {
      path = pathOrAuth
      requestHeaders = headers
    } else {
      const { header, query } = pathOrAuth
      path = query
        ? `/api/v1/notifications/stream?token=${encodeURIComponent(query)}`
        : '/api/v1/notifications/stream'
      requestHeaders = header ? { Authorization: header } : {}
    }
    const connection = new SseConnection(baseUrl, path, requestHeaders)
    openConnections.push(connection)
    return connection
  }

  /**
   * Creates a disposable user, signs an access token for it and tracks the row for cleanup.
   */
  async function createAuthenticatedUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  /**
   * Opens an authenticated SSE stream for a new user's new session and keeps that session's
   * refresh token. Unlike `createAuthenticatedUser`, whose `signAccessToken(user, randomUUID())`
   * has no refresh row, a caller here can revoke this exact session, as logout does.
   */
  async function openStreamForNewSession(): Promise<{
    stream: SseConnection
    userId: string
    refreshToken: string
  }> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    const issued = await issueRefreshToken(user.id, randomUUID())
    const token = signAccessToken(user, issued.sessionId)

    const stream = openStream({ header: `Bearer ${token}` })
    await stream.waitForResponse()

    return { stream, userId: user.id, refreshToken: issued.raw }
  }

  it('delivers a tenant invitation, via the notification worker, to the invitee’s open stream', async () => {
    const owner = await userRepository.create({
      email: uniqueEmail(),
      firstName: 'Ada',
      lastName: 'Lovelace',
      emailVerifiedAt: new Date(),
    })
    createdUserIds.push(owner.id)
    // Verified, so the invitation also notifies them in-app.
    const invitee = await userRepository.create({
      email: uniqueEmail(),
      emailVerifiedAt: new Date(),
    })
    createdUserIds.push(invitee.id)
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId: owner.id,
    })
    const worker = startNotificationWorker()
    try {
      const connection = openStream({
        header: `Bearer ${signAccessToken(invitee, randomUUID())}`,
      })
      await connection.waitForResponse()

      const invited = await fetch(`${baseUrl}/api/v1/tenants/${tenant.slug}/invitations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${signAccessToken(owner, randomUUID())}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: invitee.email, role: 'editor' }),
      })
      expect(invited.status).toBe(202)

      await waitUntil(() => connection.frames.some((frame) => frame.event === 'notification'), {
        message: 'the invitation notification frame arrives',
        timeout: 10_000,
      })
      const frame = connection.frames.find((frame) => frame.event === 'notification')
      const delivered = JSON.parse(frame?.data ?? 'null') as Record<string, unknown>
      expect(delivered).toMatchObject({
        type: 'tenant_invitation',
        title: 'Invitation to Acme Inc',
      })
      // The frame carries no owner or metadata; the stored row does.
      const row = await notificationRepository.findByIdAndUser(frame?.id ?? '', invitee.id)
      expect(row?.metadata).toMatchObject({ tenantSlug: tenant.slug })
    } finally {
      await worker.close()
      await truncateAuditLogs()
      await sql`delete from tenants where id = ${tenant.id}`
    }
  })

  it('opens an SSE stream with the expected headers for a valid Bearer token', async () => {
    const { token } = await createAuthenticatedUser()

    const connection = openStream({ header: `Bearer ${token}` })
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream')
    expect(response.headers['cache-control']).toBe('no-cache')
    expect(response.headers.connection).toBe('keep-alive')
    expect(response.headers['x-accel-buffering']).toBe('no')
  })

  // Same request as the test above; only the shutdown flag differs.
  it('refuses to open a stream once shutdown has begun, as a 503 JSON response', async () => {
    const { token } = await createAuthenticatedUser()
    markShuttingDown()

    const connection = openStream({ header: `Bearer ${token}` })
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(503)
    expect(response.headers['content-type']).not.toContain('text/event-stream')
    const body = await connection.collectBody()
    expect((JSON.parse(body) as { success: boolean }).success).toBe(false)
  })

  // /stream sits behind requireAuth like every other route, so "no credential at all" is requireAuth's own getBearerToken rejection, not anything this controller throws. The message (and the absence of a code) distinguishes it from the sid-less and denied-session 401s below, both of which carry ACCESS_TOKEN_EXPIRED_CODE.
  it("rejects a connection with no credential at all, as requireAuth's ordinary 401 JSON response, not a stream", async () => {
    const connection = openStream('/api/v1/notifications/stream')
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).not.toContain('text/event-stream')

    const body = await connection.collectBody()
    const parsed = JSON.parse(body) as { success: boolean; message: string; code?: string }
    expect(parsed.success).toBe(false)
    expect(parsed.message).toBe('Sign in to continue.')
    expect(parsed.code).toBeUndefined()
  })

  // A well-formed, valid token in the query string must be rejected exactly like no credential at all: requireAuth never reads request.query and nothing else on this route does either. If a query-parameter path were reachable anywhere, this would return 200, not 401.
  it('no longer authenticates from a ?token= query parameter, even a valid one, now that the query path is deleted', async () => {
    const { token } = await createAuthenticatedUser()

    const connection = openStream({ query: token })
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).not.toContain('text/event-stream')

    const body = await connection.collectBody()
    const parsed = JSON.parse(body) as { message: string; code?: string }
    expect(parsed.message).toBe('Sign in to continue.')
    expect(parsed.code).toBeUndefined()
  })

  it('rejects a connection with an invalid token', async () => {
    const connection = openStream({ header: 'Bearer not-a-real-jwt' })
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(401)
    const body = await connection.collectBody()
    expect((JSON.parse(body) as { message: string }).message).toBe(
      "We don't recognize this sign-in. Sign in again to continue."
    )
  })

  it('rejects a connection with an expired token, carrying the distinguishable code', async () => {
    const token = jwt.sign({ sub: randomUUID() }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      // Already expired when signed, as in tests/integration/middlewares/auth.middleware.test.ts's "rejects an expired access token".
      expiresIn: -10,
    })

    const connection = openStream({ header: `Bearer ${token}` })
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(401)
    const body = await connection.collectBody()
    const parsed = JSON.parse(body) as { message: string; code?: string }
    expect(parsed.code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
    expect(parsed.message).toBe('Your sign-in expired. Sign in again to continue.')
  })

  it('rejects a connection whose token belongs to no active user', async () => {
    const { user, token } = await createAuthenticatedUser()
    await sql`delete from users where id = ${user.id}`
    createdUserIds.length = 0 // already deleted directly above

    const connection = openStream({ header: `Bearer ${token}` })
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(401)
    const body = await connection.collectBody()
    expect((JSON.parse(body) as { message: string }).message).toBe(
      'This account is deactivated or deleted. Sign in with another account, or ask your team admin.'
    )
  })

  // Real time, not a fake timer: this proves the actual setInterval wired into a live connection fires — a mocked clock would only prove this file's own mock advances correctly. SSE_HEARTBEAT_INTERVAL_MS is set to 1000ms in .env.test so this test doesn't have to wait out the real 30-second production interval.
  it('sends a heartbeat comment within a few seconds', async () => {
    const { token } = await createAuthenticatedUser()
    const connection = openStream({ header: `Bearer ${token}` })
    await connection.waitForResponse()

    await waitUntil(() => connection.rawText.includes(':ping'), {
      message: 'a heartbeat comment arrives',
      interval: 100,
    })
    expect(connection.rawText).toContain(':ping')
  }, 10_000)

  it('delivers a notification published via the emitter, in the documented SSE frame format', async () => {
    const { user, token } = await createAuthenticatedUser()
    const connection = openStream({ header: `Bearer ${token}` })
    await connection.waitForResponse()
    // No await separates the controller's flushHeaders() from its onNotification registration, so this states the precondition and normally passes on the first check.
    await waitUntil(() => listenerCount(user.id) === 1, {
      message: "the stream's notification listener is registered",
    })

    const notification = await seedNotification(user.id, 'Pushed live')
    emitNotification(user.id, notification)

    await waitUntil(() => connection.frames.some((frame) => frame.event === 'notification'), {
      message: 'the live notification frame arrives',
    })

    const frame = connection.frames.find((candidate) => candidate.event === 'notification')
    expect(frame?.id).toBe(notification.id)
    expect(JSON.parse(frame?.data ?? '{}')).toEqual({
      id: notification.id,
      type: 'tenant_invitation',
      title: 'Pushed live',
      body: notification.body,
      // oxlint-disable-next-line unicorn/no-null -- asserting against the actual wire value: the SSE payload serializes an unread notification's readAt as JSON `null` (notification-stream.controller.ts's toStreamPayload), and `JSON.parse` produces a real `null` here, not `undefined`.
      readAt: null,
      createdAt: notification.createdAt.toISOString(),
    })
  })

  it('replays notifications created after Last-Event-ID on reconnect, oldest first', async () => {
    const { user, token } = await createAuthenticatedUser()
    const first = await seedNotification(user.id, 'First')
    const second = await seedNotification(user.id, 'Second')
    const third = await seedNotification(user.id, 'Third')

    const connection = openStream('/api/v1/notifications/stream', {
      Authorization: `Bearer ${token}`,
      'Last-Event-ID': first.id,
    })
    await connection.waitForResponse()

    await waitUntil(
      () => connection.frames.filter((frame) => frame.event === 'notification').length >= 2,
      { message: 'both replayed notification frames arrive' }
    )

    const replayed = connection.frames.filter((frame) => frame.event === 'notification')
    expect(replayed.map((frame) => frame.id)).toEqual([second.id, third.id])
  })

  it('does not lose a notification emitted while a reconnect’s replay query is still in flight', async () => {
    // streamNotifications must call onNotification before awaiting fetchMissedNotifications, or a notification published during that database round trip would land in neither the replay burst nor the live stream. This test does not control exactly when the emit lands relative to the query, but emitting immediately after the connection's headers arrive gives it the best chance of landing inside that window, and the assertion (delivered exactly once) holds regardless of which side of the query it actually lands on.
    const { user, token } = await createAuthenticatedUser()
    const first = await seedNotification(user.id, 'First')

    const connection = openStream('/api/v1/notifications/stream', {
      Authorization: `Bearer ${token}`,
      'Last-Event-ID': first.id,
    })
    await connection.waitForResponse()

    const live = await seedNotification(user.id, 'Live during replay')
    emitNotification(user.id, live)

    await waitUntil(() => connection.frames.some((frame) => frame.event === 'notification'), {
      message: 'the live notification frame arrives',
    })

    const delivered = await framesBeforeSentinel(connection, user.id)
    expect(delivered.map((frame) => frame.id)).toEqual([live.id])
  })

  /**
   * The deterministic version of the race the test above only hits by chance: `withMutatedMethod`
   * holds `findByIdAndUser` (the first of `fetchMissedNotifications`'s two queries) at a gate until
   * both notifications below have reached the stream's handler, so `isReplaying` is still true when
   * they arrive. That exercises both branches of the flush loop: a notification that also landed in
   * the missed burst (persisted before the replay query ran) is delivered exactly once, deduped out
   * of `pendingDuringReplay` by its `missedIds` check, and one with no row at all can never appear
   * in that burst and must still reach the client through the flush loop.
   */
  it('routes notifications emitted during replay through the pending queue — deduping one already in the missed burst, flushing one that is not', async () => {
    const { user, token } = await createAuthenticatedUser()
    const first = await seedNotification(user.id, 'First')

    const gate = { entered: false }
    const release = deferred()
    // oxlint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
    const realFindByIdAndUser = NotificationRepository.prototype.findByIdAndUser
    /**
     * Holds `findByIdAndUser` at `gate` until the test releases it.
     */
    const gatedFindByIdAndUser: typeof realFindByIdAndUser = async function (
      this: NotificationRepository,
      id,
      userId
    ) {
      const result = await realFindByIdAndUser.call(this, id, userId)
      gate.entered = true
      await release.promise
      return result
    }
    const passedStreamHandler = new Set<string>()
    /**
     * Registered after the stream's handler, so it hears each notification second and records which
     * ones have passed that handler.
     */
    const hearAfterStream = (notification: Notification): void => {
      passedStreamHandler.add(notification.id)
    }

    await withMutatedMethod(
      NotificationRepository.prototype,
      'findByIdAndUser',
      gatedFindByIdAndUser,
      async () => {
        try {
          const connection = openStream('/api/v1/notifications/stream', {
            Authorization: `Bearer ${token}`,
            'Last-Event-ID': first.id,
          })
          await connection.waitForResponse()
          // The controller calls onNotification before this query, so its handler is already registered.
          await waitUntil(() => gate.entered, { message: 'the replay query reaches its gate' })
          onNotification(user.id, hearAfterStream)

          const persistedLive = await seedNotification(user.id, 'Persisted, in the missed burst')
          emitNotification(user.id, persistedLive)

          // Never inserted — the replay query's own list() call can never find it, so it cannot be in missedIds however long the gate holds.
          const ephemeralLive: Notification = {
            ...persistedLive,
            id: randomUUID(),
            title: 'Ephemeral, never persisted',
            createdAt: new Date(persistedLive.createdAt.getTime() + 1),
          }
          emitNotification(user.id, ephemeralLive)

          // Listeners run in registration order, so the stream's handler has queued both while isReplaying was still true.
          await waitUntil(
            () =>
              passedStreamHandler.has(persistedLive.id) &&
              passedStreamHandler.has(ephemeralLive.id),
            { message: "both notifications reach the stream's handler during the replay" }
          )
          release.resolve()

          await waitUntil(
            () => connection.frames.filter((frame) => frame.event === 'notification').length >= 2,
            { message: 'both notification frames arrive after the replay' }
          )

          const delivered = await framesBeforeSentinel(connection, user.id)
          expect(delivered.filter((frame) => frame.id === persistedLive.id)).toHaveLength(1)
          expect(delivered.filter((frame) => frame.id === ephemeralLive.id)).toHaveLength(1)
        } finally {
          release.resolve()
          offNotification(user.id, hearAfterStream)
        }
      }
    )
  })

  it('does not write a live copy of a notification its replay burst already wrote', async () => {
    const { user, token } = await createAuthenticatedUser()
    const first = await seedNotification(user.id, 'First')
    const replayed = await seedNotification(user.id, 'In the replay burst')

    const connection = openStream('/api/v1/notifications/stream', {
      Authorization: `Bearer ${token}`,
      'Last-Event-ID': first.id,
    })
    await connection.waitForResponse()
    await waitUntil(() => connection.frames.some((frame) => frame.id === replayed.id), {
      message: 'the replayed notification frame arrives',
    })

    // Its live copy arrives after the replay finished, as a Redis round trip can.
    emitNotification(user.id, replayed)

    const delivered = await framesBeforeSentinel(connection, user.id)
    expect(delivered.map((frame) => frame.id)).toEqual([replayed.id])
  })

  it('does not leak its listener when the client disconnects while a reconnect’s replay query is still in flight', async () => {
    // response.on('close') must also be registered before the replay query, or a disconnect during that window fires 'close' before any handler was attached, leaking the subscription and the heartbeat timer for the life of the process. Destroying as soon as the response headers arrive gives the disconnect its best chance of landing inside that window; listenerCount reaching 0 either way is the invariant.
    const { user, token } = await createAuthenticatedUser()
    const first = await seedNotification(user.id, 'First')

    const connection = openStream('/api/v1/notifications/stream', {
      Authorization: `Bearer ${token}`,
      'Last-Event-ID': first.id,
    })
    await connection.waitForResponse()
    connection.destroy()

    await waitUntil(() => listenerCount(user.id) === 0, {
      message: 'the disconnected stream removes its listener',
      timeout: 2000,
    })
    expect(listenerCount(user.id)).toBe(0)
  })

  it('does not replay anything when Last-Event-ID does not resolve to a notification this user owns', async () => {
    const { user, token } = await createAuthenticatedUser()
    await seedNotification(user.id, 'Only notification')

    const connection = openStream('/api/v1/notifications/stream', {
      Authorization: `Bearer ${token}`,
      'Last-Event-ID': randomUUID(),
    })
    const response = await connection.waitForResponse()
    expect(response.statusCode).toBe(200)

    // Queued behind the replay, so it arrives after any wrongly replayed burst.
    expect(await framesBeforeSentinel(connection, user.id)).toEqual([])
  })

  it('stops delivering events and removes its listener once the client disconnects', async () => {
    const { user, token } = await createAuthenticatedUser()
    const connection = openStream({ header: `Bearer ${token}` })
    await connection.waitForResponse()
    await waitUntil(() => listenerCount(user.id) === 1, {
      message: "the stream's notification listener is registered",
      timeout: 2000,
    })

    connection.destroy()
    await waitUntil(() => listenerCount(user.id) === 0, {
      message: 'the disconnected stream removes its listener',
      timeout: 2000,
    })

    const notification = await seedNotification(user.id, 'After close')
    expect(() => emitNotification(user.id, notification)).not.toThrow()
  })

  it('removes a stream from the shutdown registry once its client disconnects', async () => {
    const { user, token } = await createAuthenticatedUser()
    const connection = openStream({ header: `Bearer ${token}` })
    await connection.waitForResponse()
    expect(countStreams(user.id)).toBe(1)

    connection.destroy()
    await vi.waitFor(() => expect(countStreams(user.id)).toBe(0))
  })

  /**
   * requireAuth rejects a denied session only at connect and never runs again on a connection
   * already open; this controller runs no denylist check of its own at connect (its only
   * connect-time check is requireSessionId; the "refuses to open a stream for an already-denied
   * session" test below covers the denied path). The heartbeat is the only
   * thing that recurs on an open SSE connection, so it is the only place a revoked session can be
   * caught, and this test proves that closes the stream.
   */
  it('closes an open stream once its session is revoked', async () => {
    const { stream, userId, refreshToken } = await openStreamForNewSession()

    // Alive first, or the assertion below proves nothing: with nothing emitted, the first frame is the heartbeat's.
    await expect(stream.nextFrame()).resolves.toBeDefined()

    await revokeRefreshToken(refreshToken)

    // Within one heartbeat, not immediately: the check rides the existing interval rather than adding a second timer.
    await expect(stream.closed(getEnv().SSE_HEARTBEAT_INTERVAL_MS * 2)).resolves.toBe(true)

    // The heartbeat's own close path must clean up exactly like an ordinary client disconnect does, not merely end the HTTP response while leaving the emitter subscription behind.
    await waitUntil(() => listenerCount(userId) === 0, {
      message: 'the revoked stream removes its listener',
      timeout: 2000,
    })
    expect(listenerCount(userId)).toBe(0)
  }, 10_000)

  // Signing out other sessions writes the same denylist entry a revocation does; this proves it reaches a live stream of the revoked session and spares the caller's.
  it('closes another session’s open stream when the user signs out their other sessions', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    const caller = await issueRefreshToken(user.id, randomUUID())
    const other = await issueRefreshToken(user.id, randomUUID())
    const stream = openStream({ header: `Bearer ${signAccessToken(user, other.sessionId)}` })
    await stream.waitForResponse()
    // Alive first, or the close below proves nothing.
    await expect(stream.nextFrame()).resolves.toBeDefined()

    await expect(revokeOtherSessions(user.id, caller.sessionId)).resolves.toBe(1)

    await expect(stream.closed(getEnv().SSE_HEARTBEAT_INTERVAL_MS * 2)).resolves.toBe(true)
    await waitUntil(() => listenerCount(user.id) === 0, {
      message: 'the revoked stream removes its listener',
      timeout: 2000,
    })
    expect(await isSessionDenied(caller.sessionId)).toBe(false)
  }, 10_000)

  /**
   * Pairs with the test above, which proves a session denied after connect closes an open stream
   * (the heartbeat). This one proves a session denied before connect never opens a stream, through
   * `requireAuth`'s own denylist check, not one this controller runs. It is told apart from the
   * sid-less rejection below by message: both carry `ACCESS_TOKEN_EXPIRED_CODE`, but only
   * `requireAuth`'s denylist rejection says "This session ended. Sign in again to continue.".
   */
  it("refuses to open a stream for an already-denied session, via requireAuth's denylist check", async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    const sessionId = randomUUID()
    const token = signAccessToken(user, sessionId)

    // denySession directly, not revokeRefreshToken: this test is about requireAuth's own denylist read, not about revocation writing that entry.
    await denySession(sessionId)

    const connection = openStream({ header: `Bearer ${token}` })
    const response = await connection.waitForResponse()

    // requireAuth's rejection happens before response.writeHead, so this is the ordinary JSON 401 envelope, not an event-stream that opens and then closes.
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).not.toContain('text/event-stream')

    const body = await connection.collectBody()
    const parsed = JSON.parse(body) as { message: string; code?: string }
    expect(parsed.message).toBe('This session ended. Sign in again to continue.')
    expect(parsed.code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
  })

  /**
   * The next two tests are a pair: a positive control proving the fixture is sound, and the actual
   * assertion. `requireAuth` tolerates a sid-less token until it expires, but this route's handler
   * does not (see `requireSessionId`), so a token `requireAuth` accepts must still fail to open a
   * stream on this controller's own check.
   */
  it('opens a stream for an ordinary signAccessToken token — the positive control for the next test', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    const token = signAccessToken(user, randomUUID())

    const connection = openStream({ header: `Bearer ${token}` })
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream')
  })

  it("refuses to open a stream for a hand-signed token with no `sid` claim at all, via this route's own check after requireAuth", async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    // Hand-signed, deliberately not via signAccessToken: signAccessToken always sets sid, so it cannot produce a token whose payload never had a sid key at all.
    const token = jwt.sign({ sub: user.id }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    const connection = openStream({ header: `Bearer ${token}` })
    const response = await connection.waitForResponse()

    // requireAuth admits this token (see the positive control above); this 401 comes from requireSessionId reading request.sessionId and finding it unset. Both this test and the "already-denied session" test carry ACCESS_TOKEN_EXPIRED_CODE, so the message attributes the rejection to the correct layer: "This session ended. Sign in again to continue." is requireAuth's denylist, this one is requireSessionId's own check.
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).not.toContain('text/event-stream')

    const body = await connection.collectBody()
    const parsed = JSON.parse(body) as { message: string; code?: string }
    expect(parsed.message).toBe('This session ended. Sign in again to continue.')
    expect(parsed.code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
  })

  it('answers 429 too_many_streams, before any stream opens, past the per-user cap', async () => {
    const { user, token } = await createAuthenticatedUser()
    const cap = getEnv().SSE_MAX_STREAMS_PER_USER

    for (let index = 0; index < cap; index += 1) {
      const stream = openStream({ header: `Bearer ${token}` })
      const opened = await stream.waitForResponse()
      expect(opened.statusCode).toBe(200)
    }
    expect(countStreams(user.id)).toBe(cap)

    const rejected = openStream({ header: `Bearer ${token}` })
    const response = await rejected.waitForResponse()
    expect(response.statusCode).toBe(429)
    expect(response.headers['content-type']).not.toContain('text/event-stream')
    const parsed = JSON.parse(await rejected.collectBody()) as { code?: string; message?: string }
    expect(parsed.code).toBe('too_many_streams')
    expect(parsed.message).toBe(
      `You've reached the limit of ${String(cap)} tabs that receive notifications. Close one, then reload this page.`
    )

    // A closed stream frees its slot.
    openConnections[0]?.destroy()
    await waitUntil(() => countStreams(user.id) < cap, {
      message: 'a closed stream frees its slot under the cap',
      timeout: 2000,
    })
    const again = openStream({ header: `Bearer ${token}` })
    const reopened = await again.waitForResponse()
    expect(reopened.statusCode).toBe(200)
  })

  it('answers 503 stream_capacity with Retry-After, before any stream opens, at the server-wide cap', async () => {
    const { user, token } = await createAuthenticatedUser()
    const total = getEnv().SSE_MAX_STREAMS_TOTAL
    // Other accounts' streams fill the process: one fake closer each, no sockets needed.
    const unregister = Array.from({ length: total }, (_, index) =>
      registerStream(`capacity-filler-${String(index)}`, () => {})
    )
    expect(countAllStreams()).toBe(total)

    const refused = openStream({ header: `Bearer ${token}` })
    const response = await refused.waitForResponse()
    expect(response.statusCode).toBe(503)
    expect(response.headers['retry-after']).toBe('30')
    expect(response.headers['content-type']).not.toContain('text/event-stream')
    const parsed = JSON.parse(await refused.collectBody()) as { code?: string; message?: string }
    expect(parsed.code).toBe('stream_capacity')
    expect(parsed.message).toBe(
      'Notifications are at capacity on this server. Reload this page in 30 seconds to try again.'
    )
    expect(countStreams(user.id)).toBe(0)

    // One slot freed anywhere lets the next stream open.
    unregister[0]?.()
    const again = openStream({ header: `Bearer ${token}` })
    const reopened = await again.waitForResponse()
    expect(reopened.statusCode).toBe(200)
  })

  it('ends the stream when the access token that opened it expires', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    // Hand-signed, like the expired-token test above: ACCESS_TOKEN_TTL is memoised by getEnv() and cannot be shortened per test. 2s, not 1s: exp is whole seconds, so a 1s token can already be expired at requireAuth.
    const token = jwt.sign({ sub: user.id, sid: randomUUID() }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: 2,
    })

    const stream = openStream({ header: `Bearer ${token}` })
    const response = await stream.waitForResponse()
    expect(response.statusCode).toBe(200)

    // exp is whole seconds, so the token expires between 1 and 2s after the stream opens.
    await expect(stream.closed(4000)).resolves.toBe(true)
    // The registry slot is freed too, not just the listener.
    await waitUntil(() => countStreams(user.id) === 0, {
      message: 'the expired stream leaves the shutdown registry',
      timeout: 2000,
    })
    expect(listenerCount(user.id)).toBe(0)
  })

  it("clamps a long-lived token's expiry timer to setTimeout's 2^31-1 ms ceiling", async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    // 30 days is ~2.59e9 ms, past the ceiling: unclamped, Node fires it at once.
    const token = jwt.sign({ sub: user.id, sid: randomUUID() }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '30d',
    })

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const stream = openStream({ header: `Bearer ${token}` })
      const response = await stream.waitForResponse()
      expect(response.statusCode).toBe(200)

      const delays = setTimeoutSpy.mock.calls.map(([, delay]) => delay ?? 0)
      expect(Math.max(...delays)).toBe(2_147_483_647)
      expect(await stream.closed(200)).toBe(false)
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('drops a client that stops reading once more than 1 MiB is buffered for it', async () => {
    const { user, token } = await createAuthenticatedUser()
    // The stream's own ServerResponse: its controller calls flushHeaders() once, after writeHead.
    const streamResponses: http.ServerResponse[] = []
    await withMutatedMethod(
      http.ServerResponse.prototype,
      'flushHeaders',
      function (this: http.ServerResponse) {
        streamResponses.push(this)
        // Inherited, so the real one is still reachable while this override shadows it.
        http.OutgoingMessage.prototype.flushHeaders.call(this)
      },
      async () => {
        const stream = openStream({ header: `Bearer ${token}` })
        const response = await stream.waitForResponse()
        expect(response.statusCode).toBe(200)
        await waitUntil(() => listenerCount(user.id) === 1, {
          message: "the stream's notification listener is registered",
          timeout: 2000,
        })
      }
    )
    expect(streamResponses).toHaveLength(1)
    const [streamResponse] = streamResponses as [http.ServerResponse]
    const client = openConnections.at(-1)?.response
    if (!client) throw new Error('expected the stream to have opened')

    // Stop reading: the client parser stops draining its socket, and the kernel buffers on both sides fill.
    client.pause()

    // 32 MiB of frames is far past any loopback kernel buffering, so the server-side writable buffer must pass SSE_MAX_BUFFERED_BYTES.
    const body = 'x'.repeat(512 * 1024)
    const frameCount = Math.ceil((32 * 1024 * 1024) / body.length)
    expect(frameCount * body.length).toBeGreaterThan(SSE_MAX_BUFFERED_BYTES * 16)
    // Paced, and stopped once the server drops the client: delivery crosses Redis, and an unpaced 32 MiB burst could pass Redis's default 32mb pub/sub output-buffer limit and disconnect the subscriber.
    for (let index = 0; index < frameCount && !streamResponse.destroyed; index += 1) {
      emitNotification(user.id, {
        id: randomUUID(),
        userId: user.id,
        type: 'tenant_invitation',
        title: 'Large',
        body,
        // oxlint-disable-next-line unicorn/no-null -- Notification.metadata/readAt are `T | null` columns
        metadata: null,
        // oxlint-disable-next-line unicorn/no-null -- see above
        readAt: null,
        // oxlint-disable-next-line unicorn/no-null -- see above
        dedupeKey: null,
        createdAt: new Date(),
      })
      await settle(20, "pacing, so 32 MiB stays under Redis's pub/sub output-buffer limit")
    }

    // Destroyed server-side, while the client is still paused, and never ended: an end() first would queue the closing chunk, which reaches the client whenever the kernel had already taken the rest.
    await waitUntil(() => streamResponse.destroyed, {
      message: 'the server destroys the stalled response',
    })
    expect(streamResponse.destroyed).toBe(true)
    expect(streamResponse.writableEnded).toBe(false)
    // The stall path's closeStream frees the registry slot and the listener.
    await waitUntil(() => countStreams(user.id) === 0, {
      message: 'the dropped stream leaves the shutdown registry',
    })
    expect(listenerCount(user.id)).toBe(0)

    // Once it reads again, the client sees a truncated body.
    client.resume()
    await waitUntil(() => client.destroyed, { message: 'the client sees its socket close' })
    expect(client.complete).toBe(false)
  })
})
