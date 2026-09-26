// src/services/session.service.ts
//
// Access tokens are signed JWTs (jsonwebtoken) — short-lived, stateless,
// carrying the user id (`sub`) plus the session and token ids (`sid`,
// `jti` — see AccessTokenPayload for why each exists). Refresh tokens are
// the opposite on
// every axis: OPAQUE random strings (crypto.randomBytes(32)), never JWTs.
// A JWT refresh token cannot be revoked without a server-side store anyway
// (the whole point of a refresh token is that it MUST be revocable), so
// signing one buys nothing but leaks its claims — issuer, subject, custom
// fields — to anyone holding it. An opaque token carries no information at
// all; only this module and the `user_tokens` table it's checked against
// know what it means. See user-token.model.ts's header comment for why the
// stored hash is SHA-256, not bcrypt.
//
// Rotation and reuse detection (rotateRefreshToken) are the security core
// of this module: presenting a token AFTER the legitimate client has
// already rotated it is reuse. Within REFRESH_REUSE_GRACE_MS of that
// rotation, and only while the session hasn't been killed, reuse gets a
// sibling token instead (findGraceSession) — a concurrent-refresh
// allowance. Past the window, or once the session is killed, reuse kills
// the entire session, not just that one token. See UserTokenRepository.
// claimOnce for how the race that would otherwise defeat this is closed —
// and how that same primitive now also guards email-verification and
// password-reset tokens, scoped so one purpose's token can never be
// claimed as another's.
//
// Every revocation here also denies the revoked sessions' access tokens
// (session-denylist.service.ts, best-effort), except revokeSessionRows, whose
// caller denies after its transaction commits. The repository only revokes
// rows and reports which sessions it touched; it never writes Redis.
//
// A rotation runs in one transaction that first takes the user row FOR
// SHARE. Logout, the kills a reused or over-age token triggers, the Google
// account claim and password writes lock that row FOR NO KEY UPDATE before
// their in-transaction revoke (revokeSession and revokeAllSessions' unlocked
// pass excepted), so a rotation either commits first and its new token is
// revoked, or waits and then finds the presented token revoked.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { getEnv } from '@/configs/env.config'
import { REFRESH_REUSE_GRACE_MS } from '@/constants/auth.constants'
import type { TokenPurpose, UserToken } from '@/database/models/user-token.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import {
  db,
  withTransaction,
  type DbExecutor,
  type DbTransaction,
} from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { denySession } from '@/services/session-denylist.service'
import { MS_PER_SECOND, requireDurationMs } from '@/utilities/duration.utilities'

// jsonwebtoken's `expiresIn` option is typed against `ms`'s own
// `StringValue` literal union — the identical narrowness
// duration.utilities.ts exists to work around — so this module converts a
// validated TTL to whole SECONDS (jsonwebtoken's numeric `expiresIn` unit)
// once, here, rather than fighting that type a second time. `MS_PER_SECOND`
// itself lives in duration.utilities.ts, not here — see that module's own
// comment for why session-denylist.service.ts needing the same constant
// made this its one definition.

// A raw token's length in bytes before hex-encoding, for every purpose. 32
// bytes (256 bits) hex-encodes to the 64 characters user-token.model.ts's
// `tokenHash` column width assumes for a SHA-256 digest — deliberately the
// same length as the hash, though the two are unrelated facts: the digest
// is fixed by SHA-256, and the raw token's length is this constant.
const RAW_TOKEN_BYTES = 32

const userTokenRepository = new UserTokenRepository()
const userRepository = new UserRepository()

/**
 * Revoke every live token in one session under the user row lock, then deny
 * the session. FOR NO KEY UPDATE waits for any rotation holding the row FOR
 * SHARE, so this revoke starts after that rotation's next token has
 * committed, and a rotation arriving later finds its token revoked.
 * @param userId - The session's user.
 * @param sessionId - The session (rotation-chain) id.
 */
