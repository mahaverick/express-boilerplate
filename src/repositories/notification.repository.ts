// src/repositories/notification.repository.ts
//
// Deliberately does NOT extend BaseRepository — same three reasons
// email-log.repository.ts gives for itself, restated for this table: (1)
// BaseRepository hands every subclass `update()`/`softDelete()`, and this
// table has no soft-delete concept — `deleteOne` below is a hard delete.
// (2) BaseRepository requires `deletedAt`/`updatedAt` columns
// (`SoftDeletableTableConfig`, base.repository.ts), neither of which
// `notifications` has. (3) BaseRepository's 23505 -> HttpError(409)
// translation exists for a unique constraint a caller could violate; this
// table has none (its only constraint is the `userId` foreign key), so
// there is nothing to translate. This is a plain class with exactly the
// methods a notification inbox needs.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  notificationModel,
  type NewNotification,
  type Notification,
} from '@/database/models/notification.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * The two fields a keyset pagination cursor for `NotificationRepository
 * .list` carries: the last row's `createdAt` and `id`, together —
 * `notifications_user_created_idx` (notification.model.ts) is built on
 * exactly this pair, in this order, for exactly this reason.
 */
export interface NotificationCursor {
  /**
   * The `createdAt` of the last row on the previous page.
   */
  createdAt: Date
  /**
   * The `id` of the last row on the previous page — the tiebreaker for two
   * rows sharing the same `createdAt`.
   */
  id: string
}

/**
 * Encode a page's last row into the opaque, URL-safe cursor string
 * `NotificationRepository.list` returns as `nextCursor`. `createdAt` is
 * serialized via `toISOString()`, not passed through as a `Date` — the
 * cursor crosses an HTTP response/request boundary (a later task's
 * controller hands this straight to a client, which hands it straight
 * back as a query parameter), and only a string survives that round trip.
 * @param cursor - The last row's `createdAt` and `id`.
 * @returns A base64url-encoded, opaque cursor string.
 */
export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })
  ).toString('base64url')
}

/**
 * Decode a cursor string produced by `encodeNotificationCursor` back into
 * the `{ createdAt, id }` pair `NotificationRepository.list` accepts as
 * `options.cursor`. The inverse of `encodeNotificationCursor` — exists so a
 * later task's controller never has to hand-roll base64url/JSON handling
 * for a value only this file's own encoder produces.
 *
 * Never throws: a cursor is client-supplied input by the time anything
 * calls this (a query parameter on a paginated list request), and a
 * malformed, tampered, or stale one must fail as "no cursor" — the safest
 * available behaviour, since `list()` without a cursor simply returns the
 * first page — not as a 500.
 * @param raw - The cursor string, as returned by `encodeNotificationCursor` or supplied by a client.
 * @returns The decoded `{ createdAt, id }` pair, or undefined when `raw` is not a validly-encoded cursor.
 */
export function decodeNotificationCursor(raw: string): NotificationCursor | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('createdAt' in decoded) ||
      !('id' in decoded) ||
      typeof decoded.createdAt !== 'string' ||
      typeof decoded.id !== 'string'
    ) {
      return undefined
    }

    const createdAt = new Date(decoded.createdAt)
    if (Number.isNaN(createdAt.getTime())) return undefined

    return { createdAt, id: decoded.id }
  } catch {
    return undefined
  }
}

/**
 * Query access to the `notifications` table: create a notification,
 * paginate a user's inbox, look up or mutate a single notification scoped
 * to its owner, and bulk mark-as-read. Every lookup/mutation that targets
 * one row also filters on `userId` — see each method's own comment — so a
 * caller can never act on, or even learn the existence of, another user's
 * notification by guessing an id.
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
    // insert(...).values(one object).returning() always returns exactly
    // one row when the insert does not throw; the driver's own types just
    // cannot express "same length as input" for a single-row insert — same
    // reasoning as UserRepository.insertOne (user.repository.ts).
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
   * offset) pagination — see `NotificationCursor`'s own comment for why
   * `(createdAt, id)` together, and notification.model.ts's header comment
   * for why `createdAt` is millisecond-precision specifically so this
   * comparison can never disagree with what was actually stored.
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
      // `.toISOString()`, cast back with `::timestamptz`, NOT the raw `Date`
      // interpolated directly. Verified empirically: drizzle-orm 0.45.2's
      // `sql` template, given a raw JS `Date` as a parameter inside a row-
      // value tuple comparison like this one, hands postgres-js's bind step
      // the `Date` object itself rather than a driver-ready string — every
      // OTHER write in this codebase only ever writes a `Date` through a
      // typed column's own insert/update path (`.values()`/`.set()`), which
      // takes a different, working code path; nothing else interpolates a
      // bare `Date` into a raw `sql` fragment the way this cursor
      // comparison needs to. Postgres-js's own bind handler then rejects it
      // with a raw "Received an instance of Date" TypeError instead of a
      // query result. A plain string this codebase's own timestamp columns
      // (`timestamp with time zone`) parse unambiguously does not have this
      // failure mode.
      conditions.push(
        sql`(${notificationModel.createdAt}, ${notificationModel.id}) < (${options.cursor.createdAt.toISOString()}::timestamptz, ${options.cursor.id})`
      )
    }

    const notifications = await executor
      .select()
      .from(notificationModel)
      .where(and(...conditions))
      .orderBy(desc(notificationModel.createdAt), desc(notificationModel.id))
      .limit(options.limit + 1) // fetch one extra to detect whether a next page exists

    const hasMore = notifications.length > options.limit
    if (hasMore) notifications.pop()

    const lastRow = notifications.at(-1)
    // Built conditionally, not as `{ notifications, nextCursor }` with
    // `nextCursor` possibly `undefined` — `exactOptionalPropertyTypes`
    // (tsconfig.json) treats an optional property's type as "present with
    // this type, or absent", not "present with this type, or present as
    // `undefined`", so explicitly assigning `undefined` to it does not
    // type-check.
    if (hasMore && lastRow !== undefined) {
      return {
        notifications,
        nextCursor: encodeNotificationCursor({ createdAt: lastRow.createdAt, id: lastRow.id }),
      }
    }
    return { notifications }
  }

  /**
   * Find one notification, scoped to its owner. The `userId` predicate is
   * what makes this an ownership check, not just a lookup by id — a caller
   * that omitted it could fetch (and a later task's controller could leak
   * the contents of) any user's notification given its id alone.
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
   * Mark one notification read, scoped to its owner. A no-op — returns
   * undefined rather than throwing — when the notification does not exist,
   * belongs to another user, or is already read; the `isNull(readAt)`
   * predicate is what makes an already-read row a no-op in the database
   * itself rather than a read-then-write race in the caller.
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
    // The postgres-js driver's own result for a write with no `.returning()`
    // exposes the affected-row count as `.count` — NOT `.rowCount`, which is
    // the node-postgres driver's name for the same concept and does not
    // exist on this type (verified against
    // node_modules/postgres/types/index.d.ts's `ResultMeta`/`RowList`, and
    // node_modules/drizzle-orm/postgres-js/session.d.ts's
    // `PostgresJsQueryResultHKT`).
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
    // See markAllRead's own comment: `.count`, not `.rowCount`.
    return result.count > 0
  }

  /**
   * Delete up to `limit` notifications read before `cutoff`.
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
      .limit(limit)
    const result = await tx.delete(notificationModel).where(inArray(notificationModel.id, batch))
    return result.count
  }

  /**
   * Delete up to `limit` unread notifications created before `cutoff`.
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
      .limit(limit)
    const result = await tx.delete(notificationModel).where(inArray(notificationModel.id, batch))
    return result.count
  }
}
