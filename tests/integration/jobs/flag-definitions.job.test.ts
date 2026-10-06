/**
 * @file The flag definitions schedule against the real Redis, and one job
 * run against the fake PostHog: a 200 writes and publishes the parsed
 * snapshot, a 304 (sent the stored ETag verbatim) touches only `checkedAt`,
 * and only while the stored snapshot is still the one the run read (a
 * snapshot another replica stored mid-run survives), a failure keeps the
 * snapshot and records the code, a stored snapshot from another registry
 * or parser (its fingerprint differs, or it has none) is fetched
 * unconditionally and replaced, and nothing is fetched while flags are
 * off. No Worker runs in this file.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { isFlagsEnabled } from '@/configs/analytics.config'
import {
  ensureFlagDefinitionsSchedule,
  FLAG_DEFINITIONS_JOB,
  runFlagDefinitionsJob,
} from '@/jobs/flag-definitions.job'
import { getFlagsStatus } from '@/services/flags/flag-counters.service'
import {
  flagSnapshotKey,
  readFlagSnapshot,
  writeFlagSnapshot,
} from '@/services/flags/flag-snapshot.service'
import { logger } from '@/services/logger.service'
import { closeQueue, getAnalyticsQueue } from '@/services/queue.service'
import { createRedisClient, getRedis, redisKey } from '@/services/redis.service'
import { flagRegistryFingerprint } from '@/validators/flag-definition.validators'
import {
  EMPTY_FLAG_DEFINITIONS,
  startFakePosthog,
  type FakePosthog,
} from '../../helpers/fake-posthog'
import { clearFlagKeys } from '../../helpers/flag-redis'

const target = vi.hoisted((): { host: string } => ({ host: 'http://127.0.0.1:1' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_HOST: target.host,
      POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
      POSTHOG_FEATURE_FLAGS_KEY: 'phs_test_key_not_real',
    }),
  }
})

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isFlagsEnabled: vi.fn(() => true) }
})

// eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null
const NONE = null
const T0 = new Date('2026-10-05T12:00:00.000Z')
const T1 = new Date('2026-10-05T12:00:30.000Z')
const fake: { posthog?: FakePosthog } = {}

const BETA_FLAG = {
  id: 1,
  key: 'example_beta_page',
  name: 'Reference flag',
  active: true,
  deleted: false,
  ensure_experience_continuity: false,
  bucketing_identifier: 'distinct_id',
  evaluation_contexts: [],
  evaluation_runtime: 'all',
  filters: {
    aggregation_group_type_index: 0,
    groups: [{ aggregation_group_type_index: 0, properties: [], rollout_percentage: 100 }],
  },
}

/**
 * `example_beta_page` (a boolean entry) with a multivariate definition: kind_drift today.
 */
const DRIFTED_BETA_FLAG = {
  ...BETA_FLAG,
  filters: {
    ...BETA_FLAG.filters,
    multivariate: {
      variants: [
        { key: 'control', rollout_percentage: 50 },
        { key: 'bold', rollout_percentage: 50 },
      ],
    },
  },
}

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

afterEach(async () => {
  vi.mocked(isFlagsEnabled).mockReturnValue(true)
  const current = posthog()
  current.setFlagDefinitions(EMPTY_FLAG_DEFINITIONS)
  current.flagDefinitionsStatus = 200
  current.flagDefinitionsRawBody = undefined
  current.beforeFlagDefinitions = undefined
  current.requests.length = 0
  await clearFlagKeys()
})

afterAll(async () => {
  await getAnalyticsQueue().obliterate({ force: true })
  await closeQueue()
  await fake.posthog?.close()
})

describe('ensureFlagDefinitionsSchedule', () => {
  it('registers one schedule every 30 s on the analytics queue, however many times it is called', async () => {
    await ensureFlagDefinitionsSchedule()
    await ensureFlagDefinitionsSchedule()
    const scheduler = await getAnalyticsQueue().getJobScheduler(FLAG_DEFINITIONS_JOB)
    expect(scheduler).toMatchObject({ name: FLAG_DEFINITIONS_JOB, every: 30_000 })
    expect(scheduler?.template?.opts).toMatchObject({ attempts: 1, removeOnComplete: true })
  })
})

