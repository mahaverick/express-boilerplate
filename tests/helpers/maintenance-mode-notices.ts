/**
 * @file The maintenance-mode notice jobs a test's changes left on this
 * worker's notification queue, and their cleanup.
 */
import type { Job } from 'bullmq'
import type { NotificationJobData } from '@/jobs/notification.job'
import { noticeIdsKey } from '@/services/maintenance-mode/maintenance-mode-notices.service'
import { getNotificationQueue } from '@/services/queue.service'
import { getRedis } from '@/services/redis.service'

/**
 * The maintenance-mode notification jobs still pending (no Worker runs in the caller's file).
 * @returns The jobs.
 */
export async function pendingMaintenanceNotices(): Promise<Job<NotificationJobData>[]> {
  const jobs = (await getNotificationQueue().getJobs(
    ['wait', 'delayed', 'prioritized'],
    0,
    -1
  )) as Job<NotificationJobData>[]
  return jobs.filter((job) => job.data.type === 'maintenance_mode_changed')
}

/**
 * Remove every pending maintenance-mode notice and the recorded notice ids.
 * @returns Resolves once removed.
 */
export async function clearMaintenanceNotices(): Promise<void> {
  const pending = await pendingMaintenanceNotices()
  for (const job of pending) await job.remove()
  const redis = await getRedis()
  await redis.del(noticeIdsKey())
}
