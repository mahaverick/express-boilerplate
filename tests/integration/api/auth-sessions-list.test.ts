/**
 * @file `GET /api/v1/auth/sessions` against the real per-worker Postgres:
 * the caller's live sessions with their client and device, the current one
 * marked, and never a revoked, expired or another user's session. The cap
 * is proved through the repository's `limit` parameter on real rows.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import type { User } from '@/database/models/user.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { sql } from '@/services/database.service'
import {
  issueRefreshToken,
  signAccessToken,
  type IssuedRefreshToken,
  type SessionClient,
} from '@/services/session.service'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { WEB_CLIENT } from '../../helpers/session-client'

const app = createApp()
const repository = new UserTokenRepository()
/**
 * `expect.any(String)` typed as `string`, because vitest types it as `any`.
 */
const ANY_STRING = expect.any(String) as unknown as string
const NATIVE_CLIENT: SessionClient = { kind: 'native', deviceName: 'Pixel 9' }

afterEach(async () => {
  await deleteTrackedUsers()
})

/**
 * Sign `user` in with `client`.
 * @param user - The session's user.
 * @param client - The client the session is for.
 * @returns The refresh token issued.
 */
function signIn(user: User, client: SessionClient): Promise<IssuedRefreshToken> {
  return issueRefreshToken(user.id, randomUUID(), undefined, { client })
}

/**
 * The session ids a list response carries, in order.
 * @param body - The response body.
 * @returns The ids.
 */
function idsOf(body: unknown): string[] {
  const { data } = body as { data: { id: string }[] }
  return data.map((session) => session.id)
}

/**
 * Read the session list as the bearer of `token`.
 * @param token - An access token, or none.
 * @returns The response.
 */
async function listSessions(token?: string) {
  const pending = request(app).get('/api/v1/auth/sessions')
  if (token !== undefined) pending.set('Authorization', `Bearer ${token}`)
  return pending
}

describe('GET /api/v1/auth/sessions', () => {
  it('lists a web and a native session for the caller, marking the current one', async () => {
    const user = await createTrackedUser()
    const web = await signIn(user, WEB_CLIENT)
    const native = await signIn(user, NATIVE_CLIENT)
    await sql`update user_tokens set created_at = now() - interval '1 hour' where session_id = ${web.sessionId}`

    const response = await listSessions(signAccessToken(user, web.sessionId, web.authenticatedAt))

    expect(response.status).toBe(200)
    expect((response.body as { data: unknown }).data).toEqual([
      {
        id: native.sessionId,
        client: 'native',
        deviceName: 'Pixel 9',
        createdAt: ANY_STRING,
        lastUsedAt: ANY_STRING,
        current: false,
      },
      {
        id: web.sessionId,
        client: 'web',
        deviceName: null,
        createdAt: ANY_STRING,
        lastUsedAt: ANY_STRING,
        current: true,
      },
    ])
  })

  it('omits revoked and expired sessions', async () => {
    const user = await createTrackedUser()
    const live = await signIn(user, WEB_CLIENT)
    const revoked = await signIn(user, NATIVE_CLIENT)
    const expired = await signIn(user, NATIVE_CLIENT)
    await sql`update user_tokens set revoked_at = now() where session_id = ${revoked.sessionId}`
    await sql`update user_tokens set expires_at = now() - interval '1 minute' where session_id = ${expired.sessionId}`

    const response = await listSessions(signAccessToken(user, live.sessionId, live.authenticatedAt))

    expect(idsOf(response.body)).toEqual([live.sessionId])
  })

  it("never lists another user's sessions", async () => {
    const user = await createTrackedUser()
    const other = await createTrackedUser()
    const mine = await signIn(user, WEB_CLIENT)
    await signIn(other, NATIVE_CLIENT)

    const response = await listSessions(signAccessToken(user, mine.sessionId, mine.authenticatedAt))

    expect(idsOf(response.body)).toEqual([mine.sessionId])
  })

  it('answers 401 without a bearer token', async () => {
    const response = await listSessions()

    expect(response.status).toBe(401)
  })

  it('keeps the newest sessions when more are live than the cap', async () => {
    const user = await createTrackedUser()
    const oldest = await signIn(user, WEB_CLIENT)
    const middle = await signIn(user, WEB_CLIENT)
    const newest = await signIn(user, WEB_CLIENT)
    await sql`update user_tokens set created_at = now() - interval '3 hours' where session_id = ${oldest.sessionId}`
    await sql`update user_tokens set created_at = now() - interval '2 hours' where session_id = ${middle.sessionId}`

    const sessions = await repository.listLiveSessions(user.id, new Date(0), undefined, 2)

    expect(sessions.map((session) => session.sessionId)).toEqual([
      newest.sessionId,
      middle.sessionId,
    ])
  })
})