async function revokeSessionUnderUserLock(userId: string, sessionId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await userRepository.lockById(userId, 'no key update', tx)
    await userTokenRepository.revokeAllForSession(sessionId, tx)
  })
  await denySession(sessionId)
}

/**
 * Deny each session a revocation reported, concurrently. Best-effort and
 * never rejects: a session that cannot be denied is logged at warn by
 * `denySession`, and its access tokens stay valid until they expire.
 * @param sessionIds - Distinct session ids the revocation touched.
 * @returns Resolves once every denial is written or its failure logged.
 */
export async function denySessions(sessionIds: readonly string[]): Promise<void> {
  await Promise.all(sessionIds.map((sessionId) => denySession(sessionId)))
}

/**
 * The claims this module signs into, and expects back out of, an access
 * token.
 */
export interface AccessTokenPayload {
  sub: string
  /**
   * The session this token belongs to. Optional ONLY so that tokens minted
   * before this claim existed keep verifying for one release; a token
   * without it cannot be revoked and is accepted until it expires.
   */
  sid?: string
  /**
   * This token's own id. Not checked — it exists so a token accepted after
   * a Redis flush can be identified in logs.
   */
  jti?: string
  /**
   * Expiry, in seconds since the epoch, as verified by jsonwebtoken. Set on
   * every verified token that carries one; the notification stream ends
   * itself at this moment.
   */
  exp?: number
}

/**
 * A freshly issued or rotated refresh token, in the only form a caller
 * needs: the raw value to hand to the client, and everything about it that
 * isn't recoverable from the raw value alone.
 */
export interface IssuedRefreshToken {
  raw: string
  userId: string
  sessionId: string
  expiresAt: Date
}

/**
 * A freshly issued token for a non-session purpose (email verification,
 * password reset): the raw value to hand to the caller (an email link, in
 * practice), and everything about it that isn't recoverable from the raw
 * value alone. No `sessionId` — see user-token.model.ts's header comment for
 * why that field means nothing outside `'refresh'`. `purpose` excludes
 * `'refresh'` for the same reason `issueToken` itself does — see that
 * function's own comment.
 */
export interface IssuedToken {
  raw: string
  userId: string
  purpose: Exclude<TokenPurpose, 'refresh'>
  expiresAt: Date
}

/**
 * SHA-256 hash a raw token, hex-encoded. Deterministic on purpose — see
 * user-token.model.ts's header comment for why that rules out bcrypt.
 * @param raw - The raw token, of any purpose.
 * @returns The hex-encoded digest, as stored in `tokenHash`.
 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Generate a new opaque token, for any purpose.
 * @returns A hex-encoded, cryptographically random token.
 */
function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString('hex')
}

/**
 * Generate, hash, and persist one token row — the single insert every
 * issuing path in this module goes through, so hashing, randomness, and the
 * write itself have exactly one implementation rather than one per purpose.
 * Session fields are the one thing callers still supply directly, since
 * they mean something for `'refresh'` only (user-token.model.ts) and no
 * other purpose has anything sensible to pass for them.
 * @param userId - The user the token belongs to.
 * @param purpose - Which of `TokenPurpose`'s three things this row is.
 * @param ttlMs - How long the token is valid for, in milliseconds.
 * @param sessionId - The rotation-chain id, for `'refresh'`; omitted (column stays NULL — neither column has a DB default) for every other purpose.
 * @param sessionStartedAt - When that chain began, for `'refresh'`; omitted for every other purpose.
 * @param executor - Where to insert. Defaults to the pool.
 * @returns The inserted row's id, the raw token to hand back, and its expiry.
 */
async function createTokenRow(
  userId: string,
  purpose: TokenPurpose,
  ttlMs: number,
  sessionId: string | undefined,
  sessionStartedAt: Date | undefined,
  executor: DbExecutor = db
): Promise<{ id: string; raw: string; expiresAt: Date }> {
  const raw = generateRawToken()
  const expiresAt = new Date(Date.now() + ttlMs)

  const row = await userTokenRepository.create(
    {
      userId,
      purpose,
      sessionId,
      sessionStartedAt,
      tokenHash: hashToken(raw),
      expiresAt,
    },
    executor
  )

  return { id: row.id, raw, expiresAt }
}

