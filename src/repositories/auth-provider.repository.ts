// src/repositories/auth-provider.repository.ts
//
// Deliberately does NOT extend BaseRepository — but NOT because the 23505
// concern BaseRepository exists to handle doesn't apply here. It does: see
// `create` below. The only reason this class can't extend it is that
// `auth_providers` has `updatedAt` but no `deletedAt`
// (`SoftDeletableTableConfig`, base.repository.ts, requires both), and this
// table has no soft-delete concept to justify adding one — an unlinked
// provider (were that ever built) would be a hard delete, same as
// email-log.repository.ts's audit rows. `isUniqueViolation` below is a
// deliberate copy of base.repository.ts's private helper of the same name,
// not an import: that function is module-private there by design (its own
// comment: "the driver-level detail this file exists to keep out of every
// caller"), so a table that cannot extend the class it belongs to
// re-implements the three-line check rather than exporting an internal.
import { and, DrizzleQueryError, eq, ne } from 'drizzle-orm'
import postgres from 'postgres'
import type { AuthProvider } from '@/constants/auth-provider.constants'
import {
  authProviderModel,
  type AuthProviderRecord,
  type NewAuthProvider,
} from '@/database/models/auth-provider.model'
import { HttpError } from '@/middlewares/error.middleware'
import { db } from '@/services/database.service'

// Postgres error code for a unique-constraint violation. Same source and
// same value as base.repository.ts's own — see that file's comment for the
// PostgreSQL docs reference.
const UNIQUE_VIOLATION_CODE = '23505'

/**
 * Whether an error thrown by `create` is a Postgres unique-constraint
 * violation — i.e. `auth_providers_provider_provider_id_unique`
 * (auth-provider.model.ts) already has a row for this `(provider,
 * providerId)` pair. A real race, not a theoretical one: Task 3's Google
 * callback does `findByProviderAndId` then `create` with no lock between
 * them, so two requests for the same not-yet-linked Google account (e.g. a
 * double-submitted callback) can both pass the lookup and race the insert.
 * See this file's header comment for why this duplicates
 * base.repository.ts's identically-named private function instead of
 * importing it.
 * @param error - The error thrown by the insert.
 * @returns True when the error is (or wraps) a 23505 unique violation.
 */
function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error
  return cause instanceof postgres.PostgresError && cause.code === UNIQUE_VIOLATION_CODE
}

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
   * @returns The matching row, or undefined when no user has linked this identity yet.
   */
  async findByProviderAndId(
    provider: AuthProvider,
    providerId: string
  ): Promise<AuthProviderRecord | undefined> {
    const [row] = await db
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
   * @returns All matching rows, in no particular guaranteed order.
   */
  async findByUser(userId: string): Promise<AuthProviderRecord[]> {
    return db.select().from(authProviderModel).where(eq(authProviderModel.userId, userId))
  }

  /**
   * Link one auth method to one user.
   *
   * Translates a 23505 on `(provider, providerId)` into `HttpError(409)`
   * rather than letting the raw driver error escape — the same translation
   * `BaseRepository.create` gives every table that extends it, applied by
   * hand here since this table cannot (see this file's header comment). A
   * caller that hits this (e.g. Task 3's callback losing the race described
   * on `isUniqueViolation`) should treat it as "already linked" and
   * re-fetch via `findByProviderAndId`, not as an unexpected failure.
   * @param data - The row's initial column values.
   * @returns The inserted row, including its generated `id` and timestamps.
   */
  async create(data: NewAuthProvider): Promise<AuthProviderRecord> {
    try {
      const [row] = await db.insert(authProviderModel).values(data).returning()
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
   * Delete every federated (non-`'email'`) provider row linked to a user,
   * keeping the `'email'` row — the invariant every user has one relies on
   * (auth-provider.model.ts's own header comment).
   * @param userId - The user whose federated provider rows are deleted.
   * @returns Resolves once the rows are gone.
   */
  async deleteFederatedForUser(userId: string): Promise<void> {
    await db
      .delete(authProviderModel)
      .where(and(eq(authProviderModel.userId, userId), ne(authProviderModel.provider, 'email')))
  }
}
