/**
 * @file The `email_events` table: an append-only record of each provider
 * event (delivered, bounced, opened, …) matched to an `email_messages` row.
 * It never holds a raw payload or a clicked URL: `detail`'s shape CHECK makes
 * a token unrepresentable there.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, index, pgTable, timestamp, unique, varchar } from 'drizzle-orm/pg-core'
import {
  BOUNCE_KINDS,
  EMAIL_DETAIL_MAX_LENGTH,
  EMAIL_DETAIL_PATTERN,
  EMAIL_EVENT_TYPES,
  type BounceKind,
  type EmailEventType,
} from '@/constants/email.constants'
import { emailMessageModel } from '@/database/models/email-message.model'

/**
 * Render a fixed, code-defined value list as SQL literals for a CHECK.
 * @param values - The allowed values.
 * @returns The values quoted and comma-separated.
 */
function sqlValueList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

/**
 * `EMAIL_DETAIL_PATTERN` as a SQL string literal, outside the CHECK's
 * template so `sonarjs/no-nested-template-literals` holds.
 */
const DETAIL_PATTERN_SQL_LITERAL = `'${EMAIL_DETAIL_PATTERN.source}'`

/**
 * The `email_events` table. No `updatedAt` or `deletedAt`: an event is
 * never rewritten; `EmailEventRepository` does not extend `BaseRepository`.
 */
export const emailEventModel = pgTable(
  'email_events',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    messageId: varchar('message_id', { length: 36 })
      .notNull()
      .references(() => emailMessageModel.id, { onDelete: 'cascade' }),
    /**
     * The adapter that received it: `resend`, `fake`.
     */
    provider: varchar('provider', { length: 32 }).notNull(),
    /**
     * The provider's own id for the event, unique per provider, so a
     * redelivered webhook inserts nothing.
     */
    providerEventId: varchar('provider_event_id', { length: 128 }).notNull(),
    type: varchar('type', { length: 16 }).$type<EmailEventType>().notNull(),
    /**
     * Set exactly when `type` is `bounced`.
     */
    bounceKind: varchar('bounce_kind', { length: 8 }).$type<BounceKind>(),
    /**
     * A provider's reason, normalised to upper snake case, or null.
     */
    detail: varchar('detail', { length: EMAIL_DETAIL_MAX_LENGTH }),
    /**
     * The provider's timestamp. Millisecond precision, as every timeline column.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('email_events_provider_event_unique').on(table.provider, table.providerEventId),
    index('email_events_message_id_idx').on(table.messageId),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'email_events_type_check',
      sql`${table.type} in (${sql.raw(sqlValueList(EMAIL_EVENT_TYPES))})`
    ),
    check(
      'email_events_bounce_kind_check',
      sql`${table.bounceKind} in (${sql.raw(sqlValueList(BOUNCE_KINDS))})`
    ),
    check(
      'email_events_bounce_kind_presence_check',
      sql`(${table.bounceKind} is not null) = (${table.type} = 'bounced')`
    ),
    // A NULL detail satisfies the CHECK, so no `is null or` is needed.
    check(
      'email_events_detail_check',
      sql`${table.detail} ~ ${sql.raw(DETAIL_PATTERN_SQL_LITERAL)}`
    ),
  ]
)

/**
 * An email_events row as read from the database.
 */
export type EmailEvent = InferSelectModel<typeof emailEventModel>

/**
 * An email_events row as written to the database.
 */
export type NewEmailEvent = InferInsertModel<typeof emailEventModel>
