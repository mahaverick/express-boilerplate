// src/repositories/user.repository.ts
//
// findByEmail deliberately does not use `eq(userModel.email, email)`. The
// table's uniqueness guarantee is a `lower(email)` index (see the model's
// own header comment), not a plain unique index on `email` — an exact-match
// lookup here would accept "a@x.com" and "A@x.com" as two different users,
// then fail to find either one deterministically the moment a caller (e.g.
// login) queries with whichever casing the OTHER row happened to be stored
// in. Matching with `lower(...) = lower(...)` is what keeps this lookup
// unable to disagree with what the index itself considers a duplicate.
//
// The four `protected` primitives below (selectOne/insertOne/updateOne/
// markDeleted) are this table's half of BaseRepository's template method —
// see that file's header comment for why the actual `db.select()/.insert()/
// .update()` calls live here, against the concrete `userModel`, rather than
// in the generic base class.
import { sql, type SQL } from 'drizzle-orm'
import { userModel, type User } from '@/database/models/user.model'
import { HttpError } from '@/middlewares/error.middleware'
import {
  BaseRepository,
  type SoftDeleteOptions,
  type Touched,
} from '@/repositories/base.repository'
import { db } from '@/services/database.service'

/**
 * Query access to the `users` table: lookup by id or email, creation,
 * update, and soft-delete. Every lookup excludes a soft-deleted user by
 * default — see `BaseRepository.scope`, which `findByEmail` below is built
 * on so it can never drift from `findById`'s soft-delete behaviour.
 */
export class UserRepository extends BaseRepository<(typeof userModel)['_']['config']> {
  /**
   * Build a repository bound to the `users` table.
   */
  constructor() {
    super(userModel)
  }

  /**
   * Find a user by email, case-insensitively. With `includeDeleted`, a
   * deleted and a live row can share an address; which one is returned is
   * then unspecified.
   * @param email - The email to search for, in any case.
   * @param options - Soft-delete visibility options.
   * @returns The matching user, or undefined when none exists — including when it exists but is soft-deleted and `includeDeleted` was not set.
   */
  findByEmail(email: string, options: SoftDeleteOptions = {}): Promise<User | undefined> {
    return this.selectOne(this.scope(sql`lower(${userModel.email}) = lower(${email})`, options))
  }

  /**
   * Mark a user's email verified, once. The `email_verified_at is null`
   * predicate is what makes this idempotent in the database rather than in
   * a caller's read-then-write: a second valid token, or two tabs
   * submitting the same one, must not move a timestamp that already
   * records when the mailbox was first proven.
   * @param id - The user's id.
   * @returns The updated row, or undefined when the user does not exist or was already verified.
   */
  markEmailVerified(id: string): Promise<User | undefined> {
    return this.updateOne(
      this.scope(sql`${userModel.id} = ${id} and ${userModel.emailVerifiedAt} is null`),
      this.touched({ emailVerifiedAt: new Date() })
    )
  }

  /**
   * Select the single user matching a condition.
   * @param where - The condition to match, or undefined to match every row.
   * @returns The matching user, or undefined when none exists.
   */
  protected async selectOne(where: SQL | undefined): Promise<User | undefined> {
    const [row] = await db.select().from(userModel).where(where).limit(1)
    return row
  }

  /**
   * Insert a single user.
   * @param values - The row's initial column values.
   * @returns The inserted user.
   */
  protected async insertOne(values: typeof userModel.$inferInsert): Promise<User> {
    const [row] = await db.insert(userModel).values(values).returning()
    // db.insert(...).values(one object).returning() always returns exactly
    // one row when the insert does not throw; the driver's own types just
    // cannot express "same length as input" for a single-row insert.
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * Update the single user matching a condition.
   * @param where - The condition to match, already scoped for soft-delete visibility.
   * @param values - The columns to change, already carrying `updatedAt`.
   * @returns The updated user, or undefined when no matching row exists.
   */
  protected async updateOne(
    where: SQL | undefined,
    values: Touched<Partial<Omit<typeof userModel.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>>>
  ): Promise<User | undefined> {
    const [row] = await db.update(userModel).set(values).where(where).returning()
    return row
  }

  /**
   * Set `deletedAt` on the single user matching a condition.
   * @param where - The condition to match, already scoped to not-yet-deleted rows.
   * @returns The updated user, or undefined when no matching row exists.
   */
  protected async markDeleted(where: SQL | undefined): Promise<User | undefined> {
    const [row] = await db
      .update(userModel)
      .set(this.touched({ deletedAt: sql`now()` }))
      .where(where)
      .returning()
    return row
  }
}