/**
 * Sign a short-lived access token carrying a user's id.
 * @param user - The authenticated user.
 * @param sessionId - The session this token belongs to.
 * @returns A signed JWT, expiring after `ACCESS_TOKEN_TTL`.
 */
export function signAccessToken(user: User, sessionId: string): string {
  const env = getEnv()
  const payload: AccessTokenPayload = { sub: user.id, sid: sessionId, jti: randomUUID() }
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: Math.floor(requireDurationMs(env.ACCESS_TOKEN_TTL) / MS_PER_SECOND),
  })
}

/**
 * The outcome of verifying an access token: its payload, or WHICH of two
 * reasons verification failed for.
 *
 * A caller (auth.middleware.ts) needs that distinction to tell a client
 * "refresh me" from "log in again" — but only this module has anything
 * trustworthy to say about why a token was rejected, since only this module
 * ever calls `jwt.verify` and sees what `jsonwebtoken` actually threw. A
 * caller re-deriving "expired" from the token's own, unverified claims after
 * a generic rejection would be trusting exactly the data verification just
 * said not to trust; a discriminated result here means it never has to.
 */
export type VerifyAccessTokenResult =
  { ok: true; payload: AccessTokenPayload } | { ok: false; reason: 'expired' | 'invalid' }

/**
 * Verify an access token.
 *
 * Never resolves `ok: true` for a token that is malformed, expired, or
 * signed with any key or algorithm other than this server's own
 * `JWT_ACCESS_SECRET` under HS256 — `algorithms: ['HS256']` is pinned
 * explicitly so a token signed with a different algorithm can never be
 * accepted, regardless of what its own (attacker-controlled) header claims.
 *
 * `reason: 'expired'` is reported ONLY for `jsonwebtoken`'s own
 * `TokenExpiredError` — i.e. only when the signature and every other check
 * already passed and the sole remaining problem is `exp`. Every other
 * failure (bad signature, wrong algorithm, malformed structure, missing
 * `sub`) is `'invalid'`. The two carry no information beyond that label —
 * in particular `'invalid'` never says which of its causes applied — so
 * resolving the distinction can never teach an unauthenticated caller
 * anything more than "your token is stale" versus "your token is no good."
 * @param token - The bearer token presented by the client.
 * @returns The verified payload, or which of the two reasons verification failed.
 */
export function verifyAccessToken(token: string): VerifyAccessTokenResult {
  try {
    const decoded = jwt.verify(token, getEnv().JWT_ACCESS_SECRET, { algorithms: ['HS256'] })
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
      return { ok: false, reason: 'invalid' }
    }
    // Built incrementally, not as an object literal with `sid: undefined` /
    // `jti: undefined` inline: this repo's `exactOptionalPropertyTypes`
    // treats an optional property explicitly set to `undefined` as a type
    // error distinct from the property being absent, so a legacy token
    // (no `sid`/`jti` claim) must OMIT the key, not assign it `undefined`.
    const payload: AccessTokenPayload = { sub: decoded.sub }
    if (typeof decoded.sid === 'string') payload.sid = decoded.sid
    if (typeof decoded.jti === 'string') payload.jti = decoded.jti
    if (typeof decoded.exp === 'number') payload.exp = decoded.exp
    return { ok: true, payload }
  } catch (error) {
    return { ok: false, reason: error instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' }
  }
}

/**
 * Issue a new refresh token for a session.
 * @param userId - The user the token belongs to.
 * @param sessionId - The session (rotation-chain) id this token starts or continues.
 * @param executor - Where to insert the token row: a caller's transaction, or the pool (default).
 * @returns The raw token to hand to the client, and its metadata.
 */
