/**
 * @file A staff delete (`DELETE /api/v1/platform/users/:id`) completes the
 * user's open deletion request in its own transaction and, after the commit,
 * mails the user the `account_deleted` confirmation at the address they had.
 * A refused delete leaves the request open and mails nothing; a user with no
 * open request gets no confirmation.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { startEmailWorker } from '@/workers/email.worker'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { findMailpitMessages } from '../../helpers/mailpit'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { waitUntil } from '../../helpers/timing'

const app = createApp()
const tenantRepository = new TenantRepository()
const REASON = 'Ticket #5120: the customer asked us to delete their account'

/**
 * The confirmation is asserted in Mailpit, so the file runs its own email
 * Worker (`account_deleted` is not auth mail); `createApp()` starts none.
 */
const emailWorker = startEmailWorker()

/**
 * Every user id whose deletion requests `afterEach` removes before the
 * users: the foreign key is RESTRICT.
 */
const requesterIds: string[] = []
const createdTenantIds: string[] = []

afterEach(async () => {
  if (requesterIds.length > 0) {
    await sql`delete from account_deletion_requests where user_id = any(${requesterIds})`
    requesterIds.length = 0
  }
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

afterAll(async () => {
  await emailWorker.close()
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A tracked customer with an open deletion request, due in 30 days.
 * @returns The user and the request's id.
 */
async function customerWithOpenRequest(): Promise<{ user: User; requestId: string }> {
  const user = await createTrackedUser({ firstName: 'Asha' })
  requesterIds.push(user.id)
  const [row] = await sql<{ id: string }[]>`
    insert into account_deletion_requests (user_id, requested_at, due_at, status)
    values (${user.id}, now(), now() + interval '30 days', 'open')
    returning id`
  if (!row) throw new Error('no request inserted')
  return { user, requestId: row.id }
}

/**
 * Soft-delete a user as a platform admin, with the staff reason.
 * @param token - The admin's recent-auth bearer token.
 * @param userId - The user.
 */
function staffDelete(token: string, userId: string): Promise<Response> {
  return request(app)
    .delete(`/api/v1/platform/users/${userId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: REASON })
}

/**
 * A request's status and completion time.
 * @param requestId - The request.
 */
async function requestState(
  requestId: string
): Promise<{ status: string; completedAt: Date | null } | undefined> {
  const [row] = await sql<{ status: string; completedAt: Date | null }[]>`
    select status, completed_at as "completedAt" from account_deletion_requests
    where id = ${requestId}`
  return row
}

/**
 * How many `account_deleted` rows were written for a user.
 * @param userId - The user.
 */
async function confirmationCount(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from email_messages
    where user_id = ${userId} and template_key = 'account_deleted'`
  return row?.count ?? 0
}

describe('a staff delete and the open deletion request', () => {
  it('staff delete of a user with an open request completes it and mails the confirmation', async () => {
    const { token } = await createTrackedStaff('admin')
    const { user, requestId } = await customerWithOpenRequest()

    const response = await staffDelete(token, user.id)

    expect(response.status).toBe(200)
    const [completion] = await sql<{ status: string; isAtDeletion: boolean }[]>`
      select r.status, r.completed_at = u.deleted_at as "isAtDeletion"
      from account_deletion_requests r join users u on u.id = r.user_id
      where r.id = ${requestId}`
    // One transaction: the request completes at the delete's own now().
    expect(completion).toEqual({ status: 'completed', isAtDeletion: true })

    const messages = await waitUntil(
      async () => {
        const found = await findMailpitMessages(user.email)
        return found.length > 0 ? found : undefined
      },
      { message: 'the account deleted confirmation in Mailpit' }
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.Subject).toBe('We deleted your account')
    expect(await confirmationCount(user.id)).toBe(1)
  })

  it('a last-owner 409 leaves the request open', async () => {
    const { token } = await createTrackedStaff('admin')
    const { user, requestId } = await customerWithOpenRequest()
    const tenant = await tenantRepository.create({
      name: 'Sole Owner Ltd',
      slug: `adc-${randomUUID()}`,
      ownerId: user.id,
    })
    createdTenantIds.push(tenant.id)

    const response = await staffDelete(token, user.id)

    expect(response.status).toBe(409)
    expect(await requestState(requestId)).toEqual({ status: 'open', completedAt: null })
    // The refusal answers before any enqueue, so the count is final once the reply lands.
    expect(await confirmationCount(user.id)).toBe(0)
  })

  it('mails no confirmation when the user had no open request', async () => {
    const { token } = await createTrackedStaff('admin')
    const user = await createTrackedUser()
    requesterIds.push(user.id)
    await sql`
      insert into account_deletion_requests (user_id, requested_at, due_at, status, completed_at)
      values (${user.id}, now() - interval '60 days', now() - interval '30 days', 'completed', now() - interval '31 days')`

    const response = await staffDelete(token, user.id)

    expect(response.status).toBe(200)
    // The enqueue runs before the reply, so the count is final once the reply lands.
    expect(await confirmationCount(user.id)).toBe(0)
  })
})
