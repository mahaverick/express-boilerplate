/**
 * @file The notice jobs of the last maintenance-mode change. Before a
 * change into `full` pauses the queues, the changing request waits for its
 * notices (`waitForNoticeJobs`) by polling each job's state, never with a
 * `QueueEvents` connection (a job removed on completion before the wait
 * starts would read as a failure). It records their ids in Redis
 * (`redisKey('maintenance-mode', 'notices')`, kept a week); the status
 * section reads them to report whether any notice has not gone out yet,
 * which happens when the queues paused first: they go out on resume.
 */
import { setTimeout as delay } from 'node:timers/promises'
import type { Job, Queue } from 'bullmq'
import { MAINTENANCE_MODE_NOTICE_WAIT_MS } from '@/constants/maintenance-mode.constants'
import { logger } from '@/services/logger.service'
import { getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { emailJobIdFor } from '@/workers/notification.worker'

/**
 * How often the notice wait asks each job's state.
 */
const NOTICE_POLL_INTERVAL_MS = 200

/**
 * How long the ids of one change's notices are kept.
 */
const NOTICE_IDS_TTL_SECONDS = 7 * 24 * 3600

/**
 * The job states that mean a job will not run again.
 */
const FINISHED_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'unknown'])

/**
 * One change's notice jobs: each notification job, and the email job id
 * its worker enqueues (or would).
 */
export interface NoticeJobIds {
  notification: string[]
  email: string[]
}

/**
 * The Redis key holding the last change's notice job ids.
 * @returns `<prefix>:maintenance-mode:notices`.
 */
export function noticeIdsKey(): string {
  return redisKey('maintenance-mode', 'notices')
}

/**
 * Record the last change's notice jobs, replacing the previous change's.
 * A failure is logged and the previous change's record (kept up to a week)
 * stays: the status then reports that change's notices, not this one's.
 * @param ids - The job ids.
 * @returns Resolves once stored or logged; never rejects.
 */
export async function rememberNoticeJobs(ids: NoticeJobIds): Promise<void> {
  try {
    const redis = await getRedis()
    await redis.set(noticeIdsKey(), JSON.stringify(ids), {
      expiration: { type: 'EX', value: NOTICE_IDS_TTL_SECONDS },
    })
  } catch (error) {
    logger.warn('Maintenance-mode notice ids could not be recorded', { error })
  }
}

/**
 * Whether any of a queue's jobs has yet to finish.
 * @param queue - The queue.
 * @param ids - Job ids on it.
 * @returns True when any is still waiting, delayed or running.
 */
async function isAnyUnfinished(queue: Queue, ids: string[]): Promise<boolean> {
  const states = await Promise.all(ids.map((id) => queue.getJobState(id)))
  return states.some((state) => !FINISHED_STATES.has(state))
}

/**
 * Whether a notice of the last change has not gone out: a notification job,
 * or the email job its worker enqueued, not yet finished.
 * @returns The answer; false when nothing is recorded or Redis fails. Never rejects.
 */
export async function hasPendingNotices(): Promise<boolean> {
  try {
    const redis = await getRedis()
    const stored = await redis.get(noticeIdsKey())
    if (stored === null) return false
    const ids = JSON.parse(stored) as NoticeJobIds
    const [notifications, emails] = await Promise.all([
      isAnyUnfinished(getNotificationQueue(), ids.notification),
      isAnyUnfinished(getEmailQueue(), ids.email),
    ])
    return notifications || emails
  } catch (error) {
    logger.warn('Maintenance-mode notice state could not be read', { error })
    return false
  }
}

/**
 * Poll some jobs' states until every one has finished or the deadline passes.
 * @param queue - Their queue.
 * @param ids - Their ids.
 * @param deadline - The epoch ms to stop at.
 * @returns Each job's final state, in order, or `'timeout'`.
 */
async function pollUntilFinished(
  queue: Queue,
  ids: string[],
  deadline: number
): Promise<string[] | 'timeout'> {
  for (;;) {
    const states = await Promise.all(ids.map((id) => queue.getJobState(id)))
    if (states.every((state) => FINISHED_STATES.has(state))) return states
    if (Date.now() >= deadline) return 'timeout'
    await delay(NOTICE_POLL_INTERVAL_MS)
  }
}

/**
 * What is left of the notice wait for a change committed at `changedAt`: the
 * wait counts from the commit, so it always ends by the time another replica's
 * backstop may pause the queues (`MAINTENANCE_MODE_PAUSE_GRACE_MS` after it).
 * @param changedAt - The commit time the database stamped.
 * @param now - The current instant in epoch ms; injectable for tests.
 * @returns The remaining wait in ms, never negative and never above the whole wait.
 */
export function noticeWaitBudgetMs(changedAt: Date, now: number = Date.now()): number {
  const left = changedAt.getTime() + MAINTENANCE_MODE_NOTICE_WAIT_MS - now
  return Math.min(MAINTENANCE_MODE_NOTICE_WAIT_MS, Math.max(0, left))
}

/**
 * Wait, under one shared deadline, for a change's notification jobs to
 * finish, then for the email job each one that did not fail enqueued
 * (`emailJobIdFor`). `completed`, `failed` and `unknown` (finished and
 * removed, or, for an email, never enqueued because the channel is off)
 * count as finished: the notification worker enqueues the email before its
 * own job completes.
 * @param jobs - The change's jobs.
 * @param jobs.notification - Its notification jobs.
 * @param deadlineMs - The shared deadline; defaults to `MAINTENANCE_MODE_NOTICE_WAIT_MS`.
 * @returns `'done'`, `'timeout'`, or `'error'` when Redis failed; never rejects.
 */
export async function waitForNoticeJobs(
  jobs: { notification: Job[] },
  deadlineMs: number = MAINTENANCE_MODE_NOTICE_WAIT_MS
): Promise<'done' | 'timeout' | 'error'> {
  const deadline = Date.now() + deadlineMs
  const notifications = jobs.notification.filter((job) => job.id !== undefined)
  try {
    const states = await pollUntilFinished(
      getNotificationQueue(),
      notifications.map((job) => job.id ?? ''),
      deadline
    )
    if (states === 'timeout') return 'timeout'
    const emailIds = notifications
      .filter((_job, index) => states[index] !== 'failed')
      .map((job) => emailJobIdFor(job))
    const emailStates = await pollUntilFinished(getEmailQueue(), emailIds, deadline)
    return emailStates === 'timeout' ? 'timeout' : 'done'
  } catch (error) {
    logger.warn('Maintenance-mode notices could not be waited for', { error })
    return 'error'
  }
}
