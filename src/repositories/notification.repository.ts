/**
 * @file Query access to `notifications`. It does not extend `BaseRepository`: the
 * table has no `deletedAt`/`updatedAt`, `deleteOne` is a hard delete, and its one
 * unique index (`dedupe_key`) is handled by `createOnce`'s ON CONFLICT, not a 409.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  notificationModel,
  type NewNotification,
  type Notification,
} from '@/database/models/notification.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * The two fields a keyset pagination cursor for `NotificationRepository.list`
 * carries: the last row's `createdAt` and `id`, the pair (after `userId`)
 * `notifications_user_created_idx` is built on.
 */
export interface NotificationCursor {
  /**
   * The `createdAt` of the last row on the previous page.
   */
  createdAt: Date
  /**
   * The `id` of the last row on the previous page, the tiebreaker for two
   * rows sharing the same `createdAt`.
   */
  id: string
}

/**
 * Encode a page's last row into the opaque, URL-safe cursor string
 * `NotificationRepository.list` returns as `nextCursor`. `createdAt` is
 * serialized with `toISOString()`, since the cursor goes to the client and
 * comes back as a query parameter.
 * @param cursor - The last row's `createdAt` and `id`.
 * @returns A base64url-encoded, opaque cursor string.
 */
export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })
  ).toString('base64url')
}

/**
 * Query access to the `notifications` table: create a notification,
 * paginate a user's inbox, look up or mutate a single notification scoped
 * to its owner, and bulk mark-as-read. Every lookup or mutation that targets
 * one row also filters on `userId`, so a caller can never act on, or learn
 * the existence of, another user's notification by guessing an id.
 */
