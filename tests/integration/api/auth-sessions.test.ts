/**
 * @file `POST /api/v1/auth/sessions/revoke-others` against the real
 * per-worker Postgres and Redis: the caller's other sessions end at once
 * (their refresh tokens stop rotating and their access tokens are denied)
 * while the calling session keeps working, and the product event reaches the
 * outbox. Sessions are issued with `issueRefreshToken` and a matching bearer.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { sql } from '@/services/database.service'
import { resetDomainEventSubscribers } from '@/services/domain-events.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import {
  hashToken,
  issueRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  type IssuedRefreshToken,
} from '@/services/session.service'
import { clearOutbox, outboxRowsOf } from '../../helpers/analytics-outbox'
import {
  isTokenRowLive,
  refreshCookieHeader,
  rotatedSessionId,
  sessionWithSibling,
  type SessionWithSibling,
} from '../../helpers/grace-sibling'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true }
})

const app = createApp()

beforeAll(() => {
  resetDomainEventSubscribers()
  registerAnalyticsSubscribers()
})

afterEach(async () => {
  await clearOutbox()
  await deleteTrackedUsers()
})

afterAll(() => {
  resetDomainEventSubscribers()
})

/**
 * A session for `user`: its refresh token and a bearer carrying its `sid`.
 * @param user - The user.
 * @returns The refresh token and the access token.
 */
async function sessionFor(user: User): Promise<{ refresh: IssuedRefreshToken; bearer: string }> {
  const refresh = await issueRefreshToken(user.id, randomUUID())
  return { refresh, bearer: signAccessToken(user, refresh.sessionId) }
}

/**
 * Sign out every other session as the bearer of `token`.
 * @param token - The caller's access token, or none.
 * @returns The response.
 */
async function revokeOthers(token?: string) {
  const pending = request(app).post('/api/v1/auth/sessions/revoke-others')
  if (token !== undefined) pending.set('Authorization', `Bearer ${token}`)
  return pending.send({})
}

describe('POST /api/v1/auth/sessions/revoke-others', () => {
  it('ends every other session and keeps the calling one', async () => {
    const user = await createTrackedUser()
    const current = await sessionFor(user)
    const other = await sessionFor(user)
    const third = await sessionFor(user)

    const response = await revokeOthers(current.bearer)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ success: true, data: { revoked: 2 } })
    await expect(rotateRefreshToken(other.refresh.raw)).rejects.toMatchObject({ statusCode: 401 })
    await expect(rotateRefreshToken(third.refresh.raw)).rejects.toMatchObject({ statusCode: 401 })
    expect(await isSessionDenied(other.refresh.sessionId)).toBe(true)
    expect(await isSessionDenied(third.refresh.sessionId)).toBe(true)
    expect(await isSessionDenied(current.refresh.sessionId)).toBe(false)
    const signedOut = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${other.bearer}`)
    expect(signedOut.status).toBe(401)
    const rotated = await rotateRefreshToken(current.refresh.raw)
    expect(rotated.sessionId).toBe(current.refresh.sessionId)
    const stillIn = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${current.bearer}`)
    expect(stillIn.status).toBe(200)
  })

  it('answers revoked 0 when no other session is live', async () => {
    const user = await createTrackedUser()
    const current = await sessionFor(user)

    const response = await revokeOthers(current.bearer)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { revoked: 0 } })
  })

  it('revokes a lapsed session without counting it', async () => {
    const user = await createTrackedUser()
    const current = await sessionFor(user)
    const live = await sessionFor(user)
    const lapsed = await sessionFor(user)
    await sql`update user_tokens set expires_at = now() - interval '1 minute' where session_id = ${lapsed.refresh.sessionId}`

    const response = await revokeOthers(current.bearer)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { revoked: 1 } })
    expect(await isSessionDenied(live.refresh.sessionId)).toBe(true)
    const lapsedRows = await sql<{ revoked_at: string | null }[]>`
      select revoked_at from user_tokens where session_id = ${lapsed.refresh.sessionId}
    `
    expect(lapsedRows).toHaveLength(1)
    expect(lapsedRows[0]?.revoked_at).not.toBeNull()
  })

  it('revokes a session past its absolute lifetime without counting it', async () => {
    const user = await createTrackedUser()
    const current = await sessionFor(user)
    const live = await sessionFor(user)
    const aged = await sessionFor(user)
    // Unexpired and unrevoked, but started before SESSION_ABSOLUTE_TTL: rotation refuses it, so it is not signed in.
    await sql`update user_tokens set session_started_at = now() - interval '400 days' where session_id = ${aged.refresh.sessionId}`

    const response = await revokeOthers(current.bearer)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { revoked: 1 } })
    expect(await isSessionDenied(live.refresh.sessionId)).toBe(true)
    expect(await isSessionDenied(aged.refresh.sessionId)).toBe(true)
    const agedRows = await sql<{ revoked_at: string | null }[]>`
      select revoked_at from user_tokens where session_id = ${aged.refresh.sessionId}
    `
    expect(agedRows).toHaveLength(1)
    expect(agedRows[0]?.revoked_at).not.toBeNull()
  })

  it('leaves another user’s sessions alone', async () => {
    const user = await createTrackedUser()
    const bystander = await createTrackedUser()
    const current = await sessionFor(user)
    const theirs = await sessionFor(bystander)

    await revokeOthers(current.bearer)

    expect(await isSessionDenied(theirs.refresh.sessionId)).toBe(false)
    const rotated = await rotateRefreshToken(theirs.refresh.raw)
    expect(rotated.userId).toBe(bystander.id)
  })

  it('writes other_sessions_revoked to the outbox as the user', async () => {
    const user = await createTrackedUser()
    const current = await sessionFor(user)
    await sessionFor(user)
    await clearOutbox()

    await revokeOthers(current.bearer)

    expect(await outboxRowsOf('other_sessions_revoked')).toEqual([
      expect.objectContaining({ distinctId: user.id }),
    ])
  })

  it('answers 401 without a bearer token', async () => {
    const response = await revokeOthers()

    expect(response.status).toBe(401)
  })

  it('answers 401 ACCESS_TOKEN_EXPIRED to a token without a session, revoking nothing', async () => {
    const user = await createTrackedUser()
    const other = await sessionFor(user)
    const { default: jwt } = await import('jsonwebtoken')
    const { getEnv } = await import('@/configs/env.config')
    const sidless = jwt.sign({ sub: user.id }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: 60,
    })

    const response = await revokeOthers(sidless)

    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ code: ACCESS_TOKEN_EXPIRED_CODE })
    expect(await isSessionDenied(other.refresh.sessionId)).toBe(false)
  })

  it('refuses a body with an unknown key 400, revoking nothing', async () => {
    const user = await createTrackedUser()
    const current = await sessionFor(user)
    const other = await sessionFor(user)

    const response = await request(app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${current.bearer}`)
      .send({ everywhere: true })

    expect(response.status).toBe(400)
    expect(await isSessionDenied(other.refresh.sessionId)).toBe(false)
  })

  it('accepts a request with no body', async () => {
    const user = await createTrackedUser()
    const current = await sessionFor(user)
    await sessionFor(user)

    const response = await request(app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${current.bearer}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { revoked: 1 } })
  })

  it('refuses a body that is not JSON 415', async () => {
    const user = await createTrackedUser()
    const current = await sessionFor(user)

    const response = await request(app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${current.bearer}`)
      .set('Content-Type', 'text/plain')
      .send('x')

    expect(response.status).toBe(415)
  })
})

