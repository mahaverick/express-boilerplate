// src/jobs/maintenance.job.ts
//
// The maintenance queue's schedule: the retention purge, daily at 03:00 UTC.
// The scheduler lives in Redis under REDIS_KEY_PREFIX, so every replica that
// upserts it shares one schedule.
import type { JobSchedulerTemplateOptions } from 'bullmq'
import { getMaintenanceQueue } from '@/services/queue.service'

/**
 * The retention purge's job name, and the id of the scheduler that creates it.
 */
export const RETENTION_PURGE_JOB = 'retention-purge'

/**
 * Options for every retention purge job. A run with a failed rule throws, and
 * the retries run it again: each rule is idempotent.
 */
export const maintenanceJobDefaults: JobSchedulerTemplateOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
}

/**
 * Register the daily retention purge. Idempotent: every call upserts the same scheduler id.
 * @returns Resolves once the scheduler and its next job are stored in Redis.
 */
export async function ensureRetentionSchedule(): Promise<void> {
  await getMaintenanceQueue().upsertJobScheduler(
    RETENTION_PURGE_JOB,
    { pattern: '0 3 * * *', tz: 'UTC' },
    { name: RETENTION_PURGE_JOB, opts: maintenanceJobDefaults }
  )
}
