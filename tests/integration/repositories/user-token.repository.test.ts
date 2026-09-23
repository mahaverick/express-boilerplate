// tests/integration/repositories/user-token.repository.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts). Every user row this file creates is
// unique to this run and deleted in afterEach; deleting the user cascades
// (ON DELETE CASCADE on user_tokens.user_id) to every token row it owns, so
// there is nothing separate to clean up there.
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { userTokenModel } from '@/database/models/user-token.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { issueRefreshToken, issueToken, rotateRefreshToken } from '@/utilities/token.utilities'

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
    // Asserted before the field checks below: `claimed?.revokedAt` alone
    // passes when `claimed` is `undefined` too (undefined is not null), so
    // this is what actually proves a row came back, not just that whatever
    // came back (possibly nothing) lacks a null field.
    expect(claimed).toBeDefined()
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

  // Pins the contract documented on claimOnce's own JSDoc: expiry is
  // deliberately NOT part of this method's predicate. Folding it in would
  // make an expired-but-unrevoked row indistinguishable, to
  // rotateRefreshToken's `!claimed` branch, from a genuinely reused one —
  // which would revoke an entire session family for a legitimate user
  // whose token simply aged out (see "rejects an expired refresh token
  // without treating it as reuse of a live session",
  // token.utilities.test.ts). This is why every caller of claimOnce must
  // check `expiresAt` on the row it gets back, itself, after claiming.
  it("claimOnce claims an expired-but-unrevoked row — expiry is the caller's job, not the predicate's", async () => {
    const userId = await createUser()
    const tokenHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash,
      // Already expired when created — this row was never live by an
      // expiry-aware definition, only by claimOnce's actual one.
      expiresAt: new Date(Date.now() - 60_000),
    })

    const claimed = await userTokenRepository.claimOnce(tokenHash, 'refresh')
    expect(claimed).toBeDefined()
    expect(claimed?.expiresAt.getTime()).toBeLessThan(Date.now())
    expect(claimed?.revokedAt).not.toBeNull()
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

  it('revokeAllForUser denies every session it revoked, and only those', async () => {
    const userId = await createUser()
    const otherUserId = await createUser()

    const sessionIdOne = randomUUID()
    const sessionIdTwo = randomUUID()
    const otherUsersSessionId = randomUUID()

    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: sessionIdOne,
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: sessionIdTwo,
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    // No sessionId: proves the null filter neither crashes nor denies a
    // bogus key built from `null` — this row contributes nothing to either
    // assertion below.
    await userTokenRepository.create({
      userId,
      purpose: 'password_reset',
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await userTokenRepository.create({
      userId: otherUserId,
      purpose: 'refresh',
      sessionId: otherUsersSessionId,
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })

    await userTokenRepository.revokeAllForUser(userId)

    expect(await isSessionDenied(sessionIdOne)).toBe(true)
    expect(await isSessionDenied(sessionIdTwo)).toBe(true)
    expect(await isSessionDenied(otherUsersSessionId)).toBe(false)
  })

  describe('revokeAllForUserExceptSession', () => {
    it('revokes every other session but leaves the spared one untouched', async () => {
      const userId = await createUser()
      const sparedSessionId = randomUUID()
      const otherSessionId = randomUUID()

      const spared = await userTokenRepository.create({
        userId,
        purpose: 'refresh',
        sessionId: sparedSessionId,
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      const other = await userTokenRepository.create({
        userId,
        purpose: 'refresh',
        sessionId: otherSessionId,
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      await userTokenRepository.revokeAllForUserExceptSession(userId, sparedSessionId)

      const sparedRow = await userTokenRepository.findByHash(spared.tokenHash)
      const otherRow = await userTokenRepository.findByHash(other.tokenHash)
      expect(sparedRow?.revokedAt).toBeNull()
      expect(otherRow?.revokedAt).not.toBeNull()
    })

    // THE TRAP THIS METHOD EXISTS TO CLOSE: a row with no sessionId at all
    // (password_reset/email_verification — sessionId is only ever set on a
    // 'refresh' row, user-token.model.ts) must still be revoked, because it
    // does not belong to the spared session either. A predicate written
    // with `session_id != $2` would evaluate to NULL — not true — for this
    // exact row, silently leaving it live. If this test ever goes green for
    // the wrong reason, it is because someone "simplified" the repository's
    // `IS DISTINCT FROM` back to `!=`.
    it('revokes a row with no sessionId at all — the IS DISTINCT FROM case, not != ', async () => {
      const userId = await createUser()
      const sparedSessionId = randomUUID()

      await userTokenRepository.create({
        userId,
        purpose: 'refresh',
        sessionId: sparedSessionId,
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      const noSessionToken = await userTokenRepository.create({
        userId,
        purpose: 'password_reset',
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      await userTokenRepository.revokeAllForUserExceptSession(userId, sparedSessionId)

      const row = await userTokenRepository.findByHash(noSessionToken.tokenHash)
      expect(row?.revokedAt).not.toBeNull()
    })

    it('denies every revoked session except the spared one, and never another user’s', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const sparedSessionId = randomUUID()
      const revokedSessionId = randomUUID()
      const otherUsersSessionId = randomUUID()

      await userTokenRepository.create({
        userId,
        purpose: 'refresh',
        sessionId: sparedSessionId,
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      await userTokenRepository.create({
        userId,
        purpose: 'refresh',
        sessionId: revokedSessionId,
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      await userTokenRepository.create({
        userId: otherUserId,
        purpose: 'refresh',
        sessionId: otherUsersSessionId,
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      await userTokenRepository.revokeAllForUserExceptSession(userId, sparedSessionId)

      expect(await isSessionDenied(sparedSessionId)).toBe(false)
      expect(await isSessionDenied(revokedSessionId)).toBe(true)
      expect(await isSessionDenied(otherUsersSessionId)).toBe(false)
    })

    it('does not touch another user’s rows, even one sharing no session with the spared id', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const sparedSessionId = randomUUID()

      await userTokenRepository.create({
        userId,
        purpose: 'refresh',
        sessionId: sparedSessionId,
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      const otherUsersToken = await userTokenRepository.create({
        userId: otherUserId,
        purpose: 'refresh',
        sessionId: randomUUID(),
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      await userTokenRepository.revokeAllForUserExceptSession(userId, sparedSessionId)

      const otherUsersRow = await userTokenRepository.findByHash(otherUsersToken.tokenHash)
      expect(otherUsersRow?.revokedAt).toBeNull()
    })
  })

  // `softDelete`/`markDeleted` (BaseRepository, base.repository.ts) — this
  // file's other tests never call it, since real token lifecycle uses
  // `claimOnce`/`revokeAllFor*` (a `revokedAt` column) rather than
  // soft-delete. Still real, inherited public API: proven the same way
  // tenant.repository.test.ts's own "excludes a soft-deleted tenant from
  // findById" case proves it for a different table.
  it('softDelete sets deletedAt and excludes the row from findById by default', async () => {
    const userId = await createUser()
    const created = await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })

    const deleted = await userTokenRepository.softDelete(created.id)
    expect(deleted?.deletedAt).not.toBeNull()

    expect(await userTokenRepository.findById(created.id)).toBeUndefined()
    expect(await userTokenRepository.findById(created.id, { includeDeleted: true })).toMatchObject({
      id: created.id,
    })
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

  describe('revokeAllForUserAndPurpose', () => {
    it('revokes the named purpose and leaves a live refresh token alone', async () => {
      const userId = await createUser()
      const refresh = await issueRefreshToken(userId, randomUUID())
      await issueToken(userId, 'email_verification', 60_000)

      await userTokenRepository.revokeAllForUserAndPurpose(userId, 'email_verification')

      // This assertion is the entire reason the method exists.
      // revokeAllForUser matches on userId ALONE, so calling it here would
      // silently log the user out of every device as a side effect of them
      // asking for a verification mail.
      expect(await rotateRefreshToken(refresh.raw)).toBeDefined()

      // IssuedToken (token.utilities.ts) carries no row id, and hashToken
      // is not exported, so the verification row is identified by
      // userId + purpose rather than by hash or id.
      const [remaining] = await db
        .select()
        .from(userTokenModel)
        .where(
          and(eq(userTokenModel.userId, userId), eq(userTokenModel.purpose, 'email_verification'))
        )
      // Proves a row was actually found — `remaining?.revokedAt` alone
      // passes when `remaining` is `undefined` too, which would prove
      // nothing about revocation.
      expect(remaining).toBeDefined()
      expect(remaining?.revokedAt).not.toBeNull()
    })
  })
})
