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
// (session.service.ts), and generalised here to every purpose
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
import { HttpError } from '@/errors/http-error'
import {
  BaseRepository,
  type SoftDeleteOptions,
  type Touched,
} from '@/repositories/base.repository'
import { db, type DbExecutor } from '@/services/database.service'

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
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching row, or undefined when none exists.
   */
  findByHash(
    tokenHash: string,
    options: SoftDeleteOptions = {},
    executor: DbExecutor = db
  ): Promise<UserToken | undefined> {
    return this.selectOne(this.scope(eq(userTokenModel.tokenHash, tokenHash), options), executor)
  }

  /**
   * Atomically claim a not-yet-revoked token row of one purpose: sets
   * `revokedAt` and `consumedAt`, and returns the row, but only if it was
   * still live — meaning `revokedAt IS NULL`, and NOTHING ELSE — for that
   * exact purpose, the instant this statement ran. A second, concurrent
   * call for the same hash — including a genuine reuse attempt racing a
   * legitimate rotation, or a claim for the wrong purpose — gets undefined,
   * never the same row twice.
   *
   * THIS METHOD DOES NOT CHECK `expiresAt`. An expired-but-not-yet-revoked
   * row is still "live" by the definition above and WILL be claimed —
   * deliberately, not an oversight: folding expiry into this predicate
   * would make a merely-expired token indistinguishable from a genuinely
   * replayed one, so `rotateRefreshToken`'s reuse-detection branch would
   * revoke an entire session family for a legitimate user whose token
   * simply aged out (see the existing test `rejects an expired refresh
   * token without treating it as reuse of a live session`,
   * session.service.test.ts). EVERY CALLER MUST CHECK `expiresAt` on the
   * returned row itself, immediately after claiming, before treating the
   * claim as a valid redemption — `rotateRefreshToken` does this for
   * `'refresh'`; a future `email_verification`/`password_reset` redemption
   * path must do the same, or it ships a token that is redeemable forever.
   * Pinned by `claimOnce claims an expired-but-unrevoked row — expiry is
   * the caller's job, not the predicate's` (user-token.repository.test.ts).
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
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The now-claimed row, EXPIRY NOT CHECKED — its `expiresAt` is still the pre-claim value the caller must validate (its `userId`/`sessionId` are likewise still the values to act on) — or undefined when no not-yet-revoked row of that purpose matched.
   */
  async claimOnce(
    tokenHash: string,
    purpose: TokenPurpose,
    executor: DbExecutor = db
  ): Promise<UserToken | undefined> {
    const [row] = await executor
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
   * Whether a token row was consumed within the last `ms` milliseconds, judged by Postgres's own clock — never the app's — so the window can't drift with clock skew between the two.
   * @param tokenHash - The SHA-256 hash of the raw token, hex-encoded.
   * @param ms - The window's length, in milliseconds.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns True when the row exists and its `consumedAt` is within the window; false when it doesn't exist, or was never consumed, or the window has passed.
   */
  async wasConsumedWithin(
    tokenHash: string,
    ms: number,
    executor: DbExecutor = db
  ): Promise<boolean> {
    const [row] = await executor
      .select({
        withinWindow: sql<
          boolean | null
        >`${userTokenModel.consumedAt} > now() - make_interval(secs => ${ms}::double precision / 1000.0)`,
      })
      .from(userTokenModel)
      .where(this.scope(eq(userTokenModel.tokenHash, tokenHash)))
      .limit(1)
    // withinWindow is boolean | null (SQL NULL for a never-consumed row); narrowed to a plain boolean here.
    return row?.withinWindow === true
  }

  /**
   * Whether a session was explicitly revoked: a row revoked without being consumed (logout, reuse, reset).
   * @param sessionId - The session (rotation-chain) id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns True when any row in the session carries that kill marker.
   */
  async isSessionKilled(sessionId: string, executor: DbExecutor = db): Promise<boolean> {
    // claimOnce sets revokedAt AND consumedAt; only explicit revocation sets revokedAt alone.
    const [row] = await executor
      .select({ id: userTokenModel.id })
      .from(userTokenModel)
      .where(
        this.scope(
          sql`${userTokenModel.sessionId} = ${sessionId} and ${userTokenModel.revokedAt} is not null and ${userTokenModel.consumedAt} is null`
        )
      )
      .limit(1)
    return row !== undefined
  }

  /**
   * Revoke every still-live token sharing a session id — the whole rotation
   * chain for one login. Used by logout and by reuse detection;
   * session.service.ts denies the session's access tokens afterwards.
   * @param sessionId - The session id shared by every token in the chain.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Resolves once every matching row is revoked.
   */
  async revokeAllForSession(sessionId: string, executor: DbExecutor = db): Promise<void> {
    await executor
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
   * session, and report each revoked session id so session.service.ts can
   * deny its access tokens. Used where every session must end at once —
   * e.g. a password reset. Its returned ids are what let a reset end an
   * already-issued access token immediately.
   *
   * This method has no purpose predicate — it deliberately revokes
   * `password_reset`, `email_verification`, and every other purpose too,
   * not just `'refresh'` rows. `sessionId` is only ever set on a
   * `'refresh'` row (user-token.model.ts), so a revoked non-refresh row
   * contributes `sessionId: null` and is filtered out of the returned ids.
   * An entire rotation chain shares one session id, so the ids are
   * deduplicated.
   *
   * KNOWN GAP, not fixed here: a session mid-rotation when this runs — the
   * old refresh row already claimed by `rotateRefreshToken`, the new one
   * not yet written — survives on both the revocation and denial side,
   * because the row this method's `WHERE` clause would otherwise catch
   * does not exist yet at the instant this query runs. Real, pre-existing,
   * and needs the rotation and this revocation to share a transaction to
   * close properly; not attempted here.
   * @param userId - The user whose tokens should all be revoked.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The distinct session ids of the rows it revoked.
   */
  async revokeAllForUser(userId: string, executor: DbExecutor = db): Promise<string[]> {
    const revoked = await executor
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(
        this.scope(
          sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.revokedAt} is null`
        )
      )
      .returning({ sessionId: userTokenModel.sessionId })

    const sessionIds = new Set(
      revoked
        .map((row) => row.sessionId)
        .filter((sessionId): sessionId is string => sessionId !== null)
    )
    return [...sessionIds]
  }

  /**
   * Revoke every still-live token belonging to a user EXCEPT the ones
   * sharing one given session id, and report each revoked session id so
   * session.service.ts can deny it. Used by password change:
   * every OTHER session must end at once, while the session presenting the
   * request that triggered the change keeps working uninterrupted.
   *
   * Modelled directly on `revokeAllForUser` above, as it stands today: same
   * `RETURNING session_id`, same null-filtering `!== null` type guard, same
   * de-duplicating `Set`. The one addition is the
   * spared-session predicate, and it MUST read `session_id IS DISTINCT FROM
   * $2`, not `session_id != $2`. SQL's `!=` evaluates to NULL — not true —
   * for a row whose `session_id` IS NULL, and NULL is not true, so a plain
   * `!=` would silently exclude every non-refresh row (`password_reset`,
   * `email_verification` — `sessionId` is only ever set on a `'refresh'`
   * row, user-token.model.ts) from being revoked at all: those rows would
   * survive a password change, which is exactly the gap `revokeAllForUser`
   * already closes today for a full revocation and this method must not
   * reopen for a partial one. `IS DISTINCT FROM` treats NULL as an ordinary
   * comparable value — a NULL `session_id` IS DISTINCT FROM the (never-null)
   * spared id, so it evaluates true and that row IS revoked, matching
   * `revokeAllForUser`'s own "every purpose, not just refresh" behaviour for
   * everything except the one session this call is told to spare. DO NOT
   * "simplify" this back to `!=`; that is precisely the silent regression
   * this comment exists to prevent.
   *
   * Same known gap as `revokeAllForUser`, not fixed here either: a session
   * mid-rotation when this runs — the old refresh row already claimed by
   * `rotateRefreshToken`, the new one not yet written — survives on both the
   * revocation and denial side.
   * @param userId - The user whose tokens should all be revoked, except one session's.
   * @param sessionId - The one session id to spare; every token sharing it is left untouched.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The distinct session ids of the rows it revoked, never the spared one.
   */
  async revokeAllForUserExceptSession(
    userId: string,
    sessionId: string,
    executor: DbExecutor = db
  ): Promise<string[]> {
    const revoked = await executor
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(
        this.scope(
          sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.sessionId} is distinct from ${sessionId} and ${userTokenModel.revokedAt} is null`
        )
      )
      .returning({ sessionId: userTokenModel.sessionId })

    const sessionIds = new Set(
      revoked
        .map((row) => row.sessionId)
        .filter((revokedSessionId): revokedSessionId is string => revokedSessionId !== null)
    )
    return [...sessionIds]
  }

  /**
   * Revoke every still-live token a user holds FOR ONE PURPOSE. The
   * purpose predicate is the whole point: `revokeAllForUser` above matches
   * on `userId` alone, so using it to clear stale verification links would
   * take the user's live refresh tokens with it and log them out of every
   * device as a side effect of requesting an email.
   * @param userId - The user whose tokens should be revoked.
   * @param purpose - The only purpose to revoke; every other purpose is untouched.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Resolves once every matching row is revoked.
   */
  async revokeAllForUserAndPurpose(
    userId: string,
    purpose: TokenPurpose,
    executor: DbExecutor = db
  ): Promise<void> {
    await executor
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(
        this.scope(
          sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.purpose} = ${purpose} and ${userTokenModel.revokedAt} is null`
        )
      )
  }

  /**
   * Select the single token row matching a condition.
   * @param where - The condition to match, or undefined to match every row.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching row, or undefined when none exists.
   */
  protected async selectOne(
    where: SQL | undefined,
    executor: DbExecutor = db
  ): Promise<UserToken | undefined> {
    const [row] = await executor.select().from(userTokenModel).where(where).limit(1)
    return row
  }

  /**
   * Insert a single token row.
   * @param values - The row's initial column values.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row.
   */
  protected async insertOne(values: NewUserToken, executor: DbExecutor = db): Promise<UserToken> {
    const [row] = await executor.insert(userTokenModel).values(values).returning()
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
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when no matching row exists.
   */
  protected async updateOne(
    where: SQL | undefined,
    values: Touched<Partial<Omit<NewUserToken, 'id' | 'createdAt' | 'updatedAt'>>>,
    executor: DbExecutor = db
  ): Promise<UserToken | undefined> {
    const [row] = await executor.update(userTokenModel).set(values).where(where).returning()
    return row
  }

  /**
   * Set `deletedAt` on the single token row matching a condition.
   * @param where - The condition to match, already scoped to not-yet-deleted rows.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when no matching row exists.
   */
  protected async markDeleted(
    where: SQL | undefined,
    executor: DbExecutor = db
  ): Promise<UserToken | undefined> {
    const [row] = await executor
      .update(userTokenModel)
      .set(this.touched({ deletedAt: sql`now()` }))
      .where(where)
      .returning()
    return row
  }
}
