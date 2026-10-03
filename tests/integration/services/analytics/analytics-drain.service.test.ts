/**
 * @file drainAnalyticsOutbox against the real per-worker Postgres and the
 * fake PostHog: acknowledged rows are deleted, a retryable answer keeps every
 * row through an outage of any length, a lease that expires is resent, two
 * drainers never claim one row, and a rejected batch is bisected down to the
 * row PostHog refuses, which is dropped at its third rejection, unless it
 * refuses every part of the batch and a lone row of each half, which keeps
 * every row. Analytics is enabled for this file only, through a mocked
 * `getEnv()`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANALYTICS_LEASE_SECONDS,
  ANALYTICS_POISON_REJECTIONS,
} from '@/constants/analytics.constants'
import { analyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { drainAnalyticsOutbox } from '@/services/analytics/analytics-drain.service'
import type { PosthogBatchEvent } from '@/services/analytics/posthog-batch.service'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { startFakePosthog, type FakePosthog } from '../../../helpers/fake-posthog'

const target = vi.hoisted(() => ({ host: 'http://127.0.0.1:1', batchSize: 500 }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
      POSTHOG_HOST: target.host,
      ANALYTICS_DRAIN_BATCH_SIZE: target.batchSize,
    }),
  }
})

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
// The longest backoff (600 s) plus the lease: past it, every leased row is claimable again.
const PAST_LEASE_AND_BACKOFF_MS = (ANALYTICS_LEASE_SECONDS + 600 + 1) * SECOND_MS

// eslint-disable-next-line unicorn/no-null -- the column's "not leased" value, as postgres-js returns it
const NOT_LEASED = null

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
 * Insert outbox rows one millisecond apart, oldest first.
 * @param events - Each row's event name.
 * @returns Their ids, in the same order.
 */
async function seed(...events: string[]): Promise<string[]> {
  const base = Date.now() - MINUTE_MS
  const ids: string[] = []
  for (const [index, event] of events.entries()) {
    const [row] = await sql<{ id: string }[]>`
      insert into analytics_outbox (event, distinct_id, properties, occurred_at)
      values (${event}, 'user-1', '{"source":"audit"}'::jsonb,
              ${new Date(base + index).toISOString()}::timestamptz)
      returning id`
    if (!row) throw new Error('outbox insert returned no row')
    ids.push(row.id)
  }
  return ids
}

/**
 * Every outbox row's settlement columns, by id.
 * @returns The rows, oldest first.
 */
function outboxRows() {
  return sql<
    { id: string; attempts: number; rejections: number; claimed_until: Date | null }[]
  >`select id, attempts, rejections, claimed_until from analytics_outbox order by occurred_at`
}

/**
 * A moment some time after another.
 * @param start - The earlier moment.
 * @param ms - How much later.
 * @returns The later moment.
 */
function after(start: Date, ms: number): Date {
  return new Date(start.getTime() + ms)
}

/**
 * Whether a batch carries the event PostHog is made to refuse.
 * @param events - The batch.
 * @returns True when one of them is named `poison`.
 */
function hasPoison(events: PosthogBatchEvent[]): boolean {
  return events.some((event) => event.event === 'poison')
}

/**
 * Sort ids for comparison.
 * @param ids - Ids.
 * @returns A sorted copy.
 */
function sorted(ids: string[]): string[] {
  return ids.toSorted((a, b) => a.localeCompare(b))
}

/**
 * The event names of each batch the fake received.
 * @returns One list per batch.
 */
function batchEvents(): string[][] {
  return posthog().batches.map((batch) => batch.map((event) => event.event))
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
  target.host = fake.posthog.url
})

beforeEach(async () => {
  await sql`delete from analytics_outbox`
})

afterEach(() => {
  vi.restoreAllMocks()
  posthog().respondWith(200)
  posthog().onBatch(undefined)
  posthog().hang(0)
  posthog().requests.length = 0
  posthog().batches.length = 0
  target.batchSize = 500
})

afterAll(async () => {
  await sql`delete from analytics_outbox`
  await fake.posthog?.close()
})