export async function issueRefreshToken(
  userId: string,
  sessionId: string,
  executor: DbExecutor = db
): Promise<IssuedRefreshToken> {
  const env = getEnv()
  // This is where a session's absolute clock starts. `rotateRefreshToken`
  // copies the value forward rather than calling this function, so the
  // anchor survives every rotation — see that function and the column's own
  // comment (user-token.model.ts). Calling THIS function a second time for
  // a sessionId that already exists would restart that clock; nothing in
  // the application does (login always mints a fresh sessionId), and a
  // caller that wants a second live token in one session should be aware it
  // is also extending that session's ceiling.
  const sessionStartedAt = new Date()

  const { raw, expiresAt } = await createTokenRow(
    userId,
    'refresh',
    requireDurationMs(env.REFRESH_TOKEN_TTL),
    sessionId,
    sessionStartedAt,
    executor
  )

  return { raw, userId, sessionId, expiresAt }
}

/**
 * Issue a new token for a purpose that has no session — email verification
 * or password reset. The shared issuing path those two purposes go through
 * (`createTokenRow`).
 *
 * `'refresh'` is excluded from `purpose` at the type level, not just by
 * convention: `issueToken` has no parameter to supply a session id, so a
 * `'refresh'` row minted through it would have `sessionId` NULL — a
 * refresh token with no rotation-chain id that `revokeAllForSession` can
 * never find and reuse detection can never contain. `issueRefreshToken`
 * (above) is the one and only entry point for `'refresh'`, precisely
 * because a session id is mandatory for it and only that function's
 * signature has one to give.
 * @param userId - The user the token belongs to.
 * @param purpose - Which non-session purpose to issue — `'email_verification'` or `'password_reset'`.
 * @param ttlMs - How long the token is valid for, in milliseconds.
 * @returns The raw token to hand to the caller, and its metadata.
 */
export async function issueToken(
  userId: string,
  purpose: Exclude<TokenPurpose, 'refresh'>,
  ttlMs: number
): Promise<IssuedToken> {
  const { raw, expiresAt } = await createTokenRow(userId, purpose, ttlMs, undefined, undefined)
  return { raw, userId, purpose, expiresAt }
}

/**
 * Claim a non-session token — email verification or password reset — once,
 * atomically, and only while it is still live.
 *
 * The expiry check is HERE, not in the predicate, and that is deliberate:
 * `claimOnce` (user-token.repository.ts) matches on hash, purpose and
 * `revoked_at is null` and says in its own comment that expiry is the
 * caller's job. `rotateRefreshToken` below does the same check for
 * `'refresh'`. A caller that skipped it would ship a link that is
 * redeemable forever, and no other test in this file would notice.
 *
 * The row is claimed BEFORE expiry is judged, so presenting an expired
 * token still spends it. One presentation is one attempt; a token that
 * could be retried after failing is not single-use.
 * @param raw - The raw token presented by the caller.
 * @param purpose - The purpose it must have been issued for.
 * @returns The claimed row, or undefined when the token is unknown, of another purpose, already claimed, or expired.
 */
export async function claimToken(
  raw: string,
  purpose: Exclude<TokenPurpose, 'refresh'>
): Promise<UserToken | undefined> {
  const claimed = await userTokenRepository.claimOnce(hashToken(raw), purpose)
  if (!claimed) return undefined
  if (claimed.expiresAt.getTime() <= Date.now()) return undefined
  return claimed
}

/**
 * A rotation that issued the next token in the session.
 */
interface RotationIssued {
  ok: true
  id: string
  issued: IssuedRefreshToken
}

/**
 * A rotation that was refused. It is thrown as a 401 only after the
 * transaction commits, so its claim stands; `killSessionId` is then
 * revoked under the user row lock and denied.
 */
interface RotationRefused {
  ok: false
  message: string
  killSessionId?: string
}

/**
 * How a rotation ended inside its transaction.
 */
type RotationOutcome = RotationIssued | RotationRefused

