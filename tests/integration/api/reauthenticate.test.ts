/**
 * @file POST /api/v1/auth/reauthenticate: step-up for staff. Sessions come
 * from real logins, since the endpoint marks the session named by the
 * token's `sid` and a fabricated sid has no rows behind it. A wrong password
 * must never be a 401: every client signs out on a non-expiry 401.
 */
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import { UserRepository } from '@/repositories/user.repository'
import { reauthenticate as reauthenticateService } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { signAccessToken, verifyAccessToken } from '@/services/session.service'
import { hashPassword } from '@/utilities/password.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { agent, request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()
const PASSWORD = 'correct horse battery staple'

interface StaffSession {
  userId: string
  email: string
  token: string
  sid: string
  browser: ReturnType<typeof agent>
}

/**
 * The verified claims of a token.
 * @param token - An access token this server issued.
 * @returns Its `sid` and `auth_time`.
 */
function claims(token: string): { sid: string | undefined; authTime: number | undefined } {
  const verified = verifyAccessToken(token)
  if (!verified.ok) throw new Error('unverifiable token')
  return { sid: verified.payload.sid, authTime: verified.payload.auth_time }
}

/**
 * The access token in a reply's envelope.
 * @param response - A login, refresh or reauthenticate reply.
 * @returns The token.
 */
function accessTokenOf(response: Response): string {
  return (response.body as { data: { accessToken: string } }).data.accessToken
}

/**
 * Age a session's authentication by an hour, as if signed in long ago.
 * @param sid - The session.
 */
async function ageSession(sid: string): Promise<void> {
  await sql`
    update user_tokens set authenticated_at = authenticated_at - interval '1 hour'
    where session_id = ${sid}
  `
}

function reauthenticate(token: string, body: unknown): Promise<Response> {
  return request(app)
    .post('/api/v1/auth/reauthenticate')
    .set('Authorization', `Bearer ${token}`)
    .send(body as object)
}

async function auditRows(userId: string): Promise<{ outcome: string; tenantId: string }[]> {
  const rows = await sql<{ metadata: { outcome: string }; tenant_id: string }[]>`
    select metadata, tenant_id from audit_logs
    where action = 'auth.reauthenticated' and target_id = ${userId}
    order by occurred_at, id
  `
  return rows.map((row) => ({ outcome: row.metadata.outcome, tenantId: row.tenant_id }))
}

