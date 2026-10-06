/**
 * @file The notice jobs of the last maintenance-mode change. The changing
 * request records their ids in Redis (`redisKey('maintenance-mode',
 * 'notices')`, kept a week); the status section reads them to report
 * whether any notice has not gone out yet, which happens when the queues
 * paused before they ran: they go out on resume.
 */
import type { Queue } from 'bullmq'
import { logger } from '@/services/logger.service'
import { getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'

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
 * A failure is logged: the status then reports no pending notices.
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
