/**
 * @file A fake PostHog on 127.0.0.1 for the analytics tests: it records every
 * request (method, path with query, headers and the exact body bytes), parses
 * each `/batch/` body into `batches`, and answers with a status the test
 * chooses. It also serves the three private-API endpoints the server calls
 * with the personal key, under `/api/projects/<id>/`: `query/` (answered by
 * `respondToQuery`), `groups_types/` (from `groupTypes`, with `groupTypesStatus`) and
 * `persons/bulk_delete/` (with `bulkDeleteStatus`); any other `/api/projects/`
 * path, one without its trailing slash included, answers 404. `respondWith`
 * and `onBatch` never govern those three. `hang(ms)` holds every later
 * request, private API included, for that long before answering, and
 * `close()` ends held requests too, so a test never waits on one.
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
 * The `query` object of one `POST /api/projects/<id>/query/` body.
 */
export interface FakePosthogQuery {
  query: string
  values: Record<string, unknown>
}

/**
 * Decides the answer to one HogQL query; `json` defaults to an empty result.
 */
export type QueryResponder = (
  body: FakePosthogQuery
) => Promise<{ status: number; json?: unknown }> | { status: number; json?: unknown }

/**
 * One `persons/bulk_delete/` body as the fake received it.
 */
export interface FakePosthogBulkDelete {
  distinct_ids: string[]
  delete_events: boolean
  delete_recordings: boolean
}

/**
 * One entry of the `groups_types/` answer.
 */
export interface FakePosthogGroupType {
  group_type: string
  group_type_index: number
}

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
   * Extra headers on every later answer; pass an empty object to stop.
   */
  respondWithHeaders: (headers: Record<string, string>) => void
  /**
   * Each HogQL query body, in arrival order.
   */
  queries: FakePosthogQuery[]
  /**
   * Answer later queries with `responder`; the default answers 200 with
   * `{ columns: [], results: [] }`.
   */
  respondToQuery: (responder: QueryResponder) => void
  /**
   * The `groups_types/` answer; assign a new array to change it. Starts as
   * `[{ group_type: 'tenant', group_type_index: 0 }]`.
   */
  groupTypes: FakePosthogGroupType[]
  /**
   * The status `groups_types/` answers with (200 at start); only a 200 carries `groupTypes`.
   */
  groupTypesStatus: number
  /**
   * Each `persons/bulk_delete/` body, in arrival order.
   */
  bulkDeletes: FakePosthogBulkDelete[]
  /**
   * The status `persons/bulk_delete/` answers with (202 at start). A 202
   * carries PostHog's body, with `persons_found` equal to the ids sent.
   */
  bulkDeleteStatus: number
  /**
   * The `deletion_errors` list a 202 bulk delete answers with, from the ids
   * of that request (an empty list at start, whatever the ids).
   */
  bulkDeleteErrors: (distinctIds: string[]) => unknown[]
  /**
   * The `Authorization` header of each private-API request, in arrival order.
   */
  authHeaders: string[]
  /**
   * Stop listening, end held requests and close every connection.
   */
  close: () => Promise<void>
}

/**
 * The private-API endpoint a path names, or `undefined` when it is not under
 * `/api/projects/`, or `'unknown'` when it is but names no endpoint the fake
 * serves.
 * @param path - The request path, without its query string.
 * @returns The endpoint.
 */
function privateEndpointOf(
  path: string
): 'query' | 'groups_types' | 'bulk_delete' | 'unknown' | undefined {
  if (!path.startsWith('/api/projects/')) return undefined
  const match = /^\/api\/projects\/\d+\/(query|groups_types|persons\/bulk_delete)\/$/.exec(path)
  if (!match) return 'unknown'
  if (match[1] === 'query') return 'query'
  return match[1] === 'groups_types' ? 'groups_types' : 'bulk_delete'
}

/**
 * Parse a JSON request body.
 * @param body - The request body.
 * @returns The parsed value, or undefined when it is not JSON.
 */
