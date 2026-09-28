/**
 * @file Query access to the append-only `email_logs` table. It does not extend
 * `BaseRepository`: a delivery log must offer no `update()` or `softDelete()`, has
 * no `updatedAt`/`deletedAt` columns, and has no unique constraint to translate.
 */
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
 * Replaces, never truncates: a raw hex token is 64 characters, and a 32-character
 * prefix of it is still half a live secret. A lowercase hex token never matches
 * the uppercase-only `ERROR_CODE_PATTERN`, at any length. The database CHECK
 * stays the real guarantee; this keeps a mismatched value from failing the insert.
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
 * The value `EmailLogRepository.record` substitutes for a `recipient` that
 * exceeds `MAX_EMAIL_LENGTH`.
 *
 * The three over-width placeholders are width-only sentinels, not a secret
 * guard: a 64-character hex token fits `recipient` and `providerMessageId`, and
 * a 32-character fragment fits `templateKey`. They exist so an over-width value
 * cannot make the insert throw 22001, which `recordDelivery` (mailer.service.ts)
 * would only log, leaving no row for a mail that was sent. A fixed placeholder,
 * not a prefix: a truncated address or Message-ID still looks like real data,
 * and a value this long is a bug or hostile input upstream.
 */
export const OVERLENGTH_RECIPIENT_PLACEHOLDER = '[recipient too long]'

/**
 * The value `EmailLogRepository.record` substitutes for a `templateKey`
 * that exceeds `TEMPLATE_KEY_MAX_LENGTH`. See `OVERLENGTH_RECIPIENT_PLACEHOLDER`.
 */
export const OVERLENGTH_TEMPLATE_KEY_PLACEHOLDER = '[template key too long]'

/**
 * The value `EmailLogRepository.record` substitutes for a `providerMessageId`
 * that exceeds `PROVIDER_MESSAGE_ID_MAX_LENGTH`. See
 * `OVERLENGTH_RECIPIENT_PLACEHOLDER`.
 */
export const OVERLENGTH_PROVIDER_MESSAGE_ID_PLACEHOLDER = '[provider message id too long]'

/**
 * Replace `entry.recipient` with `OVERLENGTH_RECIPIENT_PLACEHOLDER` when it
 * exceeds `MAX_EMAIL_LENGTH`, leaving every other field untouched. `recipient`
 * is `NOT NULL`, so it needs no `typeof` guard.
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
 * untouched. `record()` accepts any string here (only `MailMessage` narrows it
 * to a template key), so this guards a direct caller.
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
 * `providerMessageId` is nullable (set on success, null on failure).
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
 * Apply every column's normalization to one row before it reaches the insert.
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
 * attempt, look up a recipient's rows, and purge old ones. It answers "did the
 * email send?" without putting a token or a rendered body in a log.
 */
export class EmailLogRepository {
  /**
   * Record one outbound email attempt, sent or failed.
   *
   * `errorCode` is normalized by shape and width, and `recipient`,
   * `templateKey` and `providerMessageId` by width, to fixed placeholders (see
   * `normalizedForInsert`), so a mis-extracted value, even a raw token passed as
   * `errorCode`, still writes a row instead of failing with 22001 or
   * `email_logs_error_code_check`. The log write happens after the send, so it
   * cannot undo it. An infrastructure failure (database unreachable, connection
   * reset) still rejects; the caller, `recordDelivery` (mailer.service.ts),
   * catches it and logs it at `logger.error` through `redactedForLog`
   * (postgres-errors.ts), without failing the request.
   * @param entry - The row to insert: recipient, templateKey, status, and whichever of providerMessageId/errorCode applies to that status.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, including its generated `id` and `createdAt`.
   */
  async record(entry: NewEmailLog, executor: DbExecutor = db): Promise<EmailLog> {
    const [row] = await executor
      .insert(emailLogModel)
      .values(normalizedForInsert(entry))
      .returning()
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * Every row recorded for one recipient, oldest first. Tests use it to
   * assert on what `record` wrote; nothing in src/ calls it. `id` (a
   * time-ordered uuidv7) breaks a tie between rows in the same millisecond.
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
   * Takes the batch oldest id first with FOR UPDATE SKIP LOCKED: a row a
   * request holds is left for a later run instead of waited on, so a batch
   * can come back short while matching rows remain.
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
      .orderBy(emailLogModel.id)
      .limit(limit)
      .for('update', { skipLocked: true })
    const result = await tx.delete(emailLogModel).where(inArray(emailLogModel.id, batch))
    return result.count
  }
}
