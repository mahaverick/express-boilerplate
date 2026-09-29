/**
 * @file `authenticated_at`: set when a session starts, carried by every
 * rotation (grace-window siblings included), and moved by
 * `markSessionReauthenticated` on every row of the session. Real per-worker
 * Postgres; deleting the user cascades to its token rows.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import {
  issueRefreshToken,
  markSessionReauthenticated,
  rotateRefreshToken,
} from '@/services/session.service'

const userRepository = new UserRepository()

/**
 * Every distinct `authenticated_at` in a session, as epoch milliseconds.
 * @param sessionId - The session.
 * @returns The distinct values, oldest first.
 */
async function authenticatedTimes(sessionId: string): Promise<number[]> {
  const rows = await sql<{ at: Date | null }[]>`
    select distinct authenticated_at as at from user_tokens where session_id = ${sessionId}
    order by 1
  `
  return rows.map((row) => (row.at === null ? NaN : new Date(row.at).getTime()))
}

/**
 * Move a session's authentication an hour into the past.
 * @param sessionId - The session.
 */
async function ageSession(sessionId: string): Promise<void> {
  await sql`
    update user_tokens set authenticated_at = authenticated_at - interval '1 hour'
    where session_id = ${sessionId}
  `
}

describe('session authentication time', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: `step-up-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    return user.id
  }

  it('stamps a new session with authenticated_at equal to its start', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)

    const [row] = await sql<{ started: Date; authenticated: Date }[]>`
      select session_started_at as started, authenticated_at as authenticated
      from user_tokens where session_id = ${sessionId}
    `
    expect(row).toBeDefined()
    expect(new Date(row!.authenticated).getTime()).toBe(new Date(row!.started).getTime())
    expect(issued.authenticatedAt?.getTime()).toBe(new Date(row!.authenticated).getTime())
  })

  it('carries authenticated_at unchanged across rotations', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)

    const rotated = await rotateRefreshToken(issued.raw)
    const rotatedAgain = await rotateRefreshToken(rotated.raw)

    expect(await authenticatedTimes(sessionId)).toEqual([issued.authenticatedAt?.getTime()])
    expect(rotatedAgain.authenticatedAt?.getTime()).toBe(issued.authenticatedAt?.getTime())
  })

  it('carries authenticated_at onto a grace-window sibling (a concurrent refresh)', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    await rotateRefreshToken(issued.raw)

    // Replayed inside REFRESH_REUSE_GRACE_MS: findGraceSession/continueSession mint a sibling.
    const sibling = await rotateRefreshToken(issued.raw)

    expect(sibling.sessionId).toBe(sessionId)
    expect(sibling.authenticatedAt?.getTime()).toBe(issued.authenticatedAt?.getTime())
    expect(await authenticatedTimes(sessionId)).toEqual([issued.authenticatedAt?.getTime()])
  })

  it('markSessionReauthenticated moves every row of the session, live and rotated away', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    const rotated = await rotateRefreshToken(issued.raw)
    await ageSession(sessionId)
    const before = Date.now()

    const at = await markSessionReauthenticated(userId, sessionId)

    expect(at.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(await authenticatedTimes(sessionId)).toEqual([at.getTime()])
    // The next rotation copies the new time forward.
    const next = await rotateRefreshToken(rotated.raw)
    expect(next.authenticatedAt?.getTime()).toBe(at.getTime())
  })

  it('a grace sibling minted after a reauthentication carries the new time', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    await rotateRefreshToken(issued.raw)
    await ageSession(sessionId)

    const at = await markSessionReauthenticated(userId, sessionId)
    const sibling = await rotateRefreshToken(issued.raw)

    expect(sibling.authenticatedAt?.getTime()).toBe(at.getTime())
  })

  it('leaves the user’s other sessions alone', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const otherSessionId = randomUUID()
    await issueRefreshToken(userId, sessionId)
    const other = await issueRefreshToken(userId, otherSessionId)
    await ageSession(sessionId)
    await ageSession(otherSessionId)

    await markSessionReauthenticated(userId, sessionId)

    expect(await authenticatedTimes(otherSessionId)).toEqual([
      (other.authenticatedAt?.getTime() ?? 0) - 60 * 60 * 1000,
    ])
  })

  it('refuses a session with no live refresh token, asking the client to refresh', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    await issueRefreshToken(userId, sessionId)
    await sql`update user_tokens set revoked_at = now() where session_id = ${sessionId}`

    await expect(markSessionReauthenticated(userId, sessionId)).rejects.toMatchObject({
      statusCode: 401,
      code: ACCESS_TOKEN_EXPIRED_CODE,
    })
  })

  it('refuses a session that belongs to another user', async () => {
    const userId = await createUser()
    const otherUserId = await createUser()
    const sessionId = randomUUID()
    await issueRefreshToken(otherUserId, sessionId)

    await expect(markSessionReauthenticated(userId, sessionId)).rejects.toMatchObject({
      statusCode: 401,
      code: ACCESS_TOKEN_EXPIRED_CODE,
    })
  })

  it('refuses an unknown session', async () => {
    const userId = await createUser()
    await expect(markSessionReauthenticated(userId, randomUUID())).rejects.toMatchObject({
      statusCode: 401,
    })
  })
})
