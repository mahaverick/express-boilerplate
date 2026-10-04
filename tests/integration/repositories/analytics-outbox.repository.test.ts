/**
 * @file AnalyticsOutboxRepository against the real per-worker Postgres: the
 * column defaults, the claim's order, limit, lease and backoff boundaries,
 * SKIP LOCKED, acks, rejections, the poison rule keyed on rejections only,
 * and the retention delete. Every test starts and ends with an empty
 * outbox, because a claim takes any sendable row in the table.
 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  analyticsOutboxModel,
  type NewAnalyticsOutboxRow,
} from '@/database/models/analytics-outbox.model'
import { analyticsOutboxRepository as repository } from '@/repositories/analytics-outbox.repository'
import { db, sql } from '@/services/database.service'

const NOW = new Date('2030-01-01T00:00:00.000Z')
// eslint-disable-next-line unicorn/no-null -- the lease column's "never claimed" state, as postgres returns it
const NONE = null
const LEASE_SECONDS = 60
const SECOND_MS = 1000

/**
 * An instant some milliseconds after `NOW`.
 * @param ms - Milliseconds after `NOW`; negative for before.
 * @returns The instant.
 */
function at(ms: number): Date {
  return new Date(NOW.getTime() + ms)
}

/**
 * A minimal row, with overrides.
 * @param overrides - Columns to set.
 * @returns The row.
 */
function row(overrides: Partial<NewAnalyticsOutboxRow> = {}): NewAnalyticsOutboxRow {
  return {
    event: 'probe_event',
    distinctId: 'user-1',
    properties: { source: 'product' },
    occurredAt: at(-60 * SECOND_MS),
    ...overrides,
  }
}

/**
 * Insert rows and return their ids in insertion order.
 * @param rows - The rows.
 * @returns Their ids.
 */
async function seed(rows: NewAnalyticsOutboxRow[]): Promise<string[]> {
  const ids: string[] = []
  for (const value of rows) {
    const [inserted] = await sql<{ id: string }[]>`
      insert into analytics_outbox (event, distinct_id, properties, occurred_at, claimed_until, attempts, rejections)
      values (${value.event}, ${value.distinctId}, ${JSON.stringify(value.properties)}::jsonb,
        ${(value.occurredAt ?? NOW).toISOString()}::timestamptz,
        ${value.claimedUntil ? value.claimedUntil.toISOString() : NONE}::timestamptz,
        ${value.attempts ?? 0}, ${value.rejections ?? 0})
      returning id`
    if (!inserted) throw new Error('setup: insert returned no row')
    ids.push(inserted.id)
  }
  return ids
}

/**
 * Every row's id, attempts, rejections and lease, by id.
 * @returns The rows.
 */
async function snapshot() {
  return sql<{ id: string; attempts: number; rejections: number; claimed_until: Date | null }[]>`
    select id, attempts, rejections, claimed_until from analytics_outbox order by occurred_at, id`
}

beforeEach(async () => {
  await sql`delete from analytics_outbox`
})

afterEach(async () => {
  await sql`delete from analytics_outbox`
})

