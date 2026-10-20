/**
 * @file `PASSKEY_MODE=required`: a signed-in account with no passkey is
 * answered 403 `PASSKEY_SETUP_REQUIRED` everywhere except the routes it needs
 * to create one. Covers the allowlist (method, path, trailing slash, case,
 * query), the lockout path (an invitation's one-click session confirms by
 * link and creates a passkey), the count query running only in required mode,
 * and a mode flip leaving stored passkeys intact. The mode is switched by
 * mocking `getEnv`, never `process.env`; the mail is read off `addEmailJob`.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import type { User } from '@/database/models/user.model'
import { addEmailJob } from '@/jobs/email.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserPasskeyRepository } from '@/repositories/user-passkey.repository'
import { db, sql } from '@/services/database.service'
import { closeQueue, getAuthEmailQueue, getEmailQueue } from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { SoftwareAuthenticator } from '../../helpers/passkey-authenticator'
import { passkeyCount, seedPasskey } from '../../helpers/passkey-rows'
import { createTrackedUser, deleteTrackedUsers, tokenFor } from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { clearRateLimiter } from '../../helpers/sign-in'

const mode = vi.hoisted(() => ({ current: 'optional' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), PASSKEY_MODE: mode.current }) }
})

vi.mock('@/jobs/email.job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/jobs/email.job')>()
  return { ...actual, addEmailJob: vi.fn(actual.addEmailJob) }
})

const app = createApp()
const BASE = '/api/v1/auth/passkeys'
const REQUIRED_MESSAGE = 'Create a passkey to continue. Your team requires one for every account.'
const countSpy = vi.spyOn(UserPasskeyRepository.prototype, 'countByUser')

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await closeQueue()
})

const usedEmails: string[] = []
const tenantIds: string[] = []

beforeEach(async () => {
  mode.current = 'required'
  countSpy.mockClear()
  await clearRateLimiter('passkey-manage')
  await clearRateLimiter('invitation-verify')
})

afterEach(async () => {
  await truncateAuditLogs()
  vi.mocked(addEmailJob).mockClear()
  if (tenantIds.length > 0) {
    await sql`delete from tenants where id = any(${tenantIds})`
    tenantIds.length = 0
  }
  if (usedEmails.length > 0) {
    await sql`delete from email_messages where recipient = any(${usedEmails})`
    await sql`delete from user_tokens where email = any(${usedEmails})`
    await sql`delete from users where lower(email) = any(${usedEmails})`
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

/**
 * A tracked, verified user.
 * @returns The user.
 */
async function makeUser(): Promise<User> {
  const user = await createTrackedUser({ firstName: 'Ada' })
  usedEmails.push(user.email.toLowerCase())
  return user
}

/**
 * The response body as the envelope fields these tests read.
 * @param response - The supertest response.
 * @returns The typed body.
 */
function body(response: { body: unknown }): {
  code: string
  message: string
  data: { accessToken: string; challengeId: string; options: { challenge: string } }
} {
  return response.body as ReturnType<typeof body>
}

/**
 * GET a path with a bearer token.
 * @param path - The full path, with any query.
 * @param token - The bearer token.
 * @returns The response.
 */
function get(path: string, token: string) {
  return request(app).get(path).set('Authorization', `Bearer ${token}`)
}

/**
 * The status a GET answers.
 * @param path - The full path, with any query.
 * @param token - The bearer token.
 * @returns The status code.
 */
async function statusOf(path: string, token: string): Promise<number> {
  const response = await get(path, token)
  return response.status
}

/**
 * The `code` a GET answers with.
 * @param path - The full path, with any query.
 * @param token - The bearer token.
 * @returns The code, or undefined for a success.
 */
async function codeOf(path: string, token: string): Promise<string | undefined> {
  const response = await get(path, token)
  return body(response).code
}

/**
 * Seed a one-click invitation to a new address, then click it.
 * @returns The new account's id, address and one-click access token.
 */
