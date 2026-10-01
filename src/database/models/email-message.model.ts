/**
 * @file The `email_messages` table: one row per logical email. Its attempts
 * are `email_logs` rows and its provider events `email_events` rows. Only
 * `status`, `status_updated_at` and `failure_origin` ever change. No column
 * holds a rendered body or a token.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH } from '@/constants/auth.constants'
import {
  EMAIL_MESSAGE_STATUSES,
  FAILURE_ORIGINS,
  SENDER_CLASSES,
  type EmailMessageStatus,
  type FailureOrigin,
  type SenderClass,
} from '@/constants/email.constants'
import { FRONTEND_APPS, type FrontendApp } from '@/constants/frontend.constants'

/**
 * Render a fixed, code-defined value list as SQL literals for a CHECK.
 * @param values - The allowed values.
 * @returns The values quoted and comma-separated.
 */
function sqlValueList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

/**
 * The width of `template_key`, equal to `email_logs.template_key`'s
 * (`TEMPLATE_KEY_MAX_LENGTH`, email-log.model.ts). Not imported: that model
 * references this one, so importing it back would be a cycle.
 */
export const MESSAGE_TEMPLATE_KEY_MAX_LENGTH = 32

/**
 * The widest a `message_id_header` value may be: `<`, a 36-character id,
 * `@`, the sender's domain and `>` fit with room to spare.
 */
export const MESSAGE_ID_HEADER_MAX_LENGTH = 255

/**
 * The widest a `job_key` value may be: the notification path's
 * `notification-email-<job id>-<timestamp>` fits.
 */
export const JOB_KEY_MAX_LENGTH = 128

/**
 * The `email_messages` table.
 */
export const emailMessageModel = pgTable(
  'email_messages',
  {
    /**
     * uuidv7. A caller reads one from Postgres first
     * (`EmailMessageRepository.nextId`), so it can build the Message-ID
     * header before the insert; the default serves the migration's backfill.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    recipient: varchar('recipient', { length: MAX_EMAIL_LENGTH }).notNull(),
    templateKey: varchar('template_key', { length: MESSAGE_TEMPLATE_KEY_MAX_LENGTH }).notNull(),
    /**
     * The account the mail is for; null when there is none. No foreign key:
     * a purge deletes these rows itself.
     */
    userId: varchar('user_id', { length: 36 }),
    /**
     * The tenant the mail is about (invitations); no foreign key, as for `userId`.
     */
    tenantId: varchar('tenant_id', { length: 36 }),
    /**
     * The invitation a `tenant_invitation` mail carried.
     */
    invitationId: varchar('invitation_id', { length: 36 }),
    /**
     * Which frontend the token link opened; null for a template with no link.
     */
    linkApp: varchar('link_app', { length: 8 }).$type<FrontendApp>(),
    senderClass: varchar('sender_class', { length: 16 }).$type<SenderClass>().notNull(),
    /**
     * The email's Message-ID header, `<{id}@{sender domain}>`, so a
     * provider's events can be matched back to this row.
     */
    messageIdHeader: varchar('message_id_header', { length: MESSAGE_ID_HEADER_MAX_LENGTH })
      .notNull()
      .unique('email_messages_message_id_header_unique'),
    /**
     * The caller's fixed BullMQ job id, when it gave one: a retried enqueue
     * with the same id gets this row back instead of a second one.
     */
    jobKey: varchar('job_key', { length: JOB_KEY_MAX_LENGTH }).unique(
      'email_messages_job_key_unique'
    ),
    /**
     * Only the template's `previewVariables`, never a link or a token.
     */
    variables: jsonb('variables').$type<Record<string, string>>().notNull().default({}),
    status: varchar('status', { length: 16 }).$type<EmailMessageStatus>().notNull(),
    failureOrigin: varchar('failure_origin', { length: 16 }).$type<FailureOrigin>(),
    /**
     * Millisecond precision, as `createdAt`.
     */
    statusUpdatedAt: timestamp('status_updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    /**
     * The message a staff resend was made from.
     */
    resentFromId: varchar('resent_from_id', { length: 36 }).references(
      (): AnyPgColumn => emailMessageModel.id,
      { onDelete: 'set null' }
    ),
    /**
     * Millisecond precision, so a keyset cursor round-trips through a JS Date exactly.
     */
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index('email_messages_recipient_lower_idx').on(sql`lower(${table.recipient})`),
    index('email_messages_user_id_idx').on(table.userId),
    index('email_messages_tenant_id_idx').on(table.tenantId),
    index('email_messages_resent_from_id_idx').on(table.resentFromId),
    index('email_messages_created_at_idx').on(table.createdAt),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'email_messages_status_check',
      sql`${table.status} in (${sql.raw(sqlValueList(EMAIL_MESSAGE_STATUSES))})`
    ),
    check(
      'email_messages_sender_class_check',
      sql`${table.senderClass} in (${sql.raw(sqlValueList(SENDER_CLASSES))})`
    ),
    // A NULL link_app or failure_origin makes `in (...)` NULL, which a CHECK accepts.
    check(
      'email_messages_link_app_check',
      sql`${table.linkApp} in (${sql.raw(sqlValueList(FRONTEND_APPS))})`
    ),
    check(
      'email_messages_failure_origin_check',
      sql`${table.failureOrigin} in (${sql.raw(sqlValueList(FAILURE_ORIGINS))})`
    ),
  ]
)

/**
 * An email_messages row as read from the database.
 */
export type EmailMessage = InferSelectModel<typeof emailMessageModel>

/**
 * An email_messages row as written to the database.
 */
export type NewEmailMessage = InferInsertModel<typeof emailMessageModel>
