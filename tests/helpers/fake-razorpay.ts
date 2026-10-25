/**
 * @file A fake Razorpay API on 127.0.0.1 for the provider tests: it records
 * every request (method, path with query, headers, the exact body bytes) and
 * answers with what the test chose. It is a recorder, not an emulator: the
 * test decides each answer. `reply(method, path, …)` answers one pathname
 * (query ignored) until replaced; `replyInTurn` gives one pathname a list of
 * answers, used in order, the last repeating; `respondWith` is the answer for every other
 * request (200 `{}` by default); `hang(ms)` holds every later request for
 * that long; `close()` ends held requests too, so a test never waits on one.
 * Serve it under `/v1` so the provider's base URL is `${fake.baseUrl}`.
 */
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

/**
 * One request as the fake received it.
 */
interface FakeRazorpayRequest {
  method: string
  /**
   * The path with its query string, as sent (`/v1/…`).
   */
  path: string
  headers: IncomingHttpHeaders
  body: Buffer
  /**
   * The body parsed as JSON, or undefined when empty or not JSON.
   */
  json: unknown
}

/**
 * One canned answer.
 */
interface FakeRazorpayAnswer {
  status: number
  json: unknown
}

/**
 * The running fake.
 */
export interface FakeRazorpay {
  /**
   * The base URL to give the provider: `http://127.0.0.1:<port>/v1`.
   */
  baseUrl: string
  /**
   * Every request so far, oldest first.
   */
  requests: FakeRazorpayRequest[]
  /**
   * Answer every request that no `reply` matches with this.
   */
  respondWith: (status: number, json?: unknown) => void
  /**
   * Answer `method` on `path` (under `/v1`, query ignored) with this until replaced.
   */
  reply: (method: string, path: string, status: number, json: unknown) => void
  /**
   * Answer `method` on `path` with each answer in turn; the last one repeats.
   */
  replyInTurn: (method: string, path: string, answers: FakeRazorpayAnswer[]) => void
  /**
   * Hold every later request for `ms` before answering; 0 answers at once.
   */
  hang: (ms: number) => void
  /**
   * Forget recorded requests, replies and the hang, and answer 200 `{}` again.
   */
  reset: () => void
  /**
   * Stop listening, end held requests and close every connection.
   */
  close: () => Promise<void>
}

/**
 * Parse a body as JSON.
 * @param body - The bytes.
 * @returns The value, or undefined when empty or not JSON.
 */
function parsed(body: Buffer): unknown {
  if (body.length === 0) return undefined
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * Start the fake on an ephemeral port on 127.0.0.1.
 * @returns The running fake.
 */
export async function startFakeRazorpay(): Promise<FakeRazorpay> {
  const state = {
    fallback: { status: 200, json: {} } as FakeRazorpayAnswer,
    replies: new Map<string, FakeRazorpayAnswer[]>(),
    hangMs: 0,
    isClosed: false,
  }
  const requests: FakeRazorpayRequest[] = []
  const held = new Map<ServerResponse, NodeJS.Timeout>()
  const sockets = new Set<Socket>()

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const path = request.url ?? '/'
      const method = request.method ?? 'GET'
      requests.push({ method, path, headers: request.headers, body, json: parsed(body) })
      const pathname = path.split('?')[0] ?? path
      const queued = state.replies.get(`${method} ${pathname}`)
      const answer =
        (queued !== undefined && queued.length > 1 ? queued.shift() : queued?.[0]) ?? state.fallback
      /**
       * Write the answer, at once or when a `hang` delay ends.
       */
      const send = (): void => {
        held.delete(response)
        if (response.writableEnded) return
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(answer.json))
      }
      if (state.hangMs > 0 && !state.isClosed) {
        held.set(response, setTimeout(send, state.hangMs))
        return
      }
      send()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    respondWith: (status, json = {}) => {
      state.fallback = { status, json }
    },
    reply: (method, path, status, json) => {
      state.replies.set(`${method} /v1${path}`, [{ status, json }])
    },
    replyInTurn: (method, path, answers) => {
      state.replies.set(`${method} /v1${path}`, [...answers])
    },
    hang: (ms) => {
      state.hangMs = ms
    },
    reset: () => {
      requests.length = 0
      state.replies.clear()
      state.fallback = { status: 200, json: {} }
      state.hangMs = 0
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
