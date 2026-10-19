/**
 * @file Query access to `email_link_tokens`. A plain class, not on
 * `BaseRepository`: the table has no `updated_at` or `deleted_at`, and a
 * row is never soft-deleted, so there is no scope to apply.
 */
import { sql, type SQL } from 'drizzle-orm'
import {
  emailLinkTokenModel,
  type EmailLinkToken,
  type LinkTokenIntent,
  type NewEmailLinkToken,
} from '@/database/models/email-link-token.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

const link = emailLinkTokenModel

/**
 * The session a `step_up` link elevates. A claim or revoke that names one
 * matches only that user's row for that session.
 */
export interface LinkTokenBinding {
  userId: string
  sessionId: string
}

/**
 * Which live links a newly issued one supersedes: every `sign_in` link of
 * one address, or every `step_up` link of one session.
 */
export type LiveLinkMatch =
  { email: string; intent: 'sign_in' } | { userId: string; sessionId: string; intent: 'step_up' }

/**
 * The predicate for one `LiveLinkMatch`, live rows only. The address is
 * compared lowercased, as the service stores it, so the partial index on
 * `(email, intent)` serves it.
 * @param match - The address or the session.
 * @returns The SQL condition.
 */
function liveMatch(match: LiveLinkMatch): SQL {
  if (match.intent === 'sign_in') {
    return sql`${link.email} = lower(${match.email}) and ${link.intent} = 'sign_in' and ${link.revokedAt} is null`
  }
  return sql`${link.userId} = ${match.userId} and ${link.sessionId} = ${match.sessionId} and ${link.intent} = 'step_up' and ${link.revokedAt} is null`
}

/**
 * Query access to the `email_link_tokens` table: insert, the single-use
 * claim, a read-only peek, the revoke-on-issue, the purge's delete by
 * address and the retention purge.
 */
export class EmailLinkTokenRepository {
  /**
   * Insert one link row.
   * @param values - The row's column values.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row.
   */
  async insert(values: NewEmailLinkToken, executor: DbExecutor = db): Promise<EmailLinkToken> {
    const [row] = await executor.insert(link).values(values).returning()
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * Atomically claim a not-yet-revoked link of one intent: sets `revokedAt`
   * and `consumedAt` and returns the row, but only if it was live the
   * instant this one statement ran, so two concurrent presentations of one
   * link never both win. A `bound` claim also requires the row's user and
   * session, so a step-up link presented by another session neither matches
   * nor is spent. It does not check `expiresAt`, and claims an expired row:
   * the caller judges expiry on the returned row, so one presentation is
   * one attempt.
   * @param tokenHash - The SHA-256 hash of the raw token, hex-encoded.
   * @param intent - The intent the link must have been issued for.
   * @param bound - For a `step_up` link: the user and session that must hold it.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The now-claimed row, expiry not checked, or undefined when no live row matched.
   */
  async claimOnce(
    tokenHash: string,
    intent: LinkTokenIntent,
    bound?: LinkTokenBinding,
    executor: DbExecutor = db
  ): Promise<EmailLinkToken | undefined> {
    const binding =
      bound === undefined
        ? sql``
        : sql` and ${link.userId} = ${bound.userId} and ${link.sessionId} = ${bound.sessionId}`
    const [row] = await executor
      .update(link)
      .set({ revokedAt: sql`now()`, consumedAt: sql`now()` })
      .where(
        sql`${link.tokenHash} = ${tokenHash} and ${link.intent} = ${intent} and ${link.revokedAt} is null${binding}`
      )
      .returning()
    return row
  }

  /**
   * Read a live link without spending it: unrevoked and unexpired, by the
   * database's clock.
   * @param tokenHash - The SHA-256 hash of the raw token, hex-encoded.
   * @param intent - The intent the link must have been issued for.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when no live, unexpired row of that intent matched.
   */
  async findLiveByHash(
    tokenHash: string,
    intent: LinkTokenIntent,
    executor: DbExecutor = db
  ): Promise<EmailLinkToken | undefined> {
    const [row] = await executor
      .select()
      .from(link)
      .where(
        sql`${link.tokenHash} = ${tokenHash} and ${link.intent} = ${intent} and ${link.revokedAt} is null and ${link.expiresAt} > now()`
      )
      .limit(1)
    return row
  }

  /**
   * Serialise issuing for one address or one session until `tx` ends, with a
   * transaction-scoped advisory lock. Without it two concurrent issues each
   * revoke before the other's insert commits, and both links stay live. The
   * key is a 64-bit hash, so an unrelated match that collides only waits.
   * @param match - The address or the session being issued for.
   * @param tx - The issuing transaction; the lock is released when it ends.
   * @returns Resolves once the lock is held.
   */
  async lockIssueFor(match: LiveLinkMatch, tx: DbTransaction): Promise<void> {
    const key =
      match.intent === 'sign_in'
        ? `email_link_tokens:sign_in:${match.email.toLowerCase()}`
        : `email_link_tokens:step_up:${match.userId}:${match.sessionId}`
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
  }

  /**
   * Revoke every live link a new one supersedes, leaving `consumedAt` null.
   * @param match - Every `sign_in` link of one address, or every `step_up` link of one session.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns How many rows this call revoked.
   */
  async revokeLiveFor(match: LiveLinkMatch, executor: DbExecutor = db): Promise<number> {
    const result = await executor
      .update(link)
      .set({ revokedAt: sql`now()` })
      .where(liveMatch(match))
    return result.count
  }

  /**
   * Delete every link mailed to one address, of either intent, created at or
   * before a moment, for a user purge. The address is compared
   * case-insensitively, as the purge's other address-keyed deletes compare it.
   * @param email - The purged user's address.
   * @param createdAtOrBefore - The user's deletion; a link written after it is kept.
   * @param tx - The purge's transaction.
   * @returns How many rows were deleted.
   */
  async deleteForEmail(email: string, createdAtOrBefore: Date, tx: DbTransaction): Promise<number> {
    const result = await tx
      .delete(link)
      .where(
        sql`lower(${link.email}) = lower(${email}) and date_trunc('milliseconds', ${link.createdAt}) <= ${createdAtOrBefore.toISOString()}::timestamptz`
      )
    return result.count
  }

  /**
   * Delete at most `limit` rows past retention: expired before `cutoff`, or
   * revoked before it without ever being used. Takes the batch oldest id
   * first with FOR UPDATE SKIP LOCKED, collected with `= any(array(...))` so
   * the delete takes at most `limit` rows (see
   * `UserTokenRepository.purgeExpiredOrRevokedBefore`).
   * @param cutoff - Rows older than this go.
   * @param limit - The most rows to delete in this call.
   * @param tx - The batch's transaction.
   * @returns How many rows were deleted.
   */
  async purgeExpiredOrRevokedBefore(
    cutoff: Date,
    limit: number,
    tx: DbTransaction
  ): Promise<number> {
    const before = sql`${cutoff.toISOString()}::timestamptz`
    const batch = tx
      .select({ id: link.id })
      .from(link)
      .where(
        sql`${link.expiresAt} < ${before} or (${link.revokedAt} < ${before} and ${link.consumedAt} is null)`
      )
      .orderBy(link.id)
      .limit(limit)
      .for('update', { skipLocked: true })
    const result = await tx.delete(link).where(sql`${link.id} = any(array(${batch}))`)
    return result.count
  }
}
