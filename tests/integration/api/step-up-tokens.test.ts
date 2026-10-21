/**
 * @file The access tokens a sign-in and a refresh hand out carry the session's
 * authentication time, and a refresh keeps it: refreshing is not
 * re-authenticating. A real link sign-in through HTTP, so the refresh cookie is real.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { verifyAccessToken } from '@/services/session.service'
import { agent } from '../../helpers/request'
import { issueTestLink } from '../../helpers/sign-in'

const app = createApp()
const userRepository = new UserRepository()

/**
 * The `auth_time` and `sid` claims of the access token in a login or refresh reply.
 */
function claimsOf(response: Response): { authTime: number | undefined; sid: string | undefined } {
  const token = (response.body as { data: { accessToken: string } }).data.accessToken
  const verified = verifyAccessToken(token)
  if (!verified.ok) throw new Error('the server issued a token it cannot verify')
  return { authTime: verified.payload.auth_time, sid: verified.payload.sid }
}

describe('auth_time on issued access tokens', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * A verified user, tracked for deletion in afterEach; returns their email.
   */
  async function createUser(): Promise<string> {
    const email = `step-up-tokens-${randomUUID()}@example.test`
    const user = await userRepository.create({ email })
    createdIds.push(user.id)
    await sql`update users set email_verified_at = now() where id = ${user.id}`
    return email
  }

  it('a sign-in token carries auth_time = now, and a refresh keeps it', async () => {
    const email = await createUser()
    const browser = agent(app)
    const before = Math.floor(Date.now() / 1000)

    const login = await browser
      .post('/api/v1/auth/link/verify')
      .send({ token: await issueTestLink(email) })
    expect(login.status).toBe(200)
    const atLogin = claimsOf(login)
    expect(atLogin.authTime).toBeGreaterThanOrEqual(before - 1)
    expect(atLogin.authTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))

    const refreshed = await browser.post('/api/v1/auth/refresh').send({})
    expect(refreshed.status).toBe(200)
    const atRefresh = claimsOf(refreshed)
    expect(atRefresh.sid).toBe(atLogin.sid)
    expect(atRefresh.authTime).toBe(atLogin.authTime)
  })

  it('a refresh after the session aged carries the old time, not the refresh time', async () => {
    const email = await createUser()
    const browser = agent(app)
    const login = await browser
      .post('/api/v1/auth/link/verify')
      .send({ token: await issueTestLink(email) })
    const { sid, authTime } = claimsOf(login)
    await sql`
      update user_tokens set authenticated_at = authenticated_at - interval '1 hour'
      where session_id = ${sid ?? ''}
    `

    const refreshed = await browser.post('/api/v1/auth/refresh').send({})

    expect(claimsOf(refreshed).authTime).toBe((authTime ?? 0) - 3600)
  })
})
