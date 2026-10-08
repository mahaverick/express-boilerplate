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
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { sql } from '@/services/database.service'
import { resetDomainEventSubscribers } from '@/services/domain-events.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import {
  issueRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  type IssuedRefreshToken,
} from '@/services/session.service'
import { clearOutbox, outboxRowsOf } from '../../helpers/analytics-outbox'
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
