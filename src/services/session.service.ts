/**
 * @file Access and refresh tokens. Access tokens are short-lived HS256 JWTs;
 * refresh tokens are opaque random strings stored as SHA-256 hashes, since a
 * refresh token must be revocable server-side anyway and a JWT would only leak
 * its claims. Every revocation here also denies the revoked sessions' access
 * tokens, best-effort, except `revokeSessionRows`, whose caller denies after commit.
 * The repository only revokes rows and reports the sessions; it never writes Redis.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE, REFRESH_REUSE_GRACE_MS } from '@/constants/auth.constants'
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
import { emitDomainEvent } from '@/services/domain-events.service'
import { logger } from '@/services/logger.service'
import { denySession } from '@/services/session-denylist.service'
import { MS_PER_SECOND, requireDurationMs } from '@/utilities/duration.utilities'

/**
 * A raw token's length in bytes before hex-encoding, for every purpose: 256
 * bits, 64 hex characters.
 */
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
 * @returns How many token rows this call revoked.
 */
async function revokeSessionUnderUserLock(userId: string, sessionId: string): Promise<number> {
  const revoked = await withTransaction(async (tx) => {
    await userRepository.lockById(userId, 'no key update', tx)
    return userTokenRepository.revokeAllForSession(sessionId, tx)
  })
  await denySession(sessionId, userId)
  return revoked
}

/**
 * The claims this module signs into, and expects back out of, an access
 * token.
 */
interface AccessTokenPayload {
  sub: string
  /**
   * The session this token belongs to. Optional: a token without it still
   * verifies, cannot be revoked, and is accepted until it expires.
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
  /**
   * When the session last authenticated, in seconds since the epoch (the
   * OpenID Connect claim name). `requireRecentAuth` (auth.middleware.ts)
   * reads it. Absent on a token whose session predates migration 0018,
   * which that middleware treats as stale.
   */
  auth_time?: number
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
  /**
   * When the session last authenticated, as stored on the token's row; the
   * caller signs it into the access token. Null only for a session that
   * started before migration 0018.
   */
  authenticatedAt: Date | null
}

/**
 * A freshly issued token for a non-session purpose (email verification,
 * password reset): the raw value to hand to the caller (an email link, in
 * practice), and everything about it that isn't recoverable from the raw
 * value alone. No `sessionId`, which means nothing outside `'refresh'`, and
 * `purpose` excludes `'refresh'` (see `issueToken`).
 */
export interface IssuedToken {
  raw: string
  userId: string
  purpose: Exclude<TokenPurpose, 'refresh'>
  expiresAt: Date
}

/**
 * SHA-256 hash a raw token, hex-encoded. Deterministic, so a token is found
 * by its hash; that rules out bcrypt (see user-token.model.ts).
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
 * Generate, hash, and persist one token row: the single insert every issuing
 * path in this module goes through. Session fields apply to `'refresh'` only.
 * @param userId - The user the token belongs to.
 * @param purpose - Which of `TokenPurpose`'s three things this row is.
 * @param ttlMs - How long the token is valid for, in milliseconds.
 * @param session - For `'refresh'`: the rotation-chain id, when the chain began, and when it last authenticated. Omitted for every other purpose, leaving all three columns NULL (none has a DB default).
 * @param session.sessionId - The rotation-chain id.
 * @param session.sessionStartedAt - When that chain began.
 * @param session.authenticatedAt - When it last authenticated; null for a chain from before migration 0018.
 * @param executor - Where to insert. Defaults to the pool.
 * @returns The inserted row's id, the raw token to hand back, and its expiry.
 */
async function createTokenRow(
  userId: string,
  purpose: TokenPurpose,
  ttlMs: number,
  session: { sessionId: string; sessionStartedAt: Date; authenticatedAt: Date | null } | undefined,
  executor: DbExecutor = db
): Promise<{ id: string; raw: string; expiresAt: Date }> {
  const raw = generateRawToken()
  const expiresAt = new Date(Date.now() + ttlMs)

  const row = await userTokenRepository.create(
    {
      userId,
      purpose,
      sessionId: session?.sessionId,
      sessionStartedAt: session?.sessionStartedAt,
      authenticatedAt: session?.authenticatedAt,
      tokenHash: hashToken(raw),
      expiresAt,
    },
    executor
  )

  return { id: row.id, raw, expiresAt }
}