/**
 * Concurrent-refresh grace: a token replayed within REFRESH_REUSE_GRACE_MS of its rotation gets a sibling (accepted trade-off); later reuse revokes the session.
 *
 * A kill that races this check (logout, reuse, a password write, an account claim) takes the user row FOR NO KEY UPDATE, which waits for this rotation's FOR SHARE, so it revokes the sibling this check lets through.
 * @param existing - The already-claimed row the presented token hashes to.
 * @param tx - The rotation's transaction.
 * @returns The session to continue when every grace condition holds and the session was not killed, otherwise undefined.
 */
async function findGraceSession(
  existing: UserToken,
  tx: DbTransaction
): Promise<{ sessionId: string; sessionStartedAt: Date } | undefined> {
  const { purpose, sessionId, sessionStartedAt, consumedAt, expiresAt, tokenHash } = existing
  if (purpose !== 'refresh' || sessionId === null || sessionStartedAt === null) return undefined
  // consumedAt is null for a row killed by logout/reuse revocation, never a rotation.
  if (consumedAt === null) return undefined
  // Judged by Postgres's own clock, not Date.now() — see wasConsumedWithin.
  if (!(await userTokenRepository.wasConsumedWithin(tokenHash, REFRESH_REUSE_GRACE_MS, tx))) {
    return undefined
  }
  // claimOnce also consumes expired rows; an expired token must never mint a sibling.
  if (expiresAt.getTime() <= Date.now()) return undefined
  // Committed kill markers only, so a sibling rotation still in flight can't look like a logout.
  if (await userTokenRepository.isSessionKilled(sessionId, tx)) return undefined
  return { sessionId, sessionStartedAt }
}

/**
 * Issue the next refresh token in a session, enforcing the session's absolute lifetime.
 * @param userId - The session's user.
 * @param sessionId - The session (rotation-chain) id.
 * @param sessionStartedAt - When the session began; copied forward so the absolute TTL never resets.
 * @param tx - The rotation's transaction.
 * @returns The new row's id and token; or, past `SESSION_ABSOLUTE_TTL`, a refusal naming the session to kill.
 */
async function continueSession(
  userId: string,
  sessionId: string,
  sessionStartedAt: Date,
  tx: DbTransaction
): Promise<RotationOutcome> {
  const env = getEnv()
  const sessionAgeMs = Date.now() - sessionStartedAt.getTime()
  if (sessionAgeMs >= requireDurationMs(env.SESSION_ABSOLUTE_TTL)) {
    // Every token in the session shares this start time, so all of them are past the ceiling.
    // Same message as the expiry branch, so a caller can't tell which clock ran out.
    return { ok: false, message: 'Refresh token expired', killSessionId: sessionId }
  }

  const { id, raw, expiresAt } = await createTokenRow(
    userId,
    'refresh',
    requireDurationMs(env.REFRESH_TOKEN_TTL),
    sessionId,
    sessionStartedAt,
    tx
  )
  return { ok: true, id, issued: { raw, userId, sessionId, expiresAt } }
}

/**
 * One rotation attempt under the user row lock. Every refusal is returned,
 * not thrown, so the transaction still commits the claim. A session to kill
 * is revoked after commit, under FOR NO KEY UPDATE, never in this FOR SHARE
 * transaction: upgrading here would deadlock two concurrent reuses.
 * @param userId - The presented token's user.
 * @param tokenHash - The presented token's hash.
 * @param tx - The rotation's transaction.
 * @returns The next token, or why it was refused.
 */
