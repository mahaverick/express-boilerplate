/**
 * @file fetchFlagDefinitions against the fake PostHog on 127.0.0.1 (no
 * database, no Redis): the request it makes, the weak ETag sent back
 * verbatim, the 304, the size cap, the timeout, the rate-limit warning and
 * how each failure is classified. The host and keys come from a mocked
 * `getEnv()`, bound once the fake is listening.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FLAG_DEFINITIONS_MAX_BYTES } from '@/constants/flags.constants'
import { fetchFlagDefinitions } from '@/services/flags/flag-definitions-client.service'
import { logger } from '@/services/logger.service'
import {
  EMPTY_FLAG_DEFINITIONS,
  startFakePosthog,
  type FakePosthog,
} from '../../../helpers/fake-posthog'
import { waitUntil } from '../../../helpers/timing'

// eslint-disable-next-line unicorn/no-null -- the stored ETag's contract is null for none
const NONE = null

/**
 * A JSON body of exactly `length` bytes.
 * @param length - The size, at least 10.
 * @returns The body.
 */
function bodyOfLength(length: number): string {
  return JSON.stringify({ pad: 'x'.repeat(length - 10) })
}

const target = vi.hoisted(
  (): { host: string; flagsKey: string | undefined; projectKey: string | undefined } => ({
    host: 'http://127.0.0.1:1',
    flagsKey: 'phs_test_key_not_real',
    projectKey: 'phc_test_key_not_real',
  })
)

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_HOST: target.host,
      POSTHOG_FEATURE_FLAGS_KEY: target.flagsKey,
      POSTHOG_PROJECT_KEY: target.projectKey,
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
  current.hang(0)
  current.respondWithHeaders({})
  current.flagDefinitions = EMPTY_FLAG_DEFINITIONS
  current.flagDefinitionsEtag = 'W/"fake-0"'
  current.flagDefinitionsStatus = 200
  current.flagDefinitionsRawBody = undefined
  current.requests.length = 0
  target.host = current.url
  target.flagsKey = 'phs_test_key_not_real'
  target.projectKey = 'phc_test_key_not_real'
})

afterAll(async () => {
  await fake.posthog?.close()
})

describe('fetchFlagDefinitions', () => {
  it('sends the project key as ?token= and the secure key as a bearer token, with no ETag at first', async () => {
    const result = await fetchFlagDefinitions(NONE)

    expect(result).toEqual({ kind: 'ok', body: EMPTY_FLAG_DEFINITIONS, etag: 'W/"fake-0"' })
    const [request] = posthog().requests
    expect(request?.method).toBe('GET')
    expect(request?.path).toBe('/flags/definitions?token=phc_test_key_not_real')
    expect(request?.headers.authorization).toBe('Bearer phs_test_key_not_real')
    expect(request?.headers['if-none-match']).toBeUndefined()
  })

  it('sends a stored weak ETag back verbatim and reads the 304 as not modified', async () => {
    await expect(fetchFlagDefinitions('W/"fake-0"')).resolves.toEqual({ kind: 'not_modified' })
    expect(posthog().requests[0]?.headers['if-none-match']).toBe('W/"fake-0"')
  })

  it('answers the new body when the ETag no longer matches', async () => {
    posthog().setFlagDefinitions({ ...EMPTY_FLAG_DEFINITIONS, property_matching_version: 2 })
    const result = await fetchFlagDefinitions('W/"fake-0"')
    expect(result).toMatchObject({ kind: 'ok', etag: 'W/"fake-1"' })
  })

  it('reads a missing ETag header as null', async () => {
    posthog().flagDefinitionsEtag = undefined
    await expect(fetchFlagDefinitions(NONE)).resolves.toMatchObject({ kind: 'ok', etag: NONE })
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [400, 'http_error'],
    [503, 'http_error'],
  ] as const)('classifies a %i as %s, with the status', async (status, code) => {
    posthog().flagDefinitionsStatus = status
    await expect(fetchFlagDefinitions(NONE)).resolves.toEqual({ kind: 'error', code, status })
  })

  it('refuses a body that is not JSON', async () => {
    posthog().flagDefinitionsRawBody = '<html>maintenance</html>'
    await expect(fetchFlagDefinitions(NONE)).resolves.toEqual({
      kind: 'error',
      code: 'invalid_body',
    })
  })

  it('refuses a body over the cap without keeping it, and accepts one exactly at the cap', async () => {
    posthog().flagDefinitionsRawBody = bodyOfLength(FLAG_DEFINITIONS_MAX_BYTES + 1)
    await expect(fetchFlagDefinitions(NONE)).resolves.toEqual({
      kind: 'error',
      code: 'body_too_large',
    })
    posthog().flagDefinitionsRawBody = bodyOfLength(FLAG_DEFINITIONS_MAX_BYTES)
    await expect(fetchFlagDefinitions(NONE)).resolves.toMatchObject({ kind: 'ok' })
  })

  it('times out a PostHog that never answers', async () => {
    posthog().hang(60_000)
    const result = await fetchFlagDefinitions(NONE, { signal: AbortSignal.timeout(50) })
    expect(result).toEqual({ kind: 'error', code: 'timeout' })
  })

  it('a fetch aborted by the caller is not classified as a network failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await fetchFlagDefinitions(NONE, { signal: controller.signal })
    expect(result).toEqual({ kind: 'aborted' })
  })

  it('reads a caller abort that lands while the request is in flight as aborted, not as a timeout or network failure', async () => {
    posthog().hang(60_000)
    const controller = new AbortController()
    const fetching = fetchFlagDefinitions(NONE, { signal: controller.signal })
    await waitUntil(() => posthog().requests.length === 1, {
      message: 'the definitions request reached PostHog',
    })

    controller.abort(new Error('shutting down'))

    await expect(fetching).resolves.toEqual({ kind: 'aborted' })
  })

  it('reads a caller signal that aborted with a TimeoutError as a timeout: the timeout check runs first', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('The deadline passed', 'TimeoutError'))
    const result = await fetchFlagDefinitions(NONE, { signal: controller.signal })
    expect(result).toEqual({ kind: 'error', code: 'timeout' })
  })

  it('classifies an unreachable host as network', async () => {
    target.host = 'http://127.0.0.1:1'
    await expect(fetchFlagDefinitions(NONE)).resolves.toEqual({ kind: 'error', code: 'network' })
  })

  it('logs PostHog rate-limit warning header at warn', async () => {
    const warn = vi.spyOn(logger, 'warn')
    posthog().respondWithHeaders({ 'x-posthog-rate-limit-warning': 'near limit' })
    await fetchFlagDefinitions(NONE)
    expect(warn).toHaveBeenCalledWith(
      'PostHog warned that flag definition fetches are near its rate limit',
      { warning: 'near limit' }
    )
  })

  it('never puts either key in a log or a result', async () => {
    const warn = vi.spyOn(logger, 'warn')
    posthog().flagDefinitionsStatus = 401
    const result = await fetchFlagDefinitions(NONE)
    const seen = JSON.stringify([result, warn.mock.calls])
    expect(seen).not.toContain('phs_test_key_not_real')
    expect(seen).not.toContain('phc_test_key_not_real')
  })

  it('throws when the keys are not configured, which only an unchecked caller can reach', async () => {
    target.flagsKey = undefined
    await expect(fetchFlagDefinitions(NONE)).rejects.toThrow('flags are not configured')
  })
})
