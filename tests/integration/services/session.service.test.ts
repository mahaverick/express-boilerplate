/**
 * @file Exercises the session/token service's security properties against
 * the real per-worker Postgres database. Every user row this file creates
 * is unique to this run and deleted in `afterEach`; deleting the user
 * cascades (`ON DELETE CASCADE` on `user_tokens.user_id`) to every token
 * row it owns.
 */
import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { userTokenModel } from '@/database/models/user-token.model'
import type { User } from '@/database/models/user.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql, withTransaction, type DbExecutor } from '@/services/database.service'
import { claimLinkToken, issueLinkToken } from '@/services/link-token.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import {
  claimToken,
  issueRefreshToken,
  issueToken,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '@/services/session.service'
import { parseDurationMs } from '@/utilities/duration.utilities'
import { withMutatedMethod } from '../../helpers/mutate'

/**
 * The hex SHA-256 of a raw token, as session.service.ts's hashToken computes it, derived
 * independently so a test checks the stored form without trusting the function under test.
 */
function hashRawToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()
const LINK_TTL_MS = 15 * 60_000

// Each repository revocation, called for one user's one session; the except-session case spares an unrelated id.
const REPOSITORY_REVOKES: readonly [
  string,
  (userId: string, sessionId: string, tx: DbExecutor) => Promise<unknown>,
][] = [
  [
    'revokeAllForSession',
    (_userId, sessionId, tx) => userTokenRepository.revokeAllForSession(sessionId, tx),
  ],
  [
    'revokeAllForUser',
    (userId, _sessionId, tx) => userTokenRepository.revokeAllForUser(userId, tx),
  ],
  [
    'revokeAllForUserExceptSession',
    (userId, _sessionId, tx) =>
      userTokenRepository.revokeAllForUserExceptSession(userId, randomUUID(), tx),
  ],
]

/**
 * vitest types `expect.any(...)` as `any`, and assigning that into an object literal's
 * property trips `@typescript-eslint/no-unsafe-assignment`. The cast fixes that at the type
 * level only, as `ANY_STRING` in `tests/integration/api/auth.test.ts` does.
 */
const ANY_STRING = expect.any(String) as unknown as string

/**
 * An address unique to each call, so users created by different tests never collide.
 */
function uniqueEmail(): string {
  return `token-flow-${randomUUID()}@example.test`
}

/**
 * The rotation test proves the old token invalid by reading its row through the repository,
 * never by presenting it again: a replay would trigger reuse detection and revoke the new
 * token, so the rotation test would pass for the reuse test's reason. The reuse test is the
 * only one that presents an already-rotated token, and it first ages the row past the reuse
 * grace window.
 */
/**
 * Issue a step-up link for one session of a user.
 */
function issueStepUp(user: User, sessionId: string) {
  return issueLinkToken(
    { intent: 'step_up', email: user.email, app: 'apex', userId: user.id, sessionId },
    LINK_TTL_MS
  )
}

