// tests/integration/api/notification-stream.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts) — same convention as
// tests/integration/api/notification.test.ts: every user created here is
// deleted in afterEach, and notifications cascade off that delete (ON
// DELETE CASCADE, notification.model.ts).
//
// This is the one file in tests/integration/api/ that cannot use
// `request(app)` (supertest) end-to-end: supertest resolves a request once
// its response has fully ENDED, and an SSE response — by design — never
// ends on its own. Instead, this file opens its own real, ephemeral
// `http.Server` (same as tests/integration/server.test.ts's own
// `startServer(0)` pattern, but a dedicated server rather than that shared
// helper — see the "server lifecycle" comment below for why) and drives it
// with a plain `node:http` client, parsing the raw SSE byte stream itself.
//
// `emitNotification` is imported and called DIRECTLY in several tests,
// rather than going through a real `NotificationWorker` job — the same
// "test this layer, not the whole pipeline" reasoning
// tests/unit/workers/notification.worker.test.ts already applies to the
// worker in the other direction. `notification.worker.test.ts` (both the
// unit and integration variants) already covers that `processNotificationJob`
// calls `emitNotification` after a successful insert; this file only needs
// to prove the SSE endpoint reacts correctly once that call happens.
import { randomUUID } from 'node:crypto'
import http, { type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import type { Notification } from '@/database/models/notification.model'
import type { User } from '@/database/models/user.model'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/middlewares/auth.middleware'
import { errorHandler } from '@/middlewares/error.middleware'
import { NotificationRepository } from '@/repositories/notification.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { emitNotification, listenerCount } from '@/services/notification-emitter.service'
import { denySession } from '@/services/session-denylist.service'
import { signAccessToken } from '@/utilities/token.utilities'
import { withMutatedMethod, withMutatedModule } from '../../helpers/mutate'

const userRepository = new UserRepository()
const notificationRepository = new NotificationRepository()
const userTokenRepository = new UserTokenRepository()

/**
 * One parsed SSE event — the fields `notification-stream.controller.ts`'s
 * `formatNotificationFrame` actually writes, plus whatever any other named
 * field (`retry`) happened to land in the same raw block. See
 * `parseSseBlock`'s own comment for why a block can contain more than one
 * logical field set.
 */
interface SseFrame {
  id?: string
  event?: string
  data?: string
}

/**
 * Parse one `\n`-joined block of SSE field lines — everything between two
 * `\n\n` boundaries — into an `SseFrame`. Comment lines (`:ping`, and any
 * line with no `:`) are skipped, not just `id`/`event`/`data`: the very
 * first block this file's client ever parses is the server's `retry:
 * 3000\n` line merged with whatever the next real write turns out to be,
 * since `retry` is sent with only a single trailing `\n`, not a blank line
 * (matching this codebase's own SSE endpoint exactly). Parsing field-by-field
 * rather than assuming one block is exactly one dispatched event is what
 * makes that merge harmless here.
 * @param raw - The raw block, without its trailing blank line.
 * @returns The fields found in this block.
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
 * Apply one parsed `field: value` pair to `frame`. A standalone function,
 * not a `switch` inlined into `parseSseBlock`'s own `for` loop — this
 * codebase's lint rules require a `switch` over three-or-more `else if`
 * branches, but also forbid a `break` inside a `switch` nested in a loop;
 * pulling the `switch` out into its own, non-nested function satisfies
 * both.
 * @param frame - The frame being built. Mutated in place.
 * @param field - The field name, e.g. `id`, `event`, `data`, or `retry`.
 * @param value - The field's value, already trimmed of its leading space.
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
    // Any other field (e.g. `retry`) is parsed but deliberately not
    // captured — nothing in this file asserts on it.
    default:
  }
}

/**
 * A raw `node:http` connection to `/api/v1/notifications/stream`, buffering
 * and incrementally parsing the SSE byte stream as it arrives — the "small
 * helper that reads chunks from the response stream" the task brief itself
 * calls for, since neither supertest nor a plain `await` can observe a
 * response that never ends.
 */
class SseConnection {
  private buffer = ''
  private readonly ready: Promise<IncomingMessage>
  private readonly ended: Promise<void>
  /**
   * How many of `frames` `nextFrame` has already handed out — so repeated
   * calls advance rather than all returning the first frame that ever
   * arrived.
   */
  private nextFrameIndex = 0
  readonly request: http.ClientRequest
  response: IncomingMessage | undefined
  /**
   * Every frame parsed so far, in arrival order.
   */
  readonly frames: SseFrame[] = []
  /**
   * The full, unparsed byte stream received so far — for assertions (the
   * heartbeat test) that only care about a raw substring, not framing.
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
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- tsconfig.json pins `lib: ["ES2023"]` deliberately (see MIGRATIONS.md); `Promise.withResolvers` is ES2024 and untyped under that lib.
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

    // Destroying an in-flight request (this file's own cleanup, and the
    // "client disconnects" test) can surface as an 'error' event on the
    // request itself — an unlistened 'error' event on a Node stream throws,
    // which would otherwise fail whichever test happened to be running when
    // cleanup destroyed a still-open connection.
    this.request.on('error', () => {
      // Expected on a deliberate destroy(); nothing to act on.
    })
  }

  /**
   * Wait for the response's headers to arrive.
   * @returns The response, with `.statusCode`/`.headers` already populated.
   */
  async waitForResponse(): Promise<IncomingMessage> {
    return this.ready
  }

  /**
   * Wait for a non-streaming response (the 401 rejections) to finish, and
   * return everything it sent.
   * @returns The full response body.
   */
  async collectBody(): Promise<string> {
    await this.ended
    return this.rawText
  }

  /**
   * Close the connection. Idempotent — safe to call from both a test's own
   * assertions and this file's `afterEach` cleanup.
   */
  destroy(): void {
    this.request.destroy()
  }

  /**
   * Wait for the next frame this connection has not yet handed out —
   * proof the stream is actually alive and delivering, not merely that
   * headers arrived.
   * @param timeoutMs - How long to wait before giving up. Defaults to 5000ms.
   * @returns The next unread frame.
   * @throws {Error} When no new frame arrives within `timeoutMs`.
   */
  async nextFrame(timeoutMs = 5000): Promise<SseFrame> {
    await waitUntil(() => this.frames.length > this.nextFrameIndex, timeoutMs)
    const frame = this.frames[this.nextFrameIndex]
    this.nextFrameIndex += 1
    if (!frame) {
      throw new Error('unreachable: waitUntil already guaranteed a frame at this index')
    }
    return frame
  }

  /**
   * Whether the server ended this response within `timeoutMs` — resolves
   * `false` on a timeout rather than rejecting, so a test asserting a
   * stream stays OPEN doesn't need to catch anything.
   * @param timeoutMs - How long to wait for the response to end.
   * @returns True once the response has ended; false if `timeoutMs` elapses first.
   */
  async closed(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const endPromise = (async (): Promise<boolean> => {
      await this.ended
      return true
    })()
    const hasClosed = await Promise.race([endPromise, timeoutPromise])
    if (timer) clearTimeout(timer)
    return hasClosed
  }
}

/**
 * Poll `isConditionMet` until it is true, or fail after `timeoutMs`.
 * @param isConditionMet - Checked every `intervalMs` until it returns true.
 * @param timeoutMs - How long to keep polling before giving up.
 * @param intervalMs - How often to poll. Defaults to 20ms.
 * @returns Resolves once `isConditionMet()` is true.
 * @throws {Error} When `timeoutMs` elapses with `isConditionMet` still false.
 */
async function waitUntil(
  isConditionMet: () => boolean,
  timeoutMs: number,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!isConditionMet()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Pause for a fixed duration.
 * @param ms - How long to pause for.
 * @returns Resolves after `ms` milliseconds.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `notification-stream-${randomUUID()}@example.test`
}

/**
 * Insert one `verify_email` notification directly through the repository —
 * mirrors what `processNotificationJob` (notification.worker.ts) does
 * before it calls `emitNotification`, without running BullMQ or the worker
 * itself.
 * @param userId - The owning user's id.
 * @param title - The notification's title. Defaults to a fixed string when omitted.
 * @returns The inserted notification.
 */
async function seedNotification(
  userId: string,
  title = 'Verify your email'
): Promise<Notification> {
  return notificationRepository.create({
    userId,
    type: 'verify_email',
    title,
    body: 'Click the link to verify your email address.',
  })
}

describe('GET /api/v1/notifications/stream', () => {
  let server: http.Server
  let baseUrl: string
  const createdUserIds: string[] = []
  const openConnections: SseConnection[] = []

  beforeAll(async () => {
    // A dedicated server, not tests/integration/server.test.ts's own
    // `startServer`/`gracefulShutdown`: this file's cleanup must destroy
    // every still-open SSE connection before the server can close at all
    // (an SSE response never ends on its own, so `server.close()`'s
    // callback would otherwise never fire) — a concern specific to this
    // file, not something to route through a shared helper that also tears
    // down the database/Redis/queue connections every other test file in
    // this worker still needs.
    server = createApp().listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  afterEach(async () => {
    for (const connection of openConnections) connection.destroy()
    openConnections.length = 0

    if (createdUserIds.length > 0) {
      await sql`delete from users where id = any(${createdUserIds})`
      createdUserIds.length = 0
    }
  })

  /**
   * Open a tracked SSE connection — tracked so `afterEach` destroys it even
   * if the test that opened it never does.
   * @param path - The request path, including any query string.
   * @param headers - Extra request headers, e.g. `Last-Event-ID`.
   * @returns The opened connection.
   */
  function openStream(path: string, headers: Record<string, string> = {}): SseConnection {
    const connection = new SseConnection(baseUrl, path, headers)
    openConnections.push(connection)
    return connection
  }

  /**
   * Create a disposable user row, sign an access token for it, and track
   * the row for cleanup.
   * @returns The created row and a valid bearer token for it.
   */
  async function createAuthenticatedUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  /**
   * Open an authenticated SSE stream for a brand-new user, capturing the
   * session id its token was minted with — unlike `createAuthenticatedUser`,
   * whose `signAccessToken(user, randomUUID())` throws its session id away,
   * a caller here can revoke this exact session afterward.
   * @returns The opened connection, its user id, and its session id.
   */
  async function openStreamForNewSession(): Promise<{
    stream: SseConnection
    userId: string
    sessionId: string
  }> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    const sessionId = randomUUID()
    const token = signAccessToken(user, sessionId)

    const stream = openStream(`/api/v1/notifications/stream?token=${encodeURIComponent(token)}`)
    await stream.waitForResponse()

    return { stream, userId: user.id, sessionId }
  }

  it('opens an SSE stream with the expected headers for a valid token', async () => {
    const { token } = await createAuthenticatedUser()

    const connection = openStream(`/api/v1/notifications/stream?token=${encodeURIComponent(token)}`)
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream')
    expect(response.headers['cache-control']).toBe('no-cache')
    expect(response.headers.connection).toBe('keep-alive')
    expect(response.headers['x-accel-buffering']).toBe('no')
  })

  it('rejects a connection with no token, as an ordinary 401 JSON response, not a stream', async () => {
    const connection = openStream('/api/v1/notifications/stream')
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).not.toContain('text/event-stream')

    const body = await connection.collectBody()
    expect((JSON.parse(body) as { success: boolean }).success).toBe(false)
  })

  it('rejects a connection with an invalid token', async () => {
    const connection = openStream('/api/v1/notifications/stream?token=not-a-real-jwt')
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(401)
  })

  it('rejects a connection with an expired token, carrying the distinguishable code', async () => {
    const token = jwt.sign({ sub: randomUUID() }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      // Already expired the moment it's signed — mirrors
      // tests/integration/middlewares/auth.middleware.test.ts's own
      // "rejects an expired access token" case, the one other place this
      // codebase manufactures an expired token by hand.
      expiresIn: -10,
    })

    const connection = openStream(`/api/v1/notifications/stream?token=${encodeURIComponent(token)}`)
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(401)
    const body = await connection.collectBody()
    expect((JSON.parse(body) as { code?: string }).code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
  })

  it('rejects a connection whose token belongs to no active user', async () => {
    const { user, token } = await createAuthenticatedUser()
    await sql`delete from users where id = ${user.id}`
    createdUserIds.length = 0 // already deleted directly above

    const connection = openStream(`/api/v1/notifications/stream?token=${encodeURIComponent(token)}`)
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(401)
  })

  // Real time, not a fake timer: this proves the actual `setInterval` wired
  // into a live connection fires — a mocked clock would only prove this
  // file's own mock advances correctly. SSE_HEARTBEAT_INTERVAL_MS
  // (env.config.ts, read by notification-stream.controller.ts) is set to
  // 1000ms in .env.test specifically so this test doesn't have to wait out
  // the real 30-second production interval — it was the single slowest test
  // in the whole suite before that config was pulled out of a hardcoded
  // controller constant.
  it('sends a heartbeat comment within a few seconds', async () => {
    const { token } = await createAuthenticatedUser()
    const connection = openStream(`/api/v1/notifications/stream?token=${encodeURIComponent(token)}`)
    await connection.waitForResponse()

    await waitUntil(() => connection.rawText.includes(':ping'), 5000, 100)
    expect(connection.rawText).toContain(':ping')
  }, 10_000)

  it('delivers a notification published via the emitter, in the documented SSE frame format', async () => {
    const { user, token } = await createAuthenticatedUser()
    const connection = openStream(`/api/v1/notifications/stream?token=${encodeURIComponent(token)}`)
    await connection.waitForResponse()
    // The handler registers synchronously once `authenticateStreamRequest`
    // resolves (streamNotifications, notification-stream.controller.ts) —
    // by the time this client has received any bytes at all, the server has
    // already run past `onNotification`. This sleep is slack against
    // scheduling jitter, not a requirement of that ordering.
    await sleep(50)

    const notification = await seedNotification(user.id, 'Pushed live')
    emitNotification(user.id, notification)

    await waitUntil(() => connection.frames.some((frame) => frame.event === 'notification'), 5000)

    const frame = connection.frames.find((candidate) => candidate.event === 'notification')
    expect(frame?.id).toBe(notification.id)
    expect(JSON.parse(frame?.data ?? '{}')).toEqual({
      id: notification.id,
      type: 'verify_email',
      title: 'Pushed live',
      body: notification.body,
      // eslint-disable-next-line unicorn/no-null -- asserting against the actual wire value: the SSE payload serializes an unread notification's readAt as JSON `null` (notification-stream.controller.ts's toStreamPayload), and `JSON.parse` produces a real `null` here, not `undefined`.
      readAt: null,
      createdAt: notification.createdAt.toISOString(),
    })
  })

  it('replays notifications created after Last-Event-ID on reconnect, oldest first', async () => {
    const { user, token } = await createAuthenticatedUser()
    const first = await seedNotification(user.id, 'First')
    const second = await seedNotification(user.id, 'Second')
    const third = await seedNotification(user.id, 'Third')

    const connection = openStream(
      `/api/v1/notifications/stream?token=${encodeURIComponent(token)}`,
      { 'Last-Event-ID': first.id }
    )
    await connection.waitForResponse()

    await waitUntil(
      () => connection.frames.filter((frame) => frame.event === 'notification').length >= 2,
      5000
    )

    const replayed = connection.frames.filter((frame) => frame.event === 'notification')
    expect(replayed.map((frame) => frame.id)).toEqual([second.id, third.id])
  })

  it('does not lose a notification emitted while a reconnect’s replay query is still in flight', async () => {
    // Regression test for a real ordering bug: an earlier version of
    // streamNotifications (notification-stream.controller.ts) awaited
    // `fetchMissedNotifications` BEFORE calling `onNotification`, so a
    // notification published during that database round trip landed in
    // neither the replay burst nor the live stream — lost until the next
    // reconnect. This test does not control exactly when the emit lands
    // relative to the query (that race is inherent to the scenario), but it
    // does not need to: emitting immediately after the connection's headers
    // arrive — before any `await` in this test — gives the emit its best
    // chance of landing inside that window, and the assertion (delivered
    // exactly once) holds regardless of which side of the query it actually
    // lands on.
    const { user, token } = await createAuthenticatedUser()
    const first = await seedNotification(user.id, 'First')

    const connection = openStream(
      `/api/v1/notifications/stream?token=${encodeURIComponent(token)}`,
      { 'Last-Event-ID': first.id }
    )
    await connection.waitForResponse()

    const live = await seedNotification(user.id, 'Live during replay')
    emitNotification(user.id, live)

    await waitUntil(() => connection.frames.some((frame) => frame.event === 'notification'), 5000)
    // A fixed settle time, not another `waitUntil`: this asserts an upper
    // bound (never delivered twice), which a condition-based wait cannot
    // express — there is no "it stayed at 1" event to poll for.
    await sleep(200)

    const delivered = connection.frames.filter((frame) => frame.event === 'notification')
    expect(delivered.map((frame) => frame.id)).toEqual([live.id])
  })

  // The deterministic version of the race the test above only ever WINS by
  // chance: `withMutatedMethod` delays `findByIdAndUser` — the first of
  // `fetchMissedNotifications`'s two queries — by 100ms, guaranteeing
  // `isReplaying` (streamNotifications, notification-stream.controller.ts)
  // is still true when both notifications below are emitted, so this
  // reliably exercises BOTH branches the flush loop has: a notification
  // that ALSO landed in the missed burst (persisted before the replay
  // query ran) must be delivered exactly once, deduped out of
  // `pendingDuringReplay` by its own `missedIds` check; a notification with
  // no corresponding row at all (never persisted — `emitNotification` is
  // called directly here, same as this file's header comment establishes
  // for every other test in it) can never appear in that burst, and must
  // still reach the client via the flush loop itself.
  it('routes notifications emitted during replay through the pending queue — deduping one already in the missed burst, flushing one that is not', async () => {
    const { user, token } = await createAuthenticatedUser()
    const first = await seedNotification(user.id, 'First')

    // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
    const realFindByIdAndUser = NotificationRepository.prototype.findByIdAndUser
    const delayedFindByIdAndUser: typeof realFindByIdAndUser = async function (
      this: NotificationRepository,
      id,
      userId
    ) {
      const result = await realFindByIdAndUser.call(this, id, userId)
      await sleep(100)
      return result
    }

    await withMutatedMethod(
      NotificationRepository.prototype,
      'findByIdAndUser',
      delayedFindByIdAndUser,
      async () => {
        const connection = openStream(
          `/api/v1/notifications/stream?token=${encodeURIComponent(token)}`,
          { 'Last-Event-ID': first.id }
        )
        await connection.waitForResponse()

        const persistedLive = await seedNotification(user.id, 'Persisted, in the missed burst')
        emitNotification(user.id, persistedLive)

        // Never inserted — the replay query's own `list()` call can never
        // find it, so it cannot be in `missedIds` no matter how long the
        // delay above runs.
        const ephemeralLive: Notification = {
          ...persistedLive,
          id: randomUUID(),
          title: 'Ephemeral, never persisted',
          createdAt: new Date(persistedLive.createdAt.getTime() + 1),
        }
        emitNotification(user.id, ephemeralLive)

        await waitUntil(
          () => connection.frames.filter((frame) => frame.event === 'notification').length >= 2,
          5000
        )
        await sleep(200)

        const delivered = connection.frames.filter((frame) => frame.event === 'notification')
        expect(delivered.filter((frame) => frame.id === persistedLive.id)).toHaveLength(1)
        expect(delivered.filter((frame) => frame.id === ephemeralLive.id)).toHaveLength(1)
      }
    )
  })

  it('does not leak its listener when the client disconnects while a reconnect’s replay query is still in flight', async () => {
    // Regression test for the other half of the same bug: the old ordering
    // also registered `request.on('close')` only after the replay query
    // resolved, so a disconnect during that window fired 'close' before any
    // handler was attached — `offNotification` never ran, leaking the
    // subscription and the heartbeat timer for the life of the process.
    // Destroying as soon as the response headers arrive, before any
    // `await` in this test, gives the disconnect its best chance of
    // landing inside that window; `listenerCount` reaching 0 either way is
    // what the fix guarantees.
    const { user, token } = await createAuthenticatedUser()
    const first = await seedNotification(user.id, 'First')

    const connection = openStream(
      `/api/v1/notifications/stream?token=${encodeURIComponent(token)}`,
      { 'Last-Event-ID': first.id }
    )
    await connection.waitForResponse()
    connection.destroy()

    await waitUntil(() => listenerCount(user.id) === 0, 2000)
    expect(listenerCount(user.id)).toBe(0)
  })

  it('does not replay anything when Last-Event-ID does not resolve to a notification this user owns', async () => {
    const { user, token } = await createAuthenticatedUser()
    await seedNotification(user.id, 'Only notification')

    const connection = openStream(
      `/api/v1/notifications/stream?token=${encodeURIComponent(token)}`,
      { 'Last-Event-ID': randomUUID() }
    )
    const response = await connection.waitForResponse()
    await sleep(200) // give a wrongly-replayed burst a chance to arrive before asserting it didn't

    expect(response.statusCode).toBe(200)
    expect(connection.frames.some((frame) => frame.event === 'notification')).toBe(false)
  })

  it('stops delivering events and removes its listener once the client disconnects', async () => {
    const { user, token } = await createAuthenticatedUser()
    const connection = openStream(`/api/v1/notifications/stream?token=${encodeURIComponent(token)}`)
    await connection.waitForResponse()
    await waitUntil(() => listenerCount(user.id) === 1, 2000)

    connection.destroy()
    await waitUntil(() => listenerCount(user.id) === 0, 2000)

    const notification = await seedNotification(user.id, 'After close')
    expect(() => emitNotification(user.id, notification)).not.toThrow()
    await sleep(100)
    expect(connection.frames.some((frame) => frame.event === 'notification')).toBe(false)
  })

  // requireAuth (auth.middleware.ts) rejects a denied session, but only at
  // connect — it never runs again on a connection already open. This
  // endpoint doesn't sit behind requireAuth at all (see this controller's
  // own header comment), and its own connect-time check
  // (authenticateStreamRequest) has the same one-shot limitation. The
  // heartbeat is the only thing that recurs on an open SSE connection, so
  // it is the only place a revoked session can actually be caught here —
  // this test proves that closes the stream, not merely that the session
  // is rejected on a fresh connect (already covered by
  // auth.middleware.test.ts's own denylist test).
  it('closes an open stream once its session is revoked', async () => {
    const { stream, userId, sessionId } = await openStreamForNewSession()

    // Alive first, or the assertion below proves nothing. The first frame
    // to arrive is always a heartbeat (no notification is emitted here) —
    // this just proves the connection is live before revoking it.
    await expect(stream.nextFrame()).resolves.toBeDefined()

    await userTokenRepository.revokeAllForSession(sessionId)

    // Within one heartbeat, not immediately: the check rides the existing
    // interval rather than adding a second timer.
    await expect(stream.closed(getEnv().SSE_HEARTBEAT_INTERVAL_MS * 2)).resolves.toBe(true)

    // The heartbeat's own close path must clean up exactly like an
    // ordinary client disconnect does — not merely end the HTTP response
    // while leaving the emitter subscription (and the interval) behind.
    await waitUntil(() => listenerCount(userId) === 0, 2000)
    expect(listenerCount(userId)).toBe(0)
  }, 10_000)

  // Pairs with the test above: that one proves a session denied AFTER
  // connect closes an already-open stream (Task 5's heartbeat, the only
  // thing that recurs on an open connection). This one proves a session
  // denied BEFORE connect never gets to open a stream at all — a different
  // code path (this task's check inside authenticateStreamRequest, at
  // connect) that Task 5's heartbeat cannot reach, since it never runs
  // until a stream is already open.
  it('refuses to open a stream for an already-denied session', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    const sessionId = randomUUID()
    const token = signAccessToken(user, sessionId)

    // denySession directly, not revokeAllForSession — this test is about
    // authenticateStreamRequest's own denylist read, not about revocation
    // writing that entry (already covered by user-token.repository.test.ts
    // and the "closes an open stream" test above).
    await denySession(sessionId)

    const connection = openStream(`/api/v1/notifications/stream?token=${encodeURIComponent(token)}`)
    const response = await connection.waitForResponse()

    // A rejection thrown by authenticateStreamRequest happens before
    // response.writeHead, so this is the ordinary JSON 401 envelope, not an
    // event-stream that opens and then closes.
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).not.toContain('text/event-stream')
  })

  // The next two tests are a pair, mirroring auth.middleware.test.ts's own
  // pair for the identical guard (`'accepts a token with no sid claim'` /
  // `'keeps a sid-less token honoured...'`, ~163-260): one proves the
  // tolerance is real end to end, the other proves it is a genuine
  // short-circuit and not incidentally-passing dead code.
  it('opens a stream for a hand-signed token with no `sid` claim — one release of tolerance for tokens minted before this claim existed', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    // Hand-signed, deliberately NOT via signAccessToken: signAccessToken
    // always sets `sid` now, so it can no longer produce the shape this
    // test needs — a token minted by the currently-deployed version,
    // before the `sid` claim existed. Mirrors
    // auth.middleware.test.ts's own copy of this comment.
    const token = jwt.sign({ sub: user.id }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    const connection = openStream(`/api/v1/notifications/stream?token=${encodeURIComponent(token)}`)
    const response = await connection.waitForResponse()

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream')
  })

  it("keeps a sid-less token connectable even when the denylist would deny every session, proving authenticateStreamRequest's `payload.sid &&` is a real short-circuit", async () => {
    // WHY THIS IS A MUTATION TEST, NOT A HAND EDIT. Same reasoning as
    // auth.middleware.test.ts's own copy of this test (CLAUDE.md, "Proving
    // a security behaviour is real, without hand-editing src/"):
    // temporarily deleting `payload.sid &&` from
    // notification-stream.controller.ts on disk to see what breaks would
    // put a live "every pre-existing token gets disconnected" regression
    // on disk in a shared worktree, even for a moment. withMutatedModule
    // gets the same evidence without it: isSessionDenied is overridden to
    // resolve `true` UNCONDITIONALLY, regardless of the argument it's
    // called with (including `undefined`).
    //
    // Under that mutation: a token WITH a sid is denied (the wiring
    // works), while a token WITHOUT one still connects — which is only
    // possible because the guard short-circuits on `payload.sid` before
    // ever calling isSessionDenied. If `payload.sid &&` were deleted, the
    // sid-less token's call would become `isSessionDenied(undefined)` —
    // and this mock returns `true` no matter what it's called with — so
    // that regression would flip the first assertion below to a 401 and
    // turn this test red, deterministically.
    //
    // This drives a FRESH one-off Express app built from the freshly
    // re-imported controller module, not this file's own shared `server`:
    // that server's route was bound to the real, unmutated controller back
    // in `beforeAll`, long before this mutation exists, so a request
    // against it could never observe the mutated isSessionDenied at all.
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)

    await withMutatedModule<
      typeof import('@/services/session-denylist.service'),
      typeof import('@/controllers/notification-stream.controller')
    >(
      '@/services/session-denylist.service',
      { isSessionDenied: () => Promise.resolve(true) },
      () => import('@/controllers/notification-stream.controller'),
      async (subject) => {
        const mutatedApp = express()
        mutatedApp.disable('x-powered-by')
        mutatedApp.get('/api/v1/notifications/stream', subject.streamNotifications)
        mutatedApp.use(errorHandler)
        const mutatedServer = mutatedApp.listen(0)
        await new Promise<void>((resolve) => mutatedServer.once('listening', resolve))
        const mutatedAddress = mutatedServer.address() as AddressInfo
        const mutatedBaseUrl = `http://127.0.0.1:${mutatedAddress.port}`

        try {
          const sidLessToken = jwt.sign({ sub: user.id }, getEnv().JWT_ACCESS_SECRET, {
            algorithm: 'HS256',
            expiresIn: '15m',
          })
          const accepted = new SseConnection(
            mutatedBaseUrl,
            `/api/v1/notifications/stream?token=${encodeURIComponent(sidLessToken)}`
          )
          const acceptedResponse = await accepted.waitForResponse()
          expect(acceptedResponse.statusCode).toBe(200)
          accepted.destroy()

          // Same mutated environment, but this token HAS a sid: it must be
          // denied, proving isSessionDenied is genuinely wired into the
          // guard and not merely unreachable dead code.
          const sidToken = signAccessToken(user, randomUUID())
          const denied = new SseConnection(
            mutatedBaseUrl,
            `/api/v1/notifications/stream?token=${encodeURIComponent(sidToken)}`
          )
          const deniedResponse = await denied.waitForResponse()
          expect(deniedResponse.statusCode).toBe(401)
          denied.destroy()
        } finally {
          await new Promise<void>((resolve) => mutatedServer.close(() => resolve()))
        }
      }
    )
  })
})
