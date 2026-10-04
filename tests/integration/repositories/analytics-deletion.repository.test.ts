/**
 * @file AnalyticsDeletionRepository against the real per-worker Postgres:
 * the insert's conflict rule, the claim's due rule, order, limit and lease,
 * SKIP LOCKED, two concurrent claims, the failure backoff and its cap, the
 * ack delete and the pending count. Every test starts and ends with an empty
 * table, because a claim takes any due row in it.
 */
import { asc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyticsDeletionModel } from '@/database/models/analytics-deletion.model'
import { analyticsDeletionRepository as repository } from '@/repositories/analytics-deletion.repository'
import { db, sql } from '@/services/database.service'

const NOW = new Date('2030-01-01T00:00:00.000Z')
const LEASE_SECONDS = 120
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS

/**
 * An instant some milliseconds after `NOW`.
 * @param ms - Milliseconds after `NOW`; negative for before.
 * @returns The instant.
 */
function at(ms: number): Date {
  return new Date(NOW.getTime() + ms)
}

/**
 * Compare two strings, for sorting ids.
 * @param left - One id.
 * @param right - The other.
 * @returns Their order.
 */
function byText(left: string, right: string): number {
  return left.localeCompare(right)
}

/**
 * Insert one row directly.
 * @param distinctId - Its id.
 * @param notBefore - When it is due.
 * @param attempts - Its failure count.
 */
async function seed(distinctId: string, notBefore: Date, attempts = 0): Promise<void> {
  await sql`
    insert into analytics_deletions (distinct_id, not_before, attempts)
    values (${distinctId}, ${notBefore.toISOString()}::timestamptz, ${attempts})`
}

/**
 * Every row, by id.
 * @returns The rows.
 */
function snapshot() {
  return db
    .select({
      distinctId: analyticsDeletionModel.distinctId,
      notBefore: analyticsDeletionModel.notBefore,
      attempts: analyticsDeletionModel.attempts,
      lastError: analyticsDeletionModel.lastError,
    })
    .from(analyticsDeletionModel)
    .orderBy(asc(analyticsDeletionModel.distinctId))
}

beforeEach(async () => {
  await sql`delete from analytics_deletions`
})

afterEach(async () => {
  await sql`delete from analytics_deletions`
})

describe('AnalyticsDeletionRepository.insert', () => {
  it('writes a due-later row with no attempts, and a second insert for the id changes nothing', async () => {
    await repository.insert('user-a', at(MINUTE_MS))
    await repository.insert('user-a', at(5 * MINUTE_MS))

    const rows = await snapshot()
    expect(rows).toEqual([
      {
        distinctId: 'user-a',
        notBefore: at(MINUTE_MS),
        attempts: 0,
        // eslint-disable-next-line unicorn/no-null -- the column's "never failed" state
        lastError: null,
      },
    ])
  })
})

