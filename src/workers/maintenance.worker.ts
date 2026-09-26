// src/workers/maintenance.worker.ts
//
// The Worker for the "maintenance" queue: runs the retention purge that
// maintenance.job.ts schedules. One job at a time, whatever
// WORKER_CONCURRENCY says: two purges at once would contend for the same rows.
import { UnrecoverableError, Worker, type Job } from 'bullmq'
import { isTerminalFailure, recordPermanentFailure } from '@/jobs/job-failure.job'
import { RETENTION_PURGE_JOB } from '@/jobs/maintenance.job'
import { logger } from '@/services/logger.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'
import { runRetentionPurge } from '@/services/retention.service'

/**
 * Process one maintenance job. Exported for unit testing.
 * @param job - The job; only its name is read.
 * @returns Resolves once every retention rule has run without error.
 * @throws {Error} When a rule failed, naming each, after every rule has run, so BullMQ retries.
 * @throws {UnrecoverableError} For a job name this worker has no handler for.
 */
export async function processMaintenanceJob(job: Job): Promise<void> {
  if (job.name !== RETENTION_PURGE_JOB) {
    throw new UnrecoverableError(`Unknown maintenance job ${job.name}`)
  }
  const results = await runRetentionPurge()
  const failed = results.filter((result) => 'error' in result).map((result) => result.table)
  if (failed.length > 0) {
    throw new Error(`Retention purge failed for ${failed.join(', ')}`)
  }
}

/**
 * Start the maintenance worker.
 * @returns The running Worker instance (for graceful shutdown).
 */
export function startMaintenanceWorker(): Worker {
  const worker = new Worker('maintenance', processMaintenanceJob, {
    connection: getQueueConnection(),
    prefix: redisKey('bull'),
    concurrency: 1,
    lockDuration: 60_000,
  })

  worker.on('completed', (job) => {
    logger.info('Maintenance job completed', { jobId: job.id, name: job.name })
  })

  worker.on('failed', (job, error) => {
    if (job === undefined || !isTerminalFailure(job, error)) {
      logger.warn('Maintenance job failed', {
        jobId: job?.id,
        name: job?.name,
        attempt: job?.attemptsMade,
        error,
      })
      return
    }
    void recordPermanentFailure('maintenance', job, error)
  })

  worker.on('error', (error: unknown) => {
    logger.error('Maintenance worker error', { error })
  })

  return worker
}
