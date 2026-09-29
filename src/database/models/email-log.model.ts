/**
 * @file The `email_logs` table: an append-only record of each outbound
 * email attempt that can never hold a raw token or a rendered body. Only
 * the retention purge and a user purge (by recipient) delete rows.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, index, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH } from '@/constants/auth.constants'

/**
 * The two things an `email_logs` row can record. `EmailLogStatus` and the
 * `email_logs_status_check` constraint are both built from it, so the type
 * and the constraint that stops a raw SQL insert cannot drift.
 */
export const EMAIL_LOG_STATUSES = ['sent', 'failed'] as const

/**
 * `EMAIL_LOG_STATUSES` as a literal SQL value list, outside the CHECK's
 * template so `sonarjs/no-nested-template-literals` holds.
 */
const EMAIL_LOG_STATUS_SQL_LIST = EMAIL_LOG_STATUSES.map((status) => `'${status}'`).join(', ')

/**
 * Whether one outbound email attempt succeeded or failed.
 */
export type EmailLogStatus = (typeof EMAIL_LOG_STATUSES)[number]

/**
 * The widest an `error_code` value may be: room for nodemailer's short
 * `code` (`ECONNECTION` is 11) and far short of a 64-character hex token.
 * `EmailLogRepository.record` replaces an over-length or wrong-shaped value
 * with `UNKNOWN_ERROR_CODE` rather than truncating it.
 */
export const ERROR_CODE_MAX_LENGTH = 32

/**
 * The error-code shape, shared by `ERROR_CODE_PATTERN` and
 * `email_logs_error_code_check`. It matches nodemailer's codes and
 * `UNKNOWN_ERROR_CODE`, and can never match a raw token, which is lowercase
 * hex (`generateRawToken`, session.service.ts).
 */
const ERROR_CODE_PATTERN_SOURCE = '^[A-Z][A-Z0-9_]*$'

/**
 * `ERROR_CODE_PATTERN_SOURCE` as a SQL string literal, for the same lint reason.
 */
const ERROR_CODE_PATTERN_SQL_LITERAL = `'${ERROR_CODE_PATTERN_SOURCE}'`

/**
 * The only shape `error_code` may take, checked by `EmailLogRepository`
 * before every insert. It does not bound length: the repository checks
 * `ERROR_CODE_MAX_LENGTH` separately, as the column width does in the database.
 */
export const ERROR_CODE_PATTERN = new RegExp(ERROR_CODE_PATTERN_SOURCE)

/**
 * The value `EmailLogRepository.record` substitutes for an `errorCode` that
 * does not match `ERROR_CODE_PATTERN` or exceeds `ERROR_CODE_MAX_LENGTH`,
 * including one that looks like a raw token.
 */
export const UNKNOWN_ERROR_CODE = 'UNKNOWN'

/**
 * The widest a `template_key` value may be, narrower than a 64-character hex
 * token so a whole token cannot fit (a fragment still could; only fixed
 * template names reach this column). `EmailLogRepository.record` replaces an
 * over-width value with a placeholder rather than letting the insert fail.
 */
export const TEMPLATE_KEY_MAX_LENGTH = 32

/**
 * The widest a `provider_message_id` value may be. A Message-ID can be long,
 * so this width guards against a failed insert, not a token leak:
 * `EmailLogRepository.record` replaces an over-width value with a placeholder.
 */
export const PROVIDER_MESSAGE_ID_MAX_LENGTH = 255

/**
 * The `email_logs` table: one row per outbound email attempt, whether it
 * sent or failed. An audit trail for "did the email send?", not a mailbox:
 * no column holds a rendered body, and `errorCode`'s shape CHECK makes a
 * token unrepresentable there. No `updatedAt` or `deletedAt`, since an audit
 * row that can be rewritten or hidden is not one; `EmailLogRepository` does
 * not extend `BaseRepository`, which would add both.
 */
export const emailLogModel = pgTable(
  'email_logs',
  {
    /**
     * uuidv7, as for `users.id`.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    recipient: varchar('recipient', { length: MAX_EMAIL_LENGTH }).notNull(),
    /**
     * Which template rendered the email, never the rendered body.
     */
    templateKey: varchar('template_key', { length: TEMPLATE_KEY_MAX_LENGTH }).notNull(),
    /**
     * varchar with a CHECK, as for `user_tokens.purpose`, since `$type<>()`
     * binds only TypeScript.
     */
    status: varchar('status', { length: 16 }).$type<EmailLogStatus>().notNull(),
    /**
     * The sending provider's message id. Set on success; null on failure.
     */
    providerMessageId: varchar('provider_message_id', { length: PROVIDER_MESSAGE_ID_MAX_LENGTH }),
    /**
     * nodemailer's short `code`, or `UNKNOWN_ERROR_CODE`. Null on success.
     * Never a message or server response.
     */
    errorCode: varchar('error_code', { length: ERROR_CODE_MAX_LENGTH }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('email_logs_created_at_idx').on(table.createdAt),
    // A user purge deletes by address in any case; this keeps it off a table scan.
    index('email_logs_recipient_lower_idx').on(sql`lower(${table.recipient})`),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'email_logs_status_check',
      sql`${table.status} in (${sql.raw(EMAIL_LOG_STATUS_SQL_LIST)})`
    ),
    // A NULL error_code (a sent row) satisfies the CHECK, so no `is null or` is needed.
    check(
      'email_logs_error_code_check',
      sql`${table.errorCode} ~ ${sql.raw(ERROR_CODE_PATTERN_SQL_LITERAL)}`
    ),
  ]
)

/**
 * An email_logs row as read from the database.
 */
export type EmailLog = InferSelectModel<typeof emailLogModel>

/**
 * An email_logs row as written to the database.
 */
export type NewEmailLog = InferInsertModel<typeof emailLogModel>