async function rotateUnderUserLock(
  userId: string,
  tokenHash: string,
  tx: DbTransaction
): Promise<RotationOutcome> {
  // Waits for a password change or reset in flight. A soft-deleted user has
  // no row to lock; refresh() in auth.service.ts refuses that user afterwards.
  await userRepository.lockById(userId, 'share', tx)
  const claimed = await userTokenRepository.claimOnce(tokenHash, 'refresh', tx)

  if (!claimed) {
    // Never issued as 'refresh', or already revoked (the reuse signal).
    // `findByHash` is purpose-agnostic; only a 'refresh' row has a session.
    const existing = await userTokenRepository.findByHash(tokenHash, {}, tx)
    const graceSession = existing ? await findGraceSession(existing, tx) : undefined
    if (existing && graceSession) {
      return continueSession(
        existing.userId,
        graceSession.sessionId,
        graceSession.sessionStartedAt,
        tx
      )
    }
    if (existing && existing.sessionId !== null) {
      return { ok: false, message: 'Invalid refresh token', killSessionId: existing.sessionId }
    }
    return { ok: false, message: 'Invalid refresh token' }
  }

  // issueRefreshToken always fills both for 'refresh'; narrowed so a broken invariant is a 401, not a crash.
  const { sessionId, sessionStartedAt } = claimed
  if (sessionId === null || sessionStartedAt === null) {
    return { ok: false, message: 'Invalid refresh token' }
  }

  if (claimed.expiresAt.getTime() < Date.now()) {
    // Already revoked by the claim; expiry is not a reuse signal, so the session is untouched.
    return { ok: false, message: 'Refresh token expired' }
  }

  const next = await continueSession(claimed.userId, sessionId, sessionStartedAt, tx)
  if (!next.ok) return next
  await userTokenRepository.update(claimed.id, { replacedById: next.id }, {}, tx)
  return next
}

/**
 * Redeem a refresh token for a new one, invalidating the old one.
 *
 * Reuse detection: presenting an already-used token revokes every token in
 * its session, except within REFRESH_REUSE_GRACE_MS of its rotation, when it
 * gets a sibling in the same session instead (`findGraceSession`).
 *
 * Two clocks stop a rotation. The token's own `expiresAt` is a sliding
 * window reset by every rotation. The session's `sessionStartedAt` is an
 * absolute ceiling (`SESSION_ABSOLUTE_TTL`), copied forward unchanged, so a
 * diligently refreshing client (or a stolen cookie) cannot hold a login forever.
 *
 * The claim, the checks and the next token's insert share one transaction
 * that holds the user row FOR SHARE, so a password change or reset cannot
 * revoke in between. A session killed by reuse or by its absolute lifetime
 * is revoked after that commit, under the user row lock, then denied.
 * @param raw - The raw refresh token presented by the client.
 * @returns The new raw token to hand to the client, and its metadata.
 * @throws {HttpError} 401, when the token is unknown, already used outside the grace window, expired, or belongs to a session past its absolute lifetime.
 */
export async function rotateRefreshToken(raw: string): Promise<IssuedRefreshToken> {
  const tokenHash = hashToken(raw)
  // Read only to learn whose row to lock; everything that decides runs under the lock.
  const presented = await userTokenRepository.findByHash(tokenHash)
  if (!presented) throw new HttpError('Invalid refresh token', 401)

  const outcome = await withTransaction((tx) =>
    rotateUnderUserLock(presented.userId, tokenHash, tx)
  )
  if (outcome.ok) return outcome.issued
  if (outcome.killSessionId !== undefined) {
    await revokeSessionUnderUserLock(presented.userId, outcome.killSessionId)
  }
  throw new HttpError(outcome.message, 401)
}

