/**
 * @file The last change's notices against the real notification and email
 * queues under this worker's prefix, with no Worker running: whether any is
 * still pending (nothing recorded, a waiting notification or email job,
 * every job finished or gone), and the notice wait's timeout and done paths.
 */
import { randomUUID } from 'node:crypto'
import type { Job } from 'bullmq'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasPendingNotices,
  noticeIdsKey,
  noticeWaitBudgetMs,
  rememberNoticeJobs,
  waitForNoticeJobs,
} from '@/services/maintenance-mode/maintenance-mode-notices.service'
import { addJob, closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { getRedis } from '@/services/redis.service'
import { emailJobIdFor } from '@/workers/notification.worker'

const added: { queue: 'notification' | 'email'; id: string }[] = []

afterEach(async () => {
  vi.restoreAllMocks()
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

/**
 * A waiting notification job and the waiting email job its worker would have enqueued.
 * @returns The notification job.
 */
async function notificationWithWaitingEmail(): Promise<Job> {
  const id = await waitingJob('notification')
  const job = await getNotificationQueue().getJob(id)
  if (!job) throw new Error('setup: the notification job was just added')
  const emailId = emailJobIdFor(job)
  await addJob(getEmailQueue(), 'probe', {}, { jobId: emailId })
  added.push({ queue: 'email', id: emailId })
  return job
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

describe('waitForNoticeJobs', () => {
  it('times out on a notification job no Worker runs', async () => {
    const id = await waitingJob('notification')
    const job = await getNotificationQueue().getJob(id)

    expect(await waitForNoticeJobs({ notification: job ? [job] : [] }, 300)).toBe('timeout')
  })

  it('is done once the notification job and its email are gone', async () => {
    const id = await waitingJob('notification')
    const job = await getNotificationQueue().getJob(id)
    await job?.remove()

    expect(await waitForNoticeJobs({ notification: job ? [job] : [] }, 300)).toBe('done')
  })

  it('skips the email of a notification that failed, so its waiting email does not hold the wait', async () => {
    const job = await notificationWithWaitingEmail()
    vi.spyOn(getNotificationQueue(), 'getJobState').mockResolvedValue('failed')

    expect(await waitForNoticeJobs({ notification: [job] }, 300)).toBe('done')
  })

  it('times out while the email of a completed notification is still waiting', async () => {
    const job = await notificationWithWaitingEmail()
    vi.spyOn(getNotificationQueue(), 'getJobState').mockResolvedValue('completed')

    expect(await waitForNoticeJobs({ notification: [job] }, 300)).toBe('timeout')
  })

  it('is done at once with no jobs', async () => {
    expect(await waitForNoticeJobs({ notification: [] }, 300)).toBe('done')
  })
})

describe('noticeWaitBudgetMs', () => {
  const COMMITTED = new Date('2026-10-06T10:00:00.000Z')

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is what is left of the notice wait counted from the commit, on the clock', () => {
    vi.useFakeTimers({ now: new Date(COMMITTED.getTime() + 3000) })

    expect(noticeWaitBudgetMs(COMMITTED)).toBe(7000)
  })

  it('is the whole wait at the commit and zero once it has passed', () => {
    expect(noticeWaitBudgetMs(COMMITTED, COMMITTED.getTime())).toBe(10_000)
    expect(noticeWaitBudgetMs(COMMITTED, COMMITTED.getTime() + 10_000)).toBe(0)
    expect(noticeWaitBudgetMs(COMMITTED, COMMITTED.getTime() + 25_000)).toBe(0)
  })

  it('never exceeds the wait when this replica’s clock runs behind the database’s', () => {
    expect(noticeWaitBudgetMs(COMMITTED, COMMITTED.getTime() - 4000)).toBe(10_000)
  })
})