/**
 * Sign a short-lived access token carrying a user's id, their session, and
 * when that session last authenticated.
 * @param user - The authenticated user.
 * @param sessionId - The session this token belongs to.
 * @param authenticatedAt - When the session last authenticated, signed as `auth_time`; null or omitted leaves the claim out, which step-up routes treat as stale.
 * @returns A signed JWT, expiring after `ACCESS_TOKEN_TTL`.
 */
export function signAccessToken(
  user: User,
  sessionId: string,
  // eslint-disable-next-line unicorn/no-null -- the stored column is null for a session before migration 0018
  authenticatedAt: Date | null = null
): string {
  const env = getEnv()
  const payload: AccessTokenPayload = { sub: user.id, sid: sessionId, jti: randomUUID() }
  if (authenticatedAt !== null) {
    payload.auth_time = Math.floor(authenticatedAt.getTime() / MS_PER_SECOND)
  }
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
    const payload: AccessTokenPayload = { sub: decoded.sub }
    if (typeof decoded.sid === 'string') payload.sid = decoded.sid
    if (typeof decoded.jti === 'string') payload.jti = decoded.jti
    if (typeof decoded.exp === 'number') payload.exp = decoded.exp
    if (typeof decoded.auth_time === 'number') payload.auth_time = decoded.auth_time
    return { ok: true, payload }
  } catch (error) {
    return { ok: false, reason: error instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' }
  }
}

/**
 * Issue a new refresh token for a session. This starts the session's absolute
 * clock (`sessionStartedAt`). The session's authentication time starts at the
 * same moment. `rotateRefreshToken` copies both forward instead of calling
 * this. Calling it again for an existing sessionId would restart both clocks;
 * login always mints a fresh sessionId.
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
  const sessionStartedAt = new Date()

  const { raw, expiresAt } = await createTokenRow(
    userId,
    'refresh',
    requireDurationMs(env.REFRESH_TOKEN_TTL),
    { sessionId, sessionStartedAt, authenticatedAt: sessionStartedAt },
    executor
  )

  return { raw, userId, sessionId, expiresAt, authenticatedAt: sessionStartedAt }
}

/**
 * Issue a new token for a purpose that has no session: email verification or
 * password reset. `'refresh'` is excluded at the type level: minted here it
 * would have no session id, so `revokeAllForSession` could never find it and
 * reuse detection could never contain it. `issueRefreshToken` is its one entry point.
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
  const { raw, expiresAt } = await createTokenRow(userId, purpose, ttlMs, undefined)
  return { raw, userId, purpose, expiresAt }
}

/**
 * Claim a non-session token — email verification or password reset — once,
 * atomically, and only while it is still live.
 *
 * `claimOnce` (user-token.repository.ts) leaves expiry to its caller, so it is
 * checked here; without it a mailed link would be redeemable forever. The row
 * is claimed before expiry is judged, so presenting an expired token still
 * spends it: one presentation is one attempt.
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
 *
 * Only a kill marker at or after the presented row's consumption refuses grace (`isSessionKilled`): an older one is a revoke that spared this chain, such as a sibling a password change or sign-out of other sessions ended, and the session keeps its grace window.
 * @param existing - The already-claimed row the presented token hashes to.
 * @param tx - The rotation's transaction.
 * @returns The session to continue when every grace condition holds and the session was not killed, otherwise undefined.
 */
async function findGraceSession(
  existing: UserToken,
  tx: DbTransaction
): Promise<
  { sessionId: string; sessionStartedAt: Date; authenticatedAt: Date | null } | undefined
> {
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
  // Committed kill markers since this row's consumption only, so a sibling rotation still in flight can't look like a logout.
  if (await userTokenRepository.isSessionKilled(sessionId, tokenHash, tx)) return undefined
  return { sessionId, sessionStartedAt, authenticatedAt: existing.authenticatedAt }
}

/**
 * Issue the next refresh token in a session, enforcing the session's absolute
 * lifetime. Every token in a session shares its start time, so past the ceiling
 * all of them are; the refusal's message matches the expiry branch's, so a
 * caller can't tell which clock ran out.
 * @param userId - The session's user.
 * @param sessionId - The session (rotation-chain) id.
 * @param sessionStartedAt - When the session began; copied forward so the absolute TTL never resets.
 * @param authenticatedAt - When the session last authenticated; copied forward like sessionStartedAt.
 * @param tx - The rotation's transaction.
 * @returns The new row's id and token; or, past `SESSION_ABSOLUTE_TTL`, a refusal naming the session to kill.
 */