/**
 * Revoke every live refresh token in one session and deny its access
 * tokens (best-effort — see `denySession`), given only the session id.
 * It takes no user row lock, so a rotation of that session in flight can
 * outlive it. The application's own paths (logout, reuse and the absolute
 * lifetime) go through the locked `revokeSessionUnderUserLock`.
 * @param sessionId - The session (rotation-chain) id to revoke.
 * @returns Resolves once every token in the session is revoked and its access tokens are denied, best-effort.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await userTokenRepository.revokeAllForSession(sessionId)
  await denySession(sessionId)
}

/**
 * Revoke the session a raw refresh token belongs to, under the user row
 * lock, and deny its access tokens (best-effort — see `denySession`) —
 * logout's primitive.
 *
 * Resolves quietly for a token that is missing, forged, already revoked, or
 * issued for a different purpose entirely (a password-reset or
 * email-verification token's raw value presented here has no session to
 * revoke, and `findByHash` is purpose-agnostic so it would still be found);
 * it never distinguishes any of those from a live one in what it returns or
 * how long it takes. Logout must feel like unconditional success to
 * whoever calls it, not a way to test whether a given token string is
 * still live — exactly the same reasoning `rotateRefreshToken` (this
 * module) and login (auth.service.ts) already apply to their own callers.
 * @param raw - The raw refresh token presented by the client.
 * @returns Resolves once the token's session (if any matched) is revoked and its access tokens are denied, best-effort.
 */
export async function revokeRefreshToken(raw: string): Promise<void> {
  const existing = await userTokenRepository.findByHash(hashToken(raw))
  if (existing && existing.sessionId !== null) {
    await revokeSessionUnderUserLock(existing.userId, existing.sessionId)
  }
}

/**
 * Revoke a user's token rows in the caller's transaction and report the
 * sessions revoked. The denylist is left to `denySessionsAfterCommit`: a
 * denial written before commit would outlive a rollback.
 * @param userId - The user whose tokens are revoked, every purpose.
 * @param options - `exceptSessionId` spares that one session's tokens.
 * @param options.exceptSessionId - The one session id to spare, if any.
 * @param tx - The transaction the revocation commits with.
 * @returns The distinct ids of the sessions revoked, never the spared one.
 */
export function revokeSessionRows(
  userId: string,
  options: { exceptSessionId?: string },
  tx: DbTransaction
): Promise<string[]> {
  if (options.exceptSessionId === undefined) {
    return userTokenRepository.revokeAllForUser(userId, tx)
  }
  return userTokenRepository.revokeAllForUserExceptSession(userId, options.exceptSessionId, tx)
}

/**
 * Deny the sessions a committed password change or reset revoked. Never
 * rejects, because the change already stands. When Redis refuses, those
 * sessions' access tokens stay valid for up to ACCESS_TOKEN_TTL, as when the
 * denylist fails open, and one error line is logged.
 * @param userId - The user whose sessions were revoked.
 * @param sessionIds - The revoked session ids.
 * @returns Resolves once every denial is written or the failure is logged.
 */
export async function denySessionsAfterCommit(userId: string, sessionIds: string[]): Promise<void> {
  const outcomes = await Promise.all(sessionIds.map((sessionId) => denySession(sessionId)))
  const failed = outcomes.filter((outcome) => outcome === 'failed').length
  if (failed > 0) {
    logger.error('session denylist write failed after password change', {
      userId,
      sessionCount: failed,
    })
  }
}

/**
 * Revoke every live token belonging to a user, across every session, and
 * deny each revoked session's access tokens (best-effort — see
 * `denySession`). It takes no user row lock, so a rotation in flight can
 * outlive it; its callers (reset and the Google account claim) follow it
 * with a pass under the lock.
 * @param userId - The user whose sessions should all end.
 * @returns Resolves once every token is revoked and each revoked session is denied, best-effort.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  const sessionIds = await withTransaction((tx) => revokeSessionRows(userId, {}, tx))
  await denySessions(sessionIds)
}

/**
 * Revoke every live session belonging to a user except one, and deny each
 * revoked session's access tokens (best-effort — see `denySession`).
 * @param userId - The user whose sessions should all end, except one.
 * @param sessionId - The one session id to spare.
 * @returns Resolves once every other session's tokens are revoked and denied, best-effort.
 */
export async function revokeAllSessionsExceptCurrent(
  userId: string,
  sessionId: string
): Promise<void> {
  const sessionIds = await withTransaction((tx) =>
    revokeSessionRows(userId, { exceptSessionId: sessionId }, tx)
  )
  await denySessions(sessionIds)
}