function jsonOf(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * The `query` object of a query body, or an empty query when it has none.
 * @param body - The request body.
 * @returns The HogQL text and its values.
 */
function queryOf(body: Buffer): FakePosthogQuery {
  const parsed = jsonOf(body) as { query?: { query?: unknown; values?: unknown } } | undefined
  const query = parsed?.query
  return {
    query: typeof query?.query === 'string' ? query.query : '',
    values:
      typeof query?.values === 'object' && query.values !== null
        ? (query.values as Record<string, unknown>)
        : {},
  }
}

/**
 * A bulk-delete body as the fake records it.
 * @param body - The request body.
 * @returns The ids and both flags, with defaults for anything missing.
 */
function bulkDeleteOf(body: Buffer): FakePosthogBulkDelete {
  const parsed = jsonOf(body) as Partial<FakePosthogBulkDelete> | undefined
  return {
    distinct_ids: Array.isArray(parsed?.distinct_ids) ? parsed.distinct_ids : [],
    delete_events: parsed?.delete_events === true,
    delete_recordings: parsed?.delete_recordings === true,
  }
}

/**
 * PostHog's 202 answer to a bulk delete, as planning probe 3 recorded it.
 * @param deletion - The recorded request.
 * @param deletionErrors - The `deletion_errors` list to answer with.
 * @returns The body.
 */
function bulkDeleteAnswer(
  deletion: FakePosthogBulkDelete,
  deletionErrors: unknown[]
): Record<string, unknown> {
  return {
    persons_found: deletion.distinct_ids.length,
    persons_queued_for_deletion: deletion.distinct_ids.length,
    events_queued_for_deletion: deletion.delete_events ? deletion.distinct_ids.length : 0,
    recordings_queued_for_deletion: deletion.delete_recordings ? deletion.distinct_ids.length : 0,
    deletion_errors: deletionErrors,
  }
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
    headers: Record<string, string>
    isClosed: boolean
  } = { status: 200, responder: undefined, hangMs: 0, headers: {}, isClosed: false }
  const batches: PosthogBatchEvent[][] = []
  const requests: FakePosthogRequest[] = []
  const sockets = new Set<Socket>()
  const held = new Map<ServerResponse, NodeJS.Timeout>()

  const queries: FakePosthogQuery[] = []
  const bulkDeletes: FakePosthogBulkDelete[] = []
  const authHeaders: string[] = []
  const answers: { query: QueryResponder } = {
    query: () => ({ status: 200, json: { columns: [], results: [] } }),
  }

  const fake: FakePosthog = {
    url: '',
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
    respondWithHeaders: (headers) => {
      state.headers = headers
    },
    queries,
    respondToQuery: (responder) => {
      answers.query = responder
    },
    groupTypes: [{ group_type: 'tenant', group_type_index: 0 }],
    groupTypesStatus: 200,
    bulkDeletes,
    bulkDeleteStatus: 202,
    bulkDeleteErrors: () => [],
    authHeaders,
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

  /**
   * The status and body for one private-API request.
   * @param endpoint - The endpoint its path names.
   * @param body - The request body.
   * @returns What to answer.
   */
  async function privateAnswer(
    endpoint: 'query' | 'groups_types' | 'bulk_delete' | 'unknown',
    body: Buffer
  ): Promise<{ status: number; json: unknown }> {
    switch (endpoint) {
      case 'query': {
        const query = queryOf(body)
        queries.push(query)
        const answer = await answers.query(query)
        return { status: answer.status, json: answer.json ?? { columns: [], results: [] } }
      }
      case 'groups_types': {
        const status = fake.groupTypesStatus
        return { status, json: status === 200 ? fake.groupTypes : { detail: 'error' } }
      }
      case 'bulk_delete': {
        const deletion = bulkDeleteOf(body)
        bulkDeletes.push(deletion)
        const status = fake.bulkDeleteStatus
        return {
          status,
          json:
            status === 202
              ? bulkDeleteAnswer(deletion, fake.bulkDeleteErrors(deletion.distinct_ids))
              : { detail: 'error' },
        }
      }
      default: {
        return { status: 404, json: { detail: 'Not found.' } }
      }
    }
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const path = request.url ?? '/'
      requests.push({ method: request.method ?? 'GET', path, headers: request.headers, body })
      const endpoint = privateEndpointOf(path.split('?', 1)[0] ?? path)
      let status = state.status
      let json: unknown = { status: status < 300 ? 1 : 0, path }
      if (endpoint === undefined) {
        if (path.split('?', 1)[0] === '/batch/') {
          const events = batchOf(body)
          batches.push(events)
          status = state.responder?.(events) ?? status
          json = { status: status < 300 ? 1 : 0, path }
        }
      } else {
        authHeaders.push(request.headers.authorization ?? '')
        const privateResult = await privateAnswer(endpoint, body)
        status = privateResult.status
        json = privateResult.json
      }
      const answer = (): void => {
        held.delete(response)
        if (response.writableEnded) return
        response.writeHead(status, { 'content-type': 'application/json', ...state.headers })
        response.end(JSON.stringify(json))
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
  fake.url = `http://127.0.0.1:${String(port)}`
  return fake
}
