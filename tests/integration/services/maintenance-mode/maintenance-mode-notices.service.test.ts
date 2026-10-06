/**
 * @file Whether the last change's notices are still pending, against the
 * real notification and email queues under this worker's prefix: nothing
 * recorded, a notification job still waiting, an email job still waiting,
 * and every job finished or gone.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  hasPendingNotices,
  noticeIdsKey,
  rememberNoticeJobs,
} from '@/services/maintenance-mode/maintenance-mode-notices.service'
import { addJob, closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { getRedis } from '@/services/redis.service'

const added: { queue: 'notification' | 'email'; id: string }[] = []

afterEach(async () => {
  for (const { queue, id } of added) {
    const job = await (queue === 'email' ? getEmailQueue() : getNotificationQueue()).getJob(id)
    await job?.remove()
  }
  added.length = 0
  const redis = await getRedis()
  await redis.del(noticeIdsKey())
})

afterAll(async () => {
  await closeQueue()
})

/**
 * Add a job no worker in this file runs, so it stays waiting.
 * @param queue - Which queue.
 * @returns Its id.
 */
async function waitingJob(queue: 'notification' | 'email'): Promise<string> {
  const id = `mm-notice-${randomUUID()}`
  await addJob(
    queue === 'email' ? getEmailQueue() : getNotificationQueue(),
    'probe',
    {},
    {
      jobId: id,
    }
  )
  added.push({ queue, id })
  return id
}

describe('hasPendingNotices', () => {
  it('is false when no change recorded notices', async () => {
    expect(await hasPendingNotices()).toBe(false)
  })

  it('is true while a notification job waits, and while its email job waits', async () => {
    await rememberNoticeJobs({ notification: [await waitingJob('notification')], email: [] })
    expect(await hasPendingNotices()).toBe(true)

    await rememberNoticeJobs({ notification: [], email: [await waitingJob('email')] })
    expect(await hasPendingNotices()).toBe(true)
  })

  it('is false once every job is finished or gone', async () => {
    await rememberNoticeJobs({
      notification: [`mm-gone-${randomUUID()}`],
      email: [`mm-gone-${randomUUID()}`],
    })

    expect(await hasPendingNotices()).toBe(false)
  })
})
