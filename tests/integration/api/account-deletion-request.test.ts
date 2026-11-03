/**
 * @file `POST` and `GET /api/v1/account/deletion-request`: a customer asks us
 * to delete their account, after a recent sign-in. The first request is due
 * `ACCOUNT_DELETION_DAYS` later, mails the customer a receipt and alerts each
 * platform admin with a staff-only notification and its email. A second
 * request returns the open one and mails nothing. The partial unique index
 * refuses a second open request at the database level.
 */
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { sql } from '@/services/database.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { findMailpitMessages } from '../../helpers/mailpit'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  recentAuthTokenFor,
  staleAuthTokenFor,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { waitUntil } from '../../helpers/timing'

const app = createApp()
const PATH = '/api/v1/account/deletion-request'
const MS_PER_DAY = 86_400_000

/**
 * The receipt and the staff alert mail are asserted in Mailpit, so the file
 * runs its own email Worker (neither template is auth mail) and a
 * notification Worker for the staff notices; `createApp()` starts neither.
 */
const emailWorker = startEmailWorker()
const notificationWorker = startNotificationWorker()

/**
 * Every user id whose deletion requests `afterEach` removes before the users:
 * the foreign key is RESTRICT.
 */
const requesterIds: string[] = []

afterEach(async () => {
  if (requesterIds.length > 0) {
    await sql`delete from notifications where type = 'account_deletion_requested'`
    await sql`delete from account_deletion_requests where user_id = any(${requesterIds})`
  }
  requesterIds.length = 0
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await emailWorker.close()
  await notificationWorker.close()
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * The response envelope, narrowed to what these tests read.
 */
interface Envelope<TData> {
  message: string
  code?: string
  data?: TData
  errors?: Record<string, string[]>
}

/**
 * The request as both routes present it.
 */
interface RequestView {
  requestedAt: string
  dueAt: string
}

/**
 * Cast a supertest body to the envelope.
 * @param response - The response.
 */
function envelopeOf<TData>(response: Response): Envelope<TData> {
  return response.body as Envelope<TData>
}

/**
 * A tracked customer whose requests `afterEach` deletes.
 * @returns The user.
 */
async function makeRequester(): Promise<User> {
  const user = await createTrackedUser({ firstName: 'Asha' })
  requesterIds.push(user.id)
  return user
}

/**
 * Ask for deletion as `user`, with a recent sign-in.
 * @param user - The customer.
 * @param body - The body; none by default.
 */
function requestDeletion(user: User, body: object = {}): Promise<Response> {
  return request(app)
    .post(PATH)
    .set('Authorization', `Bearer ${recentAuthTokenFor(user)}`)
    .send(body)
}

/**
 * How many receipt rows were written for a user.
 * @param userId - The customer.
 */
async function receiptCount(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from email_messages
    where user_id = ${userId} and template_key = 'account_deletion_requested'`
  return row?.count ?? 0
}

/**
 * The deletion notifications one user holds.
 * @param userId - The user.
 */
async function noticesOf(userId: string): Promise<{ title: string; body: string }[]> {
  return sql<{ title: string; body: string }[]>`
    select title, body from notifications
    where user_id = ${userId} and type = 'account_deletion_requested'`
}

describe('POST /api/v1/account/deletion-request', () => {
  it('needs a recent sign-in', async () => {
    const user = await makeRequester()

    const response = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${staleAuthTokenFor(user)}`)
      .send({})

    expect(response.status).toBe(401)
    expect(envelopeOf(response).code).toBe(REAUTH_REQUIRED_CODE)
    const rows = await sql`select 1 from account_deletion_requests where user_id = ${user.id}`
    expect(rows).toHaveLength(0)
  })

  it('creates a request due ACCOUNT_DELETION_DAYS days later and mails a receipt', async () => {
    const user = await makeRequester()

    const response = await requestDeletion(user, { reason: 'I no longer use it.\nThanks.' })

    expect(response.status).toBe(201)
    const body = envelopeOf<RequestView>(response)
    const view = body.data
    if (!view) throw new Error('no data')
    const requestedAt = new Date(view.requestedAt)
    const dueAt = new Date(view.dueAt)
    expect(dueAt.getTime() - requestedAt.getTime()).toBe(
      getEnv().ACCOUNT_DELETION_DAYS * MS_PER_DAY
    )
    expect(body.message).toBe(
      `We'll delete your account by ${formatUtcDateTime(dueAt)}. We emailed you a receipt.`
    )
    const [row] = await sql<{ status: string; reason: string | null; completedAt: Date | null }[]>`
      select status, reason, completed_at as "completedAt"
      from account_deletion_requests where user_id = ${user.id}`
    expect(row).toEqual({
      status: 'open',
      reason: 'I no longer use it.\nThanks.',
      completedAt: null,
    })

    const messages = await findMailpitMessages(user.email)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.Subject).toBe('We received your request to delete your account')
  })

  it('returns the open request on a second call and mails nothing', async () => {
    const user = await makeRequester()
    const first = await requestDeletion(user)
    expect(first.status).toBe(201)

    const second = await requestDeletion(user, { reason: 'Asking again.' })

    expect(second.status).toBe(200)
    expect(envelopeOf<RequestView>(second).data).toEqual(envelopeOf<RequestView>(first).data)
    expect(envelopeOf(second).message).toBe(envelopeOf(first).message)
    // The receipt row is written before its job is queued, so the count is final once the reply lands.
    expect(await receiptCount(user.id)).toBe(1)
    const rows = await sql`select 1 from account_deletion_requests where user_id = ${user.id}`
    expect(rows).toHaveLength(1)
    expect(await findMailpitMessages(user.email)).toHaveLength(1)
  })

  it('alerts each platform admin with a staff-only notification', async () => {
    const { user: firstAdmin } = await createTrackedStaff('admin')
    const { user: secondAdmin } = await createTrackedStaff('admin')
    const { user: owner } = await createTrackedStaff('owner')
    const user = await makeRequester()

    const response = await requestDeletion(user)

    expect(response.status).toBe(201)
    const dueAt = formatUtcDateTime(new Date(envelopeOf<RequestView>(response).data?.dueAt ?? ''))
    const expected = {
      title: 'Account deletion requested',
      body: `A customer asked us to delete their account. Complete it in Deletion requests by ${dueAt}.`,
    }
    for (const admin of [firstAdmin, secondAdmin]) {
      const notices = await waitUntil(
        async () => {
          const rows = await noticesOf(admin.id)
          return rows.length > 0 ? rows : undefined
        },
        { message: 'the admin notice row' }
      )
      expect(notices).toEqual([expected])
      const mail = await findMailpitMessages(admin.email)
      expect(mail).toHaveLength(1)
      expect(mail[0]?.Subject).toBe('Account deletion requested')
    }
    // Both admins' rows came from the one fan-out that skipped the owner and the customer.
    expect(await noticesOf(owner.id)).toEqual([])
    expect(await noticesOf(user.id)).toEqual([])
  })

  it('refuses a reason over 500 characters with a field error', async () => {
    const user = await makeRequester()

    const response = await requestDeletion(user, { reason: 'a'.repeat(501) })

    expect(response.status).toBe(400)
    expect(envelopeOf(response).errors?.reason).toEqual(['Reason must be at most 500 characters.'])
    const rows = await sql`select 1 from account_deletion_requests where user_id = ${user.id}`
    expect(rows).toHaveLength(0)
  })
})

