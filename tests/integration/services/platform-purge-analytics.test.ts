/**
 * @file What a purge does to analytics, against the real per-worker
 * Postgres: `purgeUser` queues the PostHog deletion an hour out and removes
 * the purged user's undelivered outbox rows and no one else's, whatever the
 * analytics config, and a failure later in its transaction leaves neither
 * change. Analytics is off under `.env.test`, which is the unconfigured case.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ANALYTICS_DELETION_DELAY_MS } from '@/constants/analytics.constants'
import { analyticsDeletionModel } from '@/database/models/analytics-deletion.model'
import { AnalyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { db, sql } from '@/services/database.service'
import { purgeUser } from '@/services/platform-purge.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

const REASON = 'Erasure request, ticket 9002'
const MINUTE_MS = 60_000

// eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the repository as `this`
const realDeleteForDistinctId = AnalyticsOutboxRepository.prototype.deleteForDistinctId

afterEach(async () => {
  await sql`delete from analytics_outbox`
  await sql`delete from analytics_deletions`
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

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
 * A soft-deleted user, ready to purge.
 * @returns Their id.
 */
async function deletedUser(): Promise<string> {
  const user = await createTrackedUser()
  await sql`update users set deleted_at = now() where id = ${user.id}`
  return user.id
}

/**
 * Insert one undelivered outbox row.
 * @param distinctId - Its distinct id.
 * @param event - Its event name.
 * @returns Its id.
 */
async function outboxRow(distinctId: string, event = 'probe_event'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into analytics_outbox (event, distinct_id, properties)
    values (${event}, ${distinctId}, '{"source":"product"}'::jsonb)
    returning id`
  if (!row) throw new Error('outbox insert returned no row')
  return row.id
}

/**
 * The ids of every outbox row.
 * @returns The ids, sorted.
 */
async function outboxIds(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from analytics_outbox`
  return rows.map((row) => row.id).toSorted(byText)
}

describe('purgeUser and analytics', () => {
  it("queues the PostHog deletion an hour out and deletes only the user's outbox rows", async () => {
    const { user: owner } = await createTrackedStaff('owner')
    const goneId = await deletedUser()
    await outboxRow(goneId, 'user_signed_in')
    await outboxRow(goneId, '$set')
    const kept = [
      await outboxRow(owner.id),
      await outboxRow(`$tenant_${randomUUID()}`, '$groupidentify'),
      await outboxRow('system'),
    ].toSorted(byText)
    const before = Date.now()

    await purgeUser({ userId: owner.id }, goneId, REASON)

    const after = Date.now()
    const rows = await db.select().from(analyticsDeletionModel)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ distinctId: goneId, attempts: 0 })
    const notBefore = rows[0]?.notBefore.getTime() ?? 0
    expect(notBefore).toBeGreaterThanOrEqual(before + ANALYTICS_DELETION_DELAY_MS)
    expect(notBefore).toBeLessThanOrEqual(after + ANALYTICS_DELETION_DELAY_MS)
    expect(ANALYTICS_DELETION_DELAY_MS).toBe(60 * MINUTE_MS)
    expect(await outboxIds()).toEqual(kept)
  })

  it('leaves neither change when the purge transaction fails after both', async () => {
    const { user: owner } = await createTrackedStaff('owner')
    const goneId = await deletedUser()
    const pending = await outboxRow(goneId)
    const failure = new Error('injected after the outbox delete')

    await withMutatedMethod(
      AnalyticsOutboxRepository.prototype,
      'deleteForDistinctId',
      async function (this: AnalyticsOutboxRepository, distinctId, executor) {
        await realDeleteForDistinctId.call(this, distinctId, executor)
        throw failure
      },
      async () => {
        await expect(purgeUser({ userId: owner.id }, goneId, REASON)).rejects.toBe(failure)
      }
    )

    expect(await sql`select 1 from analytics_deletions`).toHaveLength(0)
    expect(await outboxIds()).toEqual([pending])
    expect(await sql`select 1 from users where id = ${goneId}`).toHaveLength(1)
  })
})