/**
 * Sign out other sessions as `bearer`, presenting `cookie` when given.
 * @param bearer - The caller's access token.
 * @param cookie - The `Cookie` header to send, if any.
 * @returns The response.
 */
async function revokeOthersWithCookie(bearer: string, cookie?: string) {
  const pending = request(app)
    .post('/api/v1/auth/sessions/revoke-others')
    .set('Authorization', `Bearer ${bearer}`)
  if (cookie !== undefined) pending.set('Cookie', cookie)
  return pending.send({})
}

/**
 * A live refresh token of another user, planted in the caller's session.
 * @param caller - The caller's session.
 * @returns The planted token's raw value.
 */
async function plantForeignUsersRefresh(caller: SessionWithSibling): Promise<string> {
  const bystander = await createTrackedUser()
  const planted = await issueRefreshToken(bystander.id, caller.head.sessionId)
  return planted.raw
}

/**
 * A live password-reset token of the caller that carries the caller's
 * session id, which no application path writes.
 * @param caller - The caller's session.
 * @returns The planted token's raw value.
 */
async function plantResetRowInSession(caller: SessionWithSibling): Promise<string> {
  const raw = randomUUID()
  await new UserTokenRepository().create({
    userId: caller.head.userId,
    purpose: 'password_reset',
    sessionId: caller.head.sessionId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + 60_000),
  })
  return raw
}

/**
 * A grace-window replay mints a sibling: a second live chain in the caller's
 * own session. The refresh cookie the browser sends on this route names the
 * caller's chain, so everything else in the session ends with the other
 * sessions; without a usable cookie the whole session is spared, as before.
 */
