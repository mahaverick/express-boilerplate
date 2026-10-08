/**
 * @file The fetch counters and getFlagsStatus against the real Redis: the
 * last success and failure, the undeclared-variant window across minutes,
 * the counts by state from a snapshot, staleness, and zeros (never a
 * rejection) when Redis fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isFlagsEnabled } from '@/configs/analytics.config'
import {
  getFlagsStatus,
  recordFlagFetch,
  recordUnknownVariant,
} from '@/services/flags/flag-counters.service'
import { getFlagSnapshot } from '@/services/flags/flag-snapshot.service'
import { logger } from '@/services/logger.service'
import { getRedis } from '@/services/redis.service'
import { flagDefinitionSchema, type ParsedSnapshot } from '@/validators/flag-definition.validators'
import { clearFlagKeys } from '../../../helpers/flag-redis'

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isFlagsEnabled: vi.fn(() => true) }
})

vi.mock('@/services/flags/flag-snapshot.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/flags/flag-snapshot.service')>()
  return { ...actual, getFlagSnapshot: vi.fn() }
})

// eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null
const NONE = null
const NOW = new Date('2026-10-05T12:00:00.000Z')

/**
 * A snapshot entry.
 * @param key - The flag key.
 * @param fields - Fields to change.
 * @param fields.active - Whether it is active; true by default.
 * @param fields.unsupported - Its unsupported construct; none by default.
 * @returns The entry.
 */
function entry(
  key: string,
  fields: { active?: boolean; unsupported?: 'cohort' } = {}
): ParsedSnapshot['flags'][string] {
  const raw = flagDefinitionSchema.parse({ id: 1, key, active: true, filters: { groups: [] } })
  return {
    key,
    id: 1,
    active: fields.active ?? true,
    unsupported: fields.unsupported ?? NONE,
    raw,
  }
}

/**
 * A snapshot holding the given entries, checked at `checkedAt`.
 * @param flags - The entries.
 * @param checkedAt - When PostHog last confirmed it.
 * @returns The snapshot.
 */
function snapshotOf(flags: ParsedSnapshot['flags'][string][], checkedAt: string): ParsedSnapshot {
  return {
    etag: NONE,
    fetchedAt: '2026-10-05T11:00:00.000Z',
    checkedAt,
    propertyMatchingVersion: 1,
    tenantGroupIndex: 0,
    flags: Object.fromEntries(flags.map((flag) => [flag.key, flag])),
  }
}

beforeEach(async () => {
  vi.mocked(isFlagsEnabled).mockReturnValue(true)
  vi.mocked(getFlagSnapshot).mockReturnValue(NONE)
  await clearFlagKeys()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await clearFlagKeys()
})

describe('recordFlagFetch', () => {
  it('records the last success, and a failure until the next success', async () => {
    await recordFlagFetch('ok', NOW)
    expect(await getFlagsStatus(NOW)).toMatchObject({
      lastFetchOk: '2026-10-05T12:00:00.000Z',
      lastFetchError: NONE,
    })
    await recordFlagFetch('timeout', NOW)
    expect(await getFlagsStatus(NOW)).toMatchObject({
      lastFetchOk: '2026-10-05T12:00:00.000Z',
      lastFetchError: 'timeout',
    })
    const later = new Date('2026-10-05T12:00:30.000Z')
    await recordFlagFetch('not_modified', later)
    expect(await getFlagsStatus(later)).toMatchObject({
      lastFetchOk: '2026-10-05T12:00:30.000Z',
      lastFetchError: NONE,
    })
  })

  it('never rejects when Redis fails', async () => {
    const redis = await getRedis()
    vi.spyOn(redis, 'multi').mockImplementation(() => {
      throw new Error('Redis down')
    })
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('Redis down'))
    await expect(recordFlagFetch('ok', NOW)).resolves.toBeUndefined()
    await expect(recordFlagFetch('network', NOW)).resolves.toBeUndefined()
    await expect(recordUnknownVariant('example_cta_experiment', NOW)).resolves.toBeUndefined()
  })
})

