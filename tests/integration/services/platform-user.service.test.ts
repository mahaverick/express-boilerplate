/**
 * @file platform-user.service: a failed mail enqueue never undoes a staff
 * write; the caller is told `emailSent: false`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import * as envConfig from '@/configs/env.config'
import type { EmailJobData } from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { sql } from '@/services/database.service'
import { getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { ACCOUNT_SETUP_TEMPLATE_KEY } from '@/templates/email/account-setup.template'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedModule } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { waitForJob } from '../../helpers/queue-jobs'

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

const failingEmailJob = {
  addEmailJob: (): Promise<never> => Promise.reject(new Error('queue unavailable')),
}

describe('platform-user.service mail failures', () => {
  it('createUser keeps the user and answers emailSent: false when the mail cannot be queued', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const email = `mailfail-${randomUUID()}@example.test`

    await withMutatedModule(
      '@/jobs/email.job',
      failingEmailJob,
      () => import('@/services/platform-user.service'),
      async ({ createUser }) => {
        const result = await createUser({ userId: admin.id }, { email })
        expect(result.emailSent).toBe(false)
      }
    )

    const rows = await sql`select id from users where email = ${email}`
    expect(rows).toHaveLength(1)
    await truncateAuditLogs()
    await sql`delete from users where email = ${email}`
  })

  it('sendPasswordSetup answers emailSent: false and still records the attempt', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await createTrackedUser()

    await withMutatedModule(
      '@/jobs/email.job',
      failingEmailJob,
      () => import('@/services/platform-user.service'),
      async ({ sendPasswordSetup }) => {
        expect(await sendPasswordSetup({ userId: admin.id }, target.id)).toEqual({
          emailSent: false,
        })
      }
    )

    const rows = await sql`select action from audit_logs where target_id = ${target.id}`
    expect(rows).toEqual([{ action: 'user.password_setup_sent' }])
  })

  it('resendUserVerification answers emailSent: false and still records the attempt', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ hasPassword: true, verified: false })

    await withMutatedModule(
      '@/jobs/notification.job',
      { addNotificationJob: (): Promise<never> => Promise.reject(new Error('queue unavailable')) },
      () => import('@/services/platform-user.service'),
      async ({ resendUserVerification }) => {
        expect(await resendUserVerification({ userId: admin.id }, target.id)).toEqual({
          emailSent: false,
        })
      }
    )

    const rows = await sql`select action from audit_logs where target_id = ${target.id}`
    expect(rows).toEqual([{ action: 'user.verification_resent' }])
  })
})

const APEX_ORIGIN = 'https://apex.mail-origin.test'
const withApexUrl = {
  getEnv: () => ({ ...envConfig.getEnv(), APEX_URL: APEX_ORIGIN }),
}

describe('platform-user.service link origins', () => {
  it('a staff target gets an Apex link and a customer a web link, for set-password and verification', async () => {
    const { user: owner } = await createTrackedStaff('owner')
    const staffTarget = await createTrackedStaff('viewer', { verified: false })
    const customer = await createTrackedUser({ verified: false })
    const staffWithPassword = await createTrackedStaff('viewer', {
      hasPassword: true,
      verified: false,
    })
    const customerWithPassword = await createTrackedUser({ hasPassword: true, verified: false })

    await withMutatedModule(
      '@/configs/env.config',
      withApexUrl,
      () => import('@/services/platform-user.service'),
      async ({ sendPasswordSetup, resendUserVerification }) => {
        await sendPasswordSetup({ userId: owner.id }, staffTarget.user.id)
        await sendPasswordSetup({ userId: owner.id }, customer.id)
        await resendUserVerification({ userId: owner.id }, staffWithPassword.user.id)
        await resendUserVerification({ userId: owner.id }, customerWithPassword.id)
      }
    )

    const originOfSetup = async (to: string): Promise<string> => {
      const job = await waitForJob<EmailJobData>(
        getEmailQueue(),
        (data) => data.to === to && data.templateKey === ACCOUNT_SETUP_TEMPLATE_KEY
      )
      return new URL((job.data.variables as { setupUrl: string }).setupUrl).origin
    }
    const originOfVerification = async (userId: string): Promise<string> => {
      const job = await waitForJob<NotificationJobData>(
        getNotificationQueue(),
        (data) => data.userId === userId && data.type === 'verify_email'
      )
      return new URL((job.data.email?.variables as { verificationUrl: string }).verificationUrl)
        .origin
    }
    const webOrigin = new URL(envConfig.getEnv().WEB_URL).origin
    expect(webOrigin).not.toBe(APEX_ORIGIN)
    expect(await originOfSetup(staffTarget.user.email)).toBe(APEX_ORIGIN)
    expect(await originOfSetup(customer.email)).toBe(webOrigin)
    expect(await originOfVerification(staffWithPassword.user.id)).toBe(APEX_ORIGIN)
    expect(await originOfVerification(customerWithPassword.id)).toBe(webOrigin)
  })
})
