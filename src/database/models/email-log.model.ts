// src/database/models/email-log.model.ts
//
// Append-only delivery-attempt audit log for outbound email — see
// task-4-brief.md ("Controller addendum") for the reasoning this file's
// shape follows exactly. This table is a leaf dependency: nothing in src/
// writes through it yet — the mail transport that will (a later task) does
// not exist here, deliberately.
//
// THE LOAD-BEARING PROPERTY: a row here must never be able to hold the raw
// token a verification/reset email carries, or the rendered email body.
// That is not a convention this file states and hopes callers respect — it
// is structural: there is no column here wide enough or intended to hold
// either. `errorCode` is the column most likely to accidentally grow into
// that role (an SMTP failure routinely echoes message content back in its
// server response), so it is capped at ERROR_CODE_MAX_LENGTH and
// deliberately NOT a free-text `message`/`response` column — see that
// column's own comment below.
//
// APPEND-ONLY, DELIBERATELY: no `updatedAt`, no `deletedAt`. An audit
// record you can hide (soft-delete) or silently rewrite (update) after the
// fact is not an audit record. See ARCHITECTURE.md's repository-layer
// paragraph, and `EmailLogRepository`'s own header comment, for why this
// table's repository does not extend `BaseRepository` — which would
// otherwise hand it both, plus a 23505 -> 409 translation that has nothing
// to translate here (there is no unique constraint on this table).
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH } from '@/constants/auth.constants'

/**
 * The two things an `email_logs` row can record — the single source of
 * truth `EmailLogStatus` is derived from, below, and the same array builds
 * the `status` column's CHECK constraint's SQL (this table's
 * `(table) => [...]`, `email_logs_status_check`). One array, so the set of
 * valid statuses can never drift between the TypeScript type — which a raw
 * SQL statement is not bound by, `$type<EmailLogStatus>()` is compile-time
 * only — and the constraint that is the actual last line of defence
 * against a raw insert writing something else. Mirrors the pattern
 * `user-token.model.ts` established for `TokenPurpose`/`TOKEN_PURPOSES`.
 */
export const EMAIL_LOG_STATUSES = ['sent', 'failed'] as const

// `EMAIL_LOG_STATUSES`, pre-rendered as a literal SQL value list —
// `'sent', 'failed'` — for `email_logs_status_check` below. Built once,
// here, rather than inline inside that `sql` template: nesting this
// array's own template literal inside the check constraint's `sql\`...\``
// template trips `sonarjs/no-nested-template-literals`, and pulling it out
// one level is simpler than fighting the lint rule for no readability
// gain — same reasoning as `TOKEN_PURPOSE_SQL_LIST` in
// user-token.model.ts.
const EMAIL_LOG_STATUS_SQL_LIST = EMAIL_LOG_STATUSES.map((status) => `'${status}'`).join(', ')

/**
 * Whether one outbound email attempt succeeded or failed.
 */
export type EmailLogStatus = (typeof EMAIL_LOG_STATUSES)[number]

/**
 * The widest an `error_code` value is allowed to be. This is meant to hold
 * nodemailer's short `code` field (`ECONNECTION`, `EAUTH`, `EMESSAGE`,
 * ...), or the literal `'UNKNOWN'` when the rejected value has no `code` —
 * never a free-text message or server response. Exported so
 * `EmailLogRepository.record` can truncate an over-length value to this
 * exact width, defensively, rather than duplicating the number: a log
 * write must never be the thing that fails an already-sent email's request
 * (Ruling E, task-4-brief.md).
 */
export const ERROR_CODE_MAX_LENGTH = 64

/**
 * The `email_logs` table: one row per outbound email attempt, whether it
 * sent or failed. This is an audit trail for "did the email send?", not a
 * mailbox — see this file's header comment for the property every column
 * choice here protects.
 */
export const emailLogModel = pgTable(
  'email_logs',
  {
    // uuidv7 is time-ordered, so it indexes like a sequence without leaking
    // a row count the way a serial does — same choice as every other
    // table's id.
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    // Same width as users.email / emailSchema (MAX_EMAIL_LENGTH), imported
    // rather than retyped — the recipient of an outbound email is always
    // somebody's account email, so the two must agree for the same reason
    // user.model.ts's own email column does.
    recipient: varchar('recipient', { length: MAX_EMAIL_LENGTH }).notNull(),
    // Which template rendered the email (e.g. 'password_reset',
    // 'email_verification') — NOT the rendered body itself. See this
    // file's header comment: no column here ever holds rendered content.
    templateKey: varchar('template_key', { length: 64 }).notNull(),
    // 'sent' | 'failed'. varchar + $type<>(), NOT pgEnum — matching
    // `purpose` on user_tokens (user-token.model.ts), plus the CHECK
    // constraint below: `$type<>()` alone is compile-time-only narrowing,
    // and a raw SQL insert is not bound by it.
    status: varchar('status', { length: 16 }).$type<EmailLogStatus>().notNull(),
    // The sending provider's message id. Set on success; null on failure.
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    // nodemailer's short `code` (or the literal 'UNKNOWN' when the
    // rejected value has no `code`). Null on success. NOT a message or
    // response column — see ERROR_CODE_MAX_LENGTH's own comment and this
    // file's header comment for why the width itself, not a convention, is
    // what keeps this column structurally unable to hold a token or a
    // rendered body.
    errorCode: varchar('error_code', { length: ERROR_CODE_MAX_LENGTH }),
    // No updatedAt, no deletedAt — see this file's header comment.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The database-level half of `status`'s validity check — see that
    // column's own comment, and `TOKEN_PURPOSE_SQL_LIST`'s comment in
    // user-token.model.ts for the fuller version of this reasoning.
    //
    // `sql.raw`, not `sql`-tagged interpolation: a CHECK constraint's
    // expression is fixed at DDL time, and a plain `${value}` interpolation
    // compiles to a bound parameter (`$1, $2`) — valid inside a normal
    // query, but `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` (or the
    // equivalent inline table constraint on `CREATE TABLE`) has no
    // parameter list to bind against, so Postgres rejects it outright
    // ("there is no parameter $1"). This was verified the hard way once
    // already, on `user_tokens.purpose` (see that file's own comment on
    // this exact point) — `sql.raw` (safe here: every value comes from the
    // fixed, code-defined `EMAIL_LOG_STATUSES` array, never external input)
    // is what produces literal SQL text instead.
    check(
      'email_logs_status_check',
      sql`${table.status} in (${sql.raw(EMAIL_LOG_STATUS_SQL_LIST)})`
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
