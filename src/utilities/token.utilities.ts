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
// session, not just that one token. See UserTokenRepository.claimForRotation
// for how the race that would otherwise defeat this is closed.
import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { getEnv } from '@/configs/env.config'
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

// A raw refresh token's length in bytes before hex-encoding. 32 bytes
// (256 bits) hex-encodes to the 64 characters user-token.model.ts's
// `tokenHash` column width assumes for a SHA-256 digest — deliberately the
// same length as the hash, though the two are unrelated facts: the digest
// is fixed by SHA-256, and the raw token's length is this constant.
const REFRESH_TOKEN_BYTES = 32

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
 * SHA-256 hash a raw refresh token, hex-encoded. Deterministic on purpose —
 * see user-token.model.ts's header comment for why that rules out bcrypt.
 * @param raw - The raw refresh token.
 * @returns The hex-encoded digest, as stored in `tokenHash`.
 */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Generate a new opaque refresh token.
 * @returns A hex-encoded, cryptographically random token.
 */
function generateRawToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('hex')
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
  const raw = generateRawToken()
  const expiresAt = new Date(Date.now() + requireDurationMs(env.REFRESH_TOKEN_TTL))

  await userTokenRepository.create({
    userId,
    sessionId,
    tokenHash: hashToken(raw),
    expiresAt,
  })

  return { raw, userId, sessionId, expiresAt }
}

/**
 * Redeem a refresh token for a new one, invalidating the old one.
 *
 * Reuse detection: if the presented token was already revoked — because it
 * was already rotated, or already logged out — presenting it again revokes
 * every token in its session, not just this one. A legitimate client only
 * ever presents a token once; a second presentation of an already-used
 * token means someone else has it.
 * @param raw - The raw refresh token presented by the client.
 * @returns The new raw token to hand to the client, and its metadata.
 * @throws {HttpError} 401, when the token is unknown, already used, or expired.
 */
export async function rotateRefreshToken(raw: string): Promise<IssuedRefreshToken> {
  const tokenHash = hashToken(raw)
  const claimed = await userTokenRepository.claimForRotation(tokenHash)

  if (!claimed) {
    // Either this hash was never issued, or it was — but is already
    // revoked, which is the reuse signal. Only the second case has a
    // session worth containing.
    const existing = await userTokenRepository.findByHash(tokenHash)
    if (existing) {
      await userTokenRepository.revokeAllForSession(existing.sessionId)
    }
    throw new HttpError('Invalid refresh token', 401)
  }

  if (claimed.expiresAt.getTime() < Date.now()) {
    // Already claimed (revoked) above by the same statement that read it —
    // an expired token is simply revoked, not rotated further. This is not
    // a reuse signal: nothing else in the session is implicated.
    throw new HttpError('Refresh token expired', 401)
  }

  const env = getEnv()
  const newRaw = generateRawToken()
  const expiresAt = new Date(Date.now() + requireDurationMs(env.REFRESH_TOKEN_TTL))

  const created = await userTokenRepository.create({
    userId: claimed.userId,
    sessionId: claimed.sessionId,
    tokenHash: hashToken(newRaw),
    expiresAt,
  })

  await userTokenRepository.update(claimed.id, { replacedById: created.id })

  return { raw: newRaw, userId: claimed.userId, sessionId: claimed.sessionId, expiresAt }
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
 * Revoke every live refresh token belonging to a user, across every
 * session. Used where every session must end at once — e.g. a password
 * change, or a "log out everywhere" action.
 * @param userId - The user whose sessions should all end.
 * @returns Resolves once every one of the user's tokens is revoked.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await userTokenRepository.revokeAllForUser(userId)
}
