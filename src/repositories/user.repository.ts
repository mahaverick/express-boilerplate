/**
 * @file Query access to `users`, on `BaseRepository`.
 */
import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm'
import { userModel, type User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import {
  BaseRepository,
  type SoftDeleteOptions,
  type Touched,
} from '@/repositories/base.repository'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * Query access to the `users` table: lookup by id or email, creation,
 * update, soft-delete, and the purge of a soft-deleted user. Lookups by id or
 * email exclude a soft-deleted user by default: `findByEmail` is built on
 * `BaseRepository.scope`, so it cannot drift from `findById`'s behaviour.
 */
export class UserRepository extends BaseRepository<(typeof userModel)['_']['config']> {
  /**
   * Build a repository bound to the `users` table.
   */
  constructor() {
    super(userModel)
  }

  /**
   * Find a user by email, case-insensitively: uniqueness is a `lower(email)`
   * index, so an exact match could treat `a@x.com` and `A@x.com` as two users
   * and miss whichever casing was stored. With `includeDeleted`, a
   * deleted and a live row can share an address; which one is returned is
   * then unspecified.
   * @param email - The email to search for, in any case.
   * @param options - Soft-delete visibility options.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching user, or undefined when none exists — including when it exists but is soft-deleted and `includeDeleted` was not set.
   */
  findByEmail(
    email: string,
    options: SoftDeleteOptions = {},
    executor: DbExecutor = db
  ): Promise<User | undefined> {
    return this.selectOne(
      this.scope(sql`lower(${userModel.email}) = lower(${email})`, options),
      executor
    )
  }

  /**
   * Find several users by id in one query, in no particular order.
   * @param ids - The ids; an empty list reads nothing.
   * @param options - Soft-delete visibility options.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The users found; an id with no visible row is left out.
   */
  async findManyByIds(
    ids: readonly string[],
    options: SoftDeleteOptions = {},
    executor: DbExecutor = db
  ): Promise<User[]> {
    if (ids.length === 0) return []
    const condition = this.scope(inArray(userModel.id, [...ids]), options)
    return executor.select().from(userModel).where(condition)
  }

  /**
   * Mark a user's email verified, once.
   * Call it through account-claim.service.ts's `markEmailVerified`, never directly.
   * The `email_verified_at is null` predicate is what makes this idempotent
   * in the database rather than in a caller's read-then-write: a second
   * valid token, or two tabs submitting the same one, must not move a
   * timestamp that already records when the mailbox was first proven.
   * @param id - The user's id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when the user does not exist or was already verified.
   */
  markEmailVerified(id: string, executor: DbExecutor = db): Promise<User | undefined> {
    return this.updateOne(
      this.scope(sql`${userModel.id} = ${id} and ${userModel.emailVerifiedAt} is null`),
      this.touched({ emailVerifiedAt: new Date() }),
      executor
    )
  }

  /**
   * Find a live user by id and lock the row until the transaction ends.
   * `'no key update'` is for an account claim, logout and the refresh
   * kills, and still lets inserts that reference the user through.
   * `'share'` is for a sign-in's re-read of the account, a refresh
   * rotation, or a write that makes the user a tenant owner or platform
   * staff (`lockUserForOwnership`), which wait for that write and let each other
   * through; a single-statement update of the row (last login, a profile
   * edit, verification) waits for a `'share'` holder to commit. `'key share'`
   * is the lock a foreign-key check takes, taken first by a write that will
   * reference the user from a row locked later in the lock order (the
   * billing cancel marker).
   * @param id - The user's id.
   * @param mode - The lock strength.
   * @param tx - The transaction to hold the lock in. Required: on the pool, the lock would release as soon as the statement finished.
   * @returns The locked user, or undefined when none exists or it is soft-deleted.
   */
  async lockById(
    id: string,
    mode: 'no key update' | 'share' | 'key share',
    tx: DbTransaction
  ): Promise<User | undefined> {
    const [row] = await tx
      .select()
      .from(userModel)
      .where(this.scope(eq(userModel.id, id)))
      .limit(1)
      .for(mode)
    return row
  }

  /**
   * Select the single user matching a condition.
   * @param where - The condition to match, or undefined to match every row.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching user, or undefined when none exists.
   */
  protected async selectOne(
    where: SQL | undefined,
    executor: DbExecutor = db
  ): Promise<User | undefined> {
    const [row] = await executor.select().from(userModel).where(where).limit(1)
    return row
  }

  /**
   * Insert a single user.
   * @param values - The row's initial column values.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted user.
   */
  protected async insertOne(
    values: typeof userModel.$inferInsert,
    executor: DbExecutor = db
  ): Promise<User> {
    const [row] = await executor.insert(userModel).values(values).returning()
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * Update the single user matching a condition.
   * @param where - The condition to match, already scoped for soft-delete visibility.
   * @param values - The columns to change, already carrying `updatedAt`.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated user, or undefined when no matching row exists.
   */
  protected async updateOne(
    where: SQL | undefined,
    values: Touched<Partial<Omit<typeof userModel.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>>>,
    executor: DbExecutor = db
  ): Promise<User | undefined> {
    const [row] = await executor.update(userModel).set(values).where(where).returning()
    return row
  }

  /**
   * Set `deletedAt` on the single user matching a condition.
   * @param where - The condition to match, already scoped to not-yet-deleted rows.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated user, or undefined when no matching row exists.
   */
  protected async markDeleted(
    where: SQL | undefined,
    executor: DbExecutor = db
  ): Promise<User | undefined> {
    const [row] = await executor
      .update(userModel)
      .set(this.touched({ deletedAt: sql`now()` }))
      .where(where)
      .returning()
    return row
  }

  /**
   * Permanently delete a user who is already soft-deleted. Rows that
   * reference the user cascade or are set null by their foreign keys, except
   * `audit_logs.actor_user_id` (RESTRICT): redact it first.
   * @param id - The user.
   * @param tx - The purge's transaction.
   * @returns True when a soft-deleted row was deleted.
   */
  async purgeDeleted(id: string, tx: DbTransaction): Promise<boolean> {
    const rows = await tx
      .delete(userModel)
      .where(and(eq(userModel.id, id), isNotNull(userModel.deletedAt)))
      .returning({ id: userModel.id })
    return rows.length > 0
  }
}
