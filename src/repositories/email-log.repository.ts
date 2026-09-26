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
// methods a delivery log needs: write, read, and the retention purge.
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { MAX_EMAIL_LENGTH } from '@/constants/auth.constants'
import {
  emailLogModel,
  ERROR_CODE_MAX_LENGTH,
  ERROR_CODE_PATTERN,
  PROVIDER_MESSAGE_ID_MAX_LENGTH,
  TEMPLATE_KEY_MAX_LENGTH,
  UNKNOWN_ERROR_CODE,
  type EmailLog,
  type NewEmailLog,
} from '@/database/models/email-log.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * Replace `entry.errorCode` with `UNKNOWN_ERROR_CODE` unless it already
 * matches the exact shape `email_logs_error_code_check` (email-log.model.ts)
 * enforces at the database, leaving every other field untouched.
 *
 * NORMALIZE, do not truncate. An earlier version of this repository
 * truncated an over-length `errorCode` to `ERROR_CODE_MAX_LENGTH` — the
 * wrong remedy for this class of value: a raw token (session.service.ts)
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

// The three placeholders below are WIDTH-only sentinels — unlike
// UNKNOWN_ERROR_CODE, none of them close a secret-shape leak, because none
// of `recipient`/`templateKey`/`providerMessageId` has a shape CHECK to
// close (email-log.model.ts's header comment). They exist for a narrower
// reason: task-3-brief.md's Controller addendum, item 2 — an over-width
// value must not make `record()`'s insert throw 22001, because
// `recordDelivery` (mailer.service.ts) catches that and only logs it, so
// the send succeeded and the audit row silently never existed.
//
// NORMALIZE (a fixed placeholder), not TRUNCATE (a prefix of the real
// value) — the policy decision task-3-brief.md asks this task to argue,
// stated here because this is where it is applied. `errorCode`'s own
// "truncate, don't normalize" verdict does NOT transfer automatically: a
// truncated secret is still a live secret fragment, and none of these three
// values is a secret. The argument for a sentinel over a prefix here is
// narrower and forensic, not a leak concern: a truncated
// `very-long-user@ex` or a truncated Message-ID still LOOKS like real, if
// odd, data — an operator (or a future query) can mistake it for a genuine
// value and waste time chasing it as one. A sentinel that cannot be
// mistaken for a real address, template key, or Message-ID is preferred
// over a prefix that can, even though a prefix would preserve strictly more
// information. The counter-argument (a prefix at least narrows down WHICH
// real value this was, which a bare sentinel cannot) is real and not
// dismissed lightly — but the values this normalization actually fires on
// are, by construction, ones that should never legitimately reach 320/32/255
// characters in the first place (an email address, a fixed template-key
// literal, a provider's own message id), so the realistic case is a bug or
// a hostile input upstream, not a genuine oversized value worth partially
// preserving. Neither policy makes `findByRecipient` match the real,
// original value either way — truncation is not a strictly better
// trade-off for that lookup, only for a human reading the row directly.
//
// This does NOT exclude a raw token from any of these three columns: a
// 64-character hex-encoded token (session.service.ts) fits comfortably
// inside 320 and 255 without ever triggering this normalization at all, and
// a 32-character FRAGMENT of one fits `templateKey`'s own width exactly —
// this normalization only stops an over-width value from vanishing the
// audit row, the same "width alone is a real gate because nothing
// legitimate approaches it" property `templateKey` already relied on
// (email-log.model.ts's header comment), not a second shape guarantee.

/**
 * The value `EmailLogRepository.record` substitutes for a `recipient` that
 * exceeds `MAX_EMAIL_LENGTH`. See this file's own comment (above
 * `withErrorCodeNormalized`... continued below `TEMPLATE_KEY_MAX_LENGTH`'s
 * import) for the normalize-vs-truncate argument this represents.
 */
export const OVERLENGTH_RECIPIENT_PLACEHOLDER = '[recipient too long]'