async function continueSession(
  userId: string,
  sessionId: string,
  sessionStartedAt: Date,
  authenticatedAt: Date | null,
  tx: DbTransaction
): Promise<RotationOutcome> {
  const env = getEnv()
  const sessionAgeMs = Date.now() - sessionStartedAt.getTime()
  if (sessionAgeMs >= requireDurationMs(env.SESSION_ABSOLUTE_TTL)) {
    return { ok: false, message: 'Refresh token expired', killSessionId: sessionId }
  }

  const { id, raw, expiresAt } = await createTokenRow(
    userId,
    'refresh',
    requireDurationMs(env.REFRESH_TOKEN_TTL),
    { sessionId, sessionStartedAt, authenticatedAt },
    tx
  )
  return { ok: true, id, issued: { raw, userId, sessionId, expiresAt, authenticatedAt } }
}

/**
 * One rotation attempt under the user row lock. Every refusal is returned,
 * not thrown, so the transaction still commits the claim. A session to kill
 * is revoked after commit, under FOR NO KEY UPDATE, never in this FOR SHARE
 * transaction: upgrading here would deadlock two concurrent reuses. The
 * FOR SHARE lock waits for a password change or reset in flight; a
 * soft-deleted user has no row to lock, and refresh() (auth.service.ts)
 * refuses that user afterwards.
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
  await userRepository.lockById(userId, 'share', tx)
  const claimed = await userTokenRepository.claimOnce(tokenHash, 'refresh', tx)

  if (!claimed) {
    // Never issued as 'refresh', or already revoked (the reuse signal); only a 'refresh' row has a session.
    const existing = await userTokenRepository.findByHash(tokenHash, {}, tx)
    const graceSession = existing ? await findGraceSession(existing, tx) : undefined
    if (existing && graceSession) {
      return continueSession(
        existing.userId,
        graceSession.sessionId,
        graceSession.sessionStartedAt,
        graceSession.authenticatedAt,
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

  const next = await continueSession(
    claimed.userId,
    sessionId,
    sessionStartedAt,
    claimed.authenticatedAt,
    tx
  )
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
 * Logout, those kills, the Google account claim and password writes lock the
 * row FOR NO KEY UPDATE before their in-transaction revoke (`revokeAllSessions`'
 * first pass takes no lock), so a rotation either commits first and its new
 * token is revoked, or waits and finds the presented token revoked.
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
 * Revoke the session a raw refresh token belongs to, under the user row
 * lock, and deny its access tokens (best-effort — see `denySession`) —
 * logout's primitive.
 *
 * Resolves quietly for a token that is missing, forged, already revoked, or
 * issued for a different purpose entirely (a password-reset or
 * email-verification token's raw value presented here has no session to
 * revoke, and `findByHash` is purpose-agnostic so it would still be found);
 * it never distinguishes any of those from a live one in what it returns. A
 * matched token opens a locked transaction and a miss returns at once, so
 * the time it takes is not uniform. Logout must feel like unconditional success to
 * whoever calls it, not a way to test whether a given token string is
 * still live — exactly the same reasoning `rotateRefreshToken` (this
 * module) and login (auth.service.ts) already apply to their own callers.
 * A live token (not revoked, not expired) whose revoke changed rows emits
 * `user_signed_out` after it, on the matched branch only, which already
 * takes longer than a miss. The locked revoke decides who changed them, so
 * concurrent or replayed sign-outs count once, and a lapsed session counts
 * never.
 * @param raw - The raw refresh token presented by the client.
 * @param options - `emitSignedOut: false` revokes silently, for a sign-in that replaces the session; default true.
 * @param options.emitSignedOut - Whether a live revoke emits `user_signed_out`.
 * @returns Resolves once the token's session (if any matched) is revoked and its access tokens are denied, best-effort.
 */
export async function revokeRefreshToken(
  raw: string,
  options: { emitSignedOut?: boolean } = {}
): Promise<void> {
  const existing = await userTokenRepository.findByHash(hashToken(raw))
  if (!existing || existing.sessionId === null) return
  const revoked = await revokeSessionUnderUserLock(existing.userId, existing.sessionId)
  const isLive = existing.expiresAt.getTime() > Date.now() && existing.revokedAt === null
  if (isLive && revoked > 0 && options.emitSignedOut !== false) {
    await emitDomainEvent({ type: 'user_signed_out', userId: existing.userId, at: new Date() })
  }
}