describe('refresh token issuance, rotation, and revocation', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a user for a test and track it for the `afterEach` cleanup; resolves with its row.
   */
  async function createUserRow(): Promise<User> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user
  }

  /**
   * Create a user for a test and track it for the `afterEach` cleanup; resolves with its id.
   */
  async function createUser(): Promise<string> {
    const user = await createUserRow()
    return user.id
  }

  it('issues an access token carrying the user id and an expiry', async () => {
    const user = await createUserRow()
    const sessionId = randomUUID()
    const token = signAccessToken(user, sessionId)

    const decoded = jwt.decode(token)
    if (decoded === null || typeof decoded === 'string') {
      throw new Error('expected a decoded JWT payload')
    }
    expect(decoded.sub).toBe(user.id)
    expect(typeof decoded.exp).toBe('number')
    expect(typeof decoded.iat).toBe('number')
    expect(decoded.exp).toBeGreaterThan(decoded.iat as number)

    /**
     * `verifyAccessToken` returns a discriminated result (`VerifyAccessTokenResult`), so the
     * full `{ ok: true, payload }` is asserted: a payload-shaped object alone would not prove
     * acceptance. `jti` is random, so it is only `ANY_STRING`. `exp` must be the token's own
     * signed expiry, which the notification stream ends at.
     */
    expect(verifyAccessToken(token)).toEqual({
      ok: true,
      payload: { sub: user.id, sid: sessionId, jti: ANY_STRING, exp: decoded.exp },
    })
  })

  it('issues a refresh token whose hash — never the raw value — is stored', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()

    const issued = await issueRefreshToken(userId, sessionId)

    // The raw token never appears in the database: nothing matches it in token_hash.
    const byRawValue = await sql`select 1 from user_tokens where token_hash = ${issued.raw}`
    expect(byRawValue).toHaveLength(0)

    // A row does exist for this session, and the hash stored on it is not the raw value.
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

    // Read the old token's row instead of presenting the token: a replay would trip reuse detection and revoke the new token.
    const oldRow = await sql`
      select token_hash from user_tokens where user_id = ${userId} and session_id = ${sessionId}
        and revoked_at is not null
    `
    expect(oldRow).toHaveLength(1)
    const oldStored = await userTokenRepository.findByHash(oldRow[0]?.token_hash as string)
    expect(oldStored?.revokedAt).not.toBeNull()
    expect(oldStored?.replacedById).toBeTruthy()

    // The new token is live and itself rotatable, so rotating the old one did not affect it.
    const rotatedAgain = await rotateRefreshToken(rotated.raw)
    expect(rotatedAgain.sessionId).toBe(sessionId)
  })

  it('detects reuse: presenting an already-rotated token revokes the whole session family', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)

    const rotated = await rotateRefreshToken(issued.raw)
    // Past REFRESH_REUSE_GRACE_MS, so this replay is reuse rather than a concurrent refresh.
    await sql`
      update user_tokens set consumed_at = consumed_at - interval '11 seconds'
      where user_id = ${userId} and consumed_at is not null
    `

    // The legitimate client has moved on to `rotated.raw`; an attacker who stole the old token replays it.
    await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

    // The whole family dies: the legitimate client's current token is revoked too, though it was never misused.
    const rotatedTokenRows = await sql`
      select token_hash from user_tokens where user_id = ${userId} and session_id = ${sessionId}
        and revoked_at is not null and replaced_by_id is null
    `
    // Found first: `expect(row?.revokedAt).not.toBeNull()` also passes for an undefined row, which would hide a missing one.
    expect(rotatedTokenRows).toHaveLength(1)
    const rotatedRow = await userTokenRepository.findByHash(
      rotatedTokenRows[0]?.token_hash as string
    )
    expect(rotatedRow).toBeDefined()
    expect(rotatedRow?.revokedAt).not.toBeNull()

    // From the client's side: the token that was valid a moment ago can no longer be rotated.
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
    // A second live token in the same session shows that expiry alone does not kill the whole family, as reuse does.
    const otherInSameSession = await issueRefreshToken(userId, sessionId)

    // Expire only the first-created row, `issued`.
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

    // Expiry is not treated as reuse, so the other live token in the session is unaffected.
    const stillRotatable = await rotateRefreshToken(otherInSameSession.raw)
    expect(stillRotatable.sessionId).toBe(sessionId)
  })

  it('never mints a grace sibling for an expired token, even replayed inside the grace window', async () => {
    /**
     * Pins `findGraceSession`'s own expiry guard: `claimOnce` consumes an expired row like a
     * live one, so without the guard the replay below would read as consumed just now and get
     * a sibling minted from a dead token.
     */
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    await sql`
      update user_tokens set expires_at = now() - interval '1 second'
      where user_id = ${userId} and session_id = ${sessionId}
    `

    await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })
    // Replayed at once, well inside REFRESH_REUSE_GRACE_MS of the claim above.
    await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

    const liveRows = await sql`
      select 1 from user_tokens
      where user_id = ${userId} and session_id = ${sessionId} and revoked_at is null
    `
    expect(liveRows).toHaveLength(0)
  })

  it('refuses to rotate once the session passes its absolute lifetime, however fresh the token is', async () => {
    /**
     * `expiresAt` is a sliding window that every rotation resets, so a client that refreshes
     * within it keeps one login alive indefinitely, and so does anyone holding a stolen
     * refresh cookie, until an explicit logout. `SESSION_ABSOLUTE_TTL` is the cap: the token
     * presented here is brand new and nowhere near its own expiry, only the session is old,
     * and rotation must still refuse it.
     */
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    // A second live token shows the ceiling applies to the whole family, not only the row presented.
    const sibling = await issueRefreshToken(userId, sessionId)

    // Age the session past the ceiling, read from the same environment as the code so the test tracks `SESSION_ABSOLUTE_TTL`.
    const absoluteTtlMs = parseDurationMs(getEnv().SESSION_ABSOLUTE_TTL)
    if (absoluteTtlMs === undefined) throw new Error('SESSION_ABSOLUTE_TTL is unparseable')
    // An ISO string, not a Date: drizzle hands a raw `Date` in a raw `sql` query to postgres-js unserialised, and the query fails.
    const startedAt = new Date(Date.now() - absoluteTtlMs - 60_000).toISOString()
    await sql`
      update user_tokens set session_started_at = ${startedAt}::timestamptz
      where session_id = ${sessionId}
    `

    await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

    // Every token in the family is refused and revoked, not just the one presented: they share the session start.
    await expect(rotateRefreshToken(sibling.raw)).rejects.toMatchObject({ statusCode: 401 })
    const live = await sql`
      select 1 from user_tokens where session_id = ${sessionId} and revoked_at is null
    `
    expect(live).toHaveLength(0)
  })

  it('carries the session start forward across rotations rather than resetting it', async () => {
    /**
     * The ceiling above rests on this: if rotation stamped a fresh `session_started_at`, the
     * cap would become a second sliding window and bound nothing.
     */
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
    /**
     * One distinct value across all three rows in the chain, the one the original login wrote.
     * Compared as strings because `drizzle(sql)` also replaces the client's timestamp parsers
     * with a pass-through, so `timestamptz` comes back as text.
     */
    expect(rows).toHaveLength(1)
    expect(String(rows[0]?.session_started_at)).toBe(String(before?.session_started_at))
  })

  it('revokeRefreshToken revokes every token in that session, and none in another', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const otherSessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    const rotated = await rotateRefreshToken(issued.raw)
    const other = await issueRefreshToken(userId, otherSessionId)

    await revokeRefreshToken(rotated.raw)

    // The new token first: refusing the old token's replay revokes the session by itself.
    await expect(rotateRefreshToken(rotated.raw)).rejects.toMatchObject({ statusCode: 401 })
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

  it('a claimed step-up link does not kill its session', async () => {
    const user = await createUserRow()
    const sessionId = randomUUID()
    const first = await issueRefreshToken(user.id, sessionId)
    const second = await rotateRefreshToken(first.raw)
    // One link superseded (revoked unused) and one claimed: both leave revoked_at on the session's id.
    await issueStepUp(user, sessionId)
    const confirm = await issueStepUp(user, sessionId)
    expect(
      await claimLinkToken(confirm.raw, 'step_up', { userId: user.id, sessionId })
    ).toBeDefined()

    // A grace-window replay of the rotated token still gets a sibling: no kill marker was read.
    const sibling = await rotateRefreshToken(first.raw)
    expect(sibling.sessionId).toBe(sessionId)
    const next = await rotateRefreshToken(second.raw)
    expect(next.sessionId).toBe(sessionId)
  })

  it('refuses a link presented as a refresh token, and kills no session', async () => {
    const user = await createUserRow()
    const sessionId = randomUUID()
    const refresh = await issueRefreshToken(user.id, sessionId)
    const link = await issueStepUp(user, sessionId)

    await expect(rotateRefreshToken(link.raw)).rejects.toMatchObject({ statusCode: 401 })
    await revokeRefreshToken(link.raw)

    expect(await isSessionDenied(sessionId)).toBe(false)
    const next = await rotateRefreshToken(refresh.raw)
    expect(next.sessionId).toBe(sessionId)
  })

  it("sign-out revokes the session's live step-up link", async () => {
    const user = await createUserRow()
    const sessionId = randomUUID()
    const refresh = await issueRefreshToken(user.id, sessionId)
    const link = await issueStepUp(user, sessionId)

    await revokeRefreshToken(refresh.raw)

    expect(
      await claimLinkToken(link.raw, 'step_up', { userId: user.id, sessionId })
    ).toBeUndefined()
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
   * Create a user for a test and track it for the `afterEach` cleanup; resolves with its id.
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
    // The raw value is never what's stored — same property `issueRefreshToken` is proven against above.
    expect(row?.tokenHash).not.toBe(issued.raw)
  })

  /**
   * A token issued for one purpose must not be claimable as another.
   * Without this, a password-reset token could be spent as an email
   * verification, or a verification link, valid for `EMAIL_VERIFICATION_TTL`
   * (24h by default) and mailed without a reset request, could be spent as a
   * reset link, outside the window `PASSWORD_RESET_TTL` (1h by default) keeps
   * reset links to.
   */
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

    // Neither rejected claim touched its row: both are still claimable under their real purpose.
    const resetClaimedCorrectly = await userTokenRepository.claimOnce(resetHash, 'password_reset')
    const verifyClaimedCorrectly = await userTokenRepository.claimOnce(
      verifyHash,
      'email_verification'
    )
    expect(resetClaimedCorrectly).toBeDefined()
    expect(verifyClaimedCorrectly).toBeDefined()
  })
})

