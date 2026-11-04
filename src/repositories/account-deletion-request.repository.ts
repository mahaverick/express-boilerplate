/**
 * @file Query access to `account_deletion_requests`, and to the platform
 * owners and admins a request alerts. It does not extend `BaseRepository`: a
 * request is never soft-deleted.
 */
import { and, asc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import {
  accountDeletionRequestModel,
  type AccountDeletionRequest,
} from '@/database/models/account-deletion-request.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel, type User } from '@/database/models/user.model'
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
 * A platform owner or admin as a deletion alert addresses them.
 */
type AccountDeletionRecipient = Pick<User, 'id' | 'email' | 'firstName'>

/**
 * One open request as the staff list reads it, with the requester's identity.
 */
export interface OpenDeletionRequestRow {
  id: string
  requestedAt: Date
  dueAt: Date
  reason: string | null
  user: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'>
}

/**
 * The staff list of open deletion requests, searched by the requester's
 * email. Only `status = 'open'` rows are listed, so the partial
 * `account_deletion_requests_open_due_sort_idx` serves the `due` sort.
 * @param search - The parsed search, or undefined.
 * @returns The list definition.
 */
export function openDeletionRequestList(search: string | undefined) {
  return defineList({
    name: 'platform-deletion-requests',
    base: (executor, seek) =>
      executor
        .select({
          id: accountDeletionRequestModel.id,
          requestedAt: accountDeletionRequestModel.requestedAt,
          dueAt: accountDeletionRequestModel.dueAt,
          reason: accountDeletionRequestModel.reason,
          userId: userModel.id,
          email: userModel.email,
          firstName: userModel.firstName,
          lastName: userModel.lastName,
          sortDue: timestampKey(accountDeletionRequestModel.dueAt),
        })
        .from(accountDeletionRequestModel)
        .innerJoin(userModel, eq(accountDeletionRequestModel.userId, userModel.id))
        .where(
          and(
            eq(accountDeletionRequestModel.status, 'open'),
            searchCondition(search, [sql`lower(${userModel.email})`]),
            seek
          )
        )
        .$dynamic(),
    id: accountDeletionRequestModel.id,
    sorts: {
      due: [timestampSort(accountDeletionRequestModel.dueAt, 'asc', 'sortDue')],
      '-due': [timestampSort(accountDeletionRequestModel.dueAt, 'desc', 'sortDue')],
    },
    toItem: ({
      sortDue: _due,
      userId,
      email,
      firstName,
      lastName,
      ...rest
    }): OpenDeletionRequestRow => ({
      ...rest,
      user: { id: userId, email, firstName, lastName },
    }),
  })
}

/**
 * Query access to `account_deletion_requests`.
 */
class AccountDeletionRequestRepository {
  /**
   * Open a request for a user unless one is open already:
   * `account_deletion_requests_open_unique` makes a second a no-op. No
   * conflict target is named, because that index is partial. `requested_at`
   * and `due_at` come from the one `now()` of the statement, so the gap is
   * exactly `days` times 24 hours, whatever the session time zone.
   * @param userId - The customer.
   * @param reason - Why they are leaving, or null.
   * @param days - Days from now the deletion is due.
   * @param tx - The request's transaction.
   * @returns The inserted row, or undefined when a request was already open.
   */
  async insertOpen(
    userId: string,
    reason: string | null,
    days: number,
    tx: DbTransaction
  ): Promise<AccountDeletionRequest | undefined> {
    const [inserted] = await tx
      .insert(accountDeletionRequestModel)
      .values({
        userId,
        reason,
        requestedAt: sql`now()`,
        // Seconds, not days: a day interval follows the session time zone and gains or loses an hour across a DST change.
        dueAt: sql`now() + make_interval(secs => ${days * 86_400}::int)`,
      })
      .onConflictDoNothing()
      .returning()
    return inserted
  }

  /**
   * A user's open request.
   * @param userId - The customer.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when none is open.
   */
  async findOpen(
    userId: string,
    executor: DbExecutor = db
  ): Promise<AccountDeletionRequest | undefined> {
    const [row] = await executor
      .select()
      .from(accountDeletionRequestModel)
      .where(
        and(
          eq(accountDeletionRequestModel.userId, userId),
          eq(accountDeletionRequestModel.status, 'open')
        )
      )
    return row
  }

  /**
   * Complete a user's open request, if one is open: the staff delete's step,
   * after the user row is soft-deleted. `completed_at` is the transaction's
   * `now()`, so it equals the user's `deleted_at`.
   * @param userId - The deleted user.
   * @param tx - The delete's transaction.
   * @returns True when a request was open and is now completed.
   */
  async completeOpenFor(userId: string, tx: DbTransaction): Promise<boolean> {
    const completed = await tx
      .update(accountDeletionRequestModel)
      .set({ status: 'completed', completedAt: sql`now()` })
      .where(
        and(
          eq(accountDeletionRequestModel.userId, userId),
          eq(accountDeletionRequestModel.status, 'open')
        )
      )
      .returning({ id: accountDeletionRequestModel.id })
    return completed.length > 0
  }

  /**
   * The open requests due at or before `dueBy`, overdue ones included,
   * soonest first: what the due-soon alert reads.
   * @param dueBy - The end of the window.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows.
   */
  async listOpenDueBy(dueBy: Date, executor: DbExecutor = db): Promise<AccountDeletionRequest[]> {
    return executor
      .select()
      .from(accountDeletionRequestModel)
      .where(
        and(
          eq(accountDeletionRequestModel.status, 'open'),
          lte(accountDeletionRequestModel.dueAt, dueBy)
        )
      )
      .orderBy(asc(accountDeletionRequestModel.dueAt), asc(accountDeletionRequestModel.id))
  }

  /**
   * One page of the open requests, soonest due first unless the sort says otherwise.
   * @param params - The parsed shared list params.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async listOpen(
    params: ListParams,
    executor: DbExecutor = db
  ): Promise<ListPage<OpenDeletionRequestRow>> {
    return listPage(executor, openDeletionRequestList(params.search), params)
  }

  /**
   * Delete every request of a user, open or completed: the user purge's
   * step, since the foreign key is RESTRICT.
   * @param userId - The purged user.
   * @param tx - The purge's transaction.
   */
  async deleteForUser(userId: string, tx: DbTransaction): Promise<void> {
    await tx
      .delete(accountDeletionRequestModel)
      .where(eq(accountDeletionRequestModel.userId, userId))
  }

  /**
   * The live, active platform owners and admins other than `exceptUserId`:
   * who a request alerts. Both roles can complete a request through the staff
   * delete, as `listMaintenanceModeNoticeRecipients` reads them. A member of
   * staff who asked to delete their own account is left out.
   * @param exceptUserId - The customer who made the request.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Their ids, addresses and first names, in no guaranteed order.
   */
  async listAccountDeletionRecipients(
    exceptUserId: string,
    executor: DbExecutor = db
  ): Promise<AccountDeletionRecipient[]> {
    return executor
      .select({ id: userModel.id, email: userModel.email, firstName: userModel.firstName })
      .from(userMembershipModel)
      .innerJoin(tenantModel, eq(userMembershipModel.tenantId, tenantModel.id))
      .innerJoin(userModel, eq(userMembershipModel.userId, userModel.id))
      .where(
        and(
          eq(tenantModel.isPlatform, true),
          inArray(userMembershipModel.role, ['owner', 'admin']),
          isNull(userModel.deletedAt),
          eq(userModel.active, true),
          ne(userModel.id, exceptUserId)
        )
      )
  }
}

/**
 * The one `AccountDeletionRequestRepository`.
 */
export const accountDeletionRequestRepository = new AccountDeletionRequestRepository()