/**
 * The value `EmailLogRepository.record` substitutes for a `templateKey`
 * that exceeds `TEMPLATE_KEY_MAX_LENGTH`. See `OVERLENGTH_RECIPIENT_PLACEHOLDER`'s
 * own comment.
 */
export const OVERLENGTH_TEMPLATE_KEY_PLACEHOLDER = '[template key too long]'

/**
 * The value `EmailLogRepository.record` substitutes for a `providerMessageId`
 * that exceeds `PROVIDER_MESSAGE_ID_MAX_LENGTH`. See
 * `OVERLENGTH_RECIPIENT_PLACEHOLDER`'s own comment.
 */
export const OVERLENGTH_PROVIDER_MESSAGE_ID_PLACEHOLDER = '[provider message id too long]'

/**
 * Replace `entry.recipient` with `OVERLENGTH_RECIPIENT_PLACEHOLDER` when it
 * exceeds `MAX_EMAIL_LENGTH`, leaving every other field untouched. No
 * `typeof` guard is needed here (unlike `providerMessageId`/`errorCode`
 * below): `recipient` is `NOT NULL` in the schema, so `NewEmailLog.recipient`
 * is always a `string` — a runtime type check against an unreachable branch
 * is exactly the kind of untested, dead condition this codebase treats as a
 * defect in itself.
 * @param entry - The row about to be inserted.
 * @returns `entry` unchanged when `recipient` fits, or a shallow copy with `recipient` replaced by the placeholder.
 */
function withRecipientNormalized(entry: NewEmailLog): NewEmailLog {
  return entry.recipient.length <= MAX_EMAIL_LENGTH
    ? entry
    : { ...entry, recipient: OVERLENGTH_RECIPIENT_PLACEHOLDER }
}

/**
 * Replace `entry.templateKey` with `OVERLENGTH_TEMPLATE_KEY_PLACEHOLDER`
 * when it exceeds `TEMPLATE_KEY_MAX_LENGTH`, leaving every other field
 * untouched. See `withRecipientNormalized`'s own comment for why no
 * `typeof` guard is needed (`templateKey` is `NOT NULL`).
 *
 * `record()`'s own parameter type does not close `templateKey` to
 * `EmailTemplateKey` (email-template.utilities.ts) — only `MailMessage`
 * (mailer.service.ts) does, one layer up — so this guard is this method's
 * OWN defence against a caller reaching it directly with an arbitrary
 * string, the same way `withErrorCodeNormalized` does not lean on
 * `errorCode`'s type either.
 * @param entry - The row about to be inserted.
 * @returns `entry` unchanged when `templateKey` fits, or a shallow copy with `templateKey` replaced by the placeholder.
 */
function withTemplateKeyNormalized(entry: NewEmailLog): NewEmailLog {
  return entry.templateKey.length <= TEMPLATE_KEY_MAX_LENGTH
    ? entry
    : { ...entry, templateKey: OVERLENGTH_TEMPLATE_KEY_PLACEHOLDER }
}

/**
 * Replace `entry.providerMessageId` with
 * `OVERLENGTH_PROVIDER_MESSAGE_ID_PLACEHOLDER` when it exceeds
 * `PROVIDER_MESSAGE_ID_MAX_LENGTH`, leaving every other field untouched.
 * `providerMessageId` IS nullable (set on success, null on failure), unlike
 * `recipient`/`templateKey` above, so this keeps the `typeof` guard
 * `withErrorCodeNormalized` also needs for the identical reason.
 * @param entry - The row about to be inserted.
 * @returns `entry` unchanged when `providerMessageId` is absent or fits, or a shallow copy with it replaced by the placeholder.
 */
function withProviderMessageIdNormalized(entry: NewEmailLog): NewEmailLog {
  if (typeof entry.providerMessageId !== 'string') return entry
  return entry.providerMessageId.length <= PROVIDER_MESSAGE_ID_MAX_LENGTH
    ? entry
    : { ...entry, providerMessageId: OVERLENGTH_PROVIDER_MESSAGE_ID_PLACEHOLDER }
}