export class NotificationRepository {
  /**
   * Insert one notification.
   * @param data - The row's initial column values.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, including its generated `id` and `createdAt`.
   */
  async create(data: NewNotification, executor: DbExecutor = db): Promise<Notification> {
    const [row] = await executor.insert(notificationModel).values(data).returning()
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * Insert one notification unless a row with the same `dedupeKey` exists
   * (`ON CONFLICT (dedupe_key) DO NOTHING`). A retried producer calls this
   * safely.
   * @param data - The row's column values, including the idempotency key.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, or undefined when the key was already used.
   */
  async createOnce(
    data: NewNotification & { dedupeKey: string },
    executor: DbExecutor = db
  ): Promise<Notification | undefined> {
    const [row] = await executor
      .insert(notificationModel)
      .values(data)
      .onConflictDoNothing({ target: notificationModel.dedupeKey })
      .returning()
    return row
  }

  /**
   * A page of one user's notifications, newest first, via keyset (not
   * offset) pagination on `(createdAt, id)`. The cursor's `createdAt` is bound
   * as an ISO string cast to `timestamptz`: drizzle hands a raw `Date` in a
   * `sql` template to postgres-js unserialised, and the query fails.
   * @param userId - The notification owner. Every returned row belongs to this user.
   * @param options - `limit` (page size) and an optional `cursor` — the last row of the previous page, to resume after.
   * @param options.limit - How many notifications to return on this page.
   * @param options.cursor - The last row of the previous page, or undefined to fetch the first page.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Up to `limit` notifications, and `nextCursor` (present only when more rows remain) to fetch the next page.
   */
  async list(
    userId: string,
    options: { limit: number; cursor?: NotificationCursor },
    executor: DbExecutor = db
  ): Promise<{ notifications: Notification[]; nextCursor?: string }> {
    const conditions = [eq(notificationModel.userId, userId)]

    if (options.cursor) {
      conditions.push(
        sql`(${notificationModel.createdAt}, ${notificationModel.id}) < (${options.cursor.createdAt.toISOString()}::timestamptz, ${options.cursor.id})`
      )
    }

    const notifications = await executor
      .select()
      .from(notificationModel)
      .where(and(...conditions))
      .orderBy(desc(notificationModel.createdAt), desc(notificationModel.id))
      .limit(options.limit + 1)

    const hasMore = notifications.length > options.limit
    if (hasMore) notifications.pop()

    const lastRow = notifications.at(-1)
    if (hasMore && lastRow !== undefined) {
      return {
        notifications,
        nextCursor: encodeNotificationCursor({ createdAt: lastRow.createdAt, id: lastRow.id }),
      }
    }
    return { notifications }
  }

  /**
   * Find one notification, scoped to its owner: the `userId` predicate makes
   * this an ownership check, not just a lookup by id.
   * @param id - The notification's id.
   * @param userId - The user who must own it.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching row, or undefined when no such notification exists for this user (including when it exists but belongs to someone else).
   */
  async findByIdAndUser(
    id: string,
    userId: string,
    executor: DbExecutor = db
  ): Promise<Notification | undefined> {
    const [row] = await executor
      .select()
      .from(notificationModel)
      .where(and(eq(notificationModel.id, id), eq(notificationModel.userId, userId)))
    return row
  }

  /**
   * Mark one notification read, scoped to its owner. Returns undefined, not
   * a throw, when the notification does not exist, belongs to another user, or
   * is already read; `isNull(readAt)` makes the last case a no-op in the
   * database rather than a read-then-write race in the caller.
   * @param id - The notification's id.
   * @param userId - The user who must own it.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when no matching, not-yet-read row owned by this user exists.
   */
  async markRead(
    id: string,
    userId: string,
    executor: DbExecutor = db
  ): Promise<Notification | undefined> {
    const [row] = await executor
      .update(notificationModel)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notificationModel.id, id),
          eq(notificationModel.userId, userId),
          isNull(notificationModel.readAt)
        )
      )
      .returning()
    return row
  }

  /**
   * Mark every currently-unread notification for one user read, in a
   * single statement.
   * @param userId - The user whose unread notifications should be marked read.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns How many rows were updated (0 when the user had none unread).
   */
  async markAllRead(userId: string, executor: DbExecutor = db): Promise<number> {
    const result = await executor
      .update(notificationModel)
      .set({ readAt: sql`now()` })
      .where(and(eq(notificationModel.userId, userId), isNull(notificationModel.readAt)))
    return result.count
  }

  /**
   * Delete one notification, scoped to its owner.
   * @param id - The notification's id.
   * @param userId - The user who must own it.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns True when a row was deleted; false when no matching row owned by this user existed.
   */
  async deleteOne(id: string, userId: string, executor: DbExecutor = db): Promise<boolean> {
    const result = await executor
      .delete(notificationModel)
      .where(and(eq(notificationModel.id, id), eq(notificationModel.userId, userId)))
    return result.count > 0
  }

  /**
   * Delete up to `limit` notifications read before `cutoff`.
   * Takes the batch oldest id first with FOR UPDATE SKIP LOCKED: a row a
   * request holds is left for a later run instead of waited on, so a batch
   * can come back short while matching rows remain.
   * @param cutoff - Rows read before this go.
   * @param limit - The most rows one call deletes.
   * @param tx - The batch's transaction.
   * @returns How many rows were deleted.
   */
  async purgeReadBefore(cutoff: Date, limit: number, tx: DbTransaction): Promise<number> {
    const batch = tx
      .select({ id: notificationModel.id })
      .from(notificationModel)
      .where(sql`${notificationModel.readAt} < ${cutoff.toISOString()}::timestamptz`)
      .orderBy(notificationModel.id)
      .limit(limit)
      .for('update', { skipLocked: true })
    const result = await tx.delete(notificationModel).where(inArray(notificationModel.id, batch))
    return result.count
  }

  /**
   * Delete up to `limit` unread notifications created before `cutoff`.
   * Takes the batch oldest id first with FOR UPDATE SKIP LOCKED: a row a
   * request holds is left for a later run instead of waited on, so a batch
   * can come back short while matching rows remain.
   * @param cutoff - Unread rows created before this go.
   * @param limit - The most rows one call deletes.
   * @param tx - The batch's transaction.
   * @returns How many rows were deleted.
   */
  async purgeUnreadCreatedBefore(cutoff: Date, limit: number, tx: DbTransaction): Promise<number> {
    const batch = tx
      .select({ id: notificationModel.id })
      .from(notificationModel)
      .where(
        and(
          isNull(notificationModel.readAt),
          sql`${notificationModel.createdAt} < ${cutoff.toISOString()}::timestamptz`
        )
      )
      .orderBy(notificationModel.id)
      .limit(limit)
      .for('update', { skipLocked: true })
    const result = await tx.delete(notificationModel).where(inArray(notificationModel.id, batch))
    return result.count
  }
}
