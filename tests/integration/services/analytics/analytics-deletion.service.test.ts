/**
 * @file processAnalyticsDeletions against the real per-worker Postgres and
 * the fake PostHog: an acknowledged deletion removes its rows, a failure
 * keeps them with a backoff and `last_error`, a row not yet due is not sent,
 * one tick sends at most `ANALYTICS_DELETION_BATCH_SIZE` ids, and nothing
 * is sent while the personal API key is not configured. The timeline config
 * is set for this file only, through a mocked `getEnv()`.
 */
import { asc } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANALYTICS_DELETION_BATCH_SIZE } from '@/constants/analytics.constants'
import { analyticsDeletionModel } from '@/database/models/analytics-deletion.model'
import { processAnalyticsDeletions } from '@/services/analytics/analytics-deletion.service'
import { db, sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { startFakePosthog, type FakePosthog } from '../../../helpers/fake-posthog'

const target = vi.hoisted((): { host: string; key: string | undefined } => ({
  host: 'http://127.0.0.1:1',
  key: 'phx_test_key_not_real',
}))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_PERSONAL_API_KEY: target.key,
      POSTHOG_PROJECT_ID: 4242,
      POSTHOG_APP_HOST: target.host,
    }),
  }
})

const NOW = new Date('2030-01-01T00:00:00.000Z')
const MINUTE_MS = 60_000

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
 * Insert deletion rows due at `notBefore`.
 * @param notBefore - When they are due.
 * @param ids - Their distinct ids.
 */
async function seed(notBefore: Date, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await sql`
      insert into analytics_deletions (distinct_id, not_before, created_at)
      values (${id}, ${notBefore.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`
  }
}

/**
 * Every row, by id.
 * @returns The rows.
 */
function rows() {
  return db.select().from(analyticsDeletionModel).orderBy(asc(analyticsDeletionModel.distinctId))
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
  target.host = fake.posthog.url
})

beforeEach(async () => {
  await sql`delete from analytics_deletions`
  await sql`delete from analytics_outbox`
})

afterEach(() => {
  vi.restoreAllMocks()
  target.key = 'phx_test_key_not_real'
  posthog().bulkDeleteStatus = 202
  posthog().bulkDeleteErrors = () => []
  posthog().hang(0)
  posthog().bulkDeletes.length = 0
  posthog().authHeaders.length = 0
  posthog().requests.length = 0
})

afterAll(async () => {
  await sql`delete from analytics_deletions`
  await sql`delete from analytics_outbox`
  await fake.posthog?.close()
})