/**
 * The caller's own refresh row, named by the refresh cookie its request
 * presented: found only when that row belongs to the caller, is a refresh
 * token of the caller's session (the access token's `sid`), and is the live
 * head of its chain (not revoked). Anything else (an unknown, revoked or
 * foreign token, another session's) names nothing, and the caller's whole
 * session is spared as before. Read in the caller's transaction, after its
 * user row lock, so no rotation of that chain is in flight.
 * @param userId - The authenticated caller.
 * @param sessionId - The caller's session, from the access token's `sid`.
 * @param presentedRefreshToken - The raw refresh token the request presented.
 * @param tx - The caller's transaction.
 * @returns The row's id, or undefined when the token does not name the caller's chain.
 */
async function findCallerRefreshTokenId(
  userId: string,
  sessionId: string,
  presentedRefreshToken: string,
  tx: DbTransaction
): Promise<string | undefined> {
  const row = await userTokenRepository.findByHash(hashToken(presentedRefreshToken), {}, tx)
  if (!row) return undefined
  const isCallersHead =
    row.userId === userId &&
    row.purpose === 'refresh' &&
    row.sessionId === sessionId &&
    row.revokedAt === null
  return isCallersHead ? row.id : undefined
}

/**
 * Revoke a user's token rows in the caller's transaction and report the
 * sessions revoked. The denylist is left to `denySessionsAfterCommit`: a
 * denial written before commit would outlive a rollback.
 *
 * With `exceptSessionId` alone the whole session is spared. With a
 * `presentedRefreshToken` that names the caller's live chain
 * (`findCallerRefreshTokenId`), only that one row is spared, so a sibling a
 * grace-window replay minted in the same session ends too. Run it after the
 * user row lock, as every caller does.
 * @param userId - The user whose tokens are revoked, every purpose.
 * @param options - What to spare.
 * @param options.exceptSessionId - The one session id to spare, if any.
 * @param options.presentedRefreshToken - The caller's refresh cookie, if the request sent one; only read with `exceptSessionId`.
 * @param tx - The transaction the revocation commits with.
 * @returns The distinct ids of the sessions revoked, never the spared one.
 */
export async function revokeSessionRows(
  userId: string,
  options: { exceptSessionId?: string; presentedRefreshToken?: string | undefined },
  tx: DbTransaction
): Promise<string[]> {
  const { exceptSessionId, presentedRefreshToken } = options
  if (exceptSessionId === undefined) {
    return userTokenRepository.revokeAllForUser(userId, tx)
  }
  const callerTokenId =
    presentedRefreshToken === undefined
      ? undefined
      : await findCallerRefreshTokenId(userId, exceptSessionId, presentedRefreshToken, tx)
  if (callerTokenId === undefined) {
    return userTokenRepository.revokeAllForUserExceptSession(userId, exceptSessionId, tx)
  }
  return userTokenRepository.revokeAllForUserExceptToken(
    userId,
    { id: callerTokenId, sessionId: exceptSessionId },
    tx
  )
}

/**
 * Deny the sessions a committed revocation revoked: a password change or
 * reset, a Google account claim, or a staff deactivation, sign-out or
 * deletion. Never rejects,
 * because the revocation already stands. When Redis refuses, those
 * sessions' access tokens stay valid for up to ACCESS_TOKEN_TTL, as when the
 * denylist fails open, and one error line is logged. A denial still in flight
 * at the deadline (`'pending'`) is not counted here: it lands when Redis
 * answers, and if it fails instead `denySession` logs the same error line for
 * it, with this user id.
 * @param userId - The user whose sessions were revoked.
 * @param sessionIds - The revoked session ids.
 * @returns Resolves once every denial is written, left in flight past the deadline, or its failure logged.
 */
export async function denySessionsAfterCommit(userId: string, sessionIds: string[]): Promise<void> {
  const outcomes = await Promise.all(sessionIds.map((sessionId) => denySession(sessionId, userId)))
  const failed = outcomes.filter((outcome) => outcome === 'failed').length
  if (failed > 0) {
    logger.error('session denylist write failed after revocation', {
      userId,
      sessionCount: failed,
    })
  }
}

