/**
 * @file tenantGroupTypeIndex against the fake PostHog on 127.0.0.1 (no
 * database, no Redis): the index is read once and kept, whatever its value;
 * a missing `tenant` type is logged at error and not kept; a failed or
 * malformed answer throws TimelineUnavailableError.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import {
  resetTenantGroupTypeIndexCache,
  tenantGroupTypeIndex,
} from '@/services/analytics/timeline-group-index.service'
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
 * The running fake.
 * @returns It.
 */
function posthog(): FakePosthog {
  if (!fake.posthog) throw new Error('the fake PostHog is not running')
  return fake.posthog
}

/**
 * How many `groups_types/` requests the fake has had.
 * @returns The count.
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
      'PostHog has no "tenant" group type, so tenant timelines are unavailable',
      { groupType: 'tenant' }
    )

    posthog().groupTypes = [{ group_type: 'tenant', group_type_index: 1 }]
    expect(await tenantGroupTypeIndex()).toBe(1)
    expect(groupTypeCalls()).toBe(2)
  })

  it('throws TimelineUnavailableError, logged at warn, when PostHog fails, and keeps nothing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    posthog().groupTypesStatus = 503

    await expect(tenantGroupTypeIndex()).rejects.toBeInstanceOf(TimelineUnavailableError)
    expect(warn).toHaveBeenCalledWith('PostHog refused a timeline call', {
      operation: 'group types',
      status: 503,
    })

    posthog().groupTypesStatus = 200
    expect(await tenantGroupTypeIndex()).toBe(0)
  })

  it('throws on a 401, logged at error as a misconfiguration', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    posthog().groupTypesStatus = 401

    await expect(tenantGroupTypeIndex()).rejects.toBeInstanceOf(TimelineUnavailableError)
    expect(error).toHaveBeenCalledWith('Timeline key or project misconfigured', {
      operation: 'group types',
      status: 401,
    })
  })

  it.each([
    ['an object', { results: [] }],
    ['an index out of range', [{ group_type: 'tenant', group_type_index: 5 }]],
    ['a string index', [{ group_type: 'tenant', group_type_index: '0' }]],
  ])('throws on %s, logged at error', async (_name, answer) => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    posthog().groupTypes = answer as unknown as FakePosthog['groupTypes']

    await expect(tenantGroupTypeIndex()).rejects.toBeInstanceOf(TimelineUnavailableError)
    expect(error).toHaveBeenCalledWith(
      'PostHog answered the group types call in an unexpected shape'
    )
  })
})
