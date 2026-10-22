/**
 * @file Query access to `notifications`. It does not extend `BaseRepository`: the
 * table has no `deletedAt`/`updatedAt`, `deleteOne` is a hard delete, and its one
 * unique index (`dedupe_key`) is handled by `createOnce`'s ON CONFLICT, not a 409.
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  notificationModel,
  type NewNotification,
  type Notification,
} from '@/database/models/notification.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'
import {
  defineList,
  listPage,
  searchCondition,
  timestampKey,
  timestampSort,
  type ListPage,
  type ListParams,
} from '@/utilities/list-page.utilities'

/**
 * A notification as a list returns it: every column but the internal `dedupeKey`.
 */
export type NotificationListItem = Omit<Notification, 'dedupeKey'>

/**
 * The condition for the `unread` filter.
 * @param unread - True for unread only, false for read only, undefined for both.
 * @returns The SQL condition, or undefined for both.
 */
function readCondition(unread: boolean | undefined) {
  if (unread === undefined) return
  return unread ? isNull(notificationModel.readAt) : isNotNull(notificationModel.readAt)
}

/**
 * One user's notifications, newest first, searched by title and body. Its cursors are bound to the user.
 * @param userId - The owner.
 * @param search - The parsed search, or undefined.
 * @param filters - `unread` true for unread only, false for read only.
 * @param filters.unread - The read filter, or undefined for both.
 * @returns The list definition.
 */
export function notificationList(
  userId: string,
  search: string | undefined,
  filters: { unread: boolean | undefined }
) {
  return defineList({
    name: 'notifications',
    base: (executor, seek) =>
      executor
        .select({
          id: notificationModel.id,
          userId: notificationModel.userId,
          type: notificationModel.type,
          title: notificationModel.title,
          body: notificationModel.body,
          metadata: notificationModel.metadata,
          readAt: notificationModel.readAt,
          createdAt: notificationModel.createdAt,
          sortCreated: timestampKey(notificationModel.createdAt),
        })
        .from(notificationModel)
        .where(
          and(
            eq(notificationModel.userId, userId),
            readCondition(filters.unread),
            searchCondition(search, [
              sql`lower(${notificationModel.title})`,
              sql`lower(${notificationModel.body})`,
            ]),
            seek
          )
        )
        .$dynamic(),
    id: notificationModel.id,
    sorts: { '-created': [timestampSort(notificationModel.createdAt, 'desc', 'sortCreated')] },
    bound: { userId },
    toItem: ({ sortCreated: _created, ...notification }): NotificationListItem => notification,
  })
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
   * One page of a user's notifications, newest first, searched by title and body.
   * @param userId - The notification owner. Every returned row belongs to this user.
   * @param params - The parsed shared list params.
   * @param filters - `unread` true for unread only, false for read only.
   * @param filters.unread - The read filter, or undefined for both.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async list(
    userId: string,
    params: ListParams,
    filters: { unread: boolean | undefined },
    executor: DbExecutor = db
  ): Promise<ListPage<NotificationListItem>> {
    return listPage(executor, notificationList(userId, params.search, filters), params)
  }

  /**
   * A user's newest notifications, newest first: the SSE replay's one
   * bounded read, with no cursor, search or filter.
   * @param userId - The owner.
   * @param limit - The most rows to read.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Up to `limit` notifications, newest first, the id breaking a tie.
   */
  async listRecent(
    userId: string,
    limit: number,
    executor: DbExecutor = db
  ): Promise<Notification[]> {
    return executor
      .select()
      .from(notificationModel)
      .where(eq(notificationModel.userId, userId))
      .orderBy(desc(notificationModel.createdAt), desc(notificationModel.id))
      .limit(limit)
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
   * Delete at most `limit` notifications read before `cutoff`.
   * Takes the batch oldest id first with FOR UPDATE SKIP LOCKED: a row a
   * request holds is left for a later run instead of waited on, so a batch
   * can come back short while matching rows remain.
   * The ids are collected with `= any(array(...))`, which runs the locking
   * subquery once, so the delete takes at most `limit` rows (see
   * `AnalyticsOutboxRepository.claimBatch`).
   * @param cutoff - Rows read before this go.
   * @param limit - The most rows to delete in this call.
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
    const result = await tx
      .delete(notificationModel)
      .where(sql`${notificationModel.id} = any(array(${batch}))`)
    return result.count
  }

  /**
   * Delete at most `limit` unread notifications created before `cutoff`.
   * Takes the batch oldest id first with FOR UPDATE SKIP LOCKED: a row a
   * request holds is left for a later run instead of waited on, so a batch
   * can come back short while matching rows remain.
   * The ids are collected with `= any(array(...))`, which runs the locking
   * subquery once, so the delete takes at most `limit` rows (see
   * `AnalyticsOutboxRepository.claimBatch`).
   * @param cutoff - Unread rows created before this go.
   * @param limit - The most rows to delete in this call.
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
    const result = await tx
      .delete(notificationModel)
      .where(sql`${notificationModel.id} = any(array(${batch}))`)
    return result.count
  }
}
