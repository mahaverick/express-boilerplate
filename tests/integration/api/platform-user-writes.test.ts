/**
 * @file Staff creating and editing users, the welcome mail a created user
 * gets, and the staff-sent sign-in link. Mail is asserted on the queue,
 * never delivered.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import type { EmailJobData } from '@/jobs/email.job'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { frontendUrl } from '@/services/verification.service'
import { SIGN_IN_LINK_TEMPLATE_KEY } from '@/templates/email/sign-in-link.template'
import { WELCOME_TEMPLATE_KEY } from '@/templates/email/welcome.template'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { waitForJob } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'

/**
 * The JSON envelope every API response is wrapped in.
 */
interface ApiEnvelope<TData> {
  success: boolean
  message: string
  data?: TData
}

const app = createApp()

/**
 * Every address a test mailed a sign-in link to: those rows carry no user,
 * so deleting the user leaves them, and `afterEach` deletes them by address.
 */
const usedEmails: string[] = []

/**
 * The envelope's `data`, failing the test with the status when the response carries none.
 */
function dataOf<TData>(response: Response): TData {
  const data = (response.body as ApiEnvelope<TData>).data
  if (!data) throw new Error(`no data (status ${response.status})`)
  return data
}

/**
 * A staff POST under `/api/v1/platform/users`; `path` is appended to that prefix.
 */
