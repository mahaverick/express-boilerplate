// src/database/models/notification.model.ts
//
// Two tables: `notifications` (in-app history, one row per delivered
// notification) and `notification_preferences` (per-user per-type channel
// toggles, opt-out model — see NotificationPreferenceRepository's own header
// comment for what "opt-out" means for a row that does not exist yet).
//
// NEITHER TABLE HAS `deletedAt` OR `updatedAt`. A notification is either
// there or hard-deleted (`NotificationRepository.deleteOne`) — nothing
// "soft-deletes" a notification a user has already dismissed — and a
// preference row is only ever upserted wholesale, never partially patched
// in a way that would need an update timestamp. This is also why neither
// repository extends `BaseRepository`: that class requires exactly the two
// columns this schema deliberately does not have (`base.repository.ts`'s
// `SoftDeletableTableConfig`) — see `NotificationRepository`'s own header
// comment for the fuller version of this argument, already made once for
// `EmailLogRepository`/`email-log.model.ts`.
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import type { NotificationType } from '@/constants/notification.constants'
import { userModel } from '@/database/models/user.model'

/**
 * The `notifications` table: one row per in-app notification delivered to a
 * user, read or not, until `NotificationRepository.deleteOne` removes it.
 *
 * `createdAt` is `timestamp(3)` — precision 3, i.e. millisecond precision —
 * not this codebase's usual bare `timestamp with time zone` (microsecond
 * precision). This is deliberate, not an oversight: `NotificationRepository
 * .list`'s keyset cursor round-trips `createdAt` through a JS `Date`
 * (millisecond precision) and back into a `(created_at, id) < (?, ?)`
 * comparison. If the column stored microseconds, a row's true timestamp
 * could sit strictly between the millisecond-truncated cursor value and the
 * next page's lower bound, and that row would silently never be returned —
 * a keyset-pagination gap, not merely an off-by-one. Rounding to
 * millisecond precision AT WRITE TIME (Postgres does this once, on
 * `now()`'s own default) makes every stored value exactly representable by
 * a JS `Date`, so the cursor this repository encodes and the value Postgres
 * compares against can never disagree. `readAt` does not need this — it is
 * never part of a keyset comparison — so it keeps the default (unbounded)
 * precision.
 */
export const notificationModel = pgTable(
  'notifications',
  {
    // uuidv7 is time-ordered, so it indexes like a sequence without leaking
    // a row count the way a serial does — same choice as every other
    // table's id.
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    // $type<>() alone is compile-time narrowing only — unlike `purpose`
    // (user-token.model.ts) or `status` (email-log.model.ts), this column
    // deliberately carries no database-level CHECK constraint. See
    // notification.constants.ts's header comment for why: this list is
    // expected to grow as new notification-producing features ship, and a
    // CHECK constraint would need its own migration every time it did.
    type: varchar('type', { length: 50 }).$type<NotificationType>().notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body').notNull(),
    // Type-specific data a later task's notification worker or controller
    // may want back (e.g. which template rendered the paired email) —
    // opaque to this repository, never queried on.
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    // null = unread. Set once, by `NotificationRepository.markRead`/
    // `markAllRead`; nothing clears it back to null.
    readAt: timestamp('read_at', { withTimezone: true }),
    // Precision 3 — see this table's own header comment for why this
    // column specifically cannot use the bare (microsecond) default.
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    // Supports NotificationRepository.list's keyset pagination query:
    // `WHERE user_id = ? ORDER BY created_at DESC, id DESC` with an
    // optional `AND (created_at, id) < (?, ?)` cursor predicate. `id` is a
    // tiebreaker column, not a second meaningful sort key — two
    // notifications for the same user can share a `createdAt` (the same
    // millisecond, e.g. a worker burst), and without `id` in the index a
    // cursor built from one such row could not reliably resume after it.
    index('notifications_user_created_idx').on(table.userId, table.createdAt, table.id),
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
 * Composite primary key, deliberately — no surrogate `id`. The pair IS the
 * identity of a preference row (a second row for the same user and type
 * would be meaningless: which one wins?), so `NotificationPreferenceRepository
 * .upsert` targets `(userId, notificationType)` directly via
 * `onConflictDoUpdate`, and the primary key is what makes that a real
 * database-enforced uniqueness guarantee rather than a convention the
 * application alone maintains.
 *
 * ABSENCE OF A ROW MEANS BOTH CHANNELS ENABLED — the opt-out default. This
 * table only ever stores an explicit CHOICE (usually an opt-OUT); the
 * common case of "never touched their preferences" is represented by no row
 * at all, not by a row with both columns `true`. See
 * `NotificationPreferenceRepository.isChannelEnabled`'s own comment for what
 * this means for a lookup.
 */
export const notificationPreferenceModel = pgTable(
  'notification_preferences',
  {
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    // See notificationModel.type's own comment for why this carries no
    // CHECK constraint despite being drawn from a fixed TypeScript union.
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