describe('processAnalyticsDeletions', () => {
  it('sends the due ids in one bulk delete with events and recordings, and deletes the rows on 202', async () => {
    await seed(NOW, 'user-a', 'user-b')

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 2, failed: 0 })

    expect(posthog().bulkDeletes).toHaveLength(1)
    const [body] = posthog().bulkDeletes
    expect(body).toMatchObject({ delete_events: true, delete_recordings: true })
    expect(body?.distinct_ids.toSorted((left, right) => left.localeCompare(right))).toEqual([
      'user-a',
      'user-b',
    ])
    expect(posthog().requests.map((request) => [request.method, request.path])).toEqual([
      ['POST', '/api/projects/4242/persons/bulk_delete/'],
    ])
    expect(posthog().authHeaders).toEqual(['Bearer phx_test_key_not_real'])
    expect(await rows()).toEqual([])
  })

  it('keeps every row on a failure, counting it, recording the status and backing off', async () => {
    await seed(NOW, 'user-a')
    posthog().bulkDeleteStatus = 500
    const warn = vi.spyOn(logger, 'warn')

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 0, failed: 1 })

    const twoMinutesLater = new Date(NOW.getTime() + 2 * MINUTE_MS)
    expect(await rows()).toEqual([
      expect.objectContaining({
        distinctId: 'user-a',
        attempts: 1,
        lastError: 'http_500',
        notBefore: twoMinutesLater,
      }),
    ])
    expect(warn).toHaveBeenCalledWith(
      'PostHog deletion of purged users failed; retrying with backoff',
      { rows: 1, lastError: 'http_500', deletionErrors: undefined }
    )
    // Due again only once the backoff passes.
    posthog().bulkDeleteStatus = 202
    const oneMinuteLater = new Date(NOW.getTime() + MINUTE_MS)
    await expect(processAnalyticsDeletions(oneMinuteLater)).resolves.toEqual({
      deleted: 0,
      failed: 0,
    })
    await expect(processAnalyticsDeletions(twoMinutesLater)).resolves.toEqual({
      deleted: 1,
      failed: 0,
    })
  })

  it('sends nothing for a row that is not yet due', async () => {
    await seed(new Date(NOW.getTime() + MINUTE_MS), 'later')

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 0, failed: 0 })

    expect(posthog().requests).toHaveLength(0)
    expect(await rows()).toHaveLength(1)
  })

  it('sends at most ANALYTICS_DELETION_BATCH_SIZE ids per tick', async () => {
    const ids = Array.from(
      { length: ANALYTICS_DELETION_BATCH_SIZE + 1 },
      (_unused, index) => `user-${String(index).padStart(2, '0')}`
    )
    await seed(NOW, ...ids)

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({
      deleted: ANALYTICS_DELETION_BATCH_SIZE,
      failed: 0,
    })
    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 1, failed: 0 })
    expect(posthog().bulkDeletes.map((body) => body.distinct_ids.length)).toEqual([
      ANALYTICS_DELETION_BATCH_SIZE,
      1,
    ])
  })

  it('sends nothing and keeps the rows while the personal API key is not set', async () => {
    target.key = undefined
    await seed(NOW, 'user-a')

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 0, failed: 0 })

    expect(posthog().requests).toHaveLength(0)
    expect(await rows()).toEqual([expect.objectContaining({ distinctId: 'user-a', attempts: 0 })])
  })

  it('deletes an outbox row committed after the purge, for a claimed id only', async () => {
    await seed(NOW, 'user-a')
    // An event a request in flight at the purge committed after the purge's own outbox delete.
    await sql`
      insert into analytics_outbox (event, distinct_id, properties, occurred_at)
      values ('late.event', 'user-a', '{}'::jsonb, ${NOW.toISOString()}::timestamptz),
             ('other.event', 'someone-else', '{}'::jsonb, ${NOW.toISOString()}::timestamptz)`

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 1, failed: 0 })

    const remaining = await sql<{ distinct_id: string }[]>`select distinct_id from analytics_outbox`
    expect(remaining.map((row) => row.distinct_id)).toEqual(['someone-else'])
  })

  it('splits a batch with a partial deletion_errors into one request per id, so one bad id holds back no other', async () => {
    await seed(NOW, 'user-a', 'user-b', 'user-c')
    posthog().bulkDeleteErrors = (ids) =>
      ids.includes('user-b') ? [{ id: 'user-b', detail: 'rejected' }] : []
    const warn = vi.spyOn(logger, 'warn')

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 2, failed: 1 })

    expect(posthog().bulkDeletes.map((body) => body.distinct_ids)).toEqual([
      ['user-a', 'user-b', 'user-c'],
      ['user-a'],
      ['user-b'],
      ['user-c'],
    ])
    expect(await rows()).toEqual([
      expect.objectContaining({ distinctId: 'user-b', attempts: 1, lastError: 'deletion_errors' }),
    ])
    expect(warn).toHaveBeenCalledWith(
      'PostHog rejected part of a deletion batch; sending its ids one by one',
      { rows: 3 }
    )
  })

  it('does not split a batch that times out: every row is backed off together', async () => {
    await seed(NOW, 'user-a', 'user-b')
    posthog().hang(200)
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => originalTimeout(50))

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 0, failed: 2 })

    spy.mockRestore()
    expect(posthog().bulkDeletes).toHaveLength(1)
    const stored = await rows()
    expect(stored.map((row) => [row.distinctId, row.lastError, row.attempts])).toEqual([
      ['user-a', 'timeout', 1],
      ['user-b', 'timeout', 1],
    ])
  })
})
