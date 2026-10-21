/**
 * @file Integration test against the real per-worker Postgres database (see
 * `tests/helpers/worker-database.ts`). Every user row this file creates is
 * unique to this run and deleted in `afterEach`; deleting the user cascades
 * (ON DELETE CASCADE on `user_tokens.user_id`) to every token row it owns,
 * so there is nothing separate to clean up there.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { type LinkTokenPurpose, type NewUserToken } from '@/database/models/user-token.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { hashToken, issueRefreshToken, rotateRefreshToken } from '@/services/session.service'

const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()
const LINK_PREFIX = `user-token-link-${randomUUID()}-`
const LINK_PREFIX_LIKE = `${LINK_PREFIX}%`

/**
 * A disposable email unique to this call, so it cannot collide with rows other tests in this
 * worker's database hold.
 */
function uniqueEmail(): string {
  return `user-token-repo-${randomUUID()}@example.test`
}

/**
 * A fresh 64-character hex string standing in for a SHA-256 token digest; these tests never need it
 * to correspond to a real raw token.
 */
function uniqueHash(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Sort comparator for the session ids `revokeAllForUser` returns, which come in no guaranteed order.
 */
function byId(left: string, right: string): number {
  return left.localeCompare(right)
}

/**
 * Creates a live refresh row for `userId` in `sessionId`.
 */
function refreshRow(userId: string, sessionId: string) {
  return userTokenRepository.create({
    userId,
    purpose: 'refresh',
    sessionId,
    tokenHash: uniqueHash(),
    expiresAt: new Date(Date.now() + 60_000),
  })
}

/**
 * A row's `revokedAt`, read by its hash: null until it is revoked, undefined when there is no such row.
 */
async function revokedAtOf(tokenHash: string): Promise<Date | null | undefined> {
  const row = await userTokenRepository.findByHash(tokenHash)
  return row?.revokedAt
}

/**
 * Issues a token in `sessionId` and rotates it, so its row carries a `consumed_at`, and returns
 * that row's token hash.
 */
async function consumedHashIn(userId: string, sessionId: string): Promise<string> {
  const issued = await issueRefreshToken(userId, sessionId)
  await rotateRefreshToken(issued.raw)
  return hashToken(issued.raw)
}

/**
 * A fresh address for a link row, under this file's prefix so afterEach finds it.
 */
function linkAddress(): string {
  return `${LINK_PREFIX}${randomUUID()}@example.test`
}

/**
 * A live `sign_in_link` row's values, with `overrides` merged over them.
 */
function signInRow(overrides: Partial<NewUserToken> = {}): NewUserToken {
  return {
    purpose: 'sign_in_link',
    app: 'web',
    email: linkAddress(),
    tokenHash: uniqueHash(),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  }
}

/**
 * A live `step_up_link` row's values for one user and session, with `overrides` merged over them.
 */
function stepUpRow(
  userId: string,
  sessionId: string,
  overrides: Partial<NewUserToken> = {}
): NewUserToken {
  return {
    purpose: 'step_up_link',
    app: 'apex',
    email: linkAddress(),
    userId,
    sessionId,
    tokenHash: uniqueHash(),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  }
}

/**
 * The id `claimOnce` claims for a link, or undefined when it claims nothing.
 */
async function claimedLinkId(
  tokenHash: string,
  purpose: LinkTokenPurpose,
  bound?: { userId: string; sessionId: string }
): Promise<string | undefined> {
  const row = await userTokenRepository.claimOnce(tokenHash, purpose, db, bound)
  return row?.id
}

/**
 * Inserts a live `step_up_link` row for `userId` under `tokenHash`, with
 * every column its shape CHECK requires.
 * @param userId - The link's user.
 * @param tokenHash - The row's hash.
 * @returns Resolves once the row is stored.
 */
async function stepUpLinkRow(userId: string, tokenHash: string): Promise<void> {
  await userTokenRepository.create({
    userId,
    purpose: 'step_up_link',
    sessionId: randomUUID(),
    email: `step-up-${randomUUID()}@example.test`,
    app: 'apex',
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
  })
}

describe('UserTokenRepository', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    await sql`delete from user_tokens where email like ${LINK_PREFIX_LIKE}`
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Creates a user to own the token rows a test issues, tracked for cleanup, and returns its id.
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
    // Asserted before the field checks below: claimed?.revokedAt alone passes when claimed is undefined too.
    expect(claimed).toBeDefined()
    // RETURNING reflects the row after this UPDATE, so revokedAt/consumedAt are already set.
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

  it('wasConsumedWithin is true right after claimOnce, false once consumed_at is moved into the past', async () => {
    const userId = await createUser()
    const tokenHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    })
    await userTokenRepository.claimOnce(tokenHash, 'refresh')

    expect(await userTokenRepository.wasConsumedWithin(tokenHash, 10_000)).toBe(true)

    await sql`
      update user_tokens set consumed_at = consumed_at - interval '11 seconds'
      where token_hash = ${tokenHash}
    `

    expect(await userTokenRepository.wasConsumedWithin(tokenHash, 10_000)).toBe(false)
  })

  /**
   * Pins `claimOnce`'s contract: expiry is deliberately not part of its
   * predicate, so every caller must check `expiresAt` on the row it gets
   * back itself — folding expiry in would make an expired-but-unrevoked row
   * indistinguishable, to `rotateRefreshToken`'s `!claimed` branch, from a
   * genuinely reused one, revoking an entire session family for a token
   * that simply aged out.
   */
  it("claimOnce claims an expired-but-unrevoked row — expiry is the caller's job, not the predicate's", async () => {
    const userId = await createUser()
    const tokenHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash,
      // Already expired when created: live only by claimOnce's actual predicate, not an expiry-aware one.
      expiresAt: new Date(Date.now() - 60_000),
    })

    const claimed = await userTokenRepository.claimOnce(tokenHash, 'refresh')
    expect(claimed).toBeDefined()
    expect(claimed?.expiresAt.getTime()).toBeLessThan(Date.now())
    expect(claimed?.revokedAt).not.toBeNull()
  })

  /**
   * The `purpose` predicate keeps a token minted for one purpose from being
   * spent as another (SECURITY.md): a step-up link as a sign-in link, which
   * would sign a session in with a link mailed to confirm one.
   */
  it('claimOnce rejects a claim for a different purpose than the row was issued for', async () => {
    const userId = await createUser()
    const tokenHash = uniqueHash()
    await stepUpLinkRow(userId, tokenHash)

    // Wrong purpose: the row exists and is live, but must not be claimable as anything other than what it was issued for.
    const wrongPurpose = await userTokenRepository.claimOnce(tokenHash, 'sign_in_link')
    expect(wrongPurpose).toBeUndefined()

    // The row must be untouched by the rejected claim above: a claimOnce that revoked on a purpose mismatch would silently burn a legitimate token on a mere probe.
    const stillLive = await userTokenRepository.findByHash(tokenHash)
    expect(stillLive?.revokedAt).toBeNull()

    const rightPurpose = await userTokenRepository.claimOnce(tokenHash, 'step_up_link')
    expect(rightPurpose).toBeDefined()
    expect(rightPurpose?.revokedAt).not.toBeNull()
  })

  it('claimOnce rejects a refresh claim for a token issued as a step-up link, and vice versa', async () => {
    const userId = await createUser()
    const linkHash = uniqueHash()
    const refreshHash = uniqueHash()
    await stepUpLinkRow(userId, linkHash)
    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash: refreshHash,
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(await userTokenRepository.claimOnce(linkHash, 'refresh')).toBeUndefined()
    expect(await userTokenRepository.claimOnce(refreshHash, 'step_up_link')).toBeUndefined()

    // Both remain claimable under their real, original purpose.
    expect(await userTokenRepository.claimOnce(linkHash, 'step_up_link')).toBeDefined()
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

  it('revokeAllForUser returns each revoked session id once, and never another user’s', async () => {
    const userId = await createUser()
    const otherUserId = await createUser()
    const sessionIdOne = randomUUID()
    const sessionIdTwo = randomUUID()

    // Two rows in one session: the returned ids are de-duplicated.
    for (const sessionId of [sessionIdOne, sessionIdOne, sessionIdTwo]) {
      await userTokenRepository.create({
        userId,
        purpose: 'refresh',
        sessionId,
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    }
    // No sessionId: contributes nothing to the returned list.
    await userTokenRepository.create({
      userId,
      purpose: 'refresh',
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await userTokenRepository.create({
      userId: otherUserId,
      purpose: 'refresh',
      sessionId: randomUUID(),
      tokenHash: uniqueHash(),
      expiresAt: new Date(Date.now() + 60_000),
    })

    const revoked = await userTokenRepository.revokeAllForUser(userId)

    expect(revoked.toSorted(byId)).toEqual([sessionIdOne, sessionIdTwo].toSorted(byId))
  })

  // A fresh user and live row per method, so each one revokes something.
  it.each([
    [
      'revokeAllForSession',
      (_userId: string, sessionId: string) => userTokenRepository.revokeAllForSession(sessionId),
    ],
    ['revokeAllForUser', (userId: string) => userTokenRepository.revokeAllForUser(userId)],
    [
      'revokeAllForUserExceptSession',
      (userId: string) => userTokenRepository.revokeAllForUserExceptSession(userId, randomUUID()),
    ],
    [
      'revokeAllForUserExceptToken',
      (userId: string) =>
        userTokenRepository.revokeAllForUserExceptToken(userId, {
          id: randomUUID(),
          sessionId: randomUUID(),
        }),
    ],
  ] as const)('%s revokes the row but never writes the denylist', async (_name, revoke) => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)

    await revoke(userId, sessionId)

    const row = await userTokenRepository.findByHash(hashToken(issued.raw))
    expect(row?.revokedAt).not.toBeNull()
    expect(await isSessionDenied(sessionId)).toBe(false)
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

    /**
     * The trap this method exists to close: a row with no sessionId at all
     * (sessionId is only ever set on a 'refresh' row) must be revoked too,
     * since a predicate written with `session_id != $2` evaluates
     * to NULL, not true, for this row, silently leaving it live if the
     * repository's `IS DISTINCT FROM` is ever "simplified" to `!=`.
     */
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
        purpose: 'refresh',
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      await userTokenRepository.revokeAllForUserExceptSession(userId, sparedSessionId)

      const row = await userTokenRepository.findByHash(noSessionToken.tokenHash)
      expect(row?.revokedAt).not.toBeNull()
    })

    it('returns every revoked session id except the spared one, and never another user’s', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const sparedSessionId = randomUUID()
      const revokedSessionId = randomUUID()

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
        sessionId: randomUUID(),
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      const revoked = await userTokenRepository.revokeAllForUserExceptSession(
        userId,
        sparedSessionId
      )

      expect(revoked).toEqual([revokedSessionId])
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

  /**
   * `softDelete`/`markDeleted` (`BaseRepository`) — real token lifecycle
   * uses `claimOnce`/`revokeAllFor*` instead, but this is real, inherited
   * public API.
   */
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

  describe('revokeAllForUserExceptToken', () => {
    it('spares only the one row: its session’s other live rows, other sessions and sessionless rows are revoked', async () => {
      const userId = await createUser()
      const callerSessionId = randomUUID()
      const otherSessionId = randomUUID()
      const spared = await refreshRow(userId, callerSessionId)
      const sibling = await refreshRow(userId, callerSessionId)
      const other = await refreshRow(userId, otherSessionId)
      const sessionless = await userTokenRepository.create({
        userId,
        purpose: 'refresh',
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      const revoked = await userTokenRepository.revokeAllForUserExceptToken(userId, {
        id: spared.id,
        sessionId: callerSessionId,
      })

      expect(await revokedAtOf(spared.tokenHash)).toBeNull()
      for (const row of [sibling, other, sessionless]) {
        expect(await revokedAtOf(row.tokenHash)).toBeInstanceOf(Date)
      }
      // The caller's own session is never reported: denying it would end the caller's access token.
      expect(revoked).toEqual([otherSessionId])
    })

    it('does not touch another user’s rows, nor rewrite an already-revoked row', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const callerSessionId = randomUUID()
      const spared = await refreshRow(userId, callerSessionId)
      const theirs = await refreshRow(otherUserId, randomUUID())
      const alreadyRevoked = await refreshRow(userId, randomUUID())
      await sql`update user_tokens set revoked_at = now() - interval '1 day' where id = ${alreadyRevoked.id}`
      const before = await revokedAtOf(alreadyRevoked.tokenHash)

      const revoked = await userTokenRepository.revokeAllForUserExceptToken(userId, {
        id: spared.id,
        sessionId: callerSessionId,
      })

      expect(revoked).toEqual([])
      expect(await revokedAtOf(theirs.tokenHash)).toBeNull()
      expect(before).toBeInstanceOf(Date)
      expect(await revokedAtOf(alreadyRevoked.tokenHash)).toEqual(before)
    })
  })

  describe('isSessionKilled', () => {
    it('is false for a session holding only a rotated token and its live successor', async () => {
      const userId = await createUser()
      const sessionId = randomUUID()
      const presented = await consumedHashIn(userId, sessionId)

      expect(await userTokenRepository.isSessionKilled(sessionId, presented)).toBe(false)
    })

    it('is true once the session is revoked (logout, reuse detection)', async () => {
      const userId = await createUser()
      const sessionId = randomUUID()
      const presented = await consumedHashIn(userId, sessionId)
      await userTokenRepository.revokeAllForSession(sessionId)

      expect(await userTokenRepository.isSessionKilled(sessionId, presented)).toBe(true)
    })

    it('is true once every session of the user is revoked (an account claim)', async () => {
      const userId = await createUser()
      const sessionId = randomUUID()
      const presented = await consumedHashIn(userId, sessionId)
      await userTokenRepository.revokeAllForUser(userId)

      expect(await userTokenRepository.isSessionKilled(sessionId, presented)).toBe(true)
    })

    it('ignores a marker revoked before the presented token was consumed: a sibling-only revoke, not a kill of its chain', async () => {
      const userId = await createUser()
      const sessionId = randomUUID()
      const earlier = await issueRefreshToken(userId, sessionId)
      await sql`update user_tokens set revoked_at = now() where token_hash = ${hashToken(earlier.raw)}`
      const presented = await consumedHashIn(userId, sessionId)

      expect(await userTokenRepository.isSessionKilled(sessionId, presented)).toBe(false)
    })

    it('counts a marker revoked after the presented token was consumed', async () => {
      const userId = await createUser()
      const sessionId = randomUUID()
      const presented = await consumedHashIn(userId, sessionId)
      const later = await issueRefreshToken(userId, sessionId)
      await sql`update user_tokens set revoked_at = now() where token_hash = ${hashToken(later.raw)}`

      expect(await userTokenRepository.isSessionKilled(sessionId, presented)).toBe(true)
    })

    it('ignores another session’s kill marker', async () => {
      const userId = await createUser()
      const killed = randomUUID()
      const untouched = randomUUID()
      await issueRefreshToken(userId, killed)
      const presented = await consumedHashIn(userId, untouched)
      await userTokenRepository.revokeAllForSession(killed)

      expect(await userTokenRepository.isSessionKilled(untouched, presented)).toBe(false)
    })

    it('ignores a step-up link of the session, revoked unused or claimed', async () => {
      const userId = await createUser()
      const sessionId = randomUUID()
      const presented = await consumedHashIn(userId, sessionId)
      const superseded = await userTokenRepository.create(stepUpRow(userId, sessionId))
      await userTokenRepository.revokeLiveFor({ userId, sessionId, intent: 'step_up' })
      const claimed = await userTokenRepository.create(stepUpRow(userId, sessionId))
      await userTokenRepository.claimOnce(claimed.tokenHash, 'step_up_link', db, {
        userId,
        sessionId,
      })

      expect(await revokedAtOf(superseded.tokenHash)).not.toBeNull()
      expect(await userTokenRepository.isSessionKilled(sessionId, presented)).toBe(false)
    })
  })

  describe('emailed links', () => {
    it('claims a live link once and never twice', async () => {
      const row = await userTokenRepository.create(signInRow())
      expect(await claimedLinkId(row.tokenHash, 'sign_in_link')).toBe(row.id)
      expect(await userTokenRepository.claimOnce(row.tokenHash, 'sign_in_link')).toBeUndefined()
      const spent = await userTokenRepository.findByHash(row.tokenHash)
      expect(spent?.consumedAt).not.toBeNull()
    })

    it('never claims a sign-in link as a step-up link or a refresh token', async () => {
      const row = await userTokenRepository.create(signInRow())
      expect(await userTokenRepository.claimOnce(row.tokenHash, 'step_up_link')).toBeUndefined()
      expect(await userTokenRepository.claimOnce(row.tokenHash, 'refresh')).toBeUndefined()
      expect(await revokedAtOf(row.tokenHash)).toBeNull()
    })

    it('claims a step-up link only for its own user and session', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const sessionId = randomUUID()
      const row = await userTokenRepository.create(stepUpRow(userId, sessionId))

      expect(
        await claimedLinkId(row.tokenHash, 'step_up_link', { userId, sessionId: randomUUID() })
      ).toBeUndefined()
      expect(
        await claimedLinkId(row.tokenHash, 'step_up_link', { userId: otherUserId, sessionId })
      ).toBeUndefined()
      expect(await revokedAtOf(row.tokenHash)).toBeNull()

      expect(await claimedLinkId(row.tokenHash, 'step_up_link', { userId, sessionId })).toBe(row.id)
    })

    it('peeks without spending, and past nothing expired, revoked or claimed', async () => {
      const live = await userTokenRepository.create(signInRow())
      const first = await userTokenRepository.findLiveByHash(live.tokenHash, 'sign_in_link')
      const again = await userTokenRepository.findLiveByHash(live.tokenHash, 'sign_in_link')
      expect(first?.id).toBe(live.id)
      expect(again?.consumedAt).toBeNull()
      expect(
        await userTokenRepository.findLiveByHash(live.tokenHash, 'step_up_link')
      ).toBeUndefined()

      const aSecondAgo = new Date(Date.now() - 1000)
      const expired = await userTokenRepository.create(signInRow({ expiresAt: aSecondAgo }))
      const revoked = await userTokenRepository.create(signInRow({ revokedAt: new Date() }))
      const claimed = await userTokenRepository.create(signInRow())
      await userTokenRepository.claimOnce(claimed.tokenHash, 'sign_in_link')
      for (const row of [expired, revoked, claimed]) {
        expect(
          await userTokenRepository.findLiveByHash(row.tokenHash, 'sign_in_link')
        ).toBeUndefined()
      }
    })

    it('revokes only the live sign-in links of one address', async () => {
      const email = linkAddress()
      const first = await userTokenRepository.create(signInRow({ email }))
      const second = await userTokenRepository.create(signInRow({ email, app: 'apex' }))
      const otherAddress = await userTokenRepository.create(signInRow())
      const userId = await createUser()
      const stepUp = await userTokenRepository.create(stepUpRow(userId, randomUUID(), { email }))

      expect(
        await userTokenRepository.revokeLiveFor({ email: email.toUpperCase(), intent: 'sign_in' })
      ).toBe(2)

      const firstRow = await userTokenRepository.findByHash(first.tokenHash)
      expect(firstRow?.revokedAt).not.toBeNull()
      expect(firstRow?.consumedAt).toBeNull()
      expect(await revokedAtOf(second.tokenHash)).not.toBeNull()
      expect(await revokedAtOf(otherAddress.tokenHash)).toBeNull()
      expect(await revokedAtOf(stepUp.tokenHash)).toBeNull()
    })

    it("revokes only one session's live step-up links, never its refresh tokens", async () => {
      const userId = await createUser()
      const sessionId = randomUUID()
      const refresh = await issueRefreshToken(userId, sessionId)
      const mine = await userTokenRepository.create(stepUpRow(userId, sessionId))
      const otherSession = await userTokenRepository.create(stepUpRow(userId, randomUUID()))

      expect(
        await userTokenRepository.revokeLiveFor({ userId, sessionId, intent: 'step_up' })
      ).toBe(1)

      expect(await revokedAtOf(mine.tokenHash)).not.toBeNull()
      expect(await revokedAtOf(otherSession.tokenHash)).toBeNull()
      expect(await revokedAtOf(hashToken(refresh.raw))).toBeNull()
    })

    it("sign-out revokes the session's live step-up link", async () => {
      const userId = await createUser()
      const sessionId = randomUUID()
      await issueRefreshToken(userId, sessionId)
      const pending = await userTokenRepository.create(stepUpRow(userId, sessionId))

      await userTokenRepository.revokeAllForSession(sessionId)

      expect(await revokedAtOf(pending.tokenHash)).not.toBeNull()
    })

    it('finds a refresh token by hash, but never a link', async () => {
      const userId = await createUser()
      const sessionId = randomUUID()
      const refresh = await issueRefreshToken(userId, sessionId)
      const link = await userTokenRepository.create(stepUpRow(userId, sessionId))

      const found = await userTokenRepository.findRefreshByHash(hashToken(refresh.raw))
      expect(found?.sessionId).toBe(sessionId)
      expect(await userTokenRepository.findRefreshByHash(link.tokenHash)).toBeUndefined()
    })

    it('session listing ignores link rows', async () => {
      const userId = await createUser()
      const mine = randomUUID()
      const other = randomUUID()
      await issueRefreshToken(userId, mine)
      await issueRefreshToken(userId, other)
      // A session with only a pending step-up link is not a signed-in session.
      await userTokenRepository.create(stepUpRow(userId, randomUUID()))

      const aMinuteAgo = new Date(Date.now() - 60_000)
      expect(await userTokenRepository.liveSessionIdsExcept(userId, mine, aMinuteAgo)).toEqual([
        other,
      ])
    })

    it('deletes every link for an address up to a moment, whatever its case', async () => {
      const email = linkAddress()
      const old = await userTokenRepository.create(signInRow({ email }))
      await sql`update user_tokens set created_at = now() - interval '2 hours' where id = ${old.id}`
      const recent = await userTokenRepository.create(signInRow({ email }))
      const other = await userTokenRepository.create(signInRow())
      const anHourAgo = new Date(Date.now() - 3_600_000)

      const deleted = await db.transaction((tx) =>
        userTokenRepository.deleteForEmail(email.toUpperCase(), anHourAgo, tx)
      )

      expect(deleted).toBe(1)
      expect(await userTokenRepository.findByHash(old.tokenHash)).toBeUndefined()
      expect(await userTokenRepository.findByHash(recent.tokenHash)).toBeDefined()
      expect(await userTokenRepository.findByHash(other.tokenHash)).toBeDefined()
    })
  })
})
