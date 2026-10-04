/**
 * @file Query access to `analytics_deletions`. It does not extend
 * `BaseRepository`: a row is never updated by a user or soft-deleted. The
 * insert runs inside the user purge's transaction; the claim, ack and
 * failure methods are the deletion job's, each one autocommit statement, so
 * no pool connection is held while the job talks to PostHog.
 */
import { inArray, lte, sql } from 'drizzle-orm'
import {
  analyticsDeletionModel,
  type AnalyticsDeletionRow,
} from '@/database/models/analytics-deletion.model'
import { db, type DbExecutor } from '@/services/database.service'

const deletions = analyticsDeletionModel

/**
 * The highest exponent the backoff grows with: 2^9 minutes is past the cap.
 */
const BACKOFF_MAX_EXPONENT = 9

/**
 * The longest a failed row waits before it is due again, in minutes (6 h).
 */
const BACKOFF_CAP_MINUTES = 360

/**
 * The largest value `attempts` (a smallint) is allowed to reach.
 */
const MAX_ATTEMPTS = 32_767

/**
 * Query access to `analytics_deletions`.
 */
export class AnalyticsDeletionRepository {
  /**
   * Record that a purged user's PostHog data must be deleted. A second
   * insert for the same id changes nothing.
   * @param distinctId - The purged user's id.
   * @param notBefore - The earliest instant the deletion may be sent.
   * @param executor - Where to run the query: the purge's transaction. Defaults to the pool.
   */
  async insert(distinctId: string, notBefore: Date, executor: DbExecutor = db): Promise<void> {
    await executor.insert(deletions).values({ distinctId, notBefore }).onConflictDoNothing()
  }

  /**
   * Claim up to `limit` due rows (`not_before <= now`), earliest first, in
   * one autocommit statement, by moving their `not_before` to
   * `now + leaseSeconds`: a crash before the job settles them makes them
   * due again once the lease passes. `SKIP LOCKED` keeps two concurrent
   * claims from taking the same row. The ids are collected with
   * `= any(array(...))`, which runs the locking subquery once; under
   * `in (...)` the planner may rescan it per outer row and claim more than
   * `limit` (see `AnalyticsOutboxRepository.claimBatch`).
   * @param limit - The most rows to claim.
   * @param leaseSeconds - How long the claim holds them.
   * @param now - The current instant; injectable for tests.
   * @returns The claimed rows, `notBefore` already moved by the lease.
   */
  async claimDue(
    limit: number,
    leaseSeconds: number,
    now: Date = new Date()
  ): Promise<AnalyticsDeletionRow[]> {
    const due = db
      .select({ distinctId: deletions.distinctId })
      .from(deletions)
      .where(lte(deletions.notBefore, now))
      .orderBy(deletions.notBefore, deletions.distinctId)
      .limit(limit)
      .for('update', { skipLocked: true })
    return db
      .update(deletions)
      .set({
        notBefore: sql`${now.toISOString()}::timestamptz + make_interval(secs => ${leaseSeconds})`,
      })
      .where(sql`${deletions.distinctId} = any(array(${due}))`)
      .returning()
  }

  /**
   * Delete the rows PostHog accepted.
   * @param ids - The acknowledged distinct ids.
   * @returns How many rows were deleted.
   */
  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const result = await db.delete(deletions).where(inArray(deletions.distinctId, ids))
    return result.count
  }

  /**
   * Count one failure against each row and push it back: `attempts` grows
   * by one, `last_error` records `error`, and the row is due again after
   * `least(2^attempts, 360)` minutes, `attempts` being the new count (2
   * minutes after the first failure, at most 6 hours).
   * @param ids - The rows whose deletion request failed.
   * @param error - A status code or error class, never a response body; cut to 200 characters.
   * @param now - The current instant; injectable for tests.
   */
  async markFailed(ids: string[], error: string, now: Date = new Date()): Promise<void> {
    if (ids.length === 0) return
    // SET reads the old attempts, so the new count is attempts + 1.
    const exponent = sql`least(${deletions.attempts} + 1, ${BACKOFF_MAX_EXPONENT})`
    await db
      .update(deletions)
      .set({
        attempts: sql`least(${deletions.attempts} + 1, ${MAX_ATTEMPTS})`,
        lastError: error.slice(0, 200),
        notBefore: sql`${now.toISOString()}::timestamptz + make_interval(mins => least(power(2, ${exponent})::int, ${BACKOFF_CAP_MINUTES}))`,
      })
      .where(inArray(deletions.distinctId, ids))
  }

  /**
   * How many deletions are waiting, due or not.
   * @returns The row count.
   */
  async countPending(): Promise<number> {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(deletions)
    return row?.count ?? 0
  }
}

/**
 * The repository instance the purge and the deletion job share.
 */
export const analyticsDeletionRepository = new AnalyticsDeletionRepository()
