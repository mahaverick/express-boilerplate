// src/database/models/email-log.model.ts
//
// Append-only delivery-attempt audit log for outbound email — see
// task-4-brief.md ("Controller addendum") for the reasoning this file's
// shape follows exactly. This table is a leaf dependency: nothing in src/
// writes through it yet — the mail transport that will (a later task) does
// not exist here, deliberately.
//
// THE LOAD-BEARING PROPERTY, SCOPED TO WHAT THIS SCHEMA ACTUALLY ENFORCES
// (round-2 review finding 3: an earlier version of this comment claimed
// the guarantee table-wide, which overclaimed — the exact category of bug
// this task exists to avoid, restated at a smaller scale). Column by
// column:
//
//   - `errorCode` is STRUCTURALLY guaranteed never to hold a raw token or
//     rendered body — genuinely, not by convention. `errorCode` is the
//     column most likely to accidentally grow into that role (an SMTP
//     failure routinely echoes message content back in its server
//     response), and an earlier version of this table tried to close that
//     off with width alone (`varchar(64)`) — which was wrong:
//     `RAW_TOKEN_BYTES` (session.service.ts) is 32, and hex-encoded that is
//     EXACTLY 64 characters, so a raw token fit an over-generous width
//     perfectly rather than overflowing it. The actual guarantee is
//     `ERROR_CODE_PATTERN`/`email_logs_error_code_check` below: an
//     uppercase-only shape (`^[A-Z][A-Z0-9_]*$`) that a lowercase hex token
//     can never match, enforced at both the repository (normalization) and
//     the database (the CHECK constraint) — see `EmailLogRepository`'s own
//     comment for why normalization, not truncation, is what makes this
//     true rather than merely likely. `errorCode` is deliberately NOT a
//     free-text `message`/`response` column either way.
//   - `templateKey` is width-bounded to 32 — narrower than a 64-character
//     hex-encoded raw token, so a FULL token cannot fit — but that is a
//     weaker claim than `errorCode`'s: there is no shape CHECK here, and
//     none is needed FOR THE SAME REASON `errorCode` needed one: nothing
//     error-derived or user-derived reaches this column today, only this
//     codebase's own fixed template names (`'password_reset'`,
//     `'email_verification'`, ...). Width is a real gate here because
//     nothing legitimate approaches it, not because the column is
//     shape-unrepresentable the way `errorCode` is. A 32-character
//     FRAGMENT of a token would still fit and would not be caught by
//     anything — this column's protection is "nothing plausible reaches
//     it", not "nothing possible could". As of Task 3 (task-3-brief.md's
//     Controller addendum, item 2), `EmailLogRepository.record` also
//     NORMALIZES an over-width value here to a fixed placeholder before
//     the insert, the same "handle the class, not one column" policy
//     applied to `recipient`/`providerMessageId` below — see that file's
//     own comment for why, and for the correction this makes to the
//     addendum's own inaccurate claim that this column already had that
//     protection.
//   - `providerMessageId` (255) carries no SHAPE protection — it is
//     provider-derived, genuinely variable-length (a Message-ID can
//     legitimately be long), so nothing here can exclude a token-shaped
//     value the way `errorCode`'s shape CHECK does (flagged to the
//     plan/Task 2, not addressed here; see task-4-report.md's round-2
//     notes). As of Task 3, it DOES get the same WIDTH normalization as
//     `templateKey` above: an over-255 value is replaced with a
//     placeholder rather than left to throw a 22001 that silently drops
//     the audit row — see EmailLogRepository's own comment for the
//     truncate-vs-sentinel argument this makes.
//   - `recipient` (MAX_EMAIL_LENGTH) carries no shape protection either,
//     by design: it is the send's actual destination address, not derived
//     from an error or the rendered body, so this table's load-bearing
//     property was never about excluding a token from this column. As of
//     Task 3, it too gets width normalization — same reasoning as
//     `providerMessageId` above.
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
 * ...), or the literal `UNKNOWN_ERROR_CODE` when the rejected value has no
 * `code` — never a free-text message or server response. The longest real
 * nodemailer code is `ECONNECTION` at 11 characters; 32 is generous
 * headroom, chosen specifically to stay far short of a 64-character
 * hex-encoded raw token (see this file's header comment) rather than
 * merely "wide enough for a short code". Exported so
 * `EmailLogRepository.record` can check an incoming value against this
 * exact width, alongside `ERROR_CODE_PATTERN`, rather than duplicating the
 * number — see that method's own comment for why an over-length or
 * wrong-shaped value is NORMALIZED to `UNKNOWN_ERROR_CODE`, not truncated
 * (Ruling E, task-4-brief.md, plus the round-1 fix to this task).
 */
export const ERROR_CODE_MAX_LENGTH = 32

// The regex source, as a plain string, single-sourced between
// `ERROR_CODE_PATTERN` (below, for `EmailLogRepository`'s own
// pre-insert validation) and `email_logs_error_code_check`'s SQL — same
// "one array/string drives both the runtime check and the constraint"
// reasoning as `EMAIL_LOG_STATUS_SQL_LIST` above. An uppercase letter,
// followed by any number of uppercase letters, digits, or underscores:
// matches every real nodemailer code (`ECONNECTION`, `EAUTH`, `EENVELOPE`,
// ...) and `UNKNOWN_ERROR_CODE`, and categorically cannot match a raw
// token — `generateRawToken` (session.service.ts) hex-encodes
// `crypto.randomBytes`, which is lowercase hex digits only, so a raw token
// can never contain an uppercase letter at all, anywhere in it.
const ERROR_CODE_PATTERN_SOURCE = '^[A-Z][A-Z0-9_]*$'

// `ERROR_CODE_PATTERN_SOURCE`, pre-quoted as a SQL string literal — for
// `email_logs_error_code_check` below. Built once, here, rather than
// inline inside that `sql` template: nesting this quoting template
// literal inside the check constraint's own `sql\`...\`` template trips
// `sonarjs/no-nested-template-literals`, same as `EMAIL_LOG_STATUS_SQL_LIST`
// above.
const ERROR_CODE_PATTERN_SQL_LITERAL = `'${ERROR_CODE_PATTERN_SOURCE}'`

/**
 * The only shape `error_code` may take, checked by `EmailLogRepository`
 * before every insert — see `ERROR_CODE_PATTERN_SOURCE`'s own comment for
 * why this specific shape is what makes a raw token unrepresentable, not
 * merely unlikely. Does not itself bound length; `EmailLogRepository`
 * checks `ERROR_CODE_MAX_LENGTH` separately, the same way the database
 * enforces it via the column's own width rather than the CHECK
 * constraint below.
 */
export const ERROR_CODE_PATTERN = new RegExp(ERROR_CODE_PATTERN_SOURCE)

/**
 * The literal value `EmailLogRepository.record` substitutes for an
 * `errorCode` that does not match `ERROR_CODE_PATTERN`/`ERROR_CODE_MAX_LENGTH`
 * — including, deliberately, a value that looks exactly like a raw token.
 * Exported so nothing (this file, the repository, or a later task's
 * transport) needs to retype the string.
 */
export const UNKNOWN_ERROR_CODE = 'UNKNOWN'

/**
 * The widest a `template_key` value is allowed to be. Exported for the same
 * reason `ERROR_CODE_MAX_LENGTH` is: so `EmailLogRepository.record` can
 * check an incoming value against this EXACT width — as of Task 3, to
 * normalize an over-width value to a placeholder rather than let the insert
 * throw 22001 — rather than duplicating the number. 32 is narrower than a
 * 64-character hex-encoded raw token (this file's header comment), chosen
 * for the identical reason `ERROR_CODE_MAX_LENGTH` was narrowed from an
 * original 64: "the value that reaches this column today is trusted" is not
 * a width justification.
 */
export const TEMPLATE_KEY_MAX_LENGTH = 32

/**
 * The widest a `provider_message_id` value is allowed to be. Exported for
 * the same reason `ERROR_CODE_MAX_LENGTH` is — see `TEMPLATE_KEY_MAX_LENGTH`
 * above. Unlike that column, 255 is not chosen to stay clear of a
 * hex-encoded raw token's 64 characters — a Message-ID can legitimately be
 * long (this file's header comment) — so this width bounds the audit-row
 * insert failure Task 3 closes, not a token-shape leak.
 */
export const PROVIDER_MESSAGE_ID_MAX_LENGTH = 255

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
    // 'email_verification') — NOT the rendered body itself. 32, not the
    // original 64: round-2 review finding 2 — 64 was the exact width that
    // let a hex-encoded raw token (see this file's header comment) fit
    // perfectly, the identical mistake `errorCode` made and for the
    // identical reason ("the value that can reach it is trusted today" is
    // not a width justification). No shape CHECK here, unlike
    // `errorCode` — see this file's header comment for why width alone is
    // an adequate (if weaker) gate for this specific column.
    templateKey: varchar('template_key', { length: TEMPLATE_KEY_MAX_LENGTH }).notNull(),
    // 'sent' | 'failed'. varchar + $type<>(), NOT pgEnum — matching
    // `purpose` on user_tokens (user-token.model.ts), plus the CHECK
    // constraint below: `$type<>()` alone is compile-time-only narrowing,
    // and a raw SQL insert is not bound by it.
    status: varchar('status', { length: 16 }).$type<EmailLogStatus>().notNull(),
    // The sending provider's message id. Set on success; null on failure.
    providerMessageId: varchar('provider_message_id', { length: PROVIDER_MESSAGE_ID_MAX_LENGTH }),
    // nodemailer's short `code` (or `UNKNOWN_ERROR_CODE` when the rejected
    // value has no `code`, or doesn't match the shape below). Null on
    // success. NOT a message or response column — see this file's header
    // comment and `email_logs_error_code_check` below for why the SHAPE
    // constraint, not the width alone, is what keeps this column
    // structurally unable to hold a token or a rendered body.
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
    // The database-level half of `errorCode`'s shape guarantee — see
    // ERROR_CODE_PATTERN_SOURCE's own comment for what this excludes and
    // why. `sql.raw`, not `sql`-tagged interpolation, for the identical
    // DDL-can't-bind-a-parameter reason as the status check above: a plain
    // `${value}` here would compile to `$1`, which Postgres rejects inside
    // a CHECK expression. Safe here for the same reason: the pattern comes
    // from a fixed, code-defined string, never external input.
    //
    // No explicit `is null or` guard needed: Postgres treats a CHECK
    // expression that evaluates to NULL (which `error_code ~ pattern`
    // does whenever `error_code` itself is NULL — success rows have no
    // code) as satisfied, exactly like TRUE. Only an actual FALSE — a
    // non-null value that fails to match — is rejected.
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