describe('GET /api/v1/account/deletion-request', () => {
  it('GET returns null before a request and the request after', async () => {
    const user = await makeRequester()
    const token = tokenFor(user)

    const before = await request(app).get(PATH).set('Authorization', `Bearer ${token}`)

    expect(before.status).toBe(200)
    expect(envelopeOf(before).data).toEqual({ request: null })

    const created = await requestDeletion(user)
    const after = await request(app).get(PATH).set('Authorization', `Bearer ${token}`)

    expect(after.status).toBe(200)
    expect(envelopeOf(after).data).toEqual({ request: envelopeOf<RequestView>(created).data })
  })
})

describe('account_deletion_requests_open_unique', () => {
  it('refuses a second open request for one user, and allows a completed one beside it', async () => {
    const user = await makeRequester()
    await sql`
      insert into account_deletion_requests (user_id, requested_at, due_at, status, completed_at)
      values (${user.id}, now(), now() + interval '30 days', 'completed', now())`
    await sql`
      insert into account_deletion_requests (user_id, requested_at, due_at, status)
      values (${user.id}, now(), now() + interval '30 days', 'open')`

    await expect(
      sql`
        insert into account_deletion_requests (user_id, requested_at, due_at, status)
        values (${user.id}, now(), now() + interval '30 days', 'open')`
    ).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'account_deletion_requests_open_unique',
    })
  })

  it('refuses a status outside open and completed', async () => {
    const user = await makeRequester()

    await expect(
      sql`
        insert into account_deletion_requests (user_id, requested_at, due_at, status)
        values (${user.id}, now(), now() + interval '30 days', 'cancelled')`
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'account_deletion_requests_status_check',
    })
  })
})
