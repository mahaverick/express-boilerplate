/**
 * @file posthogProjectPath and posthogApi against the fake PostHog on
 * 127.0.0.1 (no database, no Redis): the request each call makes, and how
 * each answer is classified. The app host, key and project id come from a
 * mocked `getEnv()`, bound once the fake is listening.
 */
import { inspect } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { posthogApi, posthogProjectPath } from '@/services/analytics/posthog-api.service'
import { startFakePosthog, type FakePosthog } from '../../../helpers/fake-posthog'

const KEY = 'phx_test_key_not_real'

const target = vi.hoisted(
  (): { host: string; key: string | undefined; projectId: number | undefined } => ({
    host: 'http://127.0.0.1:1',
    key: 'phx_test_key_not_real',
    projectId: 4321,
  })
)

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_APP_HOST: target.host,
      POSTHOG_PERSONAL_API_KEY: target.key,
      POSTHOG_PROJECT_ID: target.projectId,
    }),
  }
})

const fake: { posthog?: FakePosthog } = {}

/**
 * The running fake.
 * @returns It.
 */
function posthog(): FakePosthog {
  if (!fake.posthog) throw new Error('the fake PostHog is not running')
  return fake.posthog
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
  target.host = fake.posthog.url
})

afterEach(() => {
  vi.restoreAllMocks()
  const current = posthog()
  current.respondWith(200)
  current.respondWithHeaders({})
  current.respondToQuery(() => ({ status: 200 }))
  current.hang(0)
  current.groupTypesStatus = 200
  current.bulkDeleteStatus = 202
  current.requests.length = 0
  current.queries.length = 0
  current.bulkDeletes.length = 0
  current.authHeaders.length = 0
  target.host = current.url
  target.key = KEY
  target.projectId = 4321
})

afterAll(async () => {
  await fake.posthog?.close()
})

describe('posthogProjectPath', () => {
  it('puts the suffix under the configured project', () => {
    expect(posthogProjectPath('query/')).toBe('/api/projects/4321/query/')
    expect(posthogProjectPath('persons/bulk_delete/')).toBe(
      '/api/projects/4321/persons/bulk_delete/'
    )
  })

  it('refuses a suffix without its trailing slash', () => {
    expect(() => posthogProjectPath('query')).toThrow('must end with "/"')
  })

  it('throws without a project id', () => {
    target.projectId = undefined
    expect(() => posthogProjectPath('query/')).toThrow('POSTHOG_PROJECT_ID is not set')
  })
})

