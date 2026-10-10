/**
 * @file A fake PostHog on 127.0.0.1 for the analytics tests: it records every
 * request (method, path with query, headers and the exact body bytes), parses
 * each `/batch/` body into `batches`, and answers with a status the test
 * chooses. It also serves the private-API endpoints the server calls with
 * the personal key, under `/api/projects/<id>/`: `query/` (answered by
 * `respondToQuery`), `groups_types/` (from `groupTypes`, with `groupTypesStatus`),
 * `persons/bulk_delete/` (with `bulkDeleteStatus`) and `feature_flags/`
 * (GET pages `featureFlags`; POST creates one with PostHog's validation,
 * unless `onFeatureFlagCreate`'s responder answers first);
 * any other `/api/projects/` path, one without its trailing slash included,
 * answers 404. It serves `GET /flags/definitions` from `flagDefinitions`,
 * answering 304 with an empty body when `If-None-Match` names the current
 * ETag, after awaiting `beforeFlagDefinitions` when one is set (a test
 * changes Redis mid-run with it). `respondWith` and `onBatch` govern none
 * of those. `hang(ms)` holds every later request, private API included,
 * for that long before answering, and `close()` ends held requests too, so
 * a test never waits on one.
 */
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { PosthogBatchEvent } from '@/services/analytics/posthog-batch.service'

/**
 * One request as the fake received it.
 */
