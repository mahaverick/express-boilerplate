/**
 * @file The `notifications` table (in-app history) and the
 * `notification_preferences` table (per-user, per-type channel opt-outs).
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import type { NotificationType } from '@/constants/notification.constants'
import { userModel } from '@/database/models/user.model'

/**
 * The `notifications` table: one row per in-app notification delivered to a
 * user, read or not, until `NotificationRepository.deleteOne` or the
 * retention purge removes it. No `deletedAt` or `updatedAt`, so
 * `NotificationRepository` does not extend `BaseRepository`.
 */
export const notificationModel = pgTable(
  'notifications',
  {
    /**
     * uuidv7, as for `users.id`.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    /**
     * No CHECK constraint, unlike `user_tokens.purpose`: the type list is
     * expected to grow, and each addition would need a migration.
     */
    type: varchar('type', { length: 50 }).$type<NotificationType>().notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body').notNull(),
    /**
     * Type-specific data for the notification's consumers; never queried on.
     */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /**
     * Null means unread. Set by `markRead`/`markAllRead`; nothing clears it.
     */
    readAt: timestamp('read_at', { withTimezone: true }),
    /**
     * Millisecond precision, so `list`'s keyset cursor round-trips through a
     * JS `Date` exactly. With microseconds, a row could fall between the
     * truncated cursor and the next page and never be returned.
     */
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /**
     * Idempotency key: the notification worker sets
     * `notification-job-<jobId>-<jobTimestamp>`, so a retried job cannot
     * insert twice. Null for other producers; unique indexes treat nulls as
     * distinct.
     */
    dedupeKey: varchar('dedupe_key', { length: 128 }),
  },
  (table) => [
    // id breaks createdAt ties, so a keyset cursor can resume within one millisecond.
    index('notifications_user_created_idx').on(table.userId, table.createdAt, table.id),
    uniqueIndex('notifications_dedupe_key_unique').on(table.dedupeKey),
    index('notifications_read_at_idx')
      .on(table.readAt)
      .where(sql`${table.readAt} is not null`),
    index('notifications_unread_created_idx')
      .on(table.createdAt)
      .where(sql`${table.readAt} is null`),
  ]
)

/**
 * A notifications row as read from the database.
 */
export type Notification = InferSelectModel<typeof notificationModel>

/**
 * A notifications row as written to the database.
 */
export type NewNotification = InferInsertModel<typeof notificationModel>

/**
 * The `notification_preferences` table: at most one row per
 * `(userId, notificationType)` pair, recording whether that user has opted
 * out of the email and/or in-app channel for that notification type.
 *
 * The pair is the primary key, which `NotificationPreferenceRepository.upsert`
 * targets with `onConflictDoUpdate`. No row means both channels are enabled:
 * the table stores only explicit choices.
 */
export const notificationPreferenceModel = pgTable(
  'notification_preferences',
  {
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    /**
     * No CHECK constraint, as for `notifications.type`.
     */
    notificationType: varchar('notification_type', { length: 50 })
      .$type<NotificationType>()
      .notNull(),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    inAppEnabled: boolean('in_app_enabled').notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.userId, table.notificationType] })]
)

/**
 * A notification_preferences row as read from the database.
 */
export type NotificationPreference = InferSelectModel<typeof notificationPreferenceModel>

/**
 * A notification_preferences row as written to the database.
 */
export type NewNotificationPreference = InferInsertModel<typeof notificationPreferenceModel>