describe('drainAnalyticsOutbox', () => {
  it('sends nothing when the outbox is empty', async () => {
    await expect(drainAnalyticsOutbox()).resolves.toEqual({
      sent: 0,
      retried: 0,
      rejected: 0,
      dropped: 0,
    })
    expect(posthog().requests).toHaveLength(0)
  })

  it('sends one batch oldest first, with the row id as uuid, and deletes it once acknowledged', async () => {
    const ids = await seed('first_event', 'second_event')

    await expect(drainAnalyticsOutbox()).resolves.toEqual({
      sent: 2,
      retried: 0,
      rejected: 0,
      dropped: 0,
    })

    expect(posthog().batches).toHaveLength(1)
    expect(posthog().batches[0]?.map((event) => [event.event, event.uuid])).toEqual([
      ['first_event', ids[0]],
      ['second_event', ids[1]],
    ])
    expect(posthog().batches[0]?.[0]).toMatchObject({
      distinct_id: 'user-1',
      properties: { source: 'audit' },
    })
    expect(await outboxRows()).toEqual([])
  })

  it('claims at most ANALYTICS_DRAIN_BATCH_SIZE rows per drain', async () => {
    target.batchSize = 2
    await seed('a', 'b', 'c')

    await expect(drainAnalyticsOutbox()).resolves.toMatchObject({ sent: 2 })
    await expect(drainAnalyticsOutbox()).resolves.toMatchObject({ sent: 1 })
    expect(batchEvents()).toEqual([['a', 'b'], ['c']])
  })

  it('keeps every row on a retryable answer, and resends it only once the lease and backoff pass', async () => {
    const [id] = await seed('kept_event')
    posthog().respondWith(503)
    const now = new Date()
    const warn = vi.spyOn(logger, 'warn')

    await expect(drainAnalyticsOutbox(now)).resolves.toEqual({
      sent: 0,
      retried: 1,
      rejected: 0,
      dropped: 0,
    })
    expect(warn).toHaveBeenCalledWith('analytics batch deferred', { rows: 1, status: 503 })
    expect(await outboxRows()).toMatchObject([{ id, attempts: 1, rejections: 0 }])

    // Leased: a drain inside the lease sends nothing.
    await drainAnalyticsOutbox(after(now, 30 * SECOND_MS))
    expect(posthog().batches).toHaveLength(1)

    posthog().respondWith(200)
    await expect(
      drainAnalyticsOutbox(after(now, PAST_LEASE_AND_BACKOFF_MS))
    ).resolves.toMatchObject({ sent: 1 })
    expect(posthog().batches.map((batch) => batch[0]?.uuid)).toEqual([id, id])
    expect(await outboxRows()).toEqual([])
  })

  it('drops nothing through an outage of any length: only retention removes rows', async () => {
    const ids = await seed('outage_a', 'outage_b')
    posthog().respondWith(503)
    const start = Date.now()

    // 40 ticks, each past the lease and the longest backoff: more than seven hours of outage.
    for (let tick = 0; tick < 40; tick += 1) {
      const result = await drainAnalyticsOutbox(new Date(start + tick * PAST_LEASE_AND_BACKOFF_MS))
      expect(result).toEqual({ sent: 0, retried: 2, rejected: 0, dropped: 0 })
    }
    const rows = await outboxRows()
    expect(rows.map((row) => [row.id, row.attempts, row.rejections])).toEqual([
      [ids[0], 40, 0],
      [ids[1], 40, 0],
    ])

    posthog().respondWith(200)
    await expect(
      drainAnalyticsOutbox(new Date(start + 40 * PAST_LEASE_AND_BACKOFF_MS))
    ).resolves.toMatchObject({ sent: 2 })
    expect(await outboxRows()).toEqual([])
  })

  it('resends a row whose drainer crashed after claiming it, once its lease expires', async () => {
    const [id] = await seed('crashed_event')
    const now = new Date()
    // A drainer that claimed and then died: the lease is all that is left of it.
    await analyticsOutboxRepository.claimBatch(10, ANALYTICS_LEASE_SECONDS, now)

    await drainAnalyticsOutbox(after(now, 30 * SECOND_MS))
    expect(posthog().batches).toHaveLength(0)

    await expect(
      drainAnalyticsOutbox(after(now, PAST_LEASE_AND_BACKOFF_MS))
    ).resolves.toMatchObject({ sent: 1 })
    expect(posthog().batches[0]?.map((event) => event.uuid)).toEqual([id])
  })

  it('never lets two concurrent drainers claim the same row', async () => {
    target.batchSize = 10
    const names = Array.from({ length: 30 }, (_, index) => `concurrent_${String(index)}`)
    const ids = await seed(...names)
    // Held long enough that all three drains are claiming and sending at once.
    posthog().hang(200)

    await Promise.all([drainAnalyticsOutbox(), drainAnalyticsOutbox(), drainAnalyticsOutbox()])
    // A claim racing another's commit can come back short; whatever it left, later drains send.
    posthog().hang(0)
    for (let drain = 0; drain < 3; drain += 1) {
      const remaining = await outboxRows()
      if (remaining.length === 0) break
      await drainAnalyticsOutbox()
    }

    const sentUuids = posthog()
      .batches.flat()
      .map((event) => event.uuid)
    expect(new Set(sentUuids).size).toBe(sentUuids.length)
    expect(sorted(sentUuids)).toEqual(sorted(ids))
    expect(await outboxRows()).toEqual([])
  })

  it('bisects a rejected batch: delivers the rows PostHog accepts and counts a rejection on the one it refuses', async () => {
    const [, poisonId] = await seed('good_a', 'poison', 'good_c', 'good_d')
    posthog().onBatch((events) => (hasPoison(events) ? 400 : undefined))

    await expect(drainAnalyticsOutbox()).resolves.toEqual({
      sent: 3,
      retried: 0,
      rejected: 1,
      dropped: 0,
    })

    expect(batchEvents()).toEqual([
      ['good_a', 'poison', 'good_c', 'good_d'],
      ['good_a', 'poison'],
      ['good_c', 'good_d'],
      ['good_a'],
      ['poison'],
    ])
    expect(await outboxRows()).toEqual([
      { id: poisonId, attempts: 1, rejections: 1, claimed_until: NOT_LEASED },
    ])
  })

  it('drops a row at its third rejection with an error log naming only its event and id', async () => {
    const [poisonId] = await seed('poison')
    posthog().respondWith(400)
    const error = vi.spyOn(logger, 'error')

    const results = []
    for (let drain = 0; drain < ANALYTICS_POISON_REJECTIONS; drain += 1) {
      results.push(await drainAnalyticsOutbox())
    }

    expect(results.map((result) => [result.rejected, result.dropped])).toEqual([
      [1, 0],
      [1, 0],
      [1, 1],
    ])
    expect(error).toHaveBeenCalledWith('analytics event dropped after repeated rejections', {
      event: 'poison',
      id: poisonId,
    })
    expect(await outboxRows()).toEqual([])
  })

  it('keeps every row through a refused key or host, logging one error per tick, then sends them', async () => {
    await seed('key_a', 'key_b', 'key_c')
    posthog().respondWith(401)
    const error = vi.spyOn(logger, 'error')
    const start = Date.now()

    for (let tick = 0; tick < 4; tick += 1) {
      await expect(
        drainAnalyticsOutbox(new Date(start + tick * PAST_LEASE_AND_BACKOFF_MS))
      ).resolves.toEqual({ sent: 0, retried: 3, rejected: 0, dropped: 0 })
    }
    expect(error).toHaveBeenCalledTimes(4)
    expect(error).toHaveBeenCalledWith(
      'PostHog refused the analytics endpoint; check POSTHOG_PROJECT_KEY and POSTHOG_HOST',
      { status: 401 }
    )
    const rows = await outboxRows()
    expect(rows.map((row) => row.rejections)).toEqual([0, 0, 0])

    posthog().respondWith(200)
    await expect(
      drainAnalyticsOutbox(new Date(start + 4 * PAST_LEASE_AND_BACKOFF_MS))
    ).resolves.toMatchObject({ sent: 3 })
    expect(await outboxRows()).toEqual([])
  })

  it('stops the bisect at the first retryable answer and leaves every unsent row leased', async () => {
    await seed('good_a', 'poison', 'good_c', 'good_d')
    posthog().onBatch((events) => {
      if (events.length === 1) return 503
      return hasPoison(events) ? 400 : undefined
    })

    await expect(drainAnalyticsOutbox()).resolves.toEqual({
      sent: 2,
      retried: 2,
      rejected: 0,
      dropped: 0,
    })

    expect(batchEvents()).toEqual([
      ['good_a', 'poison', 'good_c', 'good_d'],
      ['good_a', 'poison'],
      ['good_c', 'good_d'],
      ['good_a'],
    ])
    const rows = await outboxRows()
    expect(rows.map((row) => row.rejections)).toEqual([0, 0])
    expect(rows.every((row) => row.claimed_until !== null)).toBe(true)
  })

  it('treats a batch refused together with both halves as an endpoint fault: keeps every row, counts none, logs one error per tick', async () => {
    await seed('row_a', 'row_b', 'row_c', 'row_d', 'row_e')
    posthog().respondWith(400)
    const error = vi.spyOn(logger, 'error')
    const start = Date.now()

    for (let tick = 0; tick < 4; tick += 1) {
      await expect(
        drainAnalyticsOutbox(new Date(start + tick * PAST_LEASE_AND_BACKOFF_MS))
      ).resolves.toEqual({ sent: 0, retried: 5, rejected: 0, dropped: 0 })
    }

    // Five sends a tick: the batch, its two halves and each half's first row alone, never a further split.
    expect(posthog().batches).toHaveLength(20)
    expect(batchEvents().slice(0, 5)).toEqual([
      ['row_a', 'row_b', 'row_c', 'row_d', 'row_e'],
      ['row_a', 'row_b', 'row_c'],
      ['row_d', 'row_e'],
      ['row_a'],
      ['row_d'],
    ])
    expect(error).toHaveBeenCalledTimes(4)
    expect(error).toHaveBeenCalledWith(
      'PostHog rejected every part of a batch; treating it as an endpoint fault and keeping the rows',
      { status: 400 }
    )
    const rows = await outboxRows()
    expect(rows.map((row) => row.rejections)).toEqual([0, 0, 0, 0, 0])

    posthog().respondWith(200)
    await expect(
      drainAnalyticsOutbox(new Date(start + 4 * PAST_LEASE_AND_BACKOFF_MS))
    ).resolves.toMatchObject({ sent: 5 })
    expect(await outboxRows()).toEqual([])
  })

  it('stops at a retryable second half without bisecting the refused first half', async () => {
    await seed('good_a', 'poison', 'good_c', 'good_d')
    posthog().onBatch((events) => {
      if (hasPoison(events)) return 400
      return events.length === 2 ? 503 : undefined
    })
    const markRejected = vi.spyOn(analyticsOutboxRepository, 'markRejected')

    await expect(drainAnalyticsOutbox()).resolves.toEqual({
      sent: 0,
      retried: 4,
      rejected: 0,
      dropped: 0,
    })

    expect(batchEvents()).toEqual([
      ['good_a', 'poison', 'good_c', 'good_d'],
      ['good_a', 'poison'],
      ['good_c', 'good_d'],
    ])
    expect(markRejected).not.toHaveBeenCalled()
    const rows = await outboxRows()
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.rejections)).toEqual([0, 0, 0, 0])
    expect(rows.every((row) => row.claimed_until !== null)).toBe(true)
  })

  it('delivers the good rows when each half holds a refused row, without calling it an endpoint fault', async () => {
    const ids = await seed('poison', 'good_b', 'good_c', 'good_d', 'poison', 'good_f')
    posthog().onBatch((events) => (hasPoison(events) ? 400 : undefined))
    const error = vi.spyOn(logger, 'error')

    await expect(drainAnalyticsOutbox()).resolves.toEqual({
      sent: 4,
      retried: 0,
      rejected: 2,
      dropped: 0,
    })

    expect(batchEvents()).toEqual([
      ['poison', 'good_b', 'good_c', 'good_d', 'poison', 'good_f'],
      ['poison', 'good_b', 'good_c'],
      ['good_d', 'poison', 'good_f'],
      ['poison'],
      ['good_d'],
      ['good_b', 'good_c'],
      ['poison', 'good_f'],
      ['poison'],
      ['good_f'],
    ])
    expect(error).not.toHaveBeenCalled()
    expect(await outboxRows()).toEqual([
      { id: ids[0], attempts: 1, rejections: 1, claimed_until: NOT_LEASED },
      { id: ids[4], attempts: 1, rejections: 1, claimed_until: NOT_LEASED },
    ])
  })

  it('still treats a refusal of every body, lone rows included, as an endpoint fault', async () => {
    await seed('row_a', 'row_b', 'row_c', 'row_d')
    posthog().respondWith(400)
    const error = vi.spyOn(logger, 'error')
    const markRejected = vi.spyOn(analyticsOutboxRepository, 'markRejected')
    const deleteByIds = vi.spyOn(analyticsOutboxRepository, 'deleteByIds')

    await expect(drainAnalyticsOutbox()).resolves.toEqual({
      sent: 0,
      retried: 4,
      rejected: 0,
      dropped: 0,
    })

    expect(batchEvents()).toEqual([
      ['row_a', 'row_b', 'row_c', 'row_d'],
      ['row_a', 'row_b'],
      ['row_c', 'row_d'],
      ['row_a'],
      ['row_c'],
    ])
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'PostHog rejected every part of a batch; treating it as an endpoint fault and keeping the rows',
      { status: 400 }
    )
    expect(markRejected).not.toHaveBeenCalled()
    expect(deleteByIds).not.toHaveBeenCalled()
    const rows = await outboxRows()
    expect(rows.map((row) => row.rejections)).toEqual([0, 0, 0, 0])
  })

  it('keeps every row when a lone row of a refused half answers retry', async () => {
    await seed('row_a', 'row_b', 'row_c', 'row_d')
    posthog().onBatch((events) => (events.length === 1 ? 503 : 400))
    const error = vi.spyOn(logger, 'error')
    const markRejected = vi.spyOn(analyticsOutboxRepository, 'markRejected')

    await expect(drainAnalyticsOutbox()).resolves.toEqual({
      sent: 0,
      retried: 4,
      rejected: 0,
      dropped: 0,
    })

    expect(batchEvents()).toEqual([
      ['row_a', 'row_b', 'row_c', 'row_d'],
      ['row_a', 'row_b'],
      ['row_c', 'row_d'],
      ['row_a'],
    ])
    expect(error).not.toHaveBeenCalled()
    expect(markRejected).not.toHaveBeenCalled()
    const rows = await outboxRows()
    expect(rows.map((row) => row.rejections)).toEqual([0, 0, 0, 0])
    expect(rows.every((row) => row.claimed_until !== null)).toBe(true)
  })

  it("delivers the first half's acknowledged lone row when the second half's lone row answers retry", async () => {
    const ids = await seed('row_a', 'row_b', 'row_c', 'row_d')
    posthog().onBatch((events) => {
      if (events.length > 1) return 400
      return events[0]?.event === 'row_a' ? undefined : 503
    })

    await expect(drainAnalyticsOutbox()).resolves.toEqual({
      sent: 1,
      retried: 3,
      rejected: 0,
      dropped: 0,
    })

    expect(batchEvents()).toEqual([
      ['row_a', 'row_b', 'row_c', 'row_d'],
      ['row_a', 'row_b'],
      ['row_c', 'row_d'],
      ['row_a'],
      ['row_c'],
    ])
    const rows = await outboxRows()
    expect(rows.map((row) => row.id)).toEqual(ids.slice(1))
    expect(rows.map((row) => row.rejections)).toEqual([0, 0, 0])
  })
})