describe('AnalyticsOutboxRepository.insert and insertMany', () => {
  it('writes a uuidv7 id, the event as given, and zero attempts, rejections and lease', async () => {
    await repository.insert(row({ properties: { source: 'audit', $groups: { tenant: 't-1' } } }))

    const [stored] = await db.select().from(analyticsOutboxModel)
    expect(stored).toMatchObject({
      event: 'probe_event',
      distinctId: 'user-1',
      properties: { source: 'audit', $groups: { tenant: 't-1' } },
      occurredAt: at(-60 * SECOND_MS),
      claimedUntil: NONE,
      attempts: 0,
      rejections: 0,
    })
    expect(stored?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('stamps occurred_at with the database clock when the row names none', async () => {
    await repository.insert({ event: 'probe_event', distinctId: 'user-1', properties: {} })

    const [stored] = await sql<{ is_recent: boolean }[]>`
      select occurred_at > now() - interval '1 minute' as is_recent from analytics_outbox`
    expect(stored?.is_recent).toBe(true)
  })

  it('inserts several rows in one call, and nothing for an empty list', async () => {
    await repository.insertMany([])
    await repository.insertMany([row({ event: 'a' }), row({ event: 'b' })])

    const rows = await sql<{ event: string }[]>`select event from analytics_outbox order by event`
    expect(rows.map((stored) => stored.event)).toEqual(['a', 'b'])
  })

  it('joins a transaction, so a rollback takes the row with it', async () => {
    await expect(
      db.transaction(async (tx) => {
        await repository.insert(row(), tx)
        throw new Error('roll back')
      })
    ).rejects.toThrow('roll back')

    expect(await snapshot()).toEqual([])
  })
})

describe('AnalyticsOutboxRepository.claimBatch', () => {
  it('leases the oldest sendable rows up to the limit and counts the attempt', async () => {
    const ids = await seed([
      row({ occurredAt: at(-3 * SECOND_MS) }),
      row({ occurredAt: at(-SECOND_MS) }),
      row({ occurredAt: at(-2 * SECOND_MS) }),
    ])

    const claimed = await repository.claimBatch(2, LEASE_SECONDS, NOW)

    expect(claimed.map((claim) => claim.id)).toEqual(expect.arrayContaining([ids[0], ids[2]]))
    expect(claimed).toHaveLength(2)
    for (const claim of claimed) {
      expect(claim).toMatchObject({
        event: 'probe_event',
        distinctId: 'user-1',
        attempts: 1,
        rejections: 0,
        claimedUntil: at(LEASE_SECONDS * SECOND_MS),
      })
    }
    const rows = await snapshot()
    expect(rows.find((stored) => stored.id === ids[1])).toMatchObject({
      attempts: 0,
      claimed_until: NONE,
    })
  })

  it('returns nothing while a lease holds, and nothing during the backoff after it ends', async () => {
    await seed([row()])
    expect(await repository.claimBatch(10, LEASE_SECONDS, NOW)).toHaveLength(1)

    // attempts is now 1, so the backoff is 2^1 x 5 = 10 seconds after the lease ends.
    const leaseEnd = LEASE_SECONDS * SECOND_MS
    expect(await repository.claimBatch(10, LEASE_SECONDS, at(leaseEnd - 1))).toEqual([])
    expect(await repository.claimBatch(10, LEASE_SECONDS, at(leaseEnd + 10 * SECOND_MS))).toEqual(
      []
    )
    const retried = await repository.claimBatch(
      10,
      LEASE_SECONDS,
      at(leaseEnd + 10 * SECOND_MS + 1)
    )
    expect(retried).toHaveLength(1)
    expect(retried[0]?.attempts).toBe(2)
  })

  it.each([
    [3, 40],
    [6, 320],
    [7, 600],
    [30_000, 600],
  ])(
    'waits min(2^attempts x 5, 600) seconds after the lease ends: %i attempts, %i s',
    async (attempts, waitSeconds) => {
      await seed([row({ attempts, claimedUntil: NOW })])

      expect(await repository.claimBatch(10, LEASE_SECONDS, at(waitSeconds * SECOND_MS))).toEqual(
        []
      )
      expect(
        await repository.claimBatch(10, LEASE_SECONDS, at(waitSeconds * SECOND_MS + 1))
      ).toHaveLength(1)
    }
  )

  it('stops counting attempts at the smallint ceiling instead of failing the claim', async () => {
    await seed([row({ attempts: 32_767, claimedUntil: at(-3600 * SECOND_MS) })])

    const [claimed] = await repository.claimBatch(10, LEASE_SECONDS, NOW)

    expect(claimed?.attempts).toBe(32_767)
  })

  it('skips rows another transaction holds locked instead of waiting for them', async () => {
    const ids = await seed([
      row({ occurredAt: at(-2 * SECOND_MS) }),
      row({ occurredAt: at(-SECOND_MS) }),
    ])

    // The pool has two connections: the open transaction holds one, the claim runs on the other.
    const claimed = await db.transaction(async (tx) => {
      await tx
        .select({ id: analyticsOutboxModel.id })
        .from(analyticsOutboxModel)
        .where(eq(analyticsOutboxModel.id, ids[0] ?? ''))
        .for('update')
      return repository.claimBatch(10, LEASE_SECONDS, NOW)
    })

    expect(claimed.map((claim) => claim.id)).toEqual([ids[1]])
  })

  it('claims no more than the limit when the planner expects an empty table', async () => {
    // Statistics of an empty table make the planner rescan an `in (...)` subquery per row.
    await sql`analyze analytics_outbox`
    await seed([
      row({ occurredAt: at(-3 * SECOND_MS) }),
      row({ occurredAt: at(-2 * SECOND_MS) }),
      row({ occurredAt: at(-SECOND_MS) }),
    ])

    expect(await repository.claimBatch(2, LEASE_SECONDS, NOW)).toHaveLength(2)
    const rows = await snapshot()
    expect(rows.map((stored) => stored.attempts)).toEqual([1, 1, 0])
  })

  it('never hands the same row to two concurrent claims', async () => {
    await seed(
      Array.from({ length: 20 }, (_unused, index) => row({ occurredAt: at(-index * SECOND_MS) }))
    )

    const [first, second] = await Promise.all([
      repository.claimBatch(20, LEASE_SECONDS, NOW),
      repository.claimBatch(20, LEASE_SECONDS, NOW),
    ])

    const ids = [...first, ...second].map((claim) => claim.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(20)
  })
})

describe('AnalyticsOutboxRepository.deleteByIds', () => {
  it('deletes exactly the acknowledged rows and reports how many', async () => {
    const ids = await seed([row(), row(), row()])

    expect(await repository.deleteByIds([ids[0] ?? '', ids[2] ?? ''])).toBe(2)
    expect(await repository.deleteByIds([])).toBe(0)

    const rows = await snapshot()
    expect(rows.map((stored) => stored.id)).toEqual([ids[1]])
  })
})

describe('AnalyticsOutboxRepository.markRejected', () => {
  it('counts a rejection and releases the lease, so the row is claimable at once', async () => {
    await seed([row()])
    const [claimed] = await repository.claimBatch(10, LEASE_SECONDS, NOW)

    await repository.markRejected([claimed?.id ?? ''])

    expect(await snapshot()).toEqual([
      expect.objectContaining({ attempts: 1, rejections: 1, claimed_until: NONE }),
    ])
    expect(await repository.claimBatch(10, LEASE_SECONDS, at(SECOND_MS))).toHaveLength(1)
  })

  it('does nothing for an empty list', async () => {
    await seed([row()])
    await repository.markRejected([])
    expect(await snapshot()).toEqual([expect.objectContaining({ rejections: 0 })])
  })
})

describe('AnalyticsOutboxRepository.deletePoisoned', () => {
  it('deletes rows at or over the rejection limit only, whatever their attempts', async () => {
    const ids = await seed([
      row({ event: 'poisoned', rejections: 3 }),
      row({ event: 'twice_rejected', rejections: 2, attempts: 2 }),
      row({ event: 'outage_survivor', rejections: 0, attempts: 30_000 }),
      row({ event: 'over_limit', rejections: 4 }),
    ])

    const dropped = await repository.deletePoisoned(3)

    expect(dropped).toEqual(
      expect.arrayContaining([
        { id: ids[0], event: 'poisoned' },
        { id: ids[3], event: 'over_limit' },
      ])
    )
    expect(dropped).toHaveLength(2)
    const rows = await snapshot()
    expect(rows.map((stored) => stored.id)).toEqual([ids[1], ids[2]])
  })
})

describe('AnalyticsOutboxRepository.deleteOlderThan', () => {
  it('deletes no more than the batch size when the planner expects an empty table', async () => {
    await sql`analyze analytics_outbox`
    await seed([
      row({ occurredAt: at(-3 * SECOND_MS) }),
      row({ occurredAt: at(-2 * SECOND_MS) }),
      row({ occurredAt: at(-SECOND_MS) }),
    ])

    expect(await repository.deleteOlderThan(NOW, 2)).toBe(2)
    expect(await snapshot()).toHaveLength(1)
  })

  it('deletes up to the batch size of rows older than the cutoff, sent or not', async () => {
    const ids = await seed([
      row({ occurredAt: at(-3 * SECOND_MS) }),
      row({ occurredAt: at(-2 * SECOND_MS), attempts: 5 }),
      row({ occurredAt: at(-SECOND_MS) }),
      row({ occurredAt: NOW }),
    ])

    expect(await repository.deleteOlderThan(NOW, 2)).toBe(2)
    const afterFirst = await snapshot()
    expect(afterFirst.map((stored) => stored.id)).toEqual([ids[2], ids[3]])
    expect(await repository.deleteOlderThan(NOW, 10)).toBe(1)
    const afterSecond = await snapshot()
    expect(afterSecond.map((stored) => stored.id)).toEqual([ids[3]])
  })
})

describe('AnalyticsOutboxRepository.deleteForDistinctId', () => {
  it("deletes every row of that distinct id, leased or not, and no other distinct id's", async () => {
    const ids = await seed([
      row({ distinctId: 'purged-user' }),
      row({ distinctId: 'purged-user', claimedUntil: at(60 * SECOND_MS), attempts: 2 }),
      row({ distinctId: 'other-user' }),
      row({ distinctId: '$tenant_t-1', event: '$groupidentify' }),
    ])

    const deleted = await db.transaction((tx) => repository.deleteForDistinctId('purged-user', tx))

    expect(deleted).toBe(2)
    const rows = await snapshot()
    expect(rows.map((stored) => stored.id)).toEqual([ids[2], ids[3]])
  })
})

describe('AnalyticsOutboxRepository.deleteForDistinctIds', () => {
  it("deletes every row of the given distinct ids in one statement, and no other id's", async () => {
    const ids = await seed([
      row({ distinctId: 'purged-a' }),
      row({ distinctId: 'purged-b', claimedUntil: at(60 * SECOND_MS), attempts: 2 }),
      row({ distinctId: 'other-user' }),
    ])

    expect(await repository.deleteForDistinctIds([])).toBe(0)
    expect(await repository.deleteForDistinctIds(['purged-a', 'purged-b'])).toBe(2)

    const rows = await snapshot()
    expect(rows.map((stored) => stored.id)).toEqual([ids[2]])
  })
})
