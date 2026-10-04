/**
 * @file The analytics queue's second schedule: the PostHog deletion of
 * purged users, every `ANALYTICS_DELETION_INTERVAL_MS`. Like the drain's,
 * the scheduler lives in Redis under `REDIS_KEY_PREFIX`, so every replica
 * that upserts it shares one schedule, and each tick runs on one Worker.
 */
import { ANALYTICS_DELETION_INTERVAL_MS } from '@/constants/analytics.constants'
import { analyticsDrainJobDefaults } from '@/jobs/analytics.job'
import { getAnalyticsQueue } from '@/services/queue.service'

/**
 * The deletion job's name, and the id of the scheduler that creates it.
 */
export const ANALYTICS_DELETIONS_JOB = 'analytics-deletions'

/**
 * Register the repeating deletion tick. Idempotent: every call upserts the
 * same scheduler id. Its jobs take the drain's options: one attempt (the
 * next tick is the retry, and a failed tick leaves every row in the table),
 * and the last 100 failures kept.
 * @returns Resolves once the scheduler and its next job are stored in Redis.
 */
export async function ensureAnalyticsDeletionSchedule(): Promise<void> {
  await getAnalyticsQueue().upsertJobScheduler(
    ANALYTICS_DELETIONS_JOB,
    { every: ANALYTICS_DELETION_INTERVAL_MS },
    { name: ANALYTICS_DELETIONS_JOB, opts: analyticsDrainJobDefaults }
  )
}