describe('claimToken', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a user for a test and track it for the `afterEach` cleanup; resolves with its id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: `claim-token-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    return user.id
  }

  it('claims a live token once', async () => {
    const userId = await createUser()
    const issued = await issueToken(userId, 'email_verification', 60_000)

    const claimed = await claimToken(issued.raw, 'email_verification')

    expect(claimed?.userId).toBe(userId)
    // Single use: `claimOnce` revoked the token on the first claim, so a second claim finds nothing.
    expect(await claimToken(issued.raw, 'email_verification')).toBeUndefined()
  })

  it('refuses a token issued for another purpose', async () => {
    const userId = await createUser()
    const issued = await issueToken(userId, 'password_reset', 60_000)

    expect(await claimToken(issued.raw, 'email_verification')).toBeUndefined()
  })

  it('refuses an EXPIRED token', async () => {
    /**
     * The only test here that fails if `claimToken` stops checking `expiresAt`: `claimOnce`
     * has no expiry predicate and claims this row, so without the check the product would ship
     * a verification link that works forever. Under `MUTATION_PROOF=1`,
     * `claim-token-mutation.test.ts` disables that check and reproduces this assertion going red.
     */
    const userId = await createUser()
    const issued = await issueToken(userId, 'email_verification', -1000)

    expect(await claimToken(issued.raw, 'email_verification')).toBeUndefined()
  })

  it('consumes an expired token rather than leaving it claimable', async () => {
    /**
     * `claimOnce` revokes the row before expiry is checked: one presentation is one attempt.
     * This pins that order, so checking expiry first cannot make an expired link retryable.
     */
    const userId = await createUser()
    const issued = await issueToken(userId, 'email_verification', -1000)

    await claimToken(issued.raw, 'email_verification')

    const row = await userTokenRepository.findByHash(hashRawToken(issued.raw))
    // Found first: `expect(row?.revokedAt).not.toBeNull()` also passes for an undefined row, which would hide a missing one.
    expect(row).toBeDefined()
    expect(row?.revokedAt).not.toBeNull()
    // `consumedAt` is set only by `claimOnce`'s claim path, never by a bare revoke, so it shows the row was spent through `claimToken`.
    expect(row?.consumedAt).not.toBeNull()
  })

  it('refuses an unknown token', async () => {
    expect(await claimToken('deadbeef', 'email_verification')).toBeUndefined()
  })
})

describe('revocation denies the revoked sessions (session.service owns the denylist write)', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Create a user for a test and track it for the `afterEach` cleanup; resolves with its id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdIds.push(user.id)
    return user.id
  }

  it('revokeRefreshToken denies that session, and no other', async () => {
    const userId = await createUser()
    const revoked = randomUUID()
    const untouched = randomUUID()
    const issued = await issueRefreshToken(userId, revoked)
    await issueRefreshToken(userId, untouched)

    await revokeRefreshToken(issued.raw)

    expect(await isSessionDenied(revoked)).toBe(true)
    expect(await isSessionDenied(untouched)).toBe(false)
  })

  it('revokeAllSessions denies every session it revoked, and only those', async () => {
    const userId = await createUser()
    const otherUserId = await createUser()
    const sessionOne = randomUUID()
    const sessionTwo = randomUUID()
    const otherUsersSession = randomUUID()
    await issueRefreshToken(userId, sessionOne)
    await issueRefreshToken(userId, sessionTwo)
    // No session id: must neither crash the null filter nor deny a bogus key.
    await issueToken(userId, 'password_reset', 60_000)
    await issueRefreshToken(otherUserId, otherUsersSession)

    await revokeAllSessions(userId)

    expect(await isSessionDenied(sessionOne)).toBe(true)
    expect(await isSessionDenied(sessionTwo)).toBe(true)
    expect(await isSessionDenied(otherUsersSession)).toBe(false)
  })

  /**
   * Each case gets its own user and live row, so every method has a row to revoke: a method
   * that matched nothing would prove nothing.
   */
  it.each(REPOSITORY_REVOKES)(
    '%s in a rolled-back transaction revokes and denies nothing',
    async (_name, revoke) => {
      const userId = await createUser()
      const sessionId = randomUUID()
      await issueRefreshToken(userId, sessionId)

      await expect(
        withTransaction(async (tx) => {
          await revoke(userId, sessionId, tx)
          // Inside the transaction the row IS revoked: the method matched it.
          const [inside] = await tx
            .select({ revokedAt: userTokenModel.revokedAt })
            .from(userTokenModel)
            .where(eq(userTokenModel.sessionId, sessionId))
          expect(inside?.revokedAt).not.toBeNull()
          throw new Error('roll back')
        })
      ).rejects.toThrow('roll back')

      const [row] = await sql<{ revoked_at: Date | null }[]>`
        select revoked_at from user_tokens where session_id = ${sessionId}`
      expect(row).toBeDefined()
      expect(row?.revoked_at).toBeNull()
      expect(await isSessionDenied(sessionId)).toBe(false)
    }
  )

  it('denies only after the database revocation: a failed revoke denies nothing', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)

    await withMutatedMethod(
      UserTokenRepository.prototype,
      'revokeAllForSession',
      () => Promise.reject(new Error('database down')),
      async () => {
        await expect(revokeRefreshToken(issued.raw)).rejects.toThrow('database down')
      }
    )

    expect(await isSessionDenied(sessionId)).toBe(false)
  })
})