describe('POST /api/v1/auth/sessions/revoke-others and a grace sibling', () => {
  it('ends the sibling chain when the caller presents its refresh cookie, and keeps the caller', async () => {
    const user = await createTrackedUser()
    const caller = await sessionWithSibling(user)
    const other = await sessionFor(user)

    const response = await revokeOthersWithCookie(
      caller.bearer,
      refreshCookieHeader(caller.head.raw)
    )

    expect(response.status).toBe(200)
    // The sibling is not another session to the user: only `other` counts.
    expect(response.body).toMatchObject({ success: true, data: { revoked: 1 } })
    await expect(rotateRefreshToken(other.refresh.raw)).rejects.toMatchObject({ statusCode: 401 })
    expect(await isSessionDenied(other.refresh.sessionId)).toBe(true)
    // Never the caller's own sid: that would end the caller's access token too.
    expect(await isSessionDenied(caller.head.sessionId)).toBe(false)
    const stillIn = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${caller.bearer}`)
    expect(stillIn.status).toBe(200)
    // The caller rotates before the sibling is replayed: a replay of the revoked sibling is reuse and ends the whole session.
    expect(await rotatedSessionId(caller.head.raw)).toBe(caller.head.sessionId)
    await expect(rotateRefreshToken(caller.sibling.raw)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('treats a later replay of the ended sibling as reuse, which ends the caller’s session too', async () => {
    const user = await createTrackedUser()
    const caller = await sessionWithSibling(user)

    await revokeOthersWithCookie(caller.bearer, refreshCookieHeader(caller.head.raw))

    // The sibling was revoked, not rotated, so no grace applies: reuse kills the shared session.
    await expect(rotateRefreshToken(caller.sibling.raw)).rejects.toMatchObject({ statusCode: 401 })
    await expect(rotateRefreshToken(caller.head.raw)).rejects.toMatchObject({ statusCode: 401 })
    expect(await isSessionDenied(caller.head.sessionId)).toBe(true)
  })

  it('spares the sibling when no refresh cookie is presented', async () => {
    const user = await createTrackedUser()
    const caller = await sessionWithSibling(user)
    const other = await sessionFor(user)

    const response = await revokeOthersWithCookie(caller.bearer)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { revoked: 1 } })
    expect(await isSessionDenied(other.refresh.sessionId)).toBe(true)
    expect(await rotatedSessionId(caller.sibling.raw)).toBe(caller.head.sessionId)
    expect(await rotatedSessionId(caller.head.raw)).toBe(caller.head.sessionId)
  })

  it('spares the caller’s whole session for a cookie of another session of the user, and ends that session', async () => {
    const user = await createTrackedUser()
    const caller = await sessionWithSibling(user)
    const other = await sessionFor(user)

    const response = await revokeOthersWithCookie(
      caller.bearer,
      refreshCookieHeader(other.refresh.raw)
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { revoked: 1 } })
    await expect(rotateRefreshToken(other.refresh.raw)).rejects.toMatchObject({ statusCode: 401 })
    expect(await isSessionDenied(other.refresh.sessionId)).toBe(true)
    expect(await isSessionDenied(caller.head.sessionId)).toBe(false)
    expect(await rotatedSessionId(caller.sibling.raw)).toBe(caller.head.sessionId)
    expect(await rotatedSessionId(caller.head.raw)).toBe(caller.head.sessionId)
  })

  it.each([
    ['an unknown cookie', (_caller: SessionWithSibling) => 'not-a-real-refresh-token'],
    // The head's predecessor: same user and session, but revoked by its rotation.
    ['a revoked cookie of the caller’s session', (caller: SessionWithSibling) => caller.spent],
  ])('spares the caller’s whole session for %s', async (_label, cookieRaw) => {
    const user = await createTrackedUser()
    const caller = await sessionWithSibling(user)
    const other = await sessionFor(user)

    const response = await revokeOthersWithCookie(
      caller.bearer,
      refreshCookieHeader(cookieRaw(caller))
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { revoked: 1 } })
    expect(await isSessionDenied(other.refresh.sessionId)).toBe(true)
    expect(await isSessionDenied(caller.head.sessionId)).toBe(false)
    expect(await isTokenRowLive(caller.sibling.raw)).toBe(true)
    expect(await isTokenRowLive(caller.head.raw)).toBe(true)
  })

  // Rows built so that exactly one check fails: each carries the caller's session id and is unrevoked.
  it.each([
    ['another user’s refresh row in the caller’s session', plantForeignUsersRefresh],
    ['a password-reset row of the caller carrying the caller’s session id', plantResetRowInSession],
  ])('spares the caller’s whole session for %s', async (_label, plant) => {
    const user = await createTrackedUser()
    const caller = await sessionWithSibling(user)
    const cookieRaw = await plant(caller)

    const response = await revokeOthersWithCookie(caller.bearer, refreshCookieHeader(cookieRaw))

    expect(response.status).toBe(200)
    expect(await isTokenRowLive(caller.head.raw)).toBe(true)
    expect(await isTokenRowLive(caller.sibling.raw)).toBe(true)
  })

  it('spares the caller’s whole session for another user’s live cookie, and leaves that user alone', async () => {
    const user = await createTrackedUser()
    const bystander = await createTrackedUser()
    const caller = await sessionWithSibling(user)
    const theirs = await sessionFor(bystander)

    const response = await revokeOthersWithCookie(
      caller.bearer,
      refreshCookieHeader(theirs.refresh.raw)
    )

    expect(response.status).toBe(200)
    expect(await isTokenRowLive(caller.sibling.raw)).toBe(true)
    expect(await isTokenRowLive(theirs.refresh.raw)).toBe(true)
  })
})
