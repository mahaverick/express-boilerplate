/**
 * @file Query access to the append-only `email_events` table. It does not
 * extend `BaseRepository`: an event is never updated or soft-deleted.
 */
import { EMAIL_DETAIL_MAX_LENGTH, EMAIL_DETAIL_PATTERN } from '@/constants/email.constants'
import {
  emailEventModel,
  type EmailEvent,
  type NewEmailEvent,
} from '@/database/models/email-event.model'
import { db, type DbExecutor } from '@/services/database.service'

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
}
