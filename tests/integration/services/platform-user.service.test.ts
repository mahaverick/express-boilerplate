/**
 * @file platform-user.service: a failed mail enqueue never undoes a staff
 * write; the caller is told `emailSent: false`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import * as envConfig from '@/configs/env.config'
import { emailQueueFor, type EmailJobData } from '@/jobs/email.job'
import { sql } from '@/services/database.service'
import { SIGN_IN_LINK_TEMPLATE_KEY } from '@/templates/email/sign-in-link.template'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedModule } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { waitForJob } from '../../helpers/queue-jobs'

/**
 * Every address a test mailed a sign-in link to: those rows carry no user,
 * so `afterEach` deletes them by address.
 */
const usedEmails: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedUsers()
  if (usedEmails.length === 0) return
  await sql`delete from user_tokens where email = any(${usedEmails})`
  usedEmails.length = 0
})

const failingEmailJob = {
  addEmailJob: (): Promise<never> => Promise.reject(new Error('queue unavailable')),
}

describe('platform-user.service mail failures', () => {
  it('createUser keeps the user and answers emailSent: false when the mail cannot be queued', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const email = `mailfail-${randomUUID()}@example.test`
    usedEmails.push(email)

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

  it('sendSignInLinkByStaff answers emailSent: false and still records the attempt', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await createTrackedUser()
    usedEmails.push(target.email)

    await withMutatedModule(
      '@/jobs/email.job',
      failingEmailJob,
      () => import('@/services/platform-user.service'),
      async ({ sendSignInLinkByStaff }) => {
        expect(await sendSignInLinkByStaff({ userId: admin.id }, target.id)).toEqual({
          emailSent: false,
        })
      }
    )

    const rows = await sql`select action from audit_logs where target_id = ${target.id}`
    expect(rows).toEqual([{ action: 'user.sign_in_link_sent' }])
  })
})

const APEX_ORIGIN = 'https://apex.mail-origin.test'
const withApexUrl = {
  getEnv: () => ({ ...envConfig.getEnv(), APEX_URL: APEX_ORIGIN }),
}

describe('platform-user.service link origins', () => {
  it('a staff target gets an Apex sign-in link and a customer a web one', async () => {
    const { user: owner } = await createTrackedStaff('owner')
    const staffTarget = await createTrackedStaff('viewer')
    const customer = await createTrackedUser()
    usedEmails.push(staffTarget.user.email, customer.email)

    await withMutatedModule(
      '@/configs/env.config',
      withApexUrl,
      () => import('@/services/platform-user.service'),
      async ({ sendSignInLinkByStaff }) => {
        await sendSignInLinkByStaff({ userId: owner.id }, staffTarget.user.id)
        await sendSignInLinkByStaff({ userId: owner.id }, customer.id)
      }
    )

    /**
     * Reads the origin of the sign-in link queued for `to`, which shows the frontend it opens.
     */
    const originOfLink = async (to: string): Promise<string> => {
      const job = await waitForJob<EmailJobData>(
        emailQueueFor(SIGN_IN_LINK_TEMPLATE_KEY),
        (data) => data.to === to && data.templateKey === SIGN_IN_LINK_TEMPLATE_KEY
      )
      return new URL((job.data.variables as { signInUrl: string }).signInUrl).origin
    }
    const webOrigin = new URL(envConfig.getEnv().WEB_URL).origin
    expect(webOrigin).not.toBe(APEX_ORIGIN)
    expect(await originOfLink(staffTarget.user.email)).toBe(APEX_ORIGIN)
    expect(await originOfLink(customer.email)).toBe(webOrigin)
  })
})
