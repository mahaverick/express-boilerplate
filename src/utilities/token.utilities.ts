// src/utilities/token.utilities.ts
//
// Access tokens are signed JWTs (jsonwebtoken) — short-lived, stateless,
// carrying only the user id (`sub`). Refresh tokens are the opposite on
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
// of this module: a stolen refresh token is only containable if presenting
// it AFTER the legitimate client has already rotated it kills the entire
// session, not just that one token. See UserTokenRepository.claimOnce for
// how the race that would otherwise defeat this is closed — and how that
// same primitive now also guards email-verification and password-reset
// tokens, scoped so one purpose's token can never be claimed as another's.
import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { getEnv } from '@/configs/env.config'
import type { TokenPurpose } from '@/database/models/user-token.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/middlewares/error.middleware'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { parseDurationMs } from '@/utilities/duration.utilities'

// jsonwebtoken's `expiresIn` option is typed against `ms`'s own
// `StringValue` literal union — the identical narrowness
// duration.utilities.ts exists to work around — so this module converts a
// validated TTL to whole SECONDS (jsonwebtoken's numeric `expiresIn` unit)
// once, here, rather than fighting that type a second time.
const MS_PER_SECOND = 1000

// A raw token's length in bytes before hex-encoding, for every purpose. 32
// bytes (256 bits) hex-encodes to the 64 characters user-token.model.ts's
// `tokenHash` column width assumes for a SHA-256 digest — deliberately the
// same length as the hash, though the two are unrelated facts: the digest
// is fixed by SHA-256, and the raw token's length is this constant.
const RAW_TOKEN_BYTES = 32

const userTokenRepository = new UserTokenRepository()

/**
 * The claims this module signs into, and expects back out of, an access
 * token.
 */
