/**
 * @file The Worker for the "analytics" queue: runs the outbox drain that
 * analytics.job.ts schedules and the PostHog deletion of purged users that
 * analytics-deletion.job.ts schedules, one job at a time whatever
 * `WORKER_CONCURRENCY` says, so this Worker never has two of its jobs
 * talking to PostHog at once. Two replicas may; each job's claim keeps their rows apart.
 */
import { UnrecoverableError, Worker, type Job } from 'bullmq'
import { isAnalyticsEnabled } from '@/configs/analytics.config'
import { ANALYTICS_DELETIONS_JOB } from '@/jobs/analytics-deletion.job'
import { ANALYTICS_DRAIN_JOB } from '@/jobs/analytics.job'
import { reportFinalJobFailure } from '@/jobs/job-failure.job'
import { processAnalyticsDeletions } from '@/services/analytics/analytics-deletion.service'
import { drainAnalyticsOutbox } from '@/services/analytics/analytics-drain.service'
import { logger } from '@/services/logger.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'

/**
 * Process one analytics job, by name. A drain job does nothing while
 * analytics is off, and a deletion job while the personal API key is not
 * configured (`processAnalyticsDeletions` checks): the Worker runs when
 * either is on, and a schedule registered under an earlier configuration
 * stays in Redis. Exported for unit testing.
 * @param job - The job; only its name is read.
 * @returns Resolves once the drain or the deletion tick has settled every row it claimed.
 * @throws {Error} Whatever the drain or the deletion tick throws (a database error); the rows stay.
 * @throws {UnrecoverableError} For a job name this worker has no handler for.
 */
export async function processAnalyticsJob(job: Job): Promise<void> {
  if (job.name === ANALYTICS_DRAIN_JOB) {
    if (isAnalyticsEnabled()) await drainAnalyticsOutbox()
    return
  }
  if (job.name === ANALYTICS_DELETIONS_JOB) {
    await processAnalyticsDeletions()
    return
  }
  throw new UnrecoverableError(`Unknown analytics job ${job.name}`)
}

/**
 * Start the analytics worker. A drain or deletion tick has one attempt, so
 * every failed tick is a final failure and is reported to error tracking;
 * the reporter's throttle bounds a run of failing ticks.
 * @returns The running Worker instance (for graceful shutdown).
 */
export function startAnalyticsWorker(): Worker {
  const worker = new Worker('analytics', processAnalyticsJob, {
    connection: getQueueConnection(),
    prefix: redisKey('bull'),
    concurrency: 1,
    lockDuration: 60_000,
  })

  // Warn, never the permanent-failure error: a failed tick loses nothing, and the next one retries.
  worker.on('failed', (job, error) => {
    const errorId = reportFinalJobFailure('analytics', job, error)
    logger.warn('Analytics job failed', { jobId: job?.id, name: job?.name, error, errorId })
  })

  worker.on('error', (error: unknown) => {
    logger.error('Analytics worker error', { error })
  })

  return worker
}