describe('recordUnknownVariant', () => {
  it('counts across the last 15 minutes only, and warns once per key per process', async () => {
    const warn = vi.spyOn(logger, 'warn')
    await recordUnknownVariant('probe_unknown_key', new Date('2026-10-05T11:44:00.000Z'))
    await recordUnknownVariant('probe_unknown_key', new Date('2026-10-05T11:46:00.000Z'))
    await recordUnknownVariant('probe_unknown_key', NOW)
    await expect(getFlagsStatus(NOW)).resolves.toMatchObject({ counts: { unknownVariant15m: 2 } })
    expect(warn.mock.calls.filter(([message]) => message.includes('variant'))).toHaveLength(1)
  })
})

describe('getFlagsStatus', () => {
  it('counts registered flags by state, and PostHog flags the registry does not declare', async () => {
    vi.mocked(getFlagSnapshot).mockReturnValue(
      snapshotOf(
        [
          entry('example_beta_page', { active: false }),
          entry('example_cta_experiment', { unsupported: 'cohort' }),
          entry('sp5d_probe_roll37'),
          entry('sp5d_probe_mv2'),
        ],
        '2026-10-05T11:55:00.000Z'
      )
    )
    expect(await getFlagsStatus(NOW)).toEqual({
      enabled: true,
      snapshotAt: '2026-10-05T11:00:00.000Z',
      checkedAt: '2026-10-05T11:55:00.000Z',
      stale: false,
      lastFetchOk: NONE,
      lastFetchError: NONE,
      propertyMatchingVersion: 1,
      counts: {
        registered: 2,
        active: 0,
        inactive: 1,
        missing: 0,
        unsupported: 1,
        unregistered: 2,
        unknownVariant15m: 0,
      },
    })
  })

  it('counts a registered flag absent from PostHog as missing', async () => {
    vi.mocked(getFlagSnapshot).mockReturnValue(
      snapshotOf([entry('example_beta_page')], '2026-10-05T11:55:00.000Z')
    )
    await expect(getFlagsStatus(NOW)).resolves.toMatchObject({ counts: { active: 1, missing: 1 } })
  })

  it('is stale when checked more than 10 minutes ago, or with no snapshot while enabled', async () => {
    vi.mocked(getFlagSnapshot).mockReturnValue(snapshotOf([], '2026-10-05T11:49:59.000Z'))
    await expect(getFlagsStatus(NOW)).resolves.toMatchObject({ stale: true })
    vi.mocked(getFlagSnapshot).mockReturnValue(snapshotOf([], '2026-10-05T11:50:00.000Z'))
    await expect(getFlagsStatus(NOW)).resolves.toMatchObject({ stale: false })
    vi.mocked(getFlagSnapshot).mockReturnValue(NONE)
    expect(await getFlagsStatus(NOW)).toMatchObject({
      stale: true,
      snapshotAt: NONE,
      checkedAt: NONE,
      propertyMatchingVersion: NONE,
      counts: { registered: 2, active: 0, missing: 0, unregistered: 0 },
    })
  })

  it('a snapshot whose checkedAt does not parse reads as stale', async () => {
    vi.mocked(getFlagSnapshot).mockReturnValue(snapshotOf([], 'garbage'))
    expect(await getFlagsStatus(NOW)).toMatchObject({ stale: true })
  })

  it('is never stale while flags are not configured', async () => {
    vi.mocked(isFlagsEnabled).mockReturnValue(false)
    expect(await getFlagsStatus(NOW)).toMatchObject({ enabled: false, stale: false })
  })

  it('reports no fetch outcome and zero variants, never rejecting, when Redis fails', async () => {
    vi.mocked(getFlagSnapshot).mockReturnValue(snapshotOf([], '2026-10-05T11:55:00.000Z'))
    const redis = await getRedis()
    vi.spyOn(redis, 'mGet').mockRejectedValue(new Error('Redis down'))
    const warn = vi.spyOn(logger, 'warn')
    expect(await getFlagsStatus(NOW)).toMatchObject({
      lastFetchOk: NONE,
      lastFetchError: NONE,
      counts: { unknownVariant15m: 0 },
    })
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      'Flag counters unavailable; reporting no fetch outcome'
    )
  })
})