export interface AccessTokenPayload {
  sub: string
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
 * Resolve a validated TTL string to milliseconds, trusting the invariant
 * `env.config.ts`'s refinement already enforced at boot.
 * @param value - An `ACCESS_TOKEN_TTL`/`REFRESH_TOKEN_TTL`-shaped value already known to be `ms()`-parseable.
 * @returns The duration in milliseconds.
 * @throws {Error} Only if that boot-time invariant was somehow violated.
 */
function requireDurationMs(value: string): number {
  const parsed = parseDurationMs(value)
  if (parsed === undefined) {
    // Unreachable in practice: getEnv() already rejects an unparseable TTL
    // at boot (env.config.ts). Guards the invariant explicitly rather than
    // asserting it away, so a future change that weakens that refinement
    // fails loudly here instead of silently signing a token with NaN.
    throw new Error(`Invalid duration string: "${value}"`)
  }
  return parsed
}

/**
 * SHA-256 hash a raw token, hex-encoded. Deterministic on purpose — see
 * user-token.model.ts's header comment for why that rules out bcrypt.
 * @param raw - The raw token, of any purpose.
 * @returns The hex-encoded digest, as stored in `tokenHash`.
 */
function hashToken(raw: string): string {
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
 * @returns The inserted row's id, the raw token to hand back, and its expiry.
 */
async function createTokenRow(
  userId: string,
  purpose: TokenPurpose,
  ttlMs: number,
  sessionId: string | undefined,
  sessionStartedAt: Date | undefined
): Promise<{ id: string; raw: string; expiresAt: Date }> {
  const raw = generateRawToken()
  const expiresAt = new Date(Date.now() + ttlMs)

  const row = await userTokenRepository.create({
    userId,
    purpose,
    sessionId,
    sessionStartedAt,
    tokenHash: hashToken(raw),
    expiresAt,
  })

  return { id: row.id, raw, expiresAt }
}

/**
 * Sign a short-lived access token carrying a user's id.
 * @param user - The authenticated user.
 * @returns A signed JWT, expiring after `ACCESS_TOKEN_TTL`.
 */
export function signAccessToken(user: User): string {
  const env = getEnv()
  const payload: AccessTokenPayload = { sub: user.id }
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
    return { ok: true, payload: { sub: decoded.sub } }
  } catch (error) {
    return { ok: false, reason: error instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' }
  }
}

/**
 * Issue a new refresh token for a session.
 * @param userId - The user the token belongs to.
 * @param sessionId - The session (rotation-chain) id this token starts or continues.
 * @returns The raw token to hand to the client, and its metadata.
 */
export async function issueRefreshToken(
  userId: string,
  sessionId: string
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
    sessionStartedAt
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
 * Redeem a refresh token for a new one, invalidating the old one.
 *
 * Reuse detection: if the presented token was already revoked — because it
 * was already rotated, or already logged out — presenting it again revokes
 * every token in its session, not just this one. A legitimate client only
 * ever presents a token once; a second presentation of an already-used
 * token means someone else has it.
 *
 * Two clocks stop a rotation, and they are not the same clock. The token's
 * own `expiresAt` is a SLIDING window reset by every rotation — it bounds
 * how long a client may go idle. The session's `sessionStartedAt` is an
 * ABSOLUTE ceiling (`SESSION_ABSOLUTE_TTL`) copied forward unchanged — it
 * bounds how long one login may live at all, however diligently it
 * refreshes. Without the second, a client refreshing every 15 minutes (as
 * `ACCESS_TOKEN_TTL` implies) holds a session forever, and so does anyone
 * who exfiltrated its cookie.
 * @param raw - The raw refresh token presented by the client.
 * @returns The new raw token to hand to the client, and its metadata.
 * @throws {HttpError} 401, when the token is unknown, already used, expired, or belongs to a session past its absolute lifetime.
 */
export async function rotateRefreshToken(raw: string): Promise<IssuedRefreshToken> {
  const tokenHash = hashToken(raw)
  const claimed = await userTokenRepository.claimOnce(tokenHash, 'refresh')

  if (!claimed) {
    // Either this hash was never issued, it was issued for a DIFFERENT
    // purpose (e.g. a password-reset token presented here by mistake — see
    // claimOnce's purpose predicate), or it is a refresh token that is
    // already revoked, which is the reuse signal. Only the last case has a
    // session worth containing; `findByHash` is purpose-agnostic, so
    // `existing` may be a row of another purpose, and only a 'refresh' row
    // ever has a non-null `sessionId` to revoke.
    const existing = await userTokenRepository.findByHash(tokenHash)
    if (existing && existing.sessionId !== null) {
      await userTokenRepository.revokeAllForSession(existing.sessionId)
    }
    throw new HttpError('Invalid refresh token', 401)
  }

  // sessionId/sessionStartedAt are nullable at the column level (they mean
  // nothing outside 'refresh', see user-token.model.ts), but `claimed` was
  // just claimed under the 'refresh' predicate above, and issueRefreshToken
  // — the only writer of a 'refresh' row — always fills both together.
  // Narrowing here, rather than asserting the type away, so a future bug
  // that broke that invariant fails loudly as a 401 instead of a runtime
  // crash further down.
  const { sessionId, sessionStartedAt } = claimed
  if (sessionId === null || sessionStartedAt === null) {
    throw new HttpError('Invalid refresh token', 401)
  }

  if (claimed.expiresAt.getTime() < Date.now()) {
    // Already claimed (revoked) above by the same statement that read it —
    // an expired token is simply revoked, not rotated further. This is not
    // a reuse signal: nothing else in the session is implicated.
    throw new HttpError('Refresh token expired', 401)
  }

  const env = getEnv()
  const sessionAgeMs = Date.now() - sessionStartedAt.getTime()
  if (sessionAgeMs >= requireDurationMs(env.SESSION_ABSOLUTE_TTL)) {
    // The absolute ceiling, which `expiresAt` above cannot enforce: that is
    // a sliding window every rotation resets, so a client that refreshes
    // before each expiry keeps a session alive indefinitely — and so does
    // anyone who stole its cookie. `sessionStartedAt` is copied forward
    // unchanged by rotation (below), so this measures the age of the LOGIN,
    // not of the token just presented.
    //
    // The whole family is revoked, unlike the expiry case above: every
    // other token in this session shares the same `sessionStartedAt` and is
    // therefore equally past the ceiling. Leaving them nominally live would
    // make the table disagree with the rule this function enforces, for no
    // gain — they could not be rotated either.
    await userTokenRepository.revokeAllForSession(sessionId)
    // Deliberately the SAME message the expiry branch uses. A third
    // distinguishable rejection would tell a caller holding a valid refresh
    // token which of the two clocks ran out, and "expired" is a true
    // description of both.
    throw new HttpError('Refresh token expired', 401)
  }

  // Copies sessionId/sessionStartedAt forward rather than recomputing them:
  // this is what makes the ceiling above an ABSOLUTE limit rather than
  // another sliding one.
  const {
    id,
    raw: newRaw,
    expiresAt,
  } = await createTokenRow(
    claimed.userId,
    'refresh',
    requireDurationMs(env.REFRESH_TOKEN_TTL),
    sessionId,
    sessionStartedAt
  )

  await userTokenRepository.update(claimed.id, { replacedById: id })

  return { raw: newRaw, userId: claimed.userId, sessionId, expiresAt }
}

/**
 * Revoke every live refresh token in one session — every token descended
 * from one login, on one device. Used by a single-session logout, and by
 * `rotateRefreshToken`'s reuse detection to contain a compromised chain.
 * @param sessionId - The session (rotation-chain) id to revoke.
 * @returns Resolves once every token in the session is revoked.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await userTokenRepository.revokeAllForSession(sessionId)
}

/**
 * Revoke the session a raw refresh token belongs to — logout's primitive.
 *
 * Resolves quietly for a token that is missing, forged, already revoked, or
 * issued for a different purpose entirely (a password-reset or
 * email-verification token's raw value presented here has no session to
 * revoke, and `findByHash` is purpose-agnostic so it would still be found);
 * it never distinguishes any of those from a live one in what it returns or
 * how long it takes. Logout must feel like unconditional success to
 * whoever calls it, not a way to test whether a given token string is
 * still live — exactly the same reasoning `rotateRefreshToken` (this
 * module) and the login endpoint (auth.controller.ts) already apply to
 * their own callers.
 * @param raw - The raw refresh token presented by the client.
 * @returns Resolves once the token's session (if any matched) is revoked.
 */
export async function revokeRefreshToken(raw: string): Promise<void> {
  const existing = await userTokenRepository.findByHash(hashToken(raw))
  if (existing && existing.sessionId !== null) {
    await userTokenRepository.revokeAllForSession(existing.sessionId)
  }
}

/**
 * Revoke every live refresh token belonging to a user, across every
 * session. Used where every session must end at once — e.g. a password
 * change, or a "log out everywhere" action.
 * @param userId - The user whose sessions should all end.
 * @returns Resolves once every one of the user's tokens is revoked.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await userTokenRepository.revokeAllForUser(userId)
}
