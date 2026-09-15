// src/repositories/user-token.repository.ts
//
// The four `protected` primitives below (selectOne/insertOne/updateOne/
// markDeleted) are this table's half of BaseRepository's template method —
// see base.repository.ts's header comment for why the actual
// `db.select()/.insert()/.update()` calls live here, against the concrete
// `userTokenModel`, rather than in the generic base class.
//
// `claimOnce` exists to close a race any single-use-token redemption would
// otherwise have — originally written for `rotateRefreshToken`
// (token.utilities.ts), and generalised here to every purpose
// (user-token.model.ts's `TokenPurpose`): a plain "read, check revokedAt,
// then write" sequence lets two concurrent presentations of the same raw
// token both observe `revokedAt IS NULL` and both proceed, defeating reuse
// detection (for a refresh token) or double-spending (for a verification or
// reset token) entirely. `claimOnce` instead does the check and the write in
// one statement — `UPDATE ... WHERE token_hash = $1 AND purpose = $2 AND
// revoked_at IS NULL RETURNING *` — so Postgres itself decides which single
// caller (if any) "wins" the claim; only that caller ever sees a defined
// result. The `purpose` predicate is what stops a token minted for one
// purpose from being claimed as another: it participates in the SAME atomic
// statement as the revocation check, not a separate lookup a caller could
// perform race-free but forget to.
import { eq, sql, type SQL } from 'drizzle-orm'
import {
  userTokenModel,
  type NewUserToken,
  type TokenPurpose,
  type UserToken,
} from '@/database/models/user-token.model'
import { HttpError } from '@/middlewares/error.middleware'
import {
  BaseRepository,
  type SoftDeleteOptions,
  type Touched,
} from '@/repositories/base.repository'
import { db } from '@/services/database.service'

/**
 * Query access to the `user_tokens` table: token issuance, lookup by hash,
 * atomic single-use claiming (`claimOnce`), and bulk revocation by session
 * or by user. Every lookup excludes a soft-deleted row by default — see
 * `BaseRepository.scope`, which every method below is built on so none of
 * them can drift from that behaviour independently.
 */
export class UserTokenRepository extends BaseRepository<(typeof userTokenModel)['_']['config']> {
  /**
   * Build a repository bound to the `user_tokens` table.
   */
  constructor() {
    super(userTokenModel)
  }

  /**
   * Find a token row by its hash, regardless of purpose.
   * @param tokenHash - The SHA-256 hash of the raw token, hex-encoded.
   * @param options - Soft-delete visibility options.
   * @returns The matching row, or undefined when none exists.
   */
  findByHash(tokenHash: string, options: SoftDeleteOptions = {}): Promise<UserToken | undefined> {
    return this.selectOne(this.scope(eq(userTokenModel.tokenHash, tokenHash), options))
  }

  /**
   * Atomically claim a not-yet-revoked token row of one purpose: sets
   * `revokedAt` and `consumedAt`, and returns the row, but only if it was
   * still live, for that exact purpose, the instant this statement ran. A
   * second, concurrent call for the same hash — including a genuine reuse
   * attempt racing a legitimate rotation, or a claim for the wrong purpose —
   * gets undefined, never the same row twice.
   *
   * `revokedAt` and `consumedAt` are set together, but mean different
   * things: `revokedAt IS NULL` is the one fact every caller checks to
   * decide "is this row still claimable" (see this file's header comment);
   * `consumedAt` is set ONLY here, so it distinguishes a row spent through
   * this normal single-use path from one killed by an explicit revoke
   * (`revokeAllForSession`/`revokeAllForUser`, below), which sets
   * `revokedAt` alone.
   * @param tokenHash - The SHA-256 hash of the raw token, hex-encoded.
   * @param purpose - The purpose the token must have been issued for; a row that exists but for a different purpose is left untouched and this resolves undefined, exactly as if no row matched at all.
   * @returns The now-claimed row (its pre-claim `expiresAt`/`userId`/`sessionId` are still the values to act on), or undefined when no live row of that purpose matched.
   */
  async claimOnce(tokenHash: string, purpose: TokenPurpose): Promise<UserToken | undefined> {
    const [row] = await db
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()`, consumedAt: sql`now()` }))
      .where(
        this.scope(
          sql`${userTokenModel.tokenHash} = ${tokenHash} and ${userTokenModel.purpose} = ${purpose} and ${userTokenModel.revokedAt} is null`
        )
      )
      .returning()
    return row
  }

  /**
   * Revoke every still-live token sharing a session id — the whole rotation
   * chain for one login. Used both by an explicit single-session logout and
   * by reuse detection to contain a compromised chain.
   * @param sessionId - The session id shared by every token in the chain.
   * @returns Resolves once every matching row is revoked.
   */
  async revokeAllForSession(sessionId: string): Promise<void> {
    await db
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(
        this.scope(
          sql`${userTokenModel.sessionId} = ${sessionId} and ${userTokenModel.revokedAt} is null`
        )
      )
  }

  /**
   * Revoke every still-live token belonging to a user, across every
   * session. Used where every session must end at once — e.g. a password
   * change.
   * @param userId - The user whose tokens should all be revoked.
   * @returns Resolves once every matching row is revoked.
   */
  async revokeAllForUser(userId: string): Promise<void> {
    await db
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(
        this.scope(
          sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.revokedAt} is null`
        )
      )
  }

  /**
   * Select the single token row matching a condition.
   * @param where - The condition to match, or undefined to match every row.
   * @returns The matching row, or undefined when none exists.
   */
  protected async selectOne(where: SQL | undefined): Promise<UserToken | undefined> {
    const [row] = await db.select().from(userTokenModel).where(where).limit(1)
    return row
  }

  /**
   * Insert a single token row.
   * @param values - The row's initial column values.
   * @returns The inserted row.
   */
  protected async insertOne(values: NewUserToken): Promise<UserToken> {
    const [row] = await db.insert(userTokenModel).values(values).returning()
    // db.insert(...).values(one object).returning() always returns exactly
    // one row when the insert does not throw; the driver's own types just
    // cannot express "same length as input" for a single-row insert.
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * Update the single token row matching a condition.
   * @param where - The condition to match, already scoped for soft-delete visibility.
   * @param values - The columns to change, already carrying `updatedAt`.
   * @returns The updated row, or undefined when no matching row exists.
   */
  protected async updateOne(
    where: SQL | undefined,
    values: Touched<Partial<Omit<NewUserToken, 'id' | 'createdAt' | 'updatedAt'>>>
  ): Promise<UserToken | undefined> {
    const [row] = await db.update(userTokenModel).set(values).where(where).returning()
    return row
  }

  /**
   * Set `deletedAt` on the single token row matching a condition.
   * @param where - The condition to match, already scoped to not-yet-deleted rows.
   * @returns The updated row, or undefined when no matching row exists.
   */
  protected async markDeleted(where: SQL | undefined): Promise<UserToken | undefined> {
    const [row] = await db
      .update(userTokenModel)
      .set(this.touched({ deletedAt: sql`now()` }))
      .where(where)
      .returning()
    return row
  }
}
