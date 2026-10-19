/**
 * @file Each mail flow threads its context onto the `email_messages` row:
 * the invitation's tenant, invitation and link app; the link app of a
 * staff-sent sign-in link and of a notification job's mail; and a staff
 * resend's `resentFromId`, through both the direct and the notification path. No
 * Worker runs here: jobs stay on the queues, and a notification job is
 * processed by calling `processNotificationJob` directly.
 */
import { randomUUID } from 'node:crypto'
import type { Job } from 'bullmq'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { emailQueueFor, type EmailJobData } from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { addNotificationJob } from '@/jobs/notification.job'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { sendSignInLinkByStaff } from '@/services/platform-user.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { invite, listPending, resend } from '@/services/tenant-invitation.service'
import { invitationListSchema } from '@/validators/tenant.validators'
import { processNotificationJob } from '@/workers/notification.worker'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { waitForJob } from '../../helpers/queue-jobs'

/**
 * Every pending invitation of a tenant, read as one page.
 * @param tenantId - The tenant.
 * @returns The page's items.
 */
async function pendingOf(tenantId: string) {
  const page = await listPending(tenantId, invitationListSchema.parse({ limit: '100' }))
  return page.items
}

const tenantRepository = new TenantRepository()
const createdTenantIds: string[] = []
const recipients: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (recipients.length > 0) {
    await sql`delete from email_messages where recipient = any(${recipients})`
    await sql`delete from user_tokens where email = any(${recipients})`
  }
  recipients.length = 0
  if (createdTenantIds.length > 0)
    await sql`delete from tenants where id = any(${createdTenantIds})`
  createdTenantIds.length = 0
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * Creates a user whose `email_messages` rows are deleted in `afterEach`, so a test's mail
 * does not outlive it.
 */
async function trackedUser(options: { verified?: boolean } = {}): Promise<User> {
  const user = await createTrackedUser({ firstName: 'Ada', ...options })
  recipients.push(user.email)
  return user
}

/**
 * Creates a customer tenant and its owner, both deleted in `afterEach`.
 */
async function customerTenant(): Promise<{ owner: User; tenant: Tenant }> {
  const owner = await trackedUser()
  const tenant = await tenantRepository.create({
    name: 'Acme Inc',
    slug: `email-context-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  return { owner, tenant }
}

/**
 * Reads the `email_messages` row an email job points at, and throws when it has none.
 */
async function rowOf(job: Job<EmailJobData>): Promise<Record<string, unknown>> {
  const [row] = await sql`select * from email_messages where id = ${job.data.messageId ?? ''}`
  if (!row) throw new Error('the email job has no email_messages row')
  return row
}

/**
 * Waits for the email job queued to `to` for one template.
 */
async function emailJobTo(
  to: string,
  templateKey: EmailJobData['templateKey']
): Promise<Job<EmailJobData>> {
  return waitForJob<EmailJobData>(
    emailQueueFor(templateKey),
    (data) => data.to === to && data.templateKey === templateKey
  )
}

describe('invitation mail', () => {
  it('records the tenant, the invitation and the customer app, and no account for a new address', async () => {
    const { owner, tenant } = await customerTenant()
    const email = `invitee-${randomUUID()}@example.test`
    recipients.push(email)

    await invite({ userId: owner.id }, tenant.id, email, 'editor')

    const [pending] = await pendingOf(tenant.id)
    const row = await rowOf(await emailJobTo(email, 'tenant_invitation'))
    expect(row).toMatchObject({
      tenant_id: tenant.id,
      invitation_id: pending?.id,
      link_app: 'web',
      sender_class: 'transactional',
      variables: { tenantName: 'Acme Inc', role: 'editor', expiresInDays: '3' },
    })
    expect(row.user_id).toBeNull()
    expect(row.variables).not.toHaveProperty('inviterName')
  })

  it('a resend records the message it re-sends for on the new message', async () => {
    const { owner, tenant } = await customerTenant()
    const email = `invitee-${randomUUID()}@example.test`
    recipients.push(email)
    await invite({ userId: owner.id }, tenant.id, email, 'editor')
    const first = await emailJobTo(email, 'tenant_invitation')
    const [pending] = await pendingOf(tenant.id)

    await resend({ userId: owner.id }, tenant.id, pending?.id ?? '', {
      resentFromId: first.data.messageId ?? '',
    })

    const second = await waitForJob<EmailJobData>(
      emailQueueFor('tenant_invitation'),
      (data) => data.to === email && data.messageId !== first.data.messageId
    )
    expect(await rowOf(second)).toMatchObject({
      resent_from_id: first.data.messageId,
      invitation_id: pending?.id,
      tenant_id: tenant.id,
    })
  })
})

/**
 * Waits for the notification job a flow enqueued for `userId` with one type.
 */
async function notificationJobFor(
  userId: string,
  type: NotificationJobData['type']
): Promise<Job<NotificationJobData>> {
  return waitForJob<NotificationJobData>(
    getNotificationQueue(),
    (data) => data.userId === userId && data.type === type
  )
}

/**
 * The message id of a staff-sent sign-in link to a fresh user: an earlier
 * message a resend can name as its origin.
 * @param admin - The staff member who sends it.
 * @returns The earlier message's id.
 */
async function earlierMessageId(admin: User): Promise<string> {
  const earlier = await trackedUser()
  await sendSignInLinkByStaff({ userId: admin.id }, earlier.id)
  const job = await emailJobTo(earlier.email, 'sign_in_link')
  return job.data.messageId ?? ''
}

describe('notification-path mail', () => {
  it('records the link app and a resend origin, and a retried job reuses the row', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const user = await trackedUser()
    const resentFromId = await earlierMessageId(admin)

    await addNotificationJob({
      userId: user.id,
      type: 'maintenance_mode_changed',
      title: 'Maintenance mode changed',
      body: 'Customers can only read until maintenance ends.',
      metadata: { templateKey: 'maintenance_mode_changed' },
      email: {
        to: user.email,
        templateKey: 'maintenance_mode_changed',
        variables: {
          firstName: 'Ada',
          appName: 'Test App',
          mode: 'read_only',
          actorName: 'Grace',
          reason: 'Database upgrade',
          changedAt: '2026-10-06T10:42:00.000Z',
        },
      },
      emailContext: { linkApp: 'apex', resentFromId },
    })

    const job = await notificationJobFor(user.id, 'maintenance_mode_changed')
    expect(job.data.emailContext).toEqual({ linkApp: 'apex', resentFromId })
    await processNotificationJob(job)
    await processNotificationJob(job)

    const rows = await sql`
      select id, link_app, resent_from_id, job_key, user_id from email_messages
      where recipient = ${user.email} and template_key = 'maintenance_mode_changed'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      link_app: 'apex',
      resent_from_id: resentFromId,
      job_key: `notification-email-${String(job.id)}-${String(job.timestamp)}`,
      user_id: user.id,
    })
  })
})

describe('staff sign-in link', () => {
  it('a staff-sent sign-in link records the web app, the user and a resend origin', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await trackedUser()
    const resentFromId = await earlierMessageId(admin)

    await expect(
      sendSignInLinkByStaff({ userId: admin.id }, target.id, { resentFromId })
    ).resolves.toEqual({ emailSent: true })

    const row = await rowOf(await emailJobTo(target.email, 'sign_in_link'))
    expect(row).toMatchObject({
      link_app: 'web',
      user_id: target.id,
      resent_from_id: resentFromId,
      sender_class: 'transactional',
      variables: { firstName: 'Ada', reason: 'staff' },
    })
  })
})