describe('runFlagDefinitionsJob', () => {
  it('writes the parsed snapshot on a 200 and publishes reload', async () => {
    posthog().setFlagDefinitions({ ...EMPTY_FLAG_DEFINITIONS, flags: [BETA_FLAG] })
    const etag = posthog().flagDefinitionsEtag
    const subscriber = createRedisClient()
    const messages: string[] = []
    await subscriber.connect()
    await subscriber.subscribe(redisKey('flags'), (message) => {
      messages.push(message)
    })
    try {
      await runFlagDefinitionsJob(T0)
      const stored = await readFlagSnapshot()
      expect(stored).toMatchObject({
        etag,
        fetchedAt: T0.toISOString(),
        checkedAt: T0.toISOString(),
        propertyMatchingVersion: 1,
        tenantGroupIndex: 0,
        fingerprint: flagRegistryFingerprint(),
      })
      expect(stored?.flags.example_beta_page).toMatchObject({ active: true, unsupported: NONE })
      await vi.waitFor(() => {
        expect(messages).toEqual(['reload'])
      })
      await expect(getFlagsStatus(T0)).resolves.toMatchObject({ lastFetchOk: T0.toISOString() })
    } finally {
      subscriber.destroy()
    }
  })

  it('sends the stored ETag and, on a 304, touches only checkedAt', async () => {
    posthog().setFlagDefinitions({ ...EMPTY_FLAG_DEFINITIONS, flags: [BETA_FLAG] })
    const etag = posthog().flagDefinitionsEtag
    await runFlagDefinitionsJob(T0)
    await runFlagDefinitionsJob(T1)
    expect(posthog().requests.at(-1)?.headers['if-none-match']).toBe(etag)
    const stored = await readFlagSnapshot()
    expect(stored).toMatchObject({
      fetchedAt: T0.toISOString(),
      checkedAt: T1.toISOString(),
      fingerprint: flagRegistryFingerprint(),
    })
    await expect(getFlagsStatus(T1)).resolves.toMatchObject({ lastFetchOk: T1.toISOString() })
  })

  it('on a 304, leaves alone a snapshot another replica stored after this run read its own', async () => {
    posthog().setFlagDefinitions({ ...EMPTY_FLAG_DEFINITIONS, flags: [BETA_FLAG] })
    await runFlagDefinitionsJob(T0)
    const read = await readFlagSnapshot()
    if (!read) throw new Error('the first run stored nothing')
    const newer = {
      ...read,
      etag: 'W/"another-replica"',
      fetchedAt: '2026-10-05T12:00:20.000Z',
      checkedAt: '2026-10-05T12:00:20.000Z',
      flags: {},
    }
    const redis = await getRedis()
    const replica: { stored?: string | null } = {}
    // The fake answers 304 (the ETag this run sent is current), but only after another replica's 200 landed.
    posthog().beforeFlagDefinitions = async () => {
      await writeFlagSnapshot(newer)
      replica.stored = await redis.get(flagSnapshotKey())
    }

    await runFlagDefinitionsJob(T1)

    expect(posthog().requests.at(-1)?.headers['if-none-match']).toBe(read.etag)
    expect(replica.stored).toEqual(expect.any(String))
    expect(await redis.get(flagSnapshotKey())).toBe(replica.stored)
    await expect(readFlagSnapshot()).resolves.toEqual(newer)
    await expect(getFlagsStatus(T1)).resolves.toMatchObject({ lastFetchOk: T1.toISOString() })
  })

  it.each<[string, (stored: Record<string, unknown>) => Record<string, unknown>]>([
    ['a different fingerprint', (stored) => ({ ...stored, fingerprint: 'stale0fingerprint' })],
    ['no fingerprint', ({ fingerprint: _dropped, ...stored }) => stored],
  ])('fetches unconditionally and replaces a stored snapshot with %s', async (_case, rewrite) => {
    posthog().setFlagDefinitions({ ...EMPTY_FLAG_DEFINITIONS, flags: [DRIFTED_BETA_FLAG] })
    await runFlagDefinitionsJob(T0)
    const redis = await getRedis()
    const raw = await redis.get(flagSnapshotKey())
    const first = JSON.parse(String(raw)) as Record<string, unknown>
    // Stand for a snapshot an earlier registry or parser stored: no verdict yet.
    const flags = first.flags as Record<string, Record<string, unknown>>
    const earlier = {
      ...first,
      flags: { example_beta_page: { ...flags.example_beta_page, unsupported: NONE } },
    }
    await redis.set(flagSnapshotKey(), JSON.stringify(rewrite(earlier)))

    await runFlagDefinitionsJob(T1)

    expect(posthog().requests.at(-1)?.headers['if-none-match']).toBeUndefined()
    const stored = await readFlagSnapshot()
    expect(stored).toMatchObject({
      fetchedAt: T1.toISOString(),
      checkedAt: T1.toISOString(),
      fingerprint: flagRegistryFingerprint(),
    })
    expect(stored?.flags.example_beta_page?.unsupported).toBe('kind_drift')
  })

  it('keeps the snapshot and records the code when the fetch fails', async () => {
    posthog().setFlagDefinitions({ ...EMPTY_FLAG_DEFINITIONS, flags: [BETA_FLAG] })
    await runFlagDefinitionsJob(T0)
    posthog().setFlagDefinitions(EMPTY_FLAG_DEFINITIONS)
    posthog().flagDefinitionsStatus = 401
    await runFlagDefinitionsJob(T1)
    const stored = await readFlagSnapshot()
    expect(stored?.checkedAt).toBe(T0.toISOString())
    expect(stored?.flags.example_beta_page).toBeDefined()
    await expect(getFlagsStatus(T1)).resolves.toMatchObject({ lastFetchError: 'unauthorized' })
  })

  it('records invalid_body, keeping the snapshot, for a body that is not the definitions shape', async () => {
    posthog().setFlagDefinitions({ flags: 'not a list' })
    await runFlagDefinitionsJob(T0)
    await expect(readFlagSnapshot()).resolves.toBeNull()
    await expect(getFlagsStatus(T0)).resolves.toMatchObject({ lastFetchError: 'invalid_body' })
  })

  it('treats an unreadable stored snapshot as none: fetches unconditionally and replaces it', async () => {
    posthog().setFlagDefinitions({ ...EMPTY_FLAG_DEFINITIONS, flags: [BETA_FLAG] })
    const etag = posthog().flagDefinitionsEtag
    const redis = await getRedis()
    await redis.set(flagSnapshotKey(), 'garbage-value-not-json')
    const warn = vi.spyOn(logger, 'warn')
    await runFlagDefinitionsJob(T0)
    expect(posthog().requests.at(-1)?.headers['if-none-match']).toBeUndefined()
    await expect(readFlagSnapshot()).resolves.toMatchObject({ etag, checkedAt: T0.toISOString() })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('garbage-value-not-json')
    warn.mockRestore()
  })

  it('fetches nothing while flags are off', async () => {
    vi.mocked(isFlagsEnabled).mockReturnValue(false)
    await runFlagDefinitionsJob(T0)
    expect(posthog().requests).toHaveLength(0)
  })
})
