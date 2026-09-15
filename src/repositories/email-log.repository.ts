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
  ERROR_CODE_PATTERN,
  UNKNOWN_ERROR_CODE,
  type EmailLog,
  type NewEmailLog,
} from '@/database/models/email-log.model'
import { HttpError } from '@/middlewares/error.middleware'
import { db } from '@/services/database.service'

/**
 * Replace `entry.errorCode` with `UNKNOWN_ERROR_CODE` unless it already
 * matches the exact shape `email_logs_error_code_check` (email-log.model.ts)
 * enforces at the database, leaving every other field untouched.
 *
 * NORMALIZE, do not truncate. An earlier version of this repository
 * truncated an over-length `errorCode` to `ERROR_CODE_MAX_LENGTH` — the
 * wrong remedy for this class of value: a raw token (token.utilities.ts)
 * hex-encoded is exactly 64 characters, and truncating it to
 * `ERROR_CODE_MAX_LENGTH` (32) still writes 128 bits of a live secret into
 * an audit table, just fewer of them. Checking the SHAPE first means a
 * mis-extracted token is replaced wholesale, not partially preserved — see
 * `ERROR_CODE_PATTERN`'s own comment (email-log.model.ts) for why its
 * uppercase-only shape makes a lowercase hex token match nothing here, at
 * any length. This also means `record` below can never actually trigger
 * `email_logs_error_code_check` itself — the shape is enforced here first
 * — but the constraint stays as the real guarantee: this function is a
 * convenience that keeps a mismatched value from reaching an insert at
 * all, not the thing that makes the property true.
 * @param entry - The row about to be inserted.
 * @returns `entry` unchanged when `errorCode` is absent or already valid, or a shallow copy with `errorCode` replaced by `UNKNOWN_ERROR_CODE`.
 */
function withErrorCodeNormalized(entry: NewEmailLog): NewEmailLog {
  if (typeof entry.errorCode !== 'string') return entry
  const isValid =
    entry.errorCode.length <= ERROR_CODE_MAX_LENGTH && ERROR_CODE_PATTERN.test(entry.errorCode)
  return isValid ? entry : { ...entry, errorCode: UNKNOWN_ERROR_CODE }
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
   * Round-2 review finding 5: this paragraph used to open with an absolute
   * "must never receive a failure," which was false — a genuine
   * infrastructure failure (the database unreachable, a connection reset)
   * still rejects here, same as any other write in this codebase; nothing
   * catches that inside this method. What IS guaranteed is narrower and
   * specific to `errorCode`: a value that does not match the expected
   * shape (wrong length, wrong characters — see `withErrorCodeNormalized`)
   * is replaced with `UNKNOWN_ERROR_CODE` rather than left to throw a
   * 22001 (string data right truncation) or an `email_logs_error_code_check`
   * violation. That specific guarantee matters because a log write happens
   * strictly after the send it describes, so nothing here can undo that
   * send — a caller that mis-extracted a value (up to and including
   * passing a raw token by mistake) must still get a written row for THAT
   * reason, not a request failure and not a leaked secret. The caller
   * itself is still responsible for the other half of Ruling E: catching
   * whatever this rejects with (a genuine infrastructure failure, not this
   * normalization) and logging it at pino `error` rather than failing the
   * request.
   * @param entry - The row to insert: recipient, templateKey, status, and whichever of providerMessageId/errorCode applies to that status.
   * @returns The inserted row, including its generated `id` and `createdAt`.
   */
  async record(entry: NewEmailLog): Promise<EmailLog> {
    const [row] = await db.insert(emailLogModel).values(withErrorCodeNormalized(entry)).returning()
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
   *
   * Orders by `createdAt` then `id` — `id` is a secondary sort, not a
   * second meaningful ordering: uuidv7 (every table's `id` default) is
   * itself time-ordered, so it breaks a tie between two rows that land in
   * the same millisecond deterministically, rather than leaving their
   * relative order to whatever Postgres happens to return (round-2 review
   * finding 7).
   * @param recipient - The recipient address to look up.
   * @returns Every matching row, ordered by `createdAt` ascending, `id` ascending as a tiebreaker.
   */
  async findByRecipient(recipient: string): Promise<EmailLog[]> {
    return db
      .select()
      .from(emailLogModel)
      .where(eq(emailLogModel.recipient, recipient))
      .orderBy(asc(emailLogModel.createdAt), asc(emailLogModel.id))
  }
}