interface FakePosthogRequest {
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
type BatchResponder = (events: PosthogBatchEvent[]) => number | undefined

/**
 * The `query` object of one `POST /api/projects/<id>/query/` body.
 */
interface FakePosthogQuery {
  query: string
  values: Record<string, unknown>
}

/**
 * Decides the answer to one HogQL query; `json` defaults to an empty result.
 */
type QueryResponder = (
  body: FakePosthogQuery
) => Promise<{ status: number; json?: unknown }> | { status: number; json?: unknown }

/**
 * One `persons/bulk_delete/` body as the fake received it.
 */
interface FakePosthogBulkDelete {
  distinct_ids: string[]
  delete_events: boolean
  delete_recordings: boolean
}

/**
 * One entry of the `groups_types/` answer.
 */
interface FakePosthogGroupType {
  group_type: string
  group_type_index: number
}

/**
 * One flag of the project, as the `feature_flags/` list answers it: the
 * fields `pnpm flags:sync` reads, plus a `created_by` that stands for the
 * personal data a real answer carries.
 */
export interface FakePosthogFeatureFlag {
  id: number
  key: string
  name: string
  active: boolean
  deleted: boolean
  filters: Record<string, unknown>
  tags: string[]
  created_by: { email: string }
}

/**
 * Overrides the answer to one `POST feature_flags/` body; undefined falls
 * back to the fake's own checks.
 */
type FeatureFlagCreateResponder = (
  body: Record<string, unknown>
) => { status: number; json: unknown } | undefined

/**
 * The definitions body of a project with no flags and the tenant group type at index 0.
 */
export const EMPTY_FLAG_DEFINITIONS = {
  cohorts: {},
  flags: [],
  group_type_mapping: { '0': 'tenant' },
  minimal_flag_called_events: false,
  property_matching_version: 1,
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
   * The JSON body `GET /flags/definitions` answers with (`EMPTY_FLAG_DEFINITIONS` at start).
   */
  flagDefinitions: unknown
  /**
   * The ETag `GET /flags/definitions` answers with (`W/"fake-0"` at start);
   * undefined sends none. `If-None-Match` equal to it, with or without the
   * `W/` prefix, gets a 304 with an empty body.
   */
  flagDefinitionsEtag: string | undefined
  /**
   * The status a non-304 `GET /flags/definitions` answers with (200 at start).
   */
  flagDefinitionsStatus: number
  /**
   * A body sent verbatim in place of `flagDefinitions` (malformed or
   * oversized bodies); undefined at start.
   */
  flagDefinitionsRawBody: string | undefined
  /**
   * Awaited before `GET /flags/definitions` is answered; undefined at start.
   * A test stands in for another replica with it, between the job's read of
   * the stored snapshot and its answer.
   */
  beforeFlagDefinitions: (() => Promise<void>) | undefined
  /**
   * Replace the definitions and give them a fresh ETag, as PostHog does on every flag change.
   */
  setFlagDefinitions: (body: unknown) => void
  /**
   * The project's flags, oldest first, as `GET feature_flags/` pages them; a
   * successful create appends to it.
   */
  featureFlags: FakePosthogFeatureFlag[]
  /**
   * The largest page `GET feature_flags/` serves, whatever `limit` asks for (200 at start).
   */
  featureFlagsPageLimit: number
  /**
   * The status `GET feature_flags/` answers with (200 at start); only a 200 carries a page.
   */
  featureFlagsStatus: number
  /**
   * Each `POST feature_flags/` body, in arrival order, accepted or not.
   */
  featureFlagCreates: unknown[]
  /**
   * Answer later creates with `responder` first, skipping validation when it
   * answers; pass undefined to remove it (none at start).
   */
  onFeatureFlagCreate: (responder: FeatureFlagCreateResponder | undefined) => void
  /**
   * Whether a create without tags is refused, as project 644121's `require_tags` does (true at start).
   */
  requireFeatureFlagTags: boolean
  /**
   * Stop listening, end held requests and close every connection.
   */
  close: () => Promise<void>
}

/**
 * The endpoints served under `/api/projects/<id>/`.
 */
type PrivateEndpoint = 'query' | 'groups_types' | 'bulk_delete' | 'feature_flags' | 'unknown'

/**
 * The private-API endpoint a path names, or `undefined` when it is not under
 * `/api/projects/`, or `'unknown'` when it is but names no endpoint the fake
 * serves.
 * @param path - The request path, without its query string.
 * @returns The endpoint.
 */
function privateEndpointOf(path: string): PrivateEndpoint | undefined {
  if (!path.startsWith('/api/projects/')) return undefined
  const match =
    /^\/api\/projects\/\d+\/(query|groups_types|persons\/bulk_delete|feature_flags)\/$/.exec(path)
  if (!match) return 'unknown'
  if (match[1] === 'persons/bulk_delete') return 'bulk_delete'
  return match[1] as PrivateEndpoint
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
 * PostHog's 400 validation body.
 * @param code - The error code.
 * @param detail - The message.
 * @param attribute - The field it names.
 * @returns The answer.
 */
function validationError(
  code: string,
  detail: string,
  attribute: string
): { status: number; json: unknown } {
  return { status: 400, json: { type: 'validation_error', code, detail, attr: attribute } }
}

/**
 * The sum of a create body's variant rollouts, or undefined when it has no variants.
 * @param filters - The create body's `filters`.
 * @returns The sum.
 */
function variantRolloutSum(filters: Record<string, unknown>): number | undefined {
  const multivariate = filters.multivariate as { variants?: unknown } | null | undefined
  if (!multivariate || !Array.isArray(multivariate.variants)) return undefined
  return (multivariate.variants as { rollout_percentage?: unknown }[]).reduce(
    (sum, variant) =>
      sum + (typeof variant.rollout_percentage === 'number' ? variant.rollout_percentage : 0),
    0
  )
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
 * An ETag without its weak `W/` prefix.
 * @param tag - The ETag.
 * @returns The tag's quoted value.
 */
function bareEtag(tag: string): string {
  return tag.replace(/^W\//, '')
}

/**
 * Whether an `If-None-Match` header names an ETag, weak or not.
 * @param header - The request header.
 * @param etag - The current ETag.
 * @returns True when they name the same tag.
 */
function isSameEtag(header: string | undefined, etag: string | undefined): boolean {
  if (header === undefined || etag === undefined) return false
  return bareEtag(header) === bareEtag(etag)
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
    definitionsVersion: number
    nextFlagId: number
    featureFlagCreate: FeatureFlagCreateResponder | undefined
  } = {
    status: 200,
    responder: undefined,
    hangMs: 0,
    headers: {},
    isClosed: false,
    definitionsVersion: 0,
    nextFlagId: 1000,
    featureFlagCreate: undefined,
  }
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
    flagDefinitions: EMPTY_FLAG_DEFINITIONS,
    flagDefinitionsEtag: 'W/"fake-0"',
    flagDefinitionsStatus: 200,
    flagDefinitionsRawBody: undefined,
    beforeFlagDefinitions: undefined,
    setFlagDefinitions: (body) => {
      state.definitionsVersion += 1
      fake.flagDefinitions = body
      fake.flagDefinitionsEtag = `W/"fake-${String(state.definitionsVersion)}"`
    },
    featureFlags: [],
    featureFlagsPageLimit: 200,
    featureFlagsStatus: 200,
    featureFlagCreates: [],
    onFeatureFlagCreate: (responder) => {
      state.featureFlagCreate = responder
    },
    requireFeatureFlagTags: true,
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
   * One page of `GET feature_flags/`, paged by `limit` (100 by default, at
   * most `featureFlagsPageLimit`) and `offset`, with `next` and `previous` as
   * full URLs, as PostHog sends them.
   * @param path - The request path with its query string.
   * @returns What to answer.
   */
  function featureFlagPage(path: string): { status: number; json: unknown } {
    if (fake.featureFlagsStatus !== 200) {
      return { status: fake.featureFlagsStatus, json: { detail: 'error' } }
    }
    const url = new URL(path, fake.url)
    const limit = Math.min(
      Number(url.searchParams.get('limit') ?? '100'),
      fake.featureFlagsPageLimit
    )
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const pageUrl = (start: number): string => {
      const next = new URL(url.pathname, fake.url)
      next.searchParams.set('limit', String(limit))
      next.searchParams.set('offset', String(start))
      return next.href
    }
    return {
      status: 200,
      json: {
        count: fake.featureFlags.length,
        // eslint-disable-next-line unicorn/no-null -- PostHog's JSON null on the last page
        next: offset + limit < fake.featureFlags.length ? pageUrl(offset + limit) : null,
        // eslint-disable-next-line unicorn/no-null -- PostHog's JSON null on the first page
        previous: offset > 0 ? pageUrl(Math.max(0, offset - limit)) : null,
        results: fake.featureFlags.slice(offset, offset + limit),
      },
    }
  }

  /**
   * Answer `POST feature_flags/`: the test's responder first, then PostHog's
   * checks, in its order: a required tag, variant rollouts summing to 100,
   * then a unique key. A created flag is appended to `featureFlags` and
   * answered 201.
   * @param body - The request body.
   * @returns What to answer.
   */
  function createFeatureFlag(body: Buffer): { status: number; json: unknown } {
    const parsed = (jsonOf(body) ?? {}) as Record<string, unknown>
    fake.featureFlagCreates.push(parsed)
    const overridden = state.featureFlagCreate?.(parsed)
    if (overridden !== undefined) return overridden
    const tags = Array.isArray(parsed.tags) ? (parsed.tags as string[]) : []
    if (fake.requireFeatureFlagTags && tags.length === 0) {
      return validationError(
        'invalid_input',
        'Add at least one tag. This project requires new feature flags to be tagged.',
        'tags'
      )
    }
    const filters = (parsed.filters ?? {}) as Record<string, unknown>
    const sum = variantRolloutSum(filters)
    if (sum !== undefined && sum !== 100) {
      return validationError(
        'cross_field.variant_rollout_sum_not_100',
        `multivariate.variants: Variant rollout percentages must sum to 100, got ${String(sum)}.`,
        'filters'
      )
    }
    const key = typeof parsed.key === 'string' ? parsed.key : ''
    if (fake.featureFlags.some((flag) => flag.key === key)) {
      return validationError('unique', 'There is already a feature flag with this key.', 'key')
    }
    state.nextFlagId += 1
    const created: FakePosthogFeatureFlag = {
      id: state.nextFlagId,
      key,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      active: parsed.active === true,
      deleted: false,
      filters,
      tags,
      created_by: { email: 'creator@example.test' },
    }
    fake.featureFlags.push(created)
    return { status: 201, json: { ...created, version: 1, status: 'ACTIVE' } }
  }

  /**
   * The status and body for one private-API request.
   * @param endpoint - The endpoint its path names.
   * @param method - The request method.
   * @param path - The request path with its query string.
   * @param body - The request body.
   * @returns What to answer.
   */
  async function privateAnswer(
    endpoint: PrivateEndpoint,
    method: string,
    path: string,
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
      case 'feature_flags': {
        return method === 'POST' ? createFeatureFlag(body) : featureFlagPage(path)
      }
      default: {
        return { status: 404, json: { detail: 'Not found.' } }
      }
    }
  }

  /**
   * The answer to `GET /flags/definitions`: a 304 with an empty body for the
   * current ETag, otherwise the status, the raw body or the JSON
   * definitions, with the ETag header.
   * @param request - The incoming request.
   * @returns The status, headers and body text.
   */
  function definitionsAnswer(request: http.IncomingMessage): {
    status: number
    headers: Record<string, string>
    text: string
  } {
    const etag = fake.flagDefinitionsEtag
    const headers: Record<string, string> = etag === undefined ? {} : { etag }
    if (isSameEtag(request.headers['if-none-match'], etag))
      return { status: 304, headers, text: '' }
    const text = fake.flagDefinitionsRawBody ?? JSON.stringify(fake.flagDefinitions)
    return { status: fake.flagDefinitionsStatus, headers, text }
  }

  /**
   * Work out the answer to one request and record it.
   * @param request - The incoming request.
   * @param body - Its body.
   * @returns The status, extra headers and body text.
   */
  async function answerFor(
    request: http.IncomingMessage,
    body: Buffer
  ): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    const path = request.url ?? '/'
    const method = request.method ?? 'GET'
    requests.push({ method, path, headers: request.headers, body })
    const bare = path.split('?', 1)[0] ?? path
    if (bare === '/flags/definitions') {
      await fake.beforeFlagDefinitions?.()
      return definitionsAnswer(request)
    }
    const endpoint = privateEndpointOf(bare)
    if (endpoint !== undefined) {
      authHeaders.push(request.headers.authorization ?? '')
      const privateResult = await privateAnswer(endpoint, method, path, body)
      return { status: privateResult.status, headers: {}, text: JSON.stringify(privateResult.json) }
    }
    let status = state.status
    if (bare === '/batch/') {
      const events = batchOf(body)
      batches.push(events)
      status = state.responder?.(events) ?? status
    }
    return { status, headers: {}, text: JSON.stringify({ status: status < 300 ? 1 : 0, path }) }
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const result = await answerFor(request, body)
      const answer = (): void => {
        held.delete(response)
        if (response.writableEnded) return
        response.writeHead(result.status, {
          'content-type': 'application/json',
          ...result.headers,
          ...state.headers,
        })
        response.end(result.status === 304 ? undefined : result.text)
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
