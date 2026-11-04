/**
 * @file The account-deletion queue's schedule: the due-soon alert, daily at
 * 04:00 UTC, which alerts platform admins once per open deletion request due
 * within five days. The scheduler lives in Redis under `REDIS_KEY_PREFIX`,
 * so every replica that upserts it shares one schedule.
 */
import type { JobSchedulerTemplateOptions } from 'bullmq'
import { getAccountDeletionQueue } from '@/services/queue.service'

/**
 * The due-soon alert's job name, and the id of the scheduler that creates it.
 */
export const ACCOUNT_DELETION_DUE_SOON_JOB = 'due-soon-alert'

/**
 * Options for every due-soon run. A run whose query fails throws, and the
 * retries run it again: the per-request dedupe key makes a rerun alert only
 * the requests not yet alerted.
 */
const accountDeletionJobDefaults: JobSchedulerTemplateOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
}

/**
 * Register the daily due-soon alert. Idempotent: every call upserts the same scheduler id.
 * @returns Resolves once the scheduler and its next job are stored in Redis.
 */
export async function ensureAccountDeletionSchedule(): Promise<void> {
  await getAccountDeletionQueue().upsertJobScheduler(
    ACCOUNT_DELETION_DUE_SOON_JOB,
    { pattern: '0 4 * * *', tz: 'UTC' },
    { name: ACCOUNT_DELETION_DUE_SOON_JOB, opts: accountDeletionJobDefaults }
  )
}
