// tests/integration/repositories/user-token.repository.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts). Every user row this file creates is
// unique to this run and deleted in afterEach; deleting the user cascades
// (ON DELETE CASCADE on user_tokens.user_id) to every token row it owns, so
// there is nothing separate to clean up there.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'

const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `user-token-repo-${randomUUID()}@example.test`
}

/**
 * A disposable, distinct token hash — stands in for a real SHA-256 digest;
 * these tests never need the hash to correspond to a real raw token.
 * @returns A 64-character hex string, unique to this call.
 */
function uniqueHash(): string {
  return randomBytes(32).toString('hex')
}

describe('UserTokenRepository', () => {
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
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  it('creates a token row and finds it again by hash', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const tokenHash = uniqueHash()
    const expiresAt = new Date(Date.now() + 60_000)

    const created = await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId,
      tokenHash,
      expiresAt,
    })
    expect(created.id).toBeTruthy()
    expect(created.revokedAt).toBeNull()
    expect(created.replacedById).toBeNull()

    const found = await userTokenRepository.findByHash(tokenHash)
    expect(found).toMatchObject({ id: created.id, userId, sessionId })
  })

  it('returns undefined from findByHash for a hash that does not exist', async () => {
    expect(await userTokenRepository.findByHash(uniqueHash())).toBeUndefined()
  })

  it('claimOnce revokes a live row of the matching purpose and returns it', async () => {
    const userId = await createUser()
    const tokenHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const claimed = await userTokenRepository.claimOnce(tokenHash, 'refresh')
    // RETURNING reflects the row AFTER this UPDATE, so revokedAt/consumedAt
    // are already set.
    expect(claimed?.revokedAt).not.toBeNull()
    expect(claimed?.consumedAt).not.toBeNull()
    expect(claimed?.tokenHash).toBe(tokenHash)

    const after = await userTokenRepository.findByHash(tokenHash)
    expect(after?.revokedAt).not.toBeNull()
  })

  it('claimOnce returns undefined for a hash that does not exist', async () => {
    expect(await userTokenRepository.claimOnce(uniqueHash(), 'refresh')).toBeUndefined()
  })

  it('claimOnce returns undefined for an already-revoked row, without re-revoking it', async () => {
    const userId = await createUser()
    const tokenHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const firstClaim = await userTokenRepository.claimOnce(tokenHash, 'refresh')
    const afterFirstClaim = await userTokenRepository.findByHash(tokenHash)
    const firstRevokedAt = afterFirstClaim?.revokedAt

    const secondClaim = await userTokenRepository.claimOnce(tokenHash, 'refresh')
    expect(firstClaim).toBeDefined()
    expect(secondClaim).toBeUndefined()

    const afterSecondClaim = await userTokenRepository.findByHash(tokenHash)
    const secondRevokedAt = afterSecondClaim?.revokedAt
    expect(secondRevokedAt?.getTime()).toBe(firstRevokedAt?.getTime())
  })

  // The test that matters most in this task (see task-1-brief.md): without
  // this predicate, a password-reset token could be spent as an email
  // verification, or worse, a verification token could reset a password —
  // turning "I can receive mail at this address" into "I can take over this
  // account."
  it('claimOnce rejects a claim for a different purpose than the row was issued for', async () => {
    const userId = await createUser()
    const tokenHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'password_reset',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    })

    // Wrong purpose: the row exists and is still live, but must not be
    // claimable as anything other than what it was issued for.
    const wrongPurpose = await userTokenRepository.claimOnce(tokenHash, 'email_verification')
    expect(wrongPurpose).toBeUndefined()

    // The row must be UNTOUCHED by the rejected claim above — still live,
    // still claimable under its real purpose. A claimOnce that revoked on a
    // purpose mismatch would silently burn a legitimate token on a mere
    // probe.
    const stillLive = await userTokenRepository.findByHash(tokenHash)
    expect(stillLive?.revokedAt).toBeNull()

    const rightPurpose = await userTokenRepository.claimOnce(tokenHash, 'password_reset')
    expect(rightPurpose).toBeDefined()
    expect(rightPurpose?.revokedAt).not.toBeNull()
  })

  it('claimOnce rejects a refresh claim for a token issued as a password reset, and vice versa', async () => {
    const userId = await createUser()
    const resetHash = uniqueHash()
    const refreshHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'password_reset',
      tokenHash: resetHash,
      expiresAt: new Date(Date.now() + 60_000),
    })
    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash: refreshHash,
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(await userTokenRepository.claimOnce(resetHash, 'refresh')).toBeUndefined()
    expect(await userTokenRepository.claimOnce(refreshHash, 'password_reset')).toBeUndefined()

    // Both remain claimable under their real, original purpose.
    expect(await userTokenRepository.claimOnce(resetHash, 'password_reset')).toBeDefined()
    expect(await userTokenRepository.claimOnce(refreshHash, 'refresh')).toBeDefined()
  })

  it('revokeAllForSession revokes every row in the session and none outside it', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const otherSessionId = randomUUID()

    const inSession = await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId,
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsideSession = await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: otherSessionId,
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })

    await userTokenRepository.revokeAllForSession(sessionId)

    const inSessionRow = await userTokenRepository.findByHash(inSession.tokenHash)
    const outsideSessionRow = await userTokenRepository.findByHash(outsideSession.tokenHash)
    expect(inSessionRow?.revokedAt).not.toBeNull()
    expect(outsideSessionRow?.revokedAt).toBeNull()
  })

  it('revokeAllForUser revokes every row for that user across every session', async () => {
    const userId = await createUser()
    const otherUserId = await createUser()

    const first = await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const second = await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const otherUsers = await userTokenRepository.create({
      userId: otherUserId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })

    await userTokenRepository.revokeAllForUser(userId)

    const firstRow = await userTokenRepository.findByHash(first.tokenHash)
    const secondRow = await userTokenRepository.findByHash(second.tokenHash)
    const otherUsersRow = await userTokenRepository.findByHash(otherUsers.tokenHash)
    expect(firstRow?.revokedAt).not.toBeNull()
    expect(secondRow?.revokedAt).not.toBeNull()
    expect(otherUsersRow?.revokedAt).toBeNull()
  })

  it('deleting the owning user cascades to its token rows', async () => {
    const userId = await createUser()
    const created = await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })

    await sql`delete from users where id = ${userId}`
    createdUserIds.length = 0 // already deleted; afterEach must not try again

    const rows = await sql`select 1 from user_tokens where id = ${created.id}`
    expect(rows).toHaveLength(0)
  })
})
