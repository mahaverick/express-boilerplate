// src/repositories/auth-provider.repository.ts
//
// Deliberately does NOT extend BaseRepository — but NOT because the 23505
// concern BaseRepository exists to handle doesn't apply here. It does: see
// `create` below. The only reason this class can't extend it is that
// `auth_providers` has `updatedAt` but no `deletedAt`
// (`SoftDeletableTableConfig`, base.repository.ts, requires both), and this
// table has no soft-delete concept to justify adding one — an unlinked
// provider (were that ever built) would be a hard delete, same as
// email-log.repository.ts's audit rows.
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
   * namespace — the lookup Task 3's Google callback makes first, before
   * deciding whether to create a new link or a new user.
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
   * Translates a 23505 on `(provider, providerId)` into `HttpError(409)`
   * rather than letting the raw driver error escape — the same translation
   * `BaseRepository.create` gives every table that extends it, applied by
   * hand here since this table cannot (see this file's header comment). A
   * caller that hits this (e.g. Task 3's callback losing a race between
   * `findByProviderAndId` and this insert for the same not-yet-linked
   * Google account) should treat it as "already linked" and re-fetch via
   * `findByProviderAndId`, not as an unexpected failure.
   * @param data - The row's initial column values.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, including its generated `id` and timestamps.
   */
  async create(data: NewAuthProvider, executor: DbExecutor = db): Promise<AuthProviderRecord> {
    try {
      const [row] = await executor.insert(authProviderModel).values(data).returning()
      // db.insert(...).values(one object).returning() always returns exactly
      // one row when the insert does not throw; the driver's own types just
      // cannot express "same length as input" for a single-row insert —
      // same reasoning as UserRepository.insertOne (user.repository.ts).
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
   * keeping the `'email'` row — the invariant every live user has one relies on
   * (auth-provider.model.ts's own header comment).
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