describe('posthogApi', () => {
  it('sends a GET with the Bearer key and returns the parsed body', async () => {
    posthog().groupTypes = [{ group_type: 'tenant', group_type_index: 2 }]

    const result = await posthogApi('GET', posthogProjectPath('groups_types/'))

    expect(result).toEqual({
      kind: 'ok',
      status: 200,
      json: [{ group_type: 'tenant', group_type_index: 2 }],
    })
    expect(posthog().authHeaders).toEqual([`Bearer ${KEY}`])
    const [request] = posthog().requests
    expect(request?.method).toBe('GET')
    expect(request?.path).toBe('/api/projects/4321/groups_types/')
    expect(request?.body.length).toBe(0)
    expect(request?.headers['content-type']).toBeUndefined()
  })

  it('sends a POST body as JSON', async () => {
    posthog().respondToQuery(() => ({ status: 200, json: { columns: ['uuid'], results: [['a']] } }))

    const result = await posthogApi('POST', posthogProjectPath('query/'), {
      query: { kind: 'HogQLQuery', query: 'select 1', values: { id: 'x' } },
    })

    expect(result).toEqual({
      kind: 'ok',
      status: 200,
      json: { columns: ['uuid'], results: [['a']] },
    })
    expect(posthog().queries).toEqual([{ query: 'select 1', values: { id: 'x' } }])
    expect(posthog().requests[0]?.headers['content-type']).toBe('application/json')
  })

  it('counts a 202 as ok', async () => {
    const result = await posthogApi('POST', posthogProjectPath('persons/bulk_delete/'), {
      distinct_ids: ['user-1'],
      delete_events: true,
      delete_recordings: true,
    })

    expect(result).toMatchObject({ kind: 'ok', status: 202, json: { persons_found: 1 } })
  })

  it.each([401, 403, 404, 429, 500, 503])(
    'returns http_error for %i, with no key anywhere in the result',
    async (status) => {
      posthog().respondToQuery(() => ({ status }))

      const result = await posthogApi('POST', posthogProjectPath('query/'), { query: {} })

      expect(result).toEqual({ kind: 'http_error', status })
      expect(inspect(result, { depth: Infinity })).not.toContain(KEY)
    }
  )

  it('returns timeout when the answer outlasts timeoutMs', async () => {
    // Held far longer than the call's 50 ms timeout; close() ends the held request.
    posthog().hang(10_000)

    const result = await posthogApi('GET', posthogProjectPath('groups_types/'), undefined, {
      timeoutMs: 50,
    })

    expect(result).toEqual({ kind: 'timeout' })
  })

  it('returns network when nothing listens', async () => {
    target.host = 'http://127.0.0.1:1'

    expect(await posthogApi('GET', posthogProjectPath('groups_types/'))).toEqual({
      kind: 'network',
    })
  })

  it('refuses a redirect instead of following it', async () => {
    posthog().respondWith(301)
    posthog().respondWithHeaders({ location: `${posthog().url}/elsewhere/` })

    const result = await posthogApi('POST', '/redirected/', { query: {} })

    expect(result).toEqual({ kind: 'network' })
    expect(posthog().requests.map((request) => request.path)).toEqual(['/redirected/'])
  })

  it('returns ok with an undefined body when a 2xx body is empty or not JSON', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    fetchSpy.mockResolvedValueOnce(new Response(undefined, { status: 202 }))

    expect(await posthogApi('GET', posthogProjectPath('groups_types/'))).toEqual({
      kind: 'ok',
      status: 200,
      json: undefined,
    })
    expect(await posthogApi('GET', posthogProjectPath('groups_types/'))).toEqual({
      kind: 'ok',
      status: 202,
      json: undefined,
    })
  })

  it('throws without a personal key, before any request', async () => {
    target.key = undefined

    await expect(posthogApi('GET', '/api/projects/4321/groups_types/')).rejects.toThrow(
      'POSTHOG_PERSONAL_API_KEY is not set'
    )
    expect(posthog().requests).toEqual([])
  })

  it('refuses a path without its trailing slash, before any request', async () => {
    await expect(posthogApi('POST', '/api/projects/4321/query', {})).rejects.toThrow(
      'must end with "/"'
    )
    expect(posthog().requests).toEqual([])
  })
})

describe('the fake PostHog private API', () => {
  it('answers 404 for a project path it does not serve, a missing trailing slash included', async () => {
    const answers = await Promise.all(
      ['/api/projects/4321/query', '/api/projects/4321/events/'].map(async (path) => {
        const response = await fetch(`${posthog().url}${path}`, { method: 'POST' })
        await response.body?.cancel()
        return response.status
      })
    )

    expect(answers).toEqual([404, 404])
    expect(posthog().queries).toEqual([])
  })

  it('records a bulk delete and answers with persons_found equal to the ids sent', async () => {
    const result = await posthogApi('POST', posthogProjectPath('persons/bulk_delete/'), {
      distinct_ids: ['user-1', 'user-2'],
      delete_events: true,
      delete_recordings: true,
    })

    expect(result).toEqual({
      kind: 'ok',
      status: 202,
      json: {
        persons_found: 2,
        persons_queued_for_deletion: 2,
        events_queued_for_deletion: 2,
        recordings_queued_for_deletion: 2,
        deletion_errors: [],
      },
    })
    expect(posthog().bulkDeletes).toEqual([
      { distinct_ids: ['user-1', 'user-2'], delete_events: true, delete_recordings: true },
    ])
  })

  it('answers bulk deletes and group types with the status the test sets', async () => {
    posthog().bulkDeleteStatus = 500
    posthog().groupTypesStatus = 503

    expect(
      await posthogApi('POST', posthogProjectPath('persons/bulk_delete/'), { distinct_ids: [] })
    ).toEqual({ kind: 'http_error', status: 500 })
    expect(await posthogApi('GET', posthogProjectPath('groups_types/'))).toEqual({
      kind: 'http_error',
      status: 503,
    })
  })

  it('leaves the private API alone when respondWith changes the /batch/ status', async () => {
    posthog().respondWith(500)

    expect(await posthogApi('GET', posthogProjectPath('groups_types/'))).toMatchObject({
      kind: 'ok',
      status: 200,
    })
  })
})
