// src/repositories/email-log.repository.ts
//
// Deliberately does NOT extend BaseRepository — see ARCHITECTURE.md's
// repository-layer paragraph and email-log.model.ts's own header comment.
// Three reasons, restated here because they are what shapes this class:
// (1) BaseRepository hands every subclass `update()` and `softDelete()`; a
// delivery log is append-only audit data, and a soft-deletable/updatable
// audit row is a contradiction in terms. (2) BaseRepository requires
// `deletedAt`/`updatedAt` columns, neither of which this table has, or
// should. (3) BaseRepository's 23505 -> HttpError(409) translation exists
// for a unique constraint a caller could violate; this table has none, so
// there is nothing to translate. This is a plain class with exactly the
// two methods a delivery log needs.
import { asc, eq } from 'drizzle-orm'
import {
  emailLogModel,
  ERROR_CODE_MAX_LENGTH,
  type EmailLog,
  type NewEmailLog,
} from '@/database/models/email-log.model'
import { HttpError } from '@/middlewares/error.middleware'
import { db } from '@/services/database.service'

/**
 * Truncate `entry.errorCode` to `ERROR_CODE_MAX_LENGTH` when it is present
 * and over-length, leaving every other field untouched. A value this
 * repository is asked to write must never be the reason an insert throws —
 * see `record`'s own comment (Ruling E, task-4-brief.md).
 * @param entry - The row about to be inserted.
 * @returns `entry` unchanged, or a shallow copy with `errorCode` truncated.
 */
function withErrorCodeTruncated(entry: NewEmailLog): NewEmailLog {
  if (typeof entry.errorCode !== 'string' || entry.errorCode.length <= ERROR_CODE_MAX_LENGTH) {
    return entry
  }
  return { ...entry, errorCode: entry.errorCode.slice(0, ERROR_CODE_MAX_LENGTH) }
}

/**
 * Query access to the append-only `email_logs` table: record one delivery
 * attempt and look up everything recorded for one recipient. This is what
 * makes "did the email send?" answerable at 2am without adding a token or
 * a rendered body to a log — see email-log.model.ts's header comment for
 * the property every column here protects, and this file's own header
 * comment for why this class does not extend `BaseRepository`.
 */
export class EmailLogRepository {
  /**
   * Record one outbound email attempt, sent or failed.
   *
   * A caller that already sent the email must never receive a failure from
   * this method for a reason the email itself did not have — logging is
   * best-effort observability, not a gate on delivery. An over-length
   * `errorCode` is truncated rather than left to throw a 22001 (string
   * data right truncation), the same class of failure `MAX_EMAIL_LENGTH`
   * exists to prevent on `users.email` (see that constant's own comment).
   * The caller itself is still responsible for the other half of Ruling E:
   * catching whatever this rejects with and logging it at pino `error`
   * rather than failing the request — a log write happens strictly after
   * the send it describes, so nothing here can undo that.
   * @param entry - The row to insert: recipient, templateKey, status, and whichever of providerMessageId/errorCode applies to that status.
   * @returns The inserted row, including its generated `id` and `createdAt`.
   */
  async record(entry: NewEmailLog): Promise<EmailLog> {
    const [row] = await db.insert(emailLogModel).values(withErrorCodeTruncated(entry)).returning()
    // db.insert(...).values(one object).returning() always returns exactly
    // one row when the insert does not throw; the driver's own types just
    // cannot express "same length as input" for a single-row insert.
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * Every row recorded for one recipient, oldest first. Exists so tests can
   * assert on what `record` actually wrote to the table; nothing in src/
   * calls this yet, and that is fine — see task-4-brief.md.
   * @param recipient - The recipient address to look up.
   * @returns Every matching row, ordered by `createdAt` ascending.
   */
  async findByRecipient(recipient: string): Promise<EmailLog[]> {
    return db
      .select()
      .from(emailLogModel)
      .where(eq(emailLogModel.recipient, recipient))
      .orderBy(asc(emailLogModel.createdAt))
  }
}
