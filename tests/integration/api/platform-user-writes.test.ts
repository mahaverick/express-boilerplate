/**
 * @file Staff creating and editing users, and the set-password and
 * verification mails. Mail is asserted on the queue, never delivered.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import type { EmailJobData } from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { ACCOUNT_SETUP_TEMPLATE_KEY } from '@/templates/email/account-setup.template'
import { PASSWORD_RESET_TEMPLATE_KEY } from '@/templates/email/password-reset.template'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { waitForJob } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'

interface ApiEnvelope<TData> {
  success: boolean
  message: string
  data?: TData
}

const app = createApp()
const HOUR_MS = 60 * 60 * 1000

function dataOf<TData>(response: Response): TData {
  const data = (response.body as ApiEnvelope<TData>).data
  if (!data) throw new Error(`no data (status ${response.status})`)
  return data
}

function post(token: string, path: string, body: object = {}): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform/users${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

function patch(token: string, id: string, body: object): Promise<Response> {
  return request(app)
    .patch(`/api/v1/platform/users/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

/**
 * The audit rows about one user, oldest first (ties, as in one transaction, by id).
 * @param targetId - The user.
 * @returns Their action, tenant and metadata.
 */
async function auditRows(
  targetId: string
): Promise<{ action: string; tenant_id: string; metadata: unknown }[]> {
  return sql<{ action: string; tenant_id: string; metadata: unknown }[]>`
    select action, tenant_id, metadata from audit_logs where target_id = ${targetId}
    order by occurred_at, id
  `
}

function setupMailFor(to: string) {
  return waitForJob<EmailJobData>(
    getEmailQueue(),
    (data) => data.to === to && data.templateKey === ACCOUNT_SETUP_TEMPLATE_KEY
  )
}

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('POST /api/v1/platform/users', () => {
  it('creates a passwordless, unverified user, mails a 24h set-password link and audits it', async () => {
    const { token } = await createTrackedStaff('admin')
    const email = `new-${randomUUID()}@example.test`

    const response = await post(token, '', { email, firstName: 'Grace' })

    expect(response.status).toBe(201)
    const body = dataOf<{
      user: { id: string; email: string; active: boolean; emailVerifiedAt: string | null }
      emailSent: boolean
    }>(response)
    expect(body.emailSent).toBe(true)
    // eslint-disable-next-line unicorn/no-null -- JSON null: not verified yet
    expect(body.user).toMatchObject({ email, active: true, emailVerifiedAt: null })
    const userId = body.user.id

    const [stored] = await sql`select password_hash from users where id = ${userId}`
    expect(stored?.password_hash).toBeNull()
    const providers = await sql`select provider from auth_providers where user_id = ${userId}`
    expect(providers).toEqual([{ provider: 'email' }])

    const [setupToken] = await sql`
      select expires_at, created_at from user_tokens
      where user_id = ${userId} and purpose = 'password_reset' and revoked_at is null`
    const ttl =
      new Date(setupToken?.expires_at as string).getTime() -
      new Date(setupToken?.created_at as string).getTime()
    expect(Math.abs(ttl - 24 * HOUR_MS)).toBeLessThan(60_000)

    const job = await setupMailFor(email)
    const variables = job.data.variables as { setupUrl: string; firstName: string }
    expect(variables.firstName).toBe('Grace')
    expect(new URL(variables.setupUrl).origin).toBe(new URL(getEnv().WEB_URL).origin)
    expect(new URL(variables.setupUrl).pathname).toBe('/reset-password')

    const platform = await platformTenant()
    expect(await auditRows(userId)).toEqual([
      { action: 'user.created', tenant_id: platform.id, metadata: { emailDomain: 'example.test' } },
    ])
    await truncateAuditLogs()
    await sql`delete from users where id = ${userId}`
  })

  it('redeeming the set-password link stores the password and verifies the address', async () => {
    const { token } = await createTrackedStaff('admin')
    const email = `redeem-${randomUUID()}@example.test`
    const created = await post(token, '', { email })
    const userId = dataOf<{ user: { id: string } }>(created).user.id
    const job = await setupMailFor(email)
    const setupUrl = new URL((job.data.variables as { setupUrl: string }).setupUrl)
    const rawToken = setupUrl.searchParams.get('token') ?? ''

    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: rawToken, password: 'a brand new secret passphrase' })

    expect(reset.status).toBe(200)
    const [row] = await sql<{ verified: Date | null; hash: string | null }[]>`
      select email_verified_at as verified, password_hash as hash from users where id = ${userId}
    `
    expect(row?.verified).not.toBeNull()
    expect(row?.hash).not.toBeNull()
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'a brand new secret passphrase' })
    expect(login.status).toBe(200)
    await truncateAuditLogs()
    await sql`delete from users where id = ${userId}`
  })

  it('answers 409 for a live account with the same address in another case, and creates nothing', async () => {
    const { token } = await createTrackedStaff('admin')
    const existing = await createTrackedUser()

    const response = await post(token, '', { email: existing.email.toUpperCase() })

    expect(response.status).toBe(409)
    expect((response.body as ApiEnvelope<unknown>).message).toBe(
      'An account already uses that email address'
    )
    const [row] =
      await sql`select count(*)::int as n from users where lower(email) = lower(${existing.email})`
    expect(row?.n).toBe(1)
  })

  it('reuses the address of a soft-deleted account', async () => {
    const { token } = await createTrackedStaff('admin')
    const gone = await createTrackedUser()
    await sql`update users set deleted_at = now() where id = ${gone.id}`

    const response = await post(token, '', { email: gone.email })

    expect(response.status).toBe(201)
    const created = dataOf<{ user: { id: string } }>(response).user.id
    await truncateAuditLogs()
    await sql`delete from users where id = ${created}`
  })

  it('refuses a platform viewer with 404, and an unknown body field with 400', async () => {
    const viewer = await createTrackedStaff('viewer')
    const admin = await createTrackedStaff('admin')
    const email = `x-${randomUUID()}@example.test`

    const response = await post(viewer.token, '', { email })
    expect(response.status).toBe(404)
    const response2 = await post(admin.token, '', { email, password: 'chosen-by-staff' })
    expect(response2.status).toBe(400)
    // The server picks the link's frontend: a new user is not staff, so it is the web app.
    const response3 = await post(admin.token, '', { email, app: 'apex' })
    expect(response3.status).toBe(400)
    expect(await sql`select 1 from users where email = ${email}`).toHaveLength(0)
  })
})

