/**
 * @file Query access to `user_passkeys`. It does not extend `BaseRepository`,
 * which requires a `deletedAt` column this table has no use for.
 */
import { and, asc, count, eq, lt, or } from 'drizzle-orm'
import {
  userPasskeyModel,
  type NewUserPasskey,
  type UserPasskeyRecord,
} from '@/database/models/user-passkey.model'
import { HttpError } from '@/errors/http-error'
import { isUniqueViolation } from '@/errors/postgres-errors'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * Query access to the `user_passkeys` table: register, look up, list, rename,
 * delete and record the use of a user's passkeys. Every write that targets a
 * row by `id` also filters by `userId`, so one user can never touch another's.
 */
export class UserPasskeyRepository {
  /**
   * Store a new passkey.
   *
   * Translates a 23505 on `credential_id` into `HttpError(409)`.
   * @param row - The row's column values.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, including its generated `id` and timestamps.
   */
  async create(row: NewUserPasskey, executor: DbExecutor = db): Promise<UserPasskeyRecord> {
    try {
      const [created] = await executor.insert(userPasskeyModel).values(row).returning()
      if (created === undefined) throw new HttpError('Insert returned no row', 500)
      return created
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(
          'This passkey is already saved. Create a new one.',
          409,
          'PASSKEY_EXISTS'
        )
      }
      throw error
    }
  }

  /**
   * Find a passkey by its credential ID.
   * @param credentialId - The base64url credential ID.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when no passkey has this credential ID.
   */
  async findByCredentialId(
    credentialId: string,
    executor: DbExecutor = db
  ): Promise<UserPasskeyRecord | undefined> {
    const [row] = await executor
      .select()
      .from(userPasskeyModel)
      .where(eq(userPasskeyModel.credentialId, credentialId))
    return row
  }

  /**
   * Every passkey a user has, oldest first.
   * @param userId - The owner.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The user's rows, ordered by creation time then id.
   */
  async listByUser(userId: string, executor: DbExecutor = db): Promise<UserPasskeyRecord[]> {
    return executor
      .select()
      .from(userPasskeyModel)
      .where(eq(userPasskeyModel.userId, userId))
      .orderBy(asc(userPasskeyModel.createdAt), asc(userPasskeyModel.id))
  }

  /**
   * How many passkeys a user has.
   * @param userId - The owner.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The count.
   */
  async countByUser(userId: string, executor: DbExecutor = db): Promise<number> {
    const [row] = await executor
      .select({ total: count() })
      .from(userPasskeyModel)
      .where(eq(userPasskeyModel.userId, userId))
    return row?.total ?? 0
  }

  /**
   * Rename a passkey the user owns.
   * @param id - The passkey's row ID.
   * @param userId - The caller; a row owned by anyone else is not matched.
   * @param name - The new name.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when the user owns no such passkey.
   */
  async rename(
    id: string,
    userId: string,
    name: string,
    executor: DbExecutor = db
  ): Promise<UserPasskeyRecord | undefined> {
    const [row] = await executor
      .update(userPasskeyModel)
      .set({ name })
      .where(and(eq(userPasskeyModel.id, id), eq(userPasskeyModel.userId, userId)))
      .returning()
    return row
  }

  /**
   * Delete a passkey the user owns.
   * @param id - The passkey's row ID.
   * @param userId - The caller; a row owned by anyone else is not matched.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The deleted row, or undefined when the user owns no such passkey.
   */
  async deleteForUser(
    id: string,
    userId: string,
    executor: DbExecutor = db
  ): Promise<UserPasskeyRecord | undefined> {
    const [row] = await executor
      .delete(userPasskeyModel)
      .where(and(eq(userPasskeyModel.id, id), eq(userPasskeyModel.userId, userId)))
      .returning()
    return row
  }

  /**
   * Delete every passkey a user holds.
   * @param userId - The owner.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns How many rows were deleted.
   */
  async deleteAllForUser(userId: string, executor: DbExecutor = db): Promise<number> {
    const deleted = await executor
      .delete(userPasskeyModel)
      .where(eq(userPasskeyModel.userId, userId))
      .returning({ id: userPasskeyModel.id })
    return deleted.length
  }

  /**
   * Record a successful use of a passkey. The signature-counter rule is in the
   * UPDATE's WHERE, so two parallel assertions with the same count cannot both
   * win on a device-bound passkey: a synced (backup-eligible) passkey, a
   * stored count of 0 or a higher new count updates; anything else changes
   * nothing. The write matches the owner too, so a row a claim deleted (or
   * that never was this user's) changes nothing.
   * @param id - The passkey's row ID.
   * @param userId - The owner the caller verified it for.
   * @param use - The new signature counter, the new backup state and when it happened.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns `recorded` when the row was updated; `regressed` when the row exists but the counter rule refused it; `missing` when no such row exists for that user.
   */
  async recordUse(
    id: string,
    userId: string,
    use: { signCount: number; backupState: boolean; at: Date },
    executor: DbExecutor = db
  ): Promise<'recorded' | 'regressed' | 'missing'> {
    const owned = and(eq(userPasskeyModel.id, id), eq(userPasskeyModel.userId, userId))
    const counterAllows = or(
      eq(userPasskeyModel.backupEligible, true),
      eq(userPasskeyModel.signCount, 0),
      lt(userPasskeyModel.signCount, use.signCount)
    )
    const updated = await executor
      .update(userPasskeyModel)
      .set({ signCount: use.signCount, backupState: use.backupState, lastUsedAt: use.at })
      .where(and(owned, counterAllows))
      .returning({ id: userPasskeyModel.id })
    if (updated.length > 0) return 'recorded'
    const [still] = await executor
      .select({ id: userPasskeyModel.id })
      .from(userPasskeyModel)
      .where(owned)
    return still === undefined ? 'missing' : 'regressed'
  }
}
