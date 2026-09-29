/**
 * @file The access tokens login and refresh hand out carry the session's
 * authentication time, and a refresh keeps it: refreshing is not
 * re-authenticating. Real login through HTTP, so the refresh cookie is real.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { verifyAccessToken } from '@/services/session.service'
import { hashPassword } from '@/utilities/password.utilities'
import { agent } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()
const PASSWORD = 'correct horse battery staple'

/**
 * The verified `auth_time` and `sid` of the access token in a login or refresh reply.
 * @param response - The reply.
 * @returns The claims.
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

  async function createUser(): Promise<string> {
    const email = `step-up-tokens-${randomUUID()}@example.test`
    const user = await userRepository.create({ email, passwordHash: await hashPassword(PASSWORD) })
    createdIds.push(user.id)
    await sql`update users set email_verified_at = now() where id = ${user.id}`
    return email
  }

  it('a login token carries auth_time = now, and a refresh keeps it', async () => {
    const email = await createUser()
    const browser = agent(app)
    const before = Math.floor(Date.now() / 1000)

    const login = await browser.post('/api/v1/auth/login').send({ email, password: PASSWORD })
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
    const login = await browser.post('/api/v1/auth/login').send({ email, password: PASSWORD })
    const { sid, authTime } = claimsOf(login)
    await sql`
      update user_tokens set authenticated_at = authenticated_at - interval '1 hour'
      where session_id = ${sid ?? ''}
    `

    const refreshed = await browser.post('/api/v1/auth/refresh').send({})

    expect(claimsOf(refreshed).authTime).toBe((authTime ?? 0) - 3600)
  })
})