describe('PATCH /api/v1/platform/users/:id', () => {
  it('changes the names and audits the changed field names only', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ firstName: 'Ada' })

    // eslint-disable-next-line unicorn/no-null -- null clears the last name
    const response = await patch(token, target.id, { firstName: 'Augusta', lastName: null })

    expect(response.status).toBe(200)
    expect(dataOf<{ firstName: string | null; lastName: string | null }>(response)).toMatchObject({
      firstName: 'Augusta',
      // eslint-disable-next-line unicorn/no-null -- JSON null: the cleared name
      lastName: null,
    })
    expect(await auditRows(target.id)).toMatchObject([
      { action: 'user.updated', metadata: { changed: ['firstName', 'lastName'] } },
    ])
  })

  it('refuses a staff user editing their own record with 403, writing and auditing nothing', async () => {
    const { user, token } = await createTrackedStaff('owner', { firstName: 'Self' })

    const response = await patch(token, user.id, { firstName: 'Changed' })

    expect(response.status).toBe(403)
    const [row] = await sql`select first_name from users where id = ${user.id}`
    expect(row?.first_name).toBe('Self')
    expect(await auditRows(user.id)).toEqual([])
  })

  it('answers 400 for an empty body and for status or email fields', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser()

    const response = await patch(token, target.id, {})
    expect(response.status).toBe(400)
    const response2 = await patch(token, target.id, { active: false })
    expect(response2.status).toBe(400)
    const response3 = await patch(token, target.id, { email: 'other@example.test' })
    expect(response3.status).toBe(400)
  })

  it('refuses a staff admin editing a staff owner or another staff admin (403), and lets an owner edit an admin or another owner', async () => {
    const admin = await createTrackedStaff('admin')
    const owner = await createTrackedStaff('owner')
    const otherOwner = await createTrackedStaff('owner')
    const otherAdmin = await createTrackedStaff('admin')

    const response = await patch(admin.token, owner.user.id, { firstName: 'X' })
    expect(response.status).toBe(403)
    const response2 = await patch(admin.token, otherAdmin.user.id, { firstName: 'X' })
    expect(response2.status).toBe(403)
    const response3 = await patch(owner.token, otherAdmin.user.id, { firstName: 'Y' })
    expect(response3.status).toBe(200)
    const response4 = await patch(owner.token, otherOwner.user.id, { firstName: 'Z' })
    expect(response4.status).toBe(200)
  })

  it('answers 404 for a malformed and an unknown id', async () => {
    const { token } = await createTrackedStaff('admin')

    const response = await patch(token, 'nope', { firstName: 'X' })
    expect(response.status).toBe(404)
    const response2 = await patch(token, randomUUID(), { firstName: 'X' })
    expect(response2.status).toBe(404)
  })
})

