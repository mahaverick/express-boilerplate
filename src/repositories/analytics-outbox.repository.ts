/**
 * @file Query access to `analytics_outbox`. It does not extend
 * `BaseRepository`: a row is never updated by a user or soft-deleted. Writes
 * come from the analytics outbox service; claims, acks, rejections and pruning
 * come from the drainer and the retention job, and the user purge deletes a
 * purged user's rows. Every drainer method here is
 * one autocommit statement, so no pool connection is held while the drainer
 * talks to PostHog.
 */
import { eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import {
  analyticsOutboxModel,
  type AnalyticsOutboxRow,
  type NewAnalyticsOutboxRow,
} from '@/database/models/analytics-outbox.model'
import { db, type DbExecutor } from '@/services/database.service'

const outbox = analyticsOutboxModel

/**
 * The highest `attempts` the backoff grows with: 2^7 x 5 s is past the cap.
 */
const BACKOFF_MAX_EXPONENT = 7

/**
 * The longest a retried row waits after its lease ends, in seconds.
 */
const BACKOFF_CAP_SECONDS = 600

/**
 * The largest value `attempts` (a smallint) is allowed to reach.
 */
const MAX_ATTEMPTS = 32_767

/**
 * Query access to `analytics_outbox`.
 */
export class AnalyticsOutboxRepository {
  /**
   * Insert one row.
   * @param row - The built event.
   * @param executor - Where to run the query. Defaults to the pool.
   */
  async insert(row: NewAnalyticsOutboxRow, executor: DbExecutor = db): Promise<void> {
    await executor.insert(outbox).values(row)
  }

  /**
   * Insert several rows in one statement; an empty list is a no-op.
   * @param rows - The built events.
   * @param executor - Where to run the query. Defaults to the pool.
   */
  async insertMany(rows: NewAnalyticsOutboxRow[], executor: DbExecutor = db): Promise<void> {
    if (rows.length === 0) return
    await executor.insert(outbox).values(rows)
  }

  /**
   * Lease up to `limit` sendable rows, oldest first, in one autocommit
   * statement. A row is sendable when nobody holds it and it is not waiting
   * out its backoff: it was never claimed or was released (`claimed_until`
   * null), or its last lease ended more than
   * `least(2^min(attempts, 7) x 5, 600)` seconds before `now`. `SKIP LOCKED`
   * keeps two concurrent claims from taking the same row, and the lease keeps
   * a later claim off it until it ends. The ids are collected with
   * `= any(array(...))`, which runs the locking subquery once: under
   * `in (...)` the planner may rescan it for every outer row (a nested loop,
   * chosen when the table's statistics say it is nearly empty), and each
   * rescan skips the rows this statement has just updated and takes the next
   * ones, so the update would claim more than `limit` rows.
   * @param limit - The most rows to claim.
   * @param leaseSeconds - How long the claim holds them.
   * @param now - The current instant; injectable for tests.
   * @returns The claimed rows, `attempts` already counting this claim.
   */
  async claimBatch(
    limit: number,
    leaseSeconds: number,
    now: Date = new Date()
  ): Promise<AnalyticsOutboxRow[]> {
    const at = sql`${now.toISOString()}::timestamptz`
    const backoffSeconds = sql`least(power(2, least(${outbox.attempts}, ${BACKOFF_MAX_EXPONENT})) * 5, ${BACKOFF_CAP_SECONDS})`
    const claimable = db
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        or(
          isNull(outbox.claimedUntil),
          sql`${outbox.claimedUntil} < ${at} - make_interval(secs => ${backoffSeconds})`
        )
      )
      .orderBy(outbox.occurredAt, outbox.id)
      .limit(limit)
      .for('update', { skipLocked: true })
    return db
      .update(outbox)
      .set({
        claimedUntil: sql`${at} + make_interval(secs => ${leaseSeconds})`,
        attempts: sql`least(${outbox.attempts} + 1, ${MAX_ATTEMPTS})`,
      })
      .where(sql`${outbox.id} = any(array(${claimable}))`)
      .returning()
  }

  /**
   * Delete acknowledged rows.
   * @param ids - The rows PostHog accepted.
   * @returns How many rows were deleted.
   */
  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const result = await db.delete(outbox).where(inArray(outbox.id, ids))
    return result.count
  }

  /**
   * Count one refusal against each row PostHog rejected on its own, and
   * release its lease so the next drain may retry it.
   * @param ids - The rows rejected alone.
   */
  async markRejected(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await db
      .update(outbox)
      .set({
        rejections: sql`least(${outbox.rejections} + 1, ${MAX_ATTEMPTS})`,
        // eslint-disable-next-line unicorn/no-null -- a null lease is the column's "released" state
        claimedUntil: null,
      })
      .where(inArray(outbox.id, ids))
  }

  /**
   * Delete every row PostHog has refused on its own `maxRejections` times or
   * more. Keyed on `rejections` only: `attempts` also grows with retryable
   * failures (an outage, a timeout), which never delete a row.
   * @param maxRejections - The poison limit.
   * @returns The deleted rows' ids and event names, for the error log.
   */
  async deletePoisoned(maxRejections: number): Promise<{ id: string; event: string }[]> {
    return db
      .delete(outbox)
      .where(sql`${outbox.rejections} >= ${maxRejections}`)
      .returning({ id: outbox.id, event: outbox.event })
  }

  /**
   * Delete every row of one distinct id, sent or not, leased or not: the
   * user purge calls it in its transaction, so no event of a purged user is
   * sent after PostHog deletes the person (which would create them again).
   * @param distinctId - The purged user's id.
   * @param executor - The purge's transaction.
   * @returns How many rows were deleted.
   */
  async deleteForDistinctId(distinctId: string, executor: DbExecutor): Promise<number> {
    const result = await executor.delete(outbox).where(eq(outbox.distinctId, distinctId))
    return result.count
  }

  /**
   * Delete up to `batchSize` rows that occurred before `cutoff`, sent or not,
   * skipping rows a drain holds locked. `= any(array(...))` runs the locking
   * subquery once, for the reason `claimBatch` gives.
   * @param cutoff - Rows older than this go.
   * @param batchSize - The most rows to delete in this call.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns How many rows were deleted.
   */
  async deleteOlderThan(
    cutoff: Date,
    batchSize: number,
    executor: DbExecutor = db
  ): Promise<number> {
    const batch = executor
      .select({ id: outbox.id })
      .from(outbox)
      .where(lt(outbox.occurredAt, cutoff))
      .orderBy(outbox.occurredAt, outbox.id)
      .limit(batchSize)
      .for('update', { skipLocked: true })
    const result = await executor.delete(outbox).where(sql`${outbox.id} = any(array(${batch}))`)
    return result.count
  }
}

/**
 * The repository instance the analytics services share.
 */
export const analyticsOutboxRepository = new AnalyticsOutboxRepository()