function post(token: string, path: string, body: object = {}): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform/users${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

/**
 * A staff PATCH of one platform user, resolving with the raw response so
 * tests can assert refusals as well as successes.
 */
function patch(token: string, id: string, body: object): Promise<Response> {
  return request(app)
    .patch(`/api/v1/platform/users/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

/**
 * The audit rows about one user, oldest first (ties, as in one transaction, by id).
 */
async function auditRows(
  targetId: string
): Promise<{ action: string; tenant_id: string; metadata: unknown }[]> {
  return sql<{ action: string; tenant_id: string; metadata: unknown }[]>`
    select action, tenant_id, metadata from audit_logs where target_id = ${targetId}
    order by occurred_at, id
  `
}

/**
 * Waits for the mail of one template queued for `to`, since mail is asserted on the queue.
 */
function mailFor(to: string, templateKey: string) {
  return waitForJob<EmailJobData>(
    getEmailQueue(),
    (data) => data.to === to.toLowerCase() && data.templateKey === templateKey
  )
}

/**
 * The sign-in link rows of one address, oldest first.
 */
async function linkRows(email: string): Promise<
  {
    userId: string | null
    app: string
    revoked: boolean
    createdAt: Date
    expiresAt: Date
  }[]
> {
  return sql<
    { userId: string | null; app: string; revoked: boolean; createdAt: Date; expiresAt: Date }[]
  >`
    select user_id as "userId", app, revoked_at is not null as revoked,
      created_at as "createdAt", expires_at as "expiresAt"
    from user_tokens
    where email = ${email.toLowerCase()} and purpose = 'sign_in_link'
    order by created_at, id
  `
}

/**
 * The frontend recorded on the message row of a queued mail.
 */
async function linkAppOf(data: EmailJobData): Promise<string | undefined> {
  const [row] = await sql<{ linkApp: string }[]>`
    select link_app as "linkApp" from email_messages where id = ${data.messageId ?? ''}
  `
  return row?.linkApp
}

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedUsers()
  if (usedEmails.length === 0) return
  await sql`delete from user_tokens where email = any(${usedEmails.map((email) => email.toLowerCase())})`
  usedEmails.length = 0
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('POST /api/v1/platform/users', () => {
  it('sends a welcome mail with a sign-in link when staff create a user', async () => {
    const { token } = await createTrackedStaff('admin')
    const email = `new-${randomUUID()}@example.test`
    usedEmails.push(email)

    const response = await post(token, '', { email, firstName: 'Grace' })

    expect(response.status).toBe(201)
    const body = dataOf<{
      user: { id: string; email: string; active: boolean; emailVerifiedAt: string | null }
      emailSent: boolean
    }>(response)
    expect(body.emailSent).toBe(true)
    // eslint-disable-next-line unicorn/no-null -- JSON null: verified by the first click
    expect(body.user).toMatchObject({ email, active: true, emailVerifiedAt: null })
    const userId = body.user.id

    const [stored] = await sql`select password_hash from users where id = ${userId}`
    expect(stored?.password_hash).toBeNull()
    const providers = await sql`select provider from auth_providers where user_id = ${userId}`
    expect(providers).toEqual([{ provider: 'email' }])

    const links = await linkRows(email)
    expect(links).toHaveLength(1)
    // eslint-disable-next-line unicorn/no-null -- a sign_in_link row is keyed by address, never a user
    expect(links[0]).toMatchObject({ userId: null, app: 'web', revoked: false })
    const expiresAt = new Date(links[0]?.expiresAt ?? 0)
    const createdAt = new Date(links[0]?.createdAt ?? 0)
    const ttlMs = requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
    expect(Math.abs(expiresAt.getTime() - createdAt.getTime() - ttlMs)).toBeLessThan(60_000)

    const job = await mailFor(email, WELCOME_TEMPLATE_KEY)
    const variables = job.data.variables as { signInUrl: string; firstName: string }
    expect(variables.firstName).toBe('Grace')
    const signInUrl = new URL(variables.signInUrl)
    expect(signInUrl.origin).toBe(new URL(getEnv().WEB_URL).origin)
    expect(signInUrl.pathname).toBe('/auth/link')
    expect(signInUrl.searchParams.get('email')).toBe(email)
    expect(await linkAppOf(job.data)).toBe('web')

    const platform = await platformTenant()
    expect(await auditRows(userId)).toEqual([
      { action: 'user.created', tenant_id: platform.id, metadata: { emailDomain: 'example.test' } },
    ])
    await truncateAuditLogs()
    await sql`delete from users where id = ${userId}`
  })

  it('signs the new user in and verifies the address when they click the welcome link', async () => {
    const { token } = await createTrackedStaff('admin')
    const email = `welcome-click-${randomUUID()}@example.test`
    usedEmails.push(email)
    const created = await post(token, '', { email })
    const userId = dataOf<{ user: { id: string } }>(created).user.id
    const job = await mailFor(email, WELCOME_TEMPLATE_KEY)
    const signInUrl = new URL((job.data.variables as { signInUrl: string }).signInUrl)

    const verify = await request(app)
      .post('/api/v1/auth/link/verify')
      .send({ token: signInUrl.searchParams.get('token') ?? '' })

    expect(verify.status).toBe(200)
    expect(dataOf<{ accessToken: string; user: { id: string } }>(verify)).toMatchObject({
      accessToken: expect.any(String) as unknown,
      user: { id: userId },
    })
    expect(verify.headers['set-cookie']).toBeDefined()
    const [row] = await sql<{ verified: boolean }[]>`
      select email_verified_at is not null as verified from users where id = ${userId}`
    expect(row?.verified).toBe(true)
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
    // The server picks the link's frontend: a new user holds no platform role, so it is the web app.
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

describe('POST /api/v1/platform/users/:id/sign-in-link', () => {
  it('mails a web sign-in link to a customer and audits user.sign_in_link_sent { app: web }', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ firstName: 'Ada' })
    usedEmails.push(target.email)

    const first = await post(token, `/${target.id}/sign-in-link`)
    expect(first.status).toBe(200)
    expect(dataOf<{ emailSent: boolean }>(first).emailSent).toBe(true)
    const second = await post(token, `/${target.id}/sign-in-link`)
    expect(second.status).toBe(200)

    const job = await mailFor(target.email, SIGN_IN_LINK_TEMPLATE_KEY)
    const variables = job.data.variables as { signInUrl: string; firstName: string; reason: string }
    expect(variables).toMatchObject({ firstName: 'Ada', reason: 'staff' })
    expect(new URL(variables.signInUrl).origin).toBe(new URL(getEnv().WEB_URL).origin)
    expect(await linkAppOf(job.data)).toBe('web')
    // Issuing a link revokes the address's earlier one.
    const rows = await linkRows(target.email)
    expect(rows.map((row) => [row.app, row.revoked])).toEqual([
      ['web', true],
      ['web', false],
    ])
    expect(await auditRows(target.id)).toMatchObject([
      { action: 'user.sign_in_link_sent', metadata: { app: 'web' } },
      { action: 'user.sign_in_link_sent', metadata: { app: 'web' } },
    ])
  })

  it('mails an apex link to a staff target', async () => {
    const { token } = await createTrackedStaff('admin')
    const staff = await createTrackedStaff('viewer')
    usedEmails.push(staff.user.email)

    const response = await post(token, `/${staff.user.id}/sign-in-link`)

    expect(response.status).toBe(200)
    const job = await mailFor(staff.user.email, SIGN_IN_LINK_TEMPLATE_KEY)
    const signInUrl = (job.data.variables as { signInUrl: string }).signInUrl
    expect(new URL(signInUrl).origin).toBe(new URL(frontendUrl('apex')).origin)
    expect(await linkAppOf(job.data)).toBe('apex')
    const rows = await linkRows(staff.user.email)
    expect(rows.map((row) => row.app)).toEqual(['apex'])
    expect(await auditRows(staff.user.id)).toMatchObject([
      { action: 'user.sign_in_link_sent', metadata: { app: 'apex' } },
    ])
  })

  it('answers 409 for a deactivated user and mails nothing', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ active: false })
    usedEmails.push(target.email)

    const response = await post(token, `/${target.id}/sign-in-link`)

    expect(response.status).toBe(409)
    expect((response.body as ApiEnvelope<unknown>).message).toBe(
      'This account is deactivated; reactivate it first'
    )
    expect(await linkRows(target.email)).toEqual([])
    expect(await auditRows(target.id)).toEqual([])
  })

  it('answers 404 for an unknown, a soft-deleted and a malformed id', async () => {
    const { token } = await createTrackedStaff('admin')
    const gone = await createTrackedUser()
    usedEmails.push(gone.email)
    await sql`update users set deleted_at = now() where id = ${gone.id}`

    for (const id of [randomUUID(), gone.id, 'nope']) {
      const response = await post(token, `/${id}/sign-in-link`)
      expect(response.status).toBe(404)
    }
    expect(await linkRows(gone.email)).toEqual([])
  })

  it('refuses a staff admin mailing a staff owner (403), and allows an admin mailing an admin', async () => {
    const admin = await createTrackedStaff('admin')
    const owner = await createTrackedStaff('owner')
    const otherAdmin = await createTrackedStaff('admin')
    usedEmails.push(owner.user.email, otherAdmin.user.email)

    const refused = await post(admin.token, `/${owner.user.id}/sign-in-link`)
    expect(refused.status).toBe(403)
    expect(await linkRows(owner.user.email)).toEqual([])
    expect(await auditRows(owner.user.id)).toEqual([])
    const allowed = await post(admin.token, `/${otherAdmin.user.id}/sign-in-link`)
    expect(allowed.status).toBe(200)
  })

  it('refuses a platform viewer with 404', async () => {
    const viewer = await createTrackedStaff('viewer')
    const target = await createTrackedUser()
    usedEmails.push(target.email)

    const response = await post(viewer.token, `/${target.id}/sign-in-link`)

    expect(response.status).toBe(404)
    expect(await linkRows(target.email)).toEqual([])
  })

  it('answers 404 on the removed password-setup and resend-verification paths', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser()
    const unknown = await post(token, `/${target.id}/not-a-route`)

    for (const path of ['password-setup', 'resend-verification']) {
      const response = await post(token, `/${target.id}/${path}`)
      expect(response.status).toBe(unknown.status)
      expect(response.body).toEqual({
        ...(unknown.body as object),
        requestId: (response.body as { requestId?: unknown }).requestId,
      })
    }
    expect(unknown.status).toBe(404)
    expect(await auditRows(target.id)).toEqual([])
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