describe('POST /api/v1/platform/users/:id/password-setup', () => {
  it('sends a set-password mail to a passwordless user and revokes the earlier link', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ verified: false })

    const response = await post(token, `/${target.id}/password-setup`)
    expect(response.status).toBe(200)
    const firstJob = await setupMailFor(target.email)
    const response2 = await post(token, `/${target.id}/password-setup`)
    expect(response2.status).toBe(200)

    const live = await sql`
      select id from user_tokens
      where user_id = ${target.id} and purpose = 'password_reset' and revoked_at is null`
    expect(live).toHaveLength(1)
    expect(firstJob.data.templateKey).toBe(ACCOUNT_SETUP_TEMPLATE_KEY)
    expect(await auditRows(target.id)).toMatchObject([
      { action: 'user.password_setup_sent', metadata: { kind: 'setup' } },
      { action: 'user.password_setup_sent', metadata: { kind: 'setup' } },
    ])
  })

  it('sends an ordinary reset mail to a user with a password', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ hasPassword: true })

    const response = await post(token, `/${target.id}/password-setup`)

    expect(response.status).toBe(200)
    expect(dataOf<{ emailSent: boolean }>(response).emailSent).toBe(true)
    await waitForJob<NotificationJobData>(
      getNotificationQueue(),
      (data) => data.userId === target.id && data.email?.templateKey === PASSWORD_RESET_TEMPLATE_KEY
    )
    expect(await auditRows(target.id)).toMatchObject([
      { action: 'user.password_setup_sent', metadata: { kind: 'reset' } },
    ])
  })

  it('refuses a staff admin mailing a staff owner (403), and allows an admin mailing an admin', async () => {
    const admin = await createTrackedStaff('admin')
    const owner = await createTrackedStaff('owner')
    const otherAdmin = await createTrackedStaff('admin')

    const response = await post(admin.token, `/${owner.user.id}/password-setup`)
    expect(response.status).toBe(403)
    const response2 = await post(admin.token, `/${otherAdmin.user.id}/password-setup`)
    expect(response2.status).toBe(200)
  })
})

describe('POST /api/v1/platform/users/:id/resend-verification', () => {
  it('mails a verification link to an unverified user with a password, and audits it', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ hasPassword: true, verified: false })

    const first = await post(token, `/${target.id}/resend-verification`)
    expect(first.status).toBe(200)
    await waitForJob<NotificationJobData>(
      getNotificationQueue(),
      (data) => data.userId === target.id && data.type === 'verify_email'
    )
    await truncateAuditLogs()
    const response = await post(token, `/${target.id}/resend-verification`)

    expect(response.status).toBe(200)
    await waitForJob<NotificationJobData>(
      getNotificationQueue(),
      (data) => data.userId === target.id && data.type === 'verify_email'
    )
    expect(await auditRows(target.id)).toMatchObject([
      { action: 'user.verification_resent', metadata: {} },
    ])
    const live = await sql`
      select id from user_tokens
      where user_id = ${target.id} and purpose = 'email_verification' and revoked_at is null`
    expect(live).toHaveLength(1)
  })

  it('answers 409 to either mail for a deactivated user, whose link would lead nowhere', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ hasPassword: true, verified: false, active: false })

    const setup = await post(token, `/${target.id}/password-setup`)
    const verification = await post(token, `/${target.id}/resend-verification`)

    for (const response of [setup, verification]) {
      expect(response.status).toBe(409)
      expect((response.body as ApiEnvelope<unknown>).message).toBe(
        'This account is deactivated; reactivate it first'
      )
    }
    expect(await auditRows(target.id)).toEqual([])
  })

  it('answers 409 for a verified user and for a passwordless one', async () => {
    const { token } = await createTrackedStaff('admin')
    const verified = await createTrackedUser({ hasPassword: true })
    const passwordless = await createTrackedUser({ verified: false })

    const verifiedResponse = await post(token, `/${verified.id}/resend-verification`)
    expect(verifiedResponse.status).toBe(409)
    expect((verifiedResponse.body as ApiEnvelope<unknown>).message).toBe(
      'Email address already verified'
    )

    const passwordlessResponse = await post(token, `/${passwordless.id}/resend-verification`)
    expect(passwordlessResponse.status).toBe(409)
    expect((passwordlessResponse.body as ApiEnvelope<unknown>).message).toBe(
      'This account has no password yet; send a set-password link instead'
    )
  })
})

describe('the platformWrite limiter', () => {
  it('puts the 30-a-minute budget on a staff write', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser()

    const response = await patch(token, target.id, { firstName: 'Limited' })

    expect(response.headers['ratelimit-limit']).toBe('30')
  })
})
