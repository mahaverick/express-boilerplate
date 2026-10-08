/**
 * @file Query access to `user_tokens`, on `BaseRepository`. The bulk writers
 * (the four revokers and `markSessionAuthenticated`) lock the rows they write
 * in id order through `lockedIds`, so two sharing rows queue instead of
 * deadlocking; a new bulk writer must lock the same way and join `WRITERS` in
 * user-token-lock-order.test.ts.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
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
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * Query access to the `user_tokens` table: token issuance, lookup by hash,
 * atomic single-use claiming (`claimOnce`), and bulk revocation by session
 * or by user. Every lookup excludes a soft-deleted row by default — see
 * `BaseRepository.scope`, which every method below except the retention
 * purge is built on so none of them can drift from that behaviour
 * independently. The purge deletes expired rows whether soft-deleted or not.
 */
export class UserTokenRepository extends BaseRepository<(typeof userTokenModel)['_']['config']> {
  /**
   * Build a repository bound to the `user_tokens` table.
   */
  constructor() {
    super(userTokenModel)
  }

  /**
   * The ids of the rows matching `where`, locked FOR NO KEY UPDATE in id
   * order. A bulk revoker that updates `WHERE id IN (…)` this subquery takes
   * its row locks in that order, whatever plan or physical row layout the
   * predicate gets, so two revokers sharing rows queue instead of
   * deadlocking. NO KEY UPDATE is the lock the UPDATE itself takes.
   * @param where - The revoker's predicate, already scoped for soft-delete visibility.
   * @param executor - Where to run the query; the locks last until its transaction ends.
   * @returns A subquery for `inArray(userTokenModel.id, …)`.
   */
  private lockedIds(where: SQL | undefined, executor: DbExecutor) {
    return executor
      .select({ id: userTokenModel.id })
      .from(userTokenModel)
      .where(where)
      .orderBy(userTokenModel.id)
      .for('no key update')
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
   * The check and the write are one statement, so Postgres picks the single
   * winner; a read-then-write would let two concurrent presentations both see
   * `revokedAt IS NULL`, defeating reuse detection or double-spending a
   * verification or reset token. `purpose` is in the same predicate, so a
   * token of one purpose can never be claimed as another.
   *
   * It does not check `expiresAt`, and claims an expired row: folding expiry
   * in would make an aged-out refresh token look like a replay and kill its
   * session. Every caller checks `expiresAt` on the returned row
   * (`rotateRefreshToken`, `claimToken` in session.service.ts), or the token
   * would be redeemable forever.
   *
   * `consumedAt` is set only here, so it tells a row spent through this path
   * from one killed by an explicit revoke, which sets `revokedAt` alone.
   * @param tokenHash - The SHA-256 hash of the raw token, hex-encoded.
   * @param purpose - The purpose the token must have been issued for; a row that exists but for a different purpose is left untouched and this resolves undefined, exactly as if no row matched at all.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The now-claimed row, expiry not checked, or undefined when no not-yet-revoked row of that purpose matched.
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
   * session.service.ts denies the session's access tokens afterwards. A
   * caller that runs this inside its own transaction must deny the session
   * only after that transaction commits. Lock the user row FOR NO KEY UPDATE
   * first, for the reason `revokeAllForUser` gives. Locks its rows in id
   * order (`lockedIds`), whatever the plan or the physical row layout.
   * @param sessionId - The session id shared by every token in the chain.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns How many rows this call revoked: zero when another revoke got there first.
   */
  async revokeAllForSession(sessionId: string, executor: DbExecutor = db): Promise<number> {
    const locked = this.lockedIds(
      this.scope(
        sql`${userTokenModel.sessionId} = ${sessionId} and ${userTokenModel.revokedAt} is null`
      ),
      executor
    )
    const revoked = await executor
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(inArray(userTokenModel.id, locked))
      .returning({ id: userTokenModel.id })
    return revoked.length
  }

  /**
   * Revoke every still-live token belonging to a user, across every
   * session, and report each revoked session id so session.service.ts can
   * deny its access tokens. Used where every session must end at once —
   * e.g. a password reset. Its returned ids are what let a reset end an
   * already-issued access token immediately. A caller that runs this inside
   * its own transaction must deny the returned ids only after that
   * transaction commits.
   *
   * This method has no purpose predicate — it deliberately revokes
   * `password_reset`, `email_verification`, and every other purpose too,
   * not just `'refresh'` rows. `sessionId` is only ever set on a
   * `'refresh'` row (user-token.model.ts), so a revoked non-refresh row
   * contributes `sessionId: null` and is filtered out of the returned ids.
   * An entire rotation chain shares one session id, so the ids are
   * deduplicated.
   *
   * A session mid-rotation when this runs (old row claimed, next row not yet
   * committed) survives it: the next row is not in this statement's snapshot.
   * Lock the user row FOR NO KEY UPDATE first (`UserRepository.lockById`),
   * as password writes and the Google account claim do before their
   * in-transaction revoke. Rotation holds it FOR SHARE from before its claim
   * until its next row commits, so this statement then starts after that
   * commit.
   *
   * Locks its rows in id order (`lockedIds`), whatever the plan or the
   * physical row layout.
   * @param userId - The user whose tokens should all be revoked.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The distinct session ids of the rows it revoked.
   */
  async revokeAllForUser(userId: string, executor: DbExecutor = db): Promise<string[]> {
    const locked = this.lockedIds(
      this.scope(sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.revokedAt} is null`),
      executor
    )
    const revoked = await executor
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(inArray(userTokenModel.id, locked))
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
   * session.service.ts can deny it (after commit, when a caller runs this
   * inside its own transaction). Used by password change:
   * every OTHER session must end at once, while the session presenting the
   * request that triggered the change keeps working uninterrupted.
   *
   * The spared-session predicate is `session_id IS DISTINCT FROM $2`, never
   * `!=`: `!=` is NULL for a non-refresh row (its `session_id` is NULL), so
   * reset and verification tokens would survive a password change.
   * `IS DISTINCT FROM` revokes them, as `revokeAllForUser` does.
   *
   * The same mid-rotation caveat as `revokeAllForUser`, closed the same way:
   * lock the user row first. Locks its rows in id order (`lockedIds`),
   * whatever the plan or the physical row layout.
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
    const locked = this.lockedIds(
      this.scope(
        sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.sessionId} is distinct from ${sessionId} and ${userTokenModel.revokedAt} is null`
      ),
      executor
    )
    const revoked = await executor
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(inArray(userTokenModel.id, locked))
      .returning({ sessionId: userTokenModel.sessionId })

    const sessionIds = new Set(
      revoked
        .map((row) => row.sessionId)
        .filter((revokedSessionId): revokedSessionId is string => revokedSessionId !== null)
    )
    return [...sessionIds]
  }