describe('AnalyticsDeletionRepository.claimDue', () => {
  it('claims only due rows, earliest first, and moves each by the lease', async () => {
    await seed('due-late', at(-SECOND_MS))
    await seed('due-early', at(-MINUTE_MS))
    await seed('exactly-now', NOW)
    await seed('not-yet', at(SECOND_MS))

    const claimed = await repository.claimDue(10, LEASE_SECONDS, NOW)

    expect(claimed.map((row) => row.distinctId).toSorted(byText)).toEqual([
      'due-early',
      'due-late',
      'exactly-now',
    ])
    expect(
      claimed.every((row) => row.notBefore.getTime() === at(LEASE_SECONDS * SECOND_MS).getTime())
    ).toBe(true)
    const rows = await snapshot()
    expect(rows.find((row) => row.distinctId === 'not-yet')?.notBefore).toEqual(at(SECOND_MS))
  })

  it('takes the earliest rows up to the limit, and a claimed row is not claimed again within its lease', async () => {
    await seed('first', at(-3 * SECOND_MS))
    await seed('second', at(-2 * SECOND_MS))
    await seed('third', at(-SECOND_MS))

    const claimed = await repository.claimDue(2, LEASE_SECONDS, NOW)
    expect(claimed.map((row) => row.distinctId).toSorted(byText)).toEqual(['first', 'second'])

    const next = await repository.claimDue(10, LEASE_SECONDS, at(SECOND_MS))
    expect(next.map((row) => row.distinctId)).toEqual(['third'])
    const afterLease = await repository.claimDue(10, LEASE_SECONDS, at(LEASE_SECONDS * SECOND_MS))
    expect(afterLease.map((row) => row.distinctId).toSorted(byText)).toEqual(['first', 'second'])
  })

  it('claims no more than the limit when the planner expects an empty table', async () => {
    // Statistics of an empty table make the planner rescan an `in (...)` subquery per row.
    await sql`analyze analytics_deletions`
    await seed('a', at(-3 * SECOND_MS))
    await seed('b', at(-2 * SECOND_MS))
    await seed('c', at(-SECOND_MS))

    expect(await repository.claimDue(2, LEASE_SECONDS, NOW)).toHaveLength(2)
    const rows = await snapshot()
    expect(rows.filter((row) => row.notBefore.getTime() <= NOW.getTime())).toHaveLength(1)
  })

  it('skips rows another transaction holds locked instead of waiting for them', async () => {
    await seed('locked', at(-2 * SECOND_MS))
    await seed('free', at(-SECOND_MS))

    // The pool has two connections: the open transaction holds one, the claim runs on the other.
    const claimed = await db.transaction(async (tx) => {
      await tx
        .select({ distinctId: analyticsDeletionModel.distinctId })
        .from(analyticsDeletionModel)
        .where(eq(analyticsDeletionModel.distinctId, 'locked'))
        .for('update')
      return repository.claimDue(10, LEASE_SECONDS, NOW)
    })

    expect(claimed.map((row) => row.distinctId)).toEqual(['free'])
  })

  it('never hands one row to two concurrent claims, and neither exceeds its limit', async () => {
    for (let index = 0; index < 20; index += 1) {
      await seed(`user-${String(index).padStart(2, '0')}`, at(-(index + 1) * SECOND_MS))
    }

    const [first, second] = await Promise.all([
      repository.claimDue(8, LEASE_SECONDS, NOW),
      repository.claimDue(8, LEASE_SECONDS, NOW),
    ])

    expect(first.length).toBeLessThanOrEqual(8)
    expect(second.length).toBeLessThanOrEqual(8)
    const ids = [...first, ...second].map((row) => row.distinctId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(16)
  })
})

describe('AnalyticsDeletionRepository.markFailed', () => {
  it('counts the failure, records the error and backs off 2^attempts minutes', async () => {
    await seed('fresh', NOW)
    await seed('third-failure', NOW, 2)

    await repository.markFailed(['fresh', 'third-failure'], 'http_500', NOW)

    expect(await snapshot()).toEqual([
      { distinctId: 'fresh', notBefore: at(2 * MINUTE_MS), attempts: 1, lastError: 'http_500' },
      {
        distinctId: 'third-failure',
        notBefore: at(8 * MINUTE_MS),
        attempts: 3,
        lastError: 'http_500',
      },
    ])
  })

  it('caps the backoff at 6 hours and attempts at the smallint maximum', async () => {
    await seed('ninth-failure', NOW, 8)
    await seed('at-cap', NOW, 32_767)

    await repository.markFailed(['ninth-failure', 'at-cap'], 'timeout', NOW)

    const rows = await snapshot()
    expect(rows).toEqual([
      {
        distinctId: 'at-cap',
        notBefore: at(360 * MINUTE_MS),
        attempts: 32_767,
        lastError: 'timeout',
      },
      {
        distinctId: 'ninth-failure',
        notBefore: at(360 * MINUTE_MS),
        attempts: 9,
        lastError: 'timeout',
      },
    ])
  })

  it('cuts the error to the column width, and does nothing for an empty list', async () => {
    await seed('long', NOW)

    await repository.markFailed([], 'never written', NOW)
    expect(await snapshot()).toEqual([expect.objectContaining({ attempts: 0 })])

    await repository.markFailed(['long'], 'x'.repeat(250), NOW)
    const [stored] = await snapshot()
    expect(stored?.lastError).toHaveLength(200)
  })
})

describe('AnalyticsDeletionRepository.deleteByIds and countPending', () => {
  it('deletes exactly the acknowledged rows, and counts the rest due or not', async () => {
    await seed('acked', NOW)
    await seed('kept-due', NOW)
    await seed('kept-later', at(MINUTE_MS))

    expect(await repository.deleteByIds(['acked', 'unknown'])).toBe(1)
    expect(await repository.deleteByIds([])).toBe(0)

    const rows = await snapshot()
    expect(rows.map((row) => row.distinctId)).toEqual(['kept-due', 'kept-later'])
    expect(await repository.countPending()).toBe(2)
  })
})