/**
 * Apply every column's normalization to one row, in a fixed order, before
 * it reaches `db.insert`. Composed once, here, rather than chained inline
 * inside `record()` — a single named function is what lets `record()`'s own
 * JSDoc describe "the row is normalized" as one guarantee instead of
 * enumerating four function calls.
 * @param entry - The row about to be inserted.
 * @returns `entry` with every over-width field replaced by its column's placeholder; fields that already fit are returned unchanged.
 */
function normalizedForInsert(entry: NewEmailLog): NewEmailLog {
  const withErrorCode = withErrorCodeNormalized(entry)
  const withRecipient = withRecipientNormalized(withErrorCode)
  const withTemplateKey = withTemplateKeyNormalized(withRecipient)
  return withProviderMessageIdNormalized(withTemplateKey)
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
   * catches that inside this method. What IS guaranteed is narrower:
   * `errorCode` is normalized by SHAPE and width (a value that does not
   * match the expected pattern, or is too long, becomes
   * `UNKNOWN_ERROR_CODE`), and `recipient`/`templateKey`/`providerMessageId`
   * are each normalized by WIDTH alone (an over-width value becomes that
   * column's own fixed placeholder — see `normalizedForInsert` and each
   * column's own `with*Normalized` function) — rather than any of the four
   * being left to throw a 22001 (string data right truncation) or, for
   * `errorCode`, an `email_logs_error_code_check` violation. That
   * normalization matters because a log write happens strictly after the
   * send it describes, so nothing here can undo that send — a caller that
   * mis-extracted a value (up to and including passing a raw token as
   * `errorCode` by mistake, or an unexpectedly long value in any of the
   * other three) must still get a written row for THAT reason, not a
   * request failure — and, for an audit table, not a silently vanished
   * row either (task-3-brief.md's Controller addendum, item 2). The caller
   * itself is still responsible for the other half of Ruling E: catching
   * whatever this rejects with (a genuine infrastructure failure, not this
   * normalization) and logging it at `console.error` — redacted the same
   * way `redactedForLog` (postgres-errors.ts) already redacts every
   * other failed write in this codebase (driver error code kept, bound
   * parameter values dropped; this table's own `recipient` is PII, not a
   * secret, but the same redaction applies to it for the identical reason)
   * — rather than failing the request.
   * @param entry - The row to insert: recipient, templateKey, status, and whichever of providerMessageId/errorCode applies to that status.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, including its generated `id` and `createdAt`.
   */
  async record(entry: NewEmailLog, executor: DbExecutor = db): Promise<EmailLog> {
    const [row] = await executor
      .insert(emailLogModel)
      .values(normalizedForInsert(entry))
      .returning()
    // insert(...).values(one object).returning() always returns exactly
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
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Every matching row, ordered by `createdAt` ascending, `id` ascending as a tiebreaker.
   */
  async findByRecipient(recipient: string, executor: DbExecutor = db): Promise<EmailLog[]> {
    return executor
      .select()
      .from(emailLogModel)
      .where(eq(emailLogModel.recipient, recipient))
      .orderBy(asc(emailLogModel.createdAt), asc(emailLogModel.id))
  }

  /**
   * Delete up to `limit` rows created before `cutoff`.
   * @param cutoff - Rows older than this go.
   * @param limit - The most rows one call deletes.
   * @param tx - The batch's transaction.
   * @returns How many rows were deleted.
   */
  async purgeCreatedBefore(cutoff: Date, limit: number, tx: DbTransaction): Promise<number> {
    const batch = tx
      .select({ id: emailLogModel.id })
      .from(emailLogModel)
      .where(sql`${emailLogModel.createdAt} < ${cutoff.toISOString()}::timestamptz`)
      .limit(limit)
    const result = await tx.delete(emailLogModel).where(inArray(emailLogModel.id, batch))
    return result.count
  }
}
