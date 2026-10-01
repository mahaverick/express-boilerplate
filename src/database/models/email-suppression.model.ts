/**
 * @file The `email_suppressions` table: addresses that hard-bounced or
 * complained, which no email may be sent to. A row is never deleted by
 * retention; lifting one keeps the row as history.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH } from '@/constants/auth.constants'
import {
  LIFT_REASON_MAX_LENGTH,
  SUPPRESSION_REASONS,
  type SuppressionReason,
} from '@/constants/email.constants'
import { emailEventModel } from '@/database/models/email-event.model'

/**
 * `SUPPRESSION_REASONS` as a literal SQL value list, outside the CHECK's
 * template so `sonarjs/no-nested-template-literals` holds.
 */
const SUPPRESSION_REASON_SQL_LIST = SUPPRESSION_REASONS.map((reason) => `'${reason}'`).join(', ')

/**
 * The `email_suppressions` table.
 */
export const emailSuppressionModel = pgTable(
  'email_suppressions',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    /**
     * Lowercased (`email_suppressions_address_lower_check`), so one lookup
     * matches the address in any case.
     */
    address: varchar('address', { length: MAX_EMAIL_LENGTH }).notNull(),
    reason: varchar('reason', { length: 16 }).$type<SuppressionReason>().notNull(),
    /**
     * The event that suppressed the address; null once that event is gone.
     */
    sourceEventId: varchar('source_event_id', { length: 36 }).references(() => emailEventModel.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    liftedAt: timestamp('lifted_at', { withTimezone: true, precision: 3 }),
    /**
     * The staff user who lifted it. No foreign key: one would block that
     * user's purge.
     */
    liftedBy: varchar('lifted_by', { length: 36 }),
    liftReason: varchar('lift_reason', { length: LIFT_REASON_MAX_LENGTH }),
  },
  (table) => [
    // One active suppression per address; lifted rows stay as history.
    uniqueIndex('email_suppressions_active_address_unique')
      .on(table.address)
      .where(sql`${table.liftedAt} is null`),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'email_suppressions_reason_check',
      sql`${table.reason} in (${sql.raw(SUPPRESSION_REASON_SQL_LIST)})`
    ),
    check(
      'email_suppressions_address_lower_check',
      sql`${table.address} = lower(${table.address})`
    ),
  ]
)

/**
 * An email_suppressions row as read from the database.
 */
export type EmailSuppression = InferSelectModel<typeof emailSuppressionModel>

/**
 * An email_suppressions row as written to the database.
 */
export type NewEmailSuppression = InferInsertModel<typeof emailSuppressionModel>
