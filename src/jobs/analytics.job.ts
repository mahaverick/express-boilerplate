/**
 * @file The analytics queue's schedule: the outbox drain, every
 * `ANALYTICS_DRAIN_INTERVAL_MS`. The scheduler lives in Redis under
 * `REDIS_KEY_PREFIX`, so every replica that upserts it shares one schedule,
 * and each tick runs on one Worker.
 */
import type { JobSchedulerTemplateOptions } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import { getAnalyticsQueue } from '@/services/queue.service'

/**
 * The drain's job name, and the id of the scheduler that creates it.
 */
export const ANALYTICS_DRAIN_JOB = 'analytics-drain'

/**
 * Options for every drain job. One attempt: the next tick is the retry, and
 * a failed drain leaves every row in the outbox. The last 100 failures are
 * kept for inspection.
 */
export const analyticsDrainJobDefaults: JobSchedulerTemplateOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { count: 100 },
}

/**
 * Register the repeating drain. Idempotent: every call upserts the same
 * scheduler id, so a changed `ANALYTICS_DRAIN_INTERVAL_MS` replaces the old interval.
 * @returns Resolves once the scheduler and its next job are stored in Redis.
 */
export async function ensureAnalyticsDrainSchedule(): Promise<void> {
  await getAnalyticsQueue().upsertJobScheduler(
    ANALYTICS_DRAIN_JOB,
    { every: getEnv().ANALYTICS_DRAIN_INTERVAL_MS },
    { name: ANALYTICS_DRAIN_JOB, opts: analyticsDrainJobDefaults }
  )
}
