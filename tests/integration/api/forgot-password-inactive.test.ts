/**
 * @file Forgot-password sends nothing to a deactivated account, and says so
 * to nobody: the reply is the one a live account gets.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { NotificationJobData } from '@/jobs/notification.job'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { expectNoJob, waitForJob } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'

const app = createApp()

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('POST /api/v1/auth/forgot-password for a deactivated account', () => {
  it('queues no reset mail and answers exactly as for a live account', async () => {
    const inactive = await createTrackedUser({ hasPassword: true, active: false })
    const live = await createTrackedUser({ hasPassword: true })

    const refused = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: inactive.email })
    const accepted = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: live.email })

    expect(refused.status).toBe(accepted.status)
    expect((refused.body as { message: string }).message).toBe(
      (accepted.body as { message: string }).message
    )
    // The live account's job was queued after the inactive one would have been.
    await waitForJob<NotificationJobData>(getNotificationQueue(), (data) => data.userId === live.id)
    await expectNoJob<NotificationJobData>(
      getNotificationQueue(),
      (data) => data.userId === inactive.id
    )
  })
})
