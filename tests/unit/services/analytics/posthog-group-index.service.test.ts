/**
 * @file tenantGroupTypeIndex against the fake PostHog on 127.0.0.1 (no
 * database, no Redis): the index is read once and kept, whatever its value;
 * a missing `tenant` type is logged at error and not kept; a failed or
 * malformed answer throws PosthogUnavailableError.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PosthogUnavailableError } from '@/errors/posthog-errors'
import {
  resetTenantGroupTypeIndexCache,
  tenantGroupTypeIndex,
} from '@/services/analytics/posthog-group-index.service'
import { logger } from '@/services/logger.service'
import { startFakePosthog, type FakePosthog } from '../../../helpers/fake-posthog'

const target = vi.hoisted(() => ({ host: 'http://127.0.0.1:1' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_APP_HOST: target.host,
      POSTHOG_PERSONAL_API_KEY: 'phx_test_key_not_real',
      POSTHOG_PROJECT_ID: 4321,
    }),
  }
})

const fake: { posthog?: FakePosthog } = {}

/**
 * The fake PostHog `beforeAll` started, or a throw before it has.
 */
function posthog(): FakePosthog {
  if (!fake.posthog) throw new Error('the fake PostHog is not running')
  return fake.posthog
}

/**
 * How many `groups_types/` requests the fake has had, which shows whether a
 * lookup was served from the cache.
 */
function groupTypeCalls(): number {
  return posthog().requests.filter((request) => request.path.endsWith('/groups_types/')).length
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
  target.host = fake.posthog.url
})

beforeEach(() => {
  resetTenantGroupTypeIndexCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  target.host = posthog().url
  posthog().groupTypes = [{ group_type: 'tenant', group_type_index: 0 }]
  posthog().groupTypesStatus = 200
  posthog().requests.length = 0
})

afterAll(async () => {
  await fake.posthog?.close()
})

describe('tenantGroupTypeIndex', () => {
  it('reads index 0 once and keeps it', async () => {
    expect(await tenantGroupTypeIndex()).toBe(0)
    expect(await tenantGroupTypeIndex()).toBe(0)
    expect(groupTypeCalls()).toBe(1)
  })

  it('uses whatever index PostHog gave the tenant type', async () => {
    posthog().groupTypes = [
      { group_type: 'organization', group_type_index: 0 },
      { group_type: 'project', group_type_index: 1 },
      { group_type: 'tenant', group_type_index: 2 },
    ]

    expect(await tenantGroupTypeIndex()).toBe(2)
  })

  it('returns undefined for a project with no tenant type, logs it at error and asks again next time', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    posthog().groupTypes = [{ group_type: 'organization', group_type_index: 0 }]

    expect(await tenantGroupTypeIndex()).toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      'PostHog has no "tenant" group type, so tenant group lookups are unavailable',
      { groupType: 'tenant' }
    )

    posthog().groupTypes = [{ group_type: 'tenant', group_type_index: 1 }]
    expect(await tenantGroupTypeIndex()).toBe(1)
    expect(groupTypeCalls()).toBe(2)
  })

  it('throws PosthogUnavailableError, logged at warn, when PostHog fails, and keeps nothing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    posthog().groupTypesStatus = 503

    await expect(tenantGroupTypeIndex()).rejects.toBeInstanceOf(PosthogUnavailableError)
    expect(warn).toHaveBeenCalledWith('PostHog refused a private API call', {
      operation: 'group types',
      status: 503,
    })

    posthog().groupTypesStatus = 200
    expect(await tenantGroupTypeIndex()).toBe(0)
  })

  it.each([
    [400, 'error', 'PostHog rejected a private API call'],
    [401, 'error', 'PostHog key or project misconfigured'],
    [403, 'error', 'PostHog key or project misconfigured'],
    [404, 'error', 'PostHog key or project misconfigured'],
    [429, 'warn', 'PostHog refused a private API call'],
    [500, 'warn', 'PostHog refused a private API call'],
    [502, 'warn', 'PostHog refused a private API call'],
  ] as const)('logs a %i at %s with "%s"', async (status, level, message) => {
    const logged = vi.spyOn(logger, level).mockImplementation(() => {})
    const other = vi
      .spyOn(logger, level === 'error' ? 'warn' : 'error')
      .mockImplementation(() => {})
    posthog().groupTypesStatus = status

    await expect(tenantGroupTypeIndex()).rejects.toBeInstanceOf(PosthogUnavailableError)

    expect(logged).toHaveBeenCalledWith(message, { operation: 'group types', status })
    expect(other).not.toHaveBeenCalled()
  })

  it('logs a network failure at warn as an unanswered call', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    target.host = 'http://127.0.0.1:1'

    await expect(tenantGroupTypeIndex()).rejects.toBeInstanceOf(PosthogUnavailableError)

    expect(warn).toHaveBeenCalledWith('PostHog did not answer a private API call', {
      operation: 'group types',
      outcome: 'network',
    })
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a timeout at warn as an unanswered call', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new DOMException('The operation timed out.', 'TimeoutError')
    )

    await expect(tenantGroupTypeIndex()).rejects.toBeInstanceOf(PosthogUnavailableError)

    expect(warn).toHaveBeenCalledWith('PostHog did not answer a private API call', {
      operation: 'group types',
      outcome: 'timeout',
    })
    expect(error).not.toHaveBeenCalled()
  })

  it.each([
    ['an object', { results: [] }],
    ['an index out of range', [{ group_type: 'tenant', group_type_index: 5 }]],
    ['a string index', [{ group_type: 'tenant', group_type_index: '0' }]],
  ])('throws on %s, logged at error', async (_name, answer) => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    posthog().groupTypes = answer as unknown as FakePosthog['groupTypes']

    await expect(tenantGroupTypeIndex()).rejects.toBeInstanceOf(PosthogUnavailableError)
    expect(error).toHaveBeenCalledWith(
      'PostHog answered the group types call in an unexpected shape'
    )
  })
})