/**
 * The earliest start a session can have and still rotate: `SESSION_ABSOLUTE_TTL`
 * before now, as `continueSession` judges it. A session that started at or
 * before it is past its absolute lifetime, so no rotation would succeed.
 * @returns The cutoff, by the application clock.
 */
function absoluteLifetimeCutoff(): Date {
  return new Date(Date.now() - requireDurationMs(getEnv().SESSION_ABSOLUTE_TTL))
}

/**
 * Sign a user out of every session but the one making the request: revoke
 * their other sessions' token rows (and any reset or verification token)
 * under the user row lock, then deny each revoked session's access tokens
 * after commit, which also ends that session's notification stream at its
 * next heartbeat (`denySessionsAfterCommit`). Emits `other_sessions_revoked`.
 *
 * When the request presented the caller's live refresh cookie, a sibling
 * chain a grace-window replay minted in the calling session is revoked too
 * (`revokeSessionRows`); its access tokens share the caller's `sid`, so they
 * are not denied and last until ACCESS_TOKEN_TTL. No Origin check is needed:
 * the route authenticates with a bearer token a browser never attaches
 * cross-site, and the cookie only narrows what is spared.
 * @param userId - The authenticated caller.
 * @param sessionId - The calling session (the token's `sid`), which is spared; undefined for a token without one.
 * @param presentedRefreshToken - The refresh cookie the request carried, if any; it spares only the caller's own chain when it names it.
 * @returns How many other sessions were signed in (held an unrevoked, unexpired refresh token, within SESSION_ABSOLUTE_TTL) and are now revoked; a lapsed session is revoked but not counted, and neither is a sibling in the calling session.
 * @throws {HttpError} 401 with ACCESS_TOKEN_EXPIRED_CODE for a token without `sid`, or an account gone or inactive.
 */
export async function revokeOtherSessions(
  userId: string,
  sessionId: string | undefined,
  presentedRefreshToken?: string
): Promise<number> {
  if (sessionId === undefined) {
    throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
  }
  const { revoked, live } = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(userId, 'no key update', tx)
    if (!locked?.active) {
      throw new HttpError('Account no longer exists or is inactive', 401, ACCESS_TOKEN_EXPIRED_CODE)
    }
    const liveSessionIds = await userTokenRepository.liveSessionIdsExcept(
      userId,
      sessionId,
      absoluteLifetimeCutoff(),
      tx
    )
    const revokedSessionIds = await revokeSessionRows(
      userId,
      { exceptSessionId: sessionId, presentedRefreshToken },
      tx
    )
    return { revoked: revokedSessionIds, live: new Set(liveSessionIds) }
  })
  await denySessionsAfterCommit(userId, revoked)
  await emitDomainEvent({ type: 'other_sessions_revoked', userId, at: new Date() })
  return revoked.filter((revokedSessionId) => live.has(revokedSessionId)).length
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
  await denySessionsAfterCommit(userId, sessionIds)
}

/**
 * Record that a session's user just proved their identity again (by password,
 * `POST /auth/reauthenticate`): move
 * `authenticated_at` to now on every row of the session
 * (`markSessionAuthenticated`). Holds the user row FOR NO KEY UPDATE, which
 * waits for a rotation holding it FOR SHARE, so that rotation's new row
 * exists before the update and gets the new time.
 * @param userId - The session's user.
 * @param sessionId - The session (rotation-chain) id, from the access token's `sid`.
 * @param tx - A caller's transaction to run in, so an audit entry can commit with the change; a transaction of its own when omitted.
 * @returns The new authentication time, for the caller to sign into a fresh access token.
 * @throws {HttpError} 401 with ACCESS_TOKEN_EXPIRED_CODE when the user is gone, soft-deleted or inactive, or the session has no live refresh token (logged out, revoked, expired, past SESSION_ABSOLUTE_TTL, or not this user's): the client's refresh then fails and it signs in again.
 */
export function markSessionReauthenticated(
  userId: string,
  sessionId: string,
  tx?: DbTransaction
): Promise<Date> {
  const mark = async (transaction: DbTransaction): Promise<Date> => {
    const user = await userRepository.lockById(userId, 'no key update', transaction)
    if (!user?.active) throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
    const authenticatedAt = await userTokenRepository.markSessionAuthenticated(
      userId,
      sessionId,
      absoluteLifetimeCutoff(),
      transaction
    )
    if (!authenticatedAt) throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
    return authenticatedAt
  }
  return tx ? mark(tx) : withTransaction(mark)
}
