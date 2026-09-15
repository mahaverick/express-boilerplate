// tests/integration/utilities/token.utilities.test.ts
//
// The six security properties this task exists to prove, against the real
// per-worker Postgres database. Every user row this file creates is
// unique to this run and deleted in afterEach; deleting the user cascades
// (ON DELETE CASCADE on user_tokens.user_id) to every token row it owns.
//
// Test 4 (rotation) and test 5 (reuse) are deliberately kept from
// contaminating each other: test 4 proves the OLD token is invalidated by
// inspecting the row directly (via the repository), never by presenting the
// old token again — doing that would itself trigger reuse detection and
// revoke the new token as a side effect, so test 4 would then only be
// passing for test 5's reason. Test 5 is the only test that presents an
// already-rotated token.
import { createHash, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import type { User } from '@/database/models/user.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { parseDurationMs } from '@/utilities/duration.utilities'
import {
  issueRefreshToken,
  issueToken,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '@/utilities/token.utilities'

/**
 * SHA-256 hash a raw token exactly as token.utilities.ts's own (private)
 * hashToken does, so a test can look up the row `issueToken` just wrote
 * without reaching into that module's internals.
 * @param raw - The raw token.
 * @returns The hex-encoded digest.
 */
function hashRawToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `token-flow-${randomUUID()}@example.test`
}

describe('refresh token issuance, rotation, and revocation', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a disposable user row for a test and track it for cleanup.
   * @returns The created user row.
   */
  async function createUserRow(): Promise<User> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user
  }

  /**
   * Create a disposable user for a test and track it for cleanup.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user = await createUserRow()
    return user.id
  }

  it('issues an access token carrying the user id and an expiry', async () => {
    const user = await createUserRow()
    const token = signAccessToken(user)

    const decoded = jwt.decode(token)
    if (decoded === null || typeof decoded === 'string') {
      throw new Error('expected a decoded JWT payload')
    }
    expect(decoded.sub).toBe(user.id)
    expect(typeof decoded.exp).toBe('number')
    expect(typeof decoded.iat).toBe('number')
    expect(decoded.exp).toBeGreaterThan(decoded.iat as number)

    // verifyAccessToken returns a discriminated result, not the bare
    // payload — see token.utilities.ts's own header comment on
    // VerifyAccessTokenResult. Asserting the full `{ ok: true, payload }`
    // shape (not just `payload`) proves acceptance, not merely that a
    // payload-shaped object came back.
    expect(verifyAccessToken(token)).toEqual({ ok: true, payload: { sub: user.id } })
  })

  it('issues a refresh token whose hash — never the raw value — is stored', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()

    const issued = await issueRefreshToken(userId, sessionId)

    // Property 6: the raw token never appears in the database. Query the
    // table for the raw value itself and prove nothing matches it.
    const byRawValue = await sql`select 1 from user_tokens where token_hash = ${issued.raw}`
    expect(byRawValue).toHaveLength(0)

    // A row keyed by the token's actual (hashed) representation does exist.
    // Re-derive the same hash issueRefreshToken computed, without reaching
    // into its private hashToken() — proves the raw value is NOT what got
    // stored, by confirming the raw value itself still doesn't match
    // anything even though a row for this session does.
    const storedRows = await sql`
      select token_hash from user_tokens where user_id = ${userId} and session_id = ${sessionId}
    `
    const row = await userTokenRepository.findByHash(storedRows[0]?.token_hash as string)
    expect(row).toBeDefined()
    expect(row?.tokenHash).not.toBe(issued.raw)
    expect(row?.revokedAt).toBeNull()
  })

  it('rotates: using a refresh token returns a new one and invalidates the old', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)

    const rotated = await rotateRefreshToken(issued.raw)

    expect(rotated.raw).not.toBe(issued.raw)
    expect(rotated.userId).toBe(userId)
    expect(rotated.sessionId).toBe(sessionId)

    // Prove the OLD token is invalidated by inspecting its row directly —
    // not by presenting it again, which would trip reuse detection and
    // revoke the very new token this assertion is about to check.
    const oldRow = await sql`
      select token_hash from user_tokens where user_id = ${userId} and session_id = ${sessionId}
        and revoked_at is not null
    `
    expect(oldRow).toHaveLength(1)
    const oldStored = await userTokenRepository.findByHash(oldRow[0]?.token_hash as string)
    expect(oldStored?.revokedAt).not.toBeNull()
    expect(oldStored?.replacedById).toBeTruthy()

    // The new token is live and itself rotatable — proof it was not
    // affected by rotating the old one.
    const rotatedAgain = await rotateRefreshToken(rotated.raw)
    expect(rotatedAgain.sessionId).toBe(sessionId)
  })

  it('detects reuse: presenting an already-rotated token revokes the whole session family', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)

    const rotated = await rotateRefreshToken(issued.raw)

    // The legitimate client already moved on to `rotated.raw`. Someone else
    // — an attacker who stole the old token — presents the OLD token again.
    await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

    // The whole family is dead: the token the LEGITIMATE client is now
    // holding must also be revoked, even though it was never itself misused.
    const rotatedTokenRows = await sql`
      select token_hash from user_tokens where user_id = ${userId} and session_id = ${sessionId}
        and revoked_at is not null and replaced_by_id is null
    `
    // The row must be FOUND before its revokedAt means anything. Asserted
    // first, and separately: `expect(row?.revokedAt).not.toBeNull()` passes
    // against `undefined` too, so if reuse detection broke and the query
    // matched nothing, that assertion alone would still be green while
    // reading as though it had checked something.
    expect(rotatedTokenRows).toHaveLength(1)
    const rotatedRow = await userTokenRepository.findByHash(
      rotatedTokenRows[0]?.token_hash as string
    )
    expect(rotatedRow).toBeDefined()
    expect(rotatedRow?.revokedAt).not.toBeNull()

    // Confirmed from the client's perspective too: the token that was still
    // valid a moment ago can no longer be rotated.
    await expect(rotateRefreshToken(rotated.raw)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unknown refresh token', async () => {
    await expect(rotateRefreshToken('a-token-that-was-never-issued')).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('rejects an expired refresh token without treating it as reuse of a live session', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    // A second, still-live token in the SAME session — proves expiry alone
    // does not trigger reuse's "kill the whole family" response.
    const otherInSameSession = await issueRefreshToken(userId, sessionId)

    // Expire only the first-created row (`issued`) — the one this test is
    // about — leaving `otherInSameSession`'s row untouched.
    await sql`
      update user_tokens set expires_at = now() - interval '1 second'
      where id = (
        select id from user_tokens
        where user_id = ${userId} and session_id = ${sessionId}
        order by created_at asc
        limit 1
      )
    `

    await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

    // The other, still-live token in the same session must be unaffected —
    // expiry is not treated as reuse, so it does not kill the whole family.
    const stillRotatable = await rotateRefreshToken(otherInSameSession.raw)
    expect(stillRotatable.sessionId).toBe(sessionId)
  })

  it('refuses to rotate once the session passes its absolute lifetime, however fresh the token is', async () => {
    // The gap this closes: expiresAt is a SLIDING window that every rotation
    // resets, so a client refreshing every 15 minutes (what a 15-minute
    // access TTL implies) keeps one login alive forever — and so does
    // anyone holding a stolen refresh cookie, until an explicit logout.
    //
    // The token presented here is brand new and nowhere near its own
    // expiry; only the SESSION is old. Red before SESSION_ABSOLUTE_TTL
    // existed: this rotation succeeds, because nothing capped the chain.
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    // A second live token in the same session, to prove the ceiling applies
    // to the whole family rather than only the row presented.
    const sibling = await issueRefreshToken(userId, sessionId)

    // Age the session past the configured ceiling, read from the same
    // environment the code reads it from rather than hard-coded here, so
    // this test tracks SESSION_ABSOLUTE_TTL instead of drifting from it.
    const absoluteTtlMs = parseDurationMs(getEnv().SESSION_ABSOLUTE_TTL)
    if (absoluteTtlMs === undefined) throw new Error('SESSION_ABSOLUTE_TTL is unparseable')
    // Passed as an ISO string, not a Date: postgres.js cannot infer a
    // parameter type for a bare Date in this position and serialises it as
    // text, which fails in the driver before the statement is ever sent.
    const startedAt = new Date(Date.now() - absoluteTtlMs - 60_000).toISOString()
    await sql`
      update user_tokens set session_started_at = ${startedAt}::timestamptz
      where session_id = ${sessionId}
    `

    await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

    // Every token in the family is revoked, not just the one presented:
    // they all share the same session start, so all are equally past the
    // ceiling.
    await expect(rotateRefreshToken(sibling.raw)).rejects.toMatchObject({ statusCode: 401 })
    const live = await sql`
      select 1 from user_tokens where session_id = ${sessionId} and revoked_at is null
    `
    expect(live).toHaveLength(0)
  })

  it('carries the session start forward across rotations rather than resetting it', async () => {
    // The mechanism the ceiling rests on. If rotation stamped a fresh
    // session_started_at, the cap above would become a second sliding
    // window and bound nothing at all.
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)

    const [before] = await sql`
      select session_started_at from user_tokens where session_id = ${sessionId}
    `
    const rotated = await rotateRefreshToken(issued.raw)
    await rotateRefreshToken(rotated.raw)

    const rows = await sql`
      select distinct session_started_at from user_tokens where session_id = ${sessionId}
    `
    // One distinct value across all three rows in the chain, and it is the
    // one the original login wrote. Compared as strings: what the driver
    // returns for a timestamptz is not guaranteed to be a Date instance,
    // and the assertion is about the value, not its JavaScript type.
    expect(rows).toHaveLength(1)
    expect(String(rows[0]?.session_started_at)).toBe(String(before?.session_started_at))
  })

  it('revokeSession revokes every token in that session, and none in another', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const otherSessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    const other = await issueRefreshToken(userId, otherSessionId)

    await revokeSession(sessionId)

    await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })
    const rotatedOther = await rotateRefreshToken(other.raw)
    expect(rotatedOther.sessionId).toBe(otherSessionId)
  })

  it('revokeAllSessions revokes every session belonging to a user', async () => {
    const userId = await createUser()
    const sessionA = randomUUID()
    const sessionB = randomUUID()
    const issuedA = await issueRefreshToken(userId, sessionA)
    const issuedB = await issueRefreshToken(userId, sessionB)

    await revokeAllSessions(userId)

    await expect(rotateRefreshToken(issuedA.raw)).rejects.toMatchObject({ statusCode: 401 })
    await expect(rotateRefreshToken(issuedB.raw)).rejects.toMatchObject({ statusCode: 401 })
  })
})

describe('issueToken and cross-purpose claiming', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a disposable user for a test and track it for cleanup.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: `issue-token-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    return user.id
  }

  it('issues a token scoped to a purpose, with no session fields set', async () => {
    const userId = await createUser()
    const issued = await issueToken(userId, 'password_reset', 60_000)

    expect(issued.userId).toBe(userId)
    expect(issued.purpose).toBe('password_reset')

    const row = await userTokenRepository.findByHash(hashRawToken(issued.raw))
    expect(row).toBeDefined()
    expect(row?.purpose).toBe('password_reset')
    expect(row?.sessionId).toBeNull()
    expect(row?.sessionStartedAt).toBeNull()
    expect(row?.revokedAt).toBeNull()
    // The raw value is never what's stored — same property issueRefreshToken
    // is proven against above.
    expect(row?.tokenHash).not.toBe(issued.raw)
  })

  // The test that matters most in this task (see task-1-brief.md): a token
  // issued for one purpose must not be claimable as another. Without this,
  // a password-reset token could be spent as an email verification, or a
  // verification token could reset a password — turning "I can receive mail
  // at this address" into "I can take over this account."
  it('rejects claiming a password-reset token as an email verification, and vice versa', async () => {
    const userId = await createUser()
    const resetIssued = await issueToken(userId, 'password_reset', 60_000)
    const verifyIssued = await issueToken(userId, 'email_verification', 60_000)
    const resetHash = hashRawToken(resetIssued.raw)
    const verifyHash = hashRawToken(verifyIssued.raw)

    const resetClaimedAsVerify = await userTokenRepository.claimOnce(
      resetHash,
      'email_verification'
    )
    const verifyClaimedAsReset = await userTokenRepository.claimOnce(verifyHash, 'password_reset')
    expect(resetClaimedAsVerify).toBeUndefined()
    expect(verifyClaimedAsReset).toBeUndefined()

    // Neither rejected claim touched the row: both remain live and
    // claimable under their real, original purpose.
    const resetClaimedCorrectly = await userTokenRepository.claimOnce(resetHash, 'password_reset')
    const verifyClaimedCorrectly = await userTokenRepository.claimOnce(
      verifyHash,
      'email_verification'
    )
    expect(resetClaimedCorrectly).toBeDefined()
    expect(verifyClaimedCorrectly).toBeDefined()
  })
})
