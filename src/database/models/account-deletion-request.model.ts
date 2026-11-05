/**
 * @file The `account_deletion_requests` table: one row per time a customer
 * asked us to delete their account. A request is `open` until staff delete
 * the account, which marks it `completed`. A user has at most one open
 * request (`account_deletion_requests_open_unique`).
 */
import { sql, type InferSelectModel } from 'drizzle-orm'
import { check, index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { userModel } from '@/database/models/user.model'
import { sqlValueList } from '@/utilities/sql-value-list.utilities'

/**
 * The states a request moves through: `open` until staff delete the account,
 * then `completed`.
 */
const ACCOUNT_DELETION_REQUEST_STATUSES = ['open', 'completed'] as const

/**
 * One of `ACCOUNT_DELETION_REQUEST_STATUSES`.
 */
export type AccountDeletionRequestStatus = (typeof ACCOUNT_DELETION_REQUEST_STATUSES)[number]

/**
 * The longest reason a customer may give.
 */
export const ACCOUNT_DELETION_REASON_MAX_LENGTH = 500

/**
 * The `account_deletion_requests` table. `user_id` is RESTRICT: a request is
 * the record that we promised a deletion, so nothing removes it by accident;
 * the user purge deletes it explicitly in its transaction.
 */
export const accountDeletionRequestModel = pgTable(
  'account_deletion_requests',
  {
    /**
     * uuidv7, as for `users.id`.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When we promised to have deleted the account by: `requested_at` plus
     * `ACCOUNT_DELETION_DAYS`.
     */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /**
     * When staff deleted the account; null while the request is open.
     */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    status: varchar('status', { length: 16 })
      .$type<AccountDeletionRequestStatus>()
      .notNull()
      .default('open'),
    /**
     * Why the customer is leaving, if they said.
     */
    reason: varchar('reason', { length: ACCOUNT_DELETION_REASON_MAX_LENGTH }),
  },
  (table) => [
    // One open request per user: `insertOpen` relies on it to return the open one instead of a second.
    uniqueIndex('account_deletion_requests_open_unique')
      .on(table.userId)
      .where(sql`${table.status} = 'open'`),
    index('account_deletion_requests_user_id_idx').on(table.userId),
    // The staff list's `due` sort: only open requests, in the order it pages them.
    index('account_deletion_requests_open_due_sort_idx')
      .on(table.dueAt, table.id)
      .where(sql`${table.status} = 'open'`),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'account_deletion_requests_status_check',
      sql`${table.status} in (${sql.raw(sqlValueList(ACCOUNT_DELETION_REQUEST_STATUSES))})`
    ),
    // A completed request says when; an open one has no completion time.
    check(
      'account_deletion_requests_completed_at_check',
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null)`
    ),
  ]
)

/**
 * An account_deletion_requests row as read from the database.
 */
export type AccountDeletionRequest = InferSelectModel<typeof accountDeletionRequestModel>
