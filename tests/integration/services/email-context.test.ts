/**
 * @file Each mail flow threads its context onto the `email_messages` row:
 * the invitation's tenant, invitation and link app; the link app of the
 * verification, reset and account-setup links; and a staff resend's
 * `resentFromId`, through both the direct and the notification path. No
 * Worker runs here: jobs stay on the queues, and a notification job is
 * processed by calling `processNotificationJob` directly.
 */
import { randomUUID } from 'node:crypto'
import type { Job } from 'bullmq'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import type { EmailJobData } from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sendPasswordResetMail } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { sendPasswordSetup } from '@/services/platform-user.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { invite, listPending, resend } from '@/services/tenant-invitation.service'
import { sendVerificationMail } from '@/services/verification.service'
import { processNotificationJob } from '@/workers/notification.worker'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { waitForJob } from '../../helpers/queue-jobs'

const tenantRepository = new TenantRepository()
const createdTenantIds: string[] = []
const recipients: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (recipients.length > 0)
    await sql`delete from email_messages where recipient = any(${recipients})`
  recipients.length = 0
  if (createdTenantIds.length > 0)
    await sql`delete from tenants where id = any(${createdTenantIds})`
  createdTenantIds.length = 0
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A tracked user whose address is tracked for message cleanup.
 * @param options - Whether it has a password and is verified.
 * @param options.hasPassword - Give it a password.
 * @param options.verified - Mark the address verified.
 * @returns The user.
 */
async function trackedUser(
  options: { hasPassword?: boolean; verified?: boolean } = {}
): Promise<User> {
  const user = await createTrackedUser({ firstName: 'Ada', ...options })
  recipients.push(user.email)
  return user
}

/**
 * A customer tenant owned by a fresh user, tracked for cleanup.
 * @returns The owner and the tenant.
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
 * The message row an email job points at.
 * @param job - The email job.
 * @returns The row.
 */
async function rowOf(job: Job<EmailJobData>): Promise<Record<string, unknown>> {
  const [row] = await sql`select * from email_messages where id = ${job.data.messageId ?? ''}`
  if (!row) throw new Error('the email job has no email_messages row')
  return row
}

/**
 * Wait for the email job to `to` with `templateKey`.
 * @param to - The recipient.
 * @param templateKey - The template.
 * @returns The job.
 */
async function emailJobTo(
  to: string,
  templateKey: EmailJobData['templateKey']
): Promise<Job<EmailJobData>> {
  return waitForJob<EmailJobData>(
    getEmailQueue(),
    (data) => data.to === to && data.templateKey === templateKey
  )
}

describe('invitation mail', () => {
  it('records the tenant, the invitation and the customer app, and no account for a new address', async () => {
    const { owner, tenant } = await customerTenant()
    const email = `invitee-${randomUUID()}@example.test`
    recipients.push(email)

    await invite({ userId: owner.id }, tenant.id, email, 'editor')

    const [pending] = await listPending(tenant.id)
    const row = await rowOf(await emailJobTo(email, 'tenant_invitation'))
    expect(row).toMatchObject({
      tenant_id: tenant.id,
      invitation_id: pending?.id,
      link_app: 'web',
      sender_class: 'transactional',
      variables: { tenantName: 'Acme Inc', role: 'editor', expiresInDays: '7' },
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
    const [pending] = await listPending(tenant.id)

    await resend({ userId: owner.id }, tenant.id, pending?.id ?? '', {
      resentFromId: first.data.messageId ?? '',
    })

    const second = await waitForJob<EmailJobData>(
      getEmailQueue(),
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
 * The notification job a flow enqueued for `userId`.
 * @param userId - The user.
 * @param type - The notification type.
 * @returns The job.
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

describe('notification-path mail', () => {
  it('password reset records the link app and a resend origin, and a retried job reuses the row', async () => {
    const user = await trackedUser({ hasPassword: true })
    const earlier = await trackedUser()
    await sendVerificationMail(earlier, 'web')
    const earlierJob = await notificationJobFor(earlier.id, 'verify_email')
    await processNotificationJob(earlierJob)
    const earlierEmail = await emailJobTo(earlier.email, 'email_verification')

    await sendPasswordResetMail(user, 'apex', { resentFromId: earlierEmail.data.messageId ?? '' })

    const job = await notificationJobFor(user.id, 'password_reset_requested')
    expect(job.data.emailContext).toEqual({
      linkApp: 'apex',
      resentFromId: earlierEmail.data.messageId,
    })
    await processNotificationJob(job)
    await processNotificationJob(job)

    const rows = await sql`
      select id, link_app, resent_from_id, job_key, user_id from email_messages
      where recipient = ${user.email} and template_key = 'password_reset'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      link_app: 'apex',
      resent_from_id: earlierEmail.data.messageId,
      job_key: `notification-email-${String(job.id)}-${String(job.timestamp)}`,
      user_id: user.id,
    })
  })

  it('verification records the web app by default', async () => {
    const user = await trackedUser({ hasPassword: true, verified: false })

    await sendVerificationMail(user)

    const job = await notificationJobFor(user.id, 'verify_email')
    expect(job.data.emailContext).toEqual({ linkApp: 'web' })
    await processNotificationJob(job)
    const row = await rowOf(await emailJobTo(user.email, 'email_verification'))
    expect(row).toMatchObject({ link_app: 'web', user_id: user.id })
    expect(row.resent_from_id).toBeNull()
  })
})

describe('staff password setup', () => {
  it('an account-setup mail records the web app, the user and a resend origin', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await trackedUser()
    const origin = await trackedUser({ hasPassword: true, verified: false })
    await sendVerificationMail(origin)
    await processNotificationJob(await notificationJobFor(origin.id, 'verify_email'))
    const originEmail = await emailJobTo(origin.email, 'email_verification')

    await expect(
      sendPasswordSetup({ userId: admin.id }, target.id, {
        resentFromId: originEmail.data.messageId ?? '',
      })
    ).resolves.toEqual({ emailSent: true })

    const row = await rowOf(await emailJobTo(target.email, 'account_setup'))
    expect(row).toMatchObject({
      link_app: 'web',
      user_id: target.id,
      resent_from_id: originEmail.data.messageId,
      sender_class: 'transactional',
      variables: { firstName: 'Ada' },
    })
  })
})
