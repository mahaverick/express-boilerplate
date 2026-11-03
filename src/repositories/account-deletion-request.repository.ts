/**
 * @file Query access to `account_deletion_requests`, and to the platform
 * admins a new request alerts. It does not extend `BaseRepository`: a
 * request is never soft-deleted.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import {
  accountDeletionRequestModel,
  type AccountDeletionRequest,
} from '@/database/models/account-deletion-request.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel, type User } from '@/database/models/user.model'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * A platform admin as a deletion alert addresses them.
 */
type AccountDeletionRecipient = Pick<User, 'id' | 'email' | 'firstName'>

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
   * The live, active platform admins other than `exceptUserId`: who a new
   * request alerts. Owners are left out, as the alert is for the staff who
   * complete requests, and so is an admin who asked to delete their own
   * account.
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
          eq(userMembershipModel.role, 'admin'),
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