describe('POST /api/v1/auth/reauthenticate', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * A verified user with a password, optionally staff, signed in through the real login.
   * @param role - The platform role, or null for a non-staff user.
   * @returns The session: its access token, sid and the cookie-carrying agent.
   */
  async function signIn(role: MembershipRole | null = 'viewer'): Promise<StaffSession> {
    const email = `reauth-${randomUUID()}@example.test`
    const user = await userRepository.create({ email, passwordHash: await hashPassword(PASSWORD) })
    createdIds.push(user.id)
    await sql`update users set email_verified_at = now() where id = ${user.id}`
    if (role !== null) await makeStaff(user.id, role)
    const browser = agent(app)
    const login = await browser.post('/api/v1/auth/login').send({ email, password: PASSWORD })
    expect(login.status).toBe(200)
    const token = accessTokenOf(login)
    const { sid } = claims(token)
    if (!sid) throw new Error('login issued a token without sid')
    return { userId: user.id, email, token, sid, browser }
  }

  it('confirms the password, returns a token with a fresh auth_time for the same session, and audits it', async () => {
    const session = await signIn('viewer')
    await ageSession(session.sid)
    const before = Math.floor(Date.now() / 1000)

    const response = await reauthenticate(session.token, { password: PASSWORD })

    expect(response.status).toBe(200)
    const fresh = claims(accessTokenOf(response))
    expect(fresh.sid).toBe(session.sid)
    expect(fresh.authTime).toBeGreaterThanOrEqual(before - 1)
    const platform = await platformTenant()
    expect(await auditRows(session.userId)).toEqual([{ outcome: 'success', tenantId: platform.id }])
  })

  it('a refresh after reauthenticating keeps the new time', async () => {
    const session = await signIn('viewer')
    await ageSession(session.sid)
    const confirmed = await reauthenticate(session.token, { password: PASSWORD })
    const confirmedAt = claims(accessTokenOf(confirmed)).authTime

    const refreshed = await session.browser.post('/api/v1/auth/refresh').send({})

    expect(refreshed.status).toBe(200)
    expect(claims(accessTokenOf(refreshed)).authTime).toBe(confirmedAt)
  })

  it('answers a wrong password with 400, never 401, and leaves the session working', async () => {
    const session = await signIn('admin')

    const response = await reauthenticate(session.token, { password: 'not the password' })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ success: false, message: 'Incorrect password.' })
    const profile = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${session.token}`)
    expect(profile.status).toBe(200)
    const result = await auditRows(session.userId)
    expect(result.map((row) => row.outcome)).toEqual(['failure'])
  })

  it('answers a passwordless (Google-only) staff account with 400 pointing at Google', async () => {
    const user = await userRepository.create({
      email: `reauth-google-${randomUUID()}@example.test`,
    })
    createdIds.push(user.id)
    await sql`update users set email_verified_at = now() where id = ${user.id}`
    await makeStaff(user.id, 'viewer')
    const sid = randomUUID()
    await sql`
      insert into user_tokens (user_id, purpose, session_id, session_started_at, authenticated_at, token_hash, expires_at)
      values (${user.id}, 'refresh', ${sid}, now(), now(), ${randomUUID().replaceAll('-', '').padEnd(64, '0')}, now() + interval '1 day')
    `

    const response = await reauthenticate(signAccessToken(user, sid, new Date()), {
      password: 'anything',
    })

    expect(response.status).toBe(400)
    expect((response.body as { message: string }).message).toMatch(/Google/)
  })

  it('is invisible to non-staff: the unknown-route 404, with no rate-limit headers', async () => {
    // eslint-disable-next-line unicorn/no-null -- a non-staff caller has no platform role
    const session = await signIn(null)

    const response = await reauthenticate(session.token, { password: PASSWORD })

    expect(response.status).toBe(404)
    expect(response.headers['ratelimit-limit']).toBeUndefined()
  })

  it('asks a token without sid to refresh (401 ACCESS_TOKEN_EXPIRED)', async () => {
    const session = await signIn('viewer')
    const sidLess = jwt.sign({ sub: session.userId }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    const response = await reauthenticate(sidLess, { password: PASSWORD })

    expect(response.status).toBe(401)
    expect((response.body as { code?: string }).code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
  })

  it('asks a session whose refresh tokens were revoked to refresh (401 ACCESS_TOKEN_EXPIRED)', async () => {
    const session = await signIn('viewer')
    await sql`update user_tokens set revoked_at = now() where session_id = ${session.sid}`

    const response = await reauthenticate(session.token, { password: PASSWORD })

    expect(response.status).toBe(401)
    expect((response.body as { code?: string }).code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
  })

  // Over HTTP requireAuth refuses an inactive account first; this is the service's own check, for one deactivated after that.
  it.each([
    ['deactivated', 'update users set active = false where id = $1'],
    ['soft-deleted', 'update users set deleted_at = now() where id = $1'],
  ])(
    'asks a caller whose account was %s to refresh (401 ACCESS_TOKEN_EXPIRED)',
    async (_label, statement) => {
      const session = await signIn('viewer')
      await sql.unsafe(statement, [session.userId])

      await expect(
        reauthenticateService(session.userId, session.sid, { password: PASSWORD })
      ).rejects.toMatchObject({ statusCode: 401, code: ACCESS_TOKEN_EXPIRED_CODE })
      expect(await auditRows(session.userId)).toEqual([])
    }
  )

  it('rejects a missing password with 400', async () => {
    const session = await signIn('viewer')
    const response = await reauthenticate(session.token, {})
    expect(response.status).toBe(400)
  })

  it('allows 5 attempts per 15 minutes per user, then 429', async () => {
    const session = await signIn('viewer')
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await reauthenticate(session.token, { password: 'wrong' })
      expect(response.status).toBe(400)
    }
    const limited = await reauthenticate(session.token, { password: PASSWORD })
    expect(limited.status).toBe(429)
  })
})
