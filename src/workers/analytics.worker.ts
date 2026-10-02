/**
 * @file The Worker for the "analytics" queue: runs the outbox drain that
 * analytics.job.ts schedules, one job at a time whatever
 * `WORKER_CONCURRENCY` says, so one process never sends two batches at
 * once. Two replicas may; the drain's lease keeps their rows apart.
 */
import { UnrecoverableError, Worker, type Job } from 'bullmq'
import { ANALYTICS_DRAIN_JOB } from '@/jobs/analytics.job'
import { drainAnalyticsOutbox } from '@/services/analytics/analytics-drain.service'
import { logger } from '@/services/logger.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'

/**
 * Process one analytics job. Exported for unit testing.
 * @param job - The job; only its name is read.
 * @returns Resolves once the drain has settled every row it claimed.
 * @throws {Error} Whatever the drain throws (a database error); the rows stay in the outbox.
 * @throws {UnrecoverableError} For a job name this worker has no handler for.
 */
export async function processAnalyticsJob(job: Job): Promise<void> {
  if (job.name !== ANALYTICS_DRAIN_JOB) {
    throw new UnrecoverableError(`Unknown analytics job ${job.name}`)
  }
  await drainAnalyticsOutbox()
}

/**
 * Start the analytics worker.
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
    logger.warn('Analytics drain failed', { jobId: job?.id, name: job?.name, error })
  })

  worker.on('error', (error: unknown) => {
    logger.error('Analytics worker error', { error })
  })

  return worker
}
