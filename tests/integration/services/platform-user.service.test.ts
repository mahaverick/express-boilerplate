/**
 * @file platform-user.service: a failed mail enqueue never undoes a staff
 * write; the caller is told `emailSent: false`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedModule } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

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
        const result = await createUser({ userId: admin.id }, { email, app: 'web' })
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
})
