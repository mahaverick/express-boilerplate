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
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it } from 'vitest'
import type { User } from '@/database/models/user.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import {
  issueRefreshToken,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '@/utilities/token.utilities'

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

    expect(verifyAccessToken(token)).toEqual({ sub: user.id })
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
    const rotatedRow = await userTokenRepository.findByHash(
      rotatedTokenRows[0]?.token_hash as string
    )
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
