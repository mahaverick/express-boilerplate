/**
 * @file `authenticated_at`: set when a session starts, carried by every
 * rotation (grace-window siblings included), and moved by a confirmed
 * step-up link (`confirmStepUpLink`, through `markSessionReauthenticated`)
 * on every refresh row of that session and nowhere else: not on the link's
 * own row, which shares the session id, and not on the user's other
 * sessions. Real per-worker Postgres; deleting the user cascades to its
 * token rows.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { issueLinkToken } from '@/services/link-token.service'
import {
  issueRefreshToken,
  markSessionReauthenticated,
  rotateRefreshToken,
  verifyAccessToken,
} from '@/services/session.service'
import { confirmStepUpLink } from '@/services/step-up.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'

const userRepository = new UserRepository()

/**
 * Every distinct `authenticated_at` on a session's refresh rows as epoch milliseconds, oldest first; NaN stands for NULL.
 */
async function authenticatedTimes(sessionId: string): Promise<number[]> {
  const rows = await sql<{ at: Date | null }[]>`
    select distinct authenticated_at as at from user_tokens
    where session_id = ${sessionId} and purpose = 'refresh'
    order by 1
  `
  return rows.map((row) => (row.at === null ? NaN : new Date(row.at).getTime()))
}

/**
 * Move a session's `authenticated_at` an hour into the past on every refresh row, so a later reauthentication is distinguishable from the issue time.
 */
async function ageSession(sessionId: string): Promise<void> {
  await sql`
    update user_tokens set authenticated_at = authenticated_at - interval '1 hour'
    where session_id = ${sessionId} and purpose = 'refresh'
  `
}

/**
 * Mint a step-up link for one session of a user, as `requestStepUpLink` would mail it.
 * @param userId - The user.
 * @param sessionId - The session it confirms.
 * @returns The raw token.
 */
async function stepUpLinkFor(userId: string, sessionId: string): Promise<string> {
  const { raw } = await issueLinkToken(
    {
      intent: 'step_up',
      userId,
      sessionId,
      email: `step-up-${userId}@example.test`,
      app: 'apex',
    },
    requireDurationMs(getEnv().STEP_UP_LINK_TTL)
  )
  return raw
}

describe('session authentication time', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a user for a test and track it for the `afterEach` cleanup; resolves with its id.
   */
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

  it('a confirmed step-up link moves authenticated_at on every refresh row of its session, live and rotated away', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const issued = await issueRefreshToken(userId, sessionId)
    const rotated = await rotateRefreshToken(issued.raw)
    await ageSession(sessionId)
    const raw = await stepUpLinkFor(userId, sessionId)
    const before = Date.now()

    const { accessToken } = await confirmStepUpLink(userId, sessionId, raw)

    const [at] = await authenticatedTimes(sessionId)
    expect(await authenticatedTimes(sessionId)).toHaveLength(1)
    expect(at).toBeGreaterThanOrEqual(before - 1000)
    const verified = verifyAccessToken(accessToken)
    expect(verified.ok && verified.payload.auth_time).toBe(Math.floor((at ?? 0) / 1000))
    // The next rotation copies the confirmed time forward.
    const next = await rotateRefreshToken(rotated.raw)
    expect(next.authenticatedAt?.getTime()).toBe(at)
  })

  it('a confirmed step-up link leaves its own row and the user’s other sessions alone', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const otherSessionId = randomUUID()
    await issueRefreshToken(userId, sessionId)
    const other = await issueRefreshToken(userId, otherSessionId)
    await ageSession(otherSessionId)
    const raw = await stepUpLinkFor(userId, sessionId)

    await confirmStepUpLink(userId, sessionId, raw)

    const [linkRow] = await sql<{ authenticatedAt: Date | null; consumed: boolean }[]>`
      select authenticated_at as "authenticatedAt", consumed_at is not null as consumed
      from user_tokens where session_id = ${sessionId} and purpose = 'step_up_link'
    `
    // eslint-disable-next-line unicorn/no-null -- the column's SQL NULL: a link row never carries an authentication time
    expect(linkRow).toEqual({ authenticatedAt: null, consumed: true })
    expect(await authenticatedTimes(otherSessionId)).toEqual([
      (other.authenticatedAt?.getTime() ?? 0) - 60 * 60 * 1000,
    ])
  })

  it('a step-up link confirmed by another session of its user moves nothing', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    const otherSessionId = randomUUID()
    await issueRefreshToken(userId, sessionId)
    await issueRefreshToken(userId, otherSessionId)
    await ageSession(sessionId)
    await ageSession(otherSessionId)
    const timesBefore = [
      await authenticatedTimes(sessionId),
      await authenticatedTimes(otherSessionId),
    ]
    const raw = await stepUpLinkFor(userId, sessionId)

    await expect(confirmStepUpLink(userId, otherSessionId, raw)).rejects.toMatchObject({
      statusCode: 400,
    })

    expect([await authenticatedTimes(sessionId), await authenticatedTimes(otherSessionId)]).toEqual(
      timesBefore
    )
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
    // The next rotation copies the reauthenticated time forward.
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
      code: ACCESS_TOKEN_EXPIRED_CODE,
    })
  })

  it('refuses a session past its absolute lifetime, as a refresh would', async () => {
    const userId = await createUser()
    const sessionId = randomUUID()
    await issueRefreshToken(userId, sessionId)
    const lifetimeMs = requireDurationMs(getEnv().SESSION_ABSOLUTE_TTL)
    await sql`
      update user_tokens
      set session_started_at = now() - make_interval(secs => ${lifetimeMs / 1000 + 60})
      where session_id = ${sessionId}
    `

    await expect(markSessionReauthenticated(userId, sessionId)).rejects.toMatchObject({
      statusCode: 401,
      code: ACCESS_TOKEN_EXPIRED_CODE,
    })
  })

  it.each([
    ['deactivated', 'update users set active = false where id = $1'],
    ['soft-deleted', 'update users set deleted_at = now() where id = $1'],
  ])('refuses a %s user, even with a live session', async (_label, statement) => {
    const userId = await createUser()
    const sessionId = randomUUID()
    await issueRefreshToken(userId, sessionId)
    await sql.unsafe(statement, [userId])

    await expect(markSessionReauthenticated(userId, sessionId)).rejects.toMatchObject({
      statusCode: 401,
      code: ACCESS_TOKEN_EXPIRED_CODE,
    })
  })
})
