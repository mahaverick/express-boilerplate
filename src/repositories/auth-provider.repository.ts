/**
 * @file Query access to `auth_providers`. It does not extend `BaseRepository`,
 * which requires a `deletedAt` column this table has no use for; `create`
 * translates a 23505 into a 409 by hand instead.
 */
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import type { AuthProvider } from '@/constants/auth-provider.constants'
import {
  authProviderModel,
  type AuthProviderRecord,
  type NewAuthProvider,
} from '@/database/models/auth-provider.model'
import { userModel } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { isUniqueViolation } from '@/errors/postgres-errors'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * Query access to the `auth_providers` table: look up the one row for a
 * given external identity, list every auth method a user has, and link a
 * new one.
 */
export class AuthProviderRepository {
  /**
   * Find the row for one external identity within one provider's
   * namespace — the lookup google-auth.service's findOrCreateByGoogle makes
   * first, before deciding whether to create a new link or a new user.
   * @param provider - Which auth method to look up.
   * @param providerId - The external identity within that provider's namespace (an email address for `'email'`, Google's profile id for `'google'`).
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching row, or undefined when no user has linked this identity yet.
   */
  async findByProviderAndId(
    provider: AuthProvider,
    providerId: string,
    executor: DbExecutor = db
  ): Promise<AuthProviderRecord | undefined> {
    const [row] = await executor
      .select()
      .from(authProviderModel)
      .where(
        and(eq(authProviderModel.provider, provider), eq(authProviderModel.providerId, providerId))
      )
    return row
  }

  /**
   * Every auth method one user has — e.g. an `'email'` row and a `'google'`
   * row for an account that has linked both.
   * @param userId - The user whose provider rows to fetch.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns All matching rows, in no particular guaranteed order.
   */
  async findByUser(userId: string, executor: DbExecutor = db): Promise<AuthProviderRecord[]> {
    return executor.select().from(authProviderModel).where(eq(authProviderModel.userId, userId))
  }

  /**
   * Link one auth method to one user.
   *
   * Translates a 23505 on `(provider, providerId)` into `HttpError(409)`, as
   * `BaseRepository.create` does. A caller that loses a race to link the same
   * identity should treat it as "already linked" and re-fetch with
   * `findByProviderAndId`.
   * @param data - The row's initial column values.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, including its generated `id` and timestamps.
   */
  async create(data: NewAuthProvider, executor: DbExecutor = db): Promise<AuthProviderRecord> {
    try {
      const [row] = await executor.insert(authProviderModel).values(data).returning()
      if (row === undefined) throw new HttpError('Insert returned no row', 500)
      return row
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError('This account is already linked', 409)
      }
      throw error
    }
  }

  /**
   * Free an email address for a new account by deleting the `'email'`
   * provider row that still names it, only when that row's user is
   * soft-deleted. The `(provider, provider_id)` unique index would
   * otherwise block the new account's own `'email'` row. A live user's row
   * is never touched, and a deleted user's `'google'` row is kept.
   * @param email - The lowercased address being claimed.
   * @param executor - The claiming transaction.
   * @returns How many rows were deleted (0 or 1).
   */
  async releaseEmailOfDeletedUsers(email: string, executor: DbExecutor = db): Promise<number> {
    const deletedUserIds = executor
      .select({ id: userModel.id })
      .from(userModel)
      .where(isNotNull(userModel.deletedAt))
    const result = await executor
      .delete(authProviderModel)
      .where(
        and(
          eq(authProviderModel.provider, 'email'),
          eq(authProviderModel.providerId, email),
          inArray(authProviderModel.userId, deletedUserIds)
        )
      )
    return result.count
  }

  /**
   * Delete every federated (non-`'email'`) provider row linked to a user,
   * keeping the `'email'` row, since every live user has one (see
   * auth-provider.model.ts).
   * @param userId - The user whose federated provider rows are deleted.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Resolves once the rows are gone.
   */
  async deleteFederatedForUser(userId: string, executor: DbExecutor = db): Promise<void> {
    await executor
      .delete(authProviderModel)
      .where(and(eq(authProviderModel.userId, userId), ne(authProviderModel.provider, 'email')))
  }

  /**
   * Delete a user's Google links other than one, keeping every non-Google row.
   * @param userId - The user whose Google links are pruned.
   * @param googleId - The one Google profile id to keep.
   * @param executor - The pool or a caller's transaction.
   * @returns Resolves once the other links are gone.
   */
  async deleteGoogleLinksExcept(
    userId: string,
    googleId: string,
    executor: DbExecutor = db
  ): Promise<void> {
    await executor
      .delete(authProviderModel)
      .where(
        and(
          eq(authProviderModel.userId, userId),
          eq(authProviderModel.provider, 'google'),
          ne(authProviderModel.providerId, googleId)
        )
      )
  }

  /**
   * Link one auth method unless `(provider, providerId)` is already linked.
   * @param data - The row's column values.
   * @param executor - The pool or a caller's transaction.
   * @returns Resolves once the row exists, inserted now or earlier.
   */
  async createIfAbsent(data: NewAuthProvider, executor: DbExecutor = db): Promise<void> {
    await executor.insert(authProviderModel).values(data).onConflictDoNothing()
  }
}
