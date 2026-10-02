/**
 * @file A fake PostHog on 127.0.0.1 for the analytics tests: it records every
 * request (method, path with query, headers and the exact body bytes), parses
 * each `/batch/` body into `batches`, and answers with a status the test
 * chooses. `hang(ms)` holds every later request for that long before
 * answering, and `close()` ends held requests too, so a test never waits
 * on one.
 */
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { PosthogBatchEvent } from '@/services/analytics/posthog-batch.service'

/**
 * One request as the fake received it.
 */
export interface FakePosthogRequest {
  method: string
  /**
   * The path with its query string, as sent.
   */
  path: string
  headers: IncomingHttpHeaders
  body: Buffer
}

/**
 * Decides the status for one `/batch/` request from its events; `undefined`
 * falls back to the status `respondWith` set.
 */
export type BatchResponder = (events: PosthogBatchEvent[]) => number | undefined

/**
 * A running fake PostHog.
 */
export interface FakePosthog {
  /**
   * The base URL, `http://127.0.0.1:<port>`, with no trailing slash.
   */
  url: string
  /**
   * Each `/batch/` request's events, in arrival order.
   */
  batches: PosthogBatchEvent[][]
  /**
   * Every request, in arrival order.
   */
  requests: FakePosthogRequest[]
  /**
   * The status every later request is answered with (200 at start).
   */
  respondWith: (status: number) => void
  /**
   * A per-batch status, consulted before `respondWith`'s; pass undefined to remove it.
   */
  onBatch: (responder: BatchResponder | undefined) => void
  /**
   * Hold every later request `ms` before answering; 0 stops holding.
   */
  hang: (ms: number) => void
  /**
   * Stop listening, end held requests and close every connection.
   */
  close: () => Promise<void>
}

/**
 * Read a request body to the end.
 * @param request - The incoming request.
 * @returns The exact bytes.
 */
async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * The events of a `/batch/` body, or an empty list when it is not one.
 * @param body - The request body.
 * @returns The parsed events.
 */
function batchOf(body: Buffer): PosthogBatchEvent[] {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { batch?: unknown }
    return Array.isArray(parsed.batch) ? (parsed.batch as PosthogBatchEvent[]) : []
  } catch {
    return []
  }
}

/**
 * Start a fake PostHog on 127.0.0.1 and an OS-chosen port.
 * @returns The running fake.
 */
export async function startFakePosthog(): Promise<FakePosthog> {
  const state: {
    status: number
    responder: BatchResponder | undefined
    hangMs: number
    isClosed: boolean
  } = { status: 200, responder: undefined, hangMs: 0, isClosed: false }
  const batches: PosthogBatchEvent[][] = []
  const requests: FakePosthogRequest[] = []
  const sockets = new Set<Socket>()
  const held = new Map<ServerResponse, NodeJS.Timeout>()

  const server = http.createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const path = request.url ?? '/'
      requests.push({ method: request.method ?? 'GET', path, headers: request.headers, body })
      let status = state.status
      if (path.split('?', 1)[0] === '/batch/') {
        const events = batchOf(body)
        batches.push(events)
        status = state.responder?.(events) ?? status
      }
      const answer = (): void => {
        held.delete(response)
        if (response.writableEnded) return
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ status: status < 300 ? 1 : 0, path }))
      }
      if (state.hangMs > 0 && !state.isClosed) {
        held.set(response, setTimeout(answer, state.hangMs))
        return
      }
      answer()
    })()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${String(port)}`,
    batches,
    requests,
    respondWith: (status) => {
      state.status = status
    },
    onBatch: (responder) => {
      state.responder = responder
    },
    hang: (ms) => {
      state.hangMs = ms
    },
    close: async () => {
      state.isClosed = true
      for (const [response, timer] of held) {
        clearTimeout(timer)
        response.destroy()
      }
      held.clear()
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
    },
  }
}