async function invitationSession(): Promise<{ userId: string; token: string }> {
  const email = `required-${randomUUID()}@example.test`
  usedEmails.push(email)
  const owner = await makeUser()
  const tenant = await new TenantRepository().create({
    name: 'Acme Inc',
    slug: `required-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  const rawToken = randomBytes(32).toString('base64url')
  await db.transaction((tx) =>
    new TenantInvitationRepository().createPending(
      {
        tenantId: tenant.id,
        email,
        role: 'editor',
        tokenHash: hashToken(rawToken),
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      tx
    )
  )
  const response = await request(app).post('/api/v1/invitations/verify').send({ token: rawToken })
  expect(response.status).toBe(200)
  const data = (response.body as { data: { accessToken: string; user: { id: string } } }).data
  return { userId: data.user.id, token: data.accessToken }
}

describe('the gate', () => {
  it('answers 403 PASSKEY_SETUP_REQUIRED on any other route, and lets the setup routes through', async () => {
    const user = await makeUser()
    const token = tokenFor(user)

    const blocked = await get('/api/v1/tenants', token)
    expect(blocked.status).toBe(403)
    expect(body(blocked).code).toBe('PASSKEY_SETUP_REQUIRED')
    expect(body(blocked).message).toBe(REQUIRED_MESSAGE)

    expect(await statusOf('/api/v1/profile', token)).toBe(200)
    expect(await statusOf('/api/v1/auth/providers', token)).toBe(200)
    expect(await statusOf(BASE, token)).toBe(200)
    expect(await statusOf(`${BASE}/config`, token)).toBe(200)
    const logout = await request(app).post('/api/v1/auth/logout').send({})
    expect(body(logout).code).not.toBe('PASSKEY_SETUP_REQUIRED')
  })

  it('matches the method: PATCH /profile and DELETE a passkey are not on the list', async () => {
    const token = tokenFor(await makeUser())

    const patched = await request(app)
      .patch('/api/v1/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Grace' })
    const deleted = await request(app)
      .delete(`${BASE}/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)

    expect(body(patched).code).toBe('PASSKEY_SETUP_REQUIRED')
    expect(body(deleted).code).toBe('PASSKEY_SETUP_REQUIRED')
  })

  it('cannot be dodged or tripped by a trailing slash, a query, or letter case', async () => {
    const token = tokenFor(await makeUser())

    for (const path of ['/api/v1/tenants/', '/api/v1/tenants?x=1', '/API/V1/TENANTS']) {
      const response = await get(path, token)
      expect(response.status, path).toBe(403)
      expect(body(response).code, path).toBe('PASSKEY_SETUP_REQUIRED')
    }
    for (const path of ['/api/v1/profile/', '/api/v1/profile?x=1', '/API/V1/Profile']) {
      expect(await statusOf(path, token), path).toBe(200)
    }
  })

  it('lets an account with a passkey through', async () => {
    const user = await makeUser()
    await seedPasskey(user.id)

    const response = await get('/api/v1/tenants', tokenFor(user))

    expect(response.status).toBe(200)
  })

  it('answers an unauthenticated call 401, not the passkey refusal', async () => {
    const response = await request(app).get('/api/v1/tenants')

    expect(response.status).toBe(401)
  })
})

describe('the lockout path', () => {
  it('lets a one-click invitation session confirm by link, create a passkey, then reach /tenants', async () => {
    const { userId, token } = await invitationSession()
    expect(await codeOf('/api/v1/tenants', token)).toBe('PASSKEY_SETUP_REQUIRED')

    const stale = await request(app)
      .post(`${BASE}/registration/options`)
      .set('Authorization', `Bearer ${token}`)
      .send({ app: 'web' })
    expect(stale.status).toBe(401)

    const asked = await request(app)
      .post('/api/v1/auth/step-up/link/request')
      .set('Authorization', `Bearer ${token}`)
      .send({ app: 'web' })
    expect(asked.status).toBe(202)
    const call = vi
      .mocked(addEmailJob)
      .mock.calls.findLast(([message]) => message.templateKey === 'step_up_link')
    if (call?.[0].templateKey !== 'step_up_link') throw new Error('no step-up mail')
    const linkToken = new URL(call[0].variables.confirmUrl).searchParams.get('token')

    const confirmed = await request(app)
      .post('/api/v1/auth/step-up/link/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: linkToken })
    expect(confirmed.status).toBe(200)
    const fresh = body(confirmed).data.accessToken

    const options = await request(app)
      .post(`${BASE}/registration/options`)
      .set('Authorization', `Bearer ${fresh}`)
      .send({ app: 'web' })
    expect(options.status).toBe(200)
    const created = await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${fresh}`)
      .send({
        app: 'web',
        challengeId: body(options).data.challengeId,
        response: new SoftwareAuthenticator().registrationResponse(
          body(options).data.options.challenge
        ),
      })
    expect(created.status).toBe(201)
    expect(await passkeyCount(userId)).toBe(1)

    expect(await statusOf('/api/v1/tenants', fresh)).toBe(200)
    expect(await statusOf('/api/v1/tenants', token)).toBe(200)
  })
})

describe('modes', () => {
  it('runs the count query in required mode only', async () => {
    const token = tokenFor(await makeUser())

    await get('/api/v1/tenants', token)
    expect(countSpy).toHaveBeenCalledTimes(1)

    for (const current of ['optional', 'off']) {
      mode.current = current
      countSpy.mockClear()
      expect(await statusOf('/api/v1/tenants', token)).toBe(200)
      expect(await statusOf('/api/v1/profile', token)).toBe(200)
      expect(countSpy, current).not.toHaveBeenCalled()
    }
  })

  it('makes no count query for an allowlisted route in required mode', async () => {
    const token = tokenFor(await makeUser())

    expect(await statusOf('/api/v1/profile', token)).toBe(200)

    expect(countSpy).not.toHaveBeenCalled()
  })

  it('hides the passkey routes under off, keeps the stored row, and lists it again under optional', async () => {
    const user = await makeUser()
    await seedPasskey(user.id)
    const token = tokenFor(user)
    mode.current = 'off'

    const hidden = await get(BASE, token)
    const hiddenOptions = await request(app)
      .post(`${BASE}/registration/options`)
      .set('Authorization', `Bearer ${token}`)
      .send({ app: 'web' })
    expect(hidden.status).toBe(404)
    expect(hiddenOptions.status).toBe(404)
    expect(await passkeyCount(user.id)).toBe(1)

    mode.current = 'optional'
    const listed = await get(BASE, token)
    expect(listed.status).toBe(200)
    expect((listed.body as { data: { passkeys: unknown[] } }).data.passkeys).toHaveLength(1)
  })
})