  /**
   * The sessions of a user, other than one, that hold a live refresh token:
   * unrevoked (a rotation's claim revokes the row it spends), unexpired, and
   * started after `startedAfter`, the absolute lifetime rotation enforces.
   * Read under the user row lock, it is the set a following
   * `revokeAllForUserExceptSession` ends that a person would call signed in;
   * a lapsed session it also revokes is not among them.
   * @param userId - The user whose sessions are read.
   * @param sessionId - The one session id to leave out.
   * @param startedAfter - A live session must have started after this, by the application clock: the caller's `SESSION_ABSOLUTE_TTL` bound.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The distinct live session ids, never the excluded one.
   */
  async liveSessionIdsExcept(
    userId: string,
    sessionId: string,
    startedAfter: Date,
    executor: DbExecutor = db
  ): Promise<string[]> {
    const rows = await executor
      .selectDistinct({ sessionId: userTokenModel.sessionId })
      .from(userTokenModel)
      .where(
        this.scope(
          sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.purpose} = 'refresh' and ${userTokenModel.sessionId} is distinct from ${sessionId} and ${userTokenModel.revokedAt} is null and ${userTokenModel.expiresAt} > now() and ${userTokenModel.sessionStartedAt} > ${startedAfter.toISOString()}::timestamptz`
        )
      )
    return rows
      .map((row) => row.sessionId)
      .filter((liveSessionId): liveSessionId is string => liveSessionId !== null)
  }

  /**
   * Revoke every still-live token a user holds for one purpose.
   * `revokeAllForUser` matches on `userId` alone, so clearing stale
   * verification links with it would also log the user out of every device.
   * Locks its rows in id order (`lockedIds`), whatever the plan or the
   * physical row layout.
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
    const locked = this.lockedIds(
      this.scope(
        sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.purpose} = ${purpose} and ${userTokenModel.revokedAt} is null`
      ),
      executor
    )
    await executor
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(inArray(userTokenModel.id, locked))
  }

  /**
   * Set `authenticated_at` to now, by the application clock (the one
   * `issueRefreshToken` stamps a new session with), on every row of one of a
   * user's sessions, provided that session still has a live refresh token
   * (not revoked, not expired, not soft-deleted) in a session started after
   * `startedAfter`. Rows already rotated away are updated too: a grace-window
   * replay copies its sibling's time from the row presented. One UPDATE whose EXISTS carries the liveness check, so the
   * statement locks through `lockedIds` in id order like the revokers
   * (user-token-lock-order.test.ts plans it). Lock the user row FOR NO KEY
   * UPDATE first, so a rotation holding it FOR SHARE commits its new row
   * before this statement and the row is included.
   * @param userId - The session's user; another user's session matches nothing.
   * @param sessionId - The session (rotation-chain) id.
   * @param startedAfter - The live token's session must have started after this, by the application clock: the caller's `SESSION_ABSOLUTE_TTL` bound.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The time written, or undefined when the session has no live refresh token.
   */
  async markSessionAuthenticated(
    userId: string,
    sessionId: string,
    startedAfter: Date,
    executor: DbExecutor = db
  ): Promise<Date | undefined> {
    const authenticatedAt = new Date()
    const session = sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.sessionId} = ${sessionId} and ${userTokenModel.purpose} = 'refresh'`
    // Raw table name in the EXISTS: an uncorrelated InitPlan, so the plan keeps one LockRows node.
    const liveTokenExists = sql`exists (select 1 from user_tokens live where live.user_id = ${userId} and live.session_id = ${sessionId} and live.purpose = 'refresh' and live.revoked_at is null and live.deleted_at is null and live.expires_at > now() and live.session_started_at > ${startedAfter.toISOString()}::timestamptz)`
    const locked = this.lockedIds(this.scope(session), executor)
    const updated = await executor
      .update(userTokenModel)
      .set(this.touched({ authenticatedAt }))
      .where(and(inArray(userTokenModel.id, locked), liveTokenExists))
      .returning({ id: userTokenModel.id })
    return updated.length > 0 ? authenticatedAt : undefined
  }

  /**
   * Delete up to `limit` token rows past retention: expired before `cutoff`,
   * or revoked before it without ever being used. A rotated-away row stays
   * until it expires: reuse detection needs it while it can still be
   * presented. Soft-deleted rows go too, so this doesn't use `scope`. A kept
   * row that pointed at a deleted one through `replaced_by_id` has that
   * pointer set to NULL by the foreign key.
   * Takes the batch oldest id first with FOR UPDATE SKIP LOCKED: a row a
   * request holds is left for a later run instead of waited on, so a batch
   * can come back short while matching rows remain. The foreign key's update
   * of a kept row is an ordinary write and does wait on a lock a request
   * holds on that row.
   * @param cutoff - Rows older than this go.
   * @param limit - The most rows one call deletes.
   * @param tx - The batch's transaction.
   * @returns How many rows were deleted.
   */
  async purgeExpiredOrRevokedBefore(
    cutoff: Date,
    limit: number,
    tx: DbTransaction
  ): Promise<number> {
    const before = sql`${cutoff.toISOString()}::timestamptz`
    const batch = tx
      .select({ id: userTokenModel.id })
      .from(userTokenModel)
      .where(
        sql`${userTokenModel.expiresAt} < ${before} or (${userTokenModel.revokedAt} < ${before} and ${userTokenModel.consumedAt} is null)`
      )
      .orderBy(userTokenModel.id)
      .limit(limit)
      .for('update', { skipLocked: true })
    const result = await tx.delete(userTokenModel).where(inArray(userTokenModel.id, batch))
    return result.count
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
