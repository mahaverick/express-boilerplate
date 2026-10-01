/**
 * @file Query access to the append-only `email_events` table. It does not
 * extend `BaseRepository`: an event is never updated or soft-deleted.
 */
import { eq, inArray, sql } from 'drizzle-orm'
import { EMAIL_DETAIL_MAX_LENGTH, EMAIL_DETAIL_PATTERN } from '@/constants/email.constants'
import {
  emailEventModel,
  type EmailEvent,
  type NewEmailEvent,
} from '@/database/models/email-event.model'
import { emailMessageModel } from '@/database/models/email-message.model'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * `row` with a `detail` that `email_events_detail_check` would refuse
 * replaced by null, so a provider's odd reason drops the detail instead of
 * failing the insert. Dropped, never truncated or rewritten: a value in the
 * wrong shape may be a fragment of something that must not be stored.
 * @param row - The event about to be inserted.
 * @returns `row` unchanged when its detail is absent or valid, or a copy with `detail` null.
 */
function withDetailChecked(row: NewEmailEvent): NewEmailEvent {
  if (typeof row.detail !== 'string') return row
  const isValid =
    row.detail.length <= EMAIL_DETAIL_MAX_LENGTH && EMAIL_DETAIL_PATTERN.test(row.detail)
  // eslint-disable-next-line unicorn/no-null -- the column's "no detail" value
  return isValid ? row : { ...row, detail: null }
}

/**
 * Query access to `email_events`.
 */
export class EmailEventRepository {
  /**
   * Record one provider event unless the provider already sent it: the
   * unique `(provider, provider_event_id)` makes a redelivered webhook a no-op.
   * @param row - The event.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, or undefined for a duplicate.
   */
  async insertIfNew(
    row: NewEmailEvent,
    executor: DbExecutor = db
  ): Promise<EmailEvent | undefined> {
    const [inserted] = await executor
      .insert(emailEventModel)
      .values(withDetailChecked(row))
      .onConflictDoNothing({ target: [emailEventModel.provider, emailEventModel.providerEventId] })
      .returning()
    return inserted
  }

  /**
   * Delete up to `limit` events whose message was created before `cutoff`:
   * the group's retention is dated by the message, not the event. Takes the
   * batch oldest id first with FOR UPDATE SKIP LOCKED on the events only, so
   * a message row a webhook is updating is never waited on.
   * @param cutoff - Events of messages created before this go.
   * @param limit - The most rows one call deletes.
   * @param tx - The batch's transaction.
   * @returns How many rows were deleted.
   */
  async purgeForMessagesCreatedBefore(
    cutoff: Date,
    limit: number,
    tx: DbTransaction
  ): Promise<number> {
    const batch = tx
      .select({ id: emailEventModel.id })
      .from(emailEventModel)
      .innerJoin(emailMessageModel, eq(emailMessageModel.id, emailEventModel.messageId))
      .where(sql`${emailMessageModel.createdAt} < ${cutoff.toISOString()}::timestamptz`)
      .orderBy(emailEventModel.id)
      .limit(limit)
      .for('update', { of: emailEventModel, skipLocked: true })
    const result = await tx.delete(emailEventModel).where(inArray(emailEventModel.id, batch))
    return result.count
  }
}
