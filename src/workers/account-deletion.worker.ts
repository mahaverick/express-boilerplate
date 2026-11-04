/**
 * @file The Worker for the "account-deletion" queue: runs the daily due-soon
 * alert that account-deletion.job.ts schedules, one job at a time, since two
 * runs at once would race for the same dedupe keys.
 */
import { UnrecoverableError, Worker, type Job } from 'bullmq'
import { ACCOUNT_DELETION_DUE_SOON_JOB } from '@/jobs/account-deletion.job'
import {
  isTerminalFailure,
  recordPermanentFailure,
  reportFinalJobFailure,
} from '@/jobs/job-failure.job'
import { alertDueSoonDeletions } from '@/services/account-deletion.service'
import { logger } from '@/services/logger.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'

/**
 * Process one account-deletion job.
 * @param job - The job; only its name is read.
 * @returns Resolves once every due request has been alerted or skipped.
 * @throws {Error} When the open requests cannot be read, so BullMQ retries.
 * @throws {UnrecoverableError} For a job name this worker has no handler for.
 */
async function processAccountDeletionJob(job: Job): Promise<void> {
  if (job.name !== ACCOUNT_DELETION_DUE_SOON_JOB) {
    throw new UnrecoverableError(`Unknown account deletion job ${job.name}`)
  }
  const alerted = await alertDueSoonDeletions(new Date())
  logger.info('Account deletion due-soon alerts queued', { requests: alerted.length })
}

/**
 * Start the Worker for the account-deletion queue, one run at a time. The
 * 'failed' handler never rejects: a retryable failure logs a warning, and
 * the last attempt calls `recordPermanentFailure`.
 * @returns The running Worker instance (for graceful shutdown).
 */
export function startAccountDeletionWorker(): Worker {
  const worker = new Worker('account-deletion', processAccountDeletionJob, {
    connection: getQueueConnection(),
    prefix: redisKey('bull'),
    concurrency: 1,
    lockDuration: 60_000,
  })

  worker.on('completed', (job) => {
    logger.info('Account deletion job completed', { jobId: job.id, name: job.name })
  })

  worker.on('failed', (job, error) => {
    const errorId = reportFinalJobFailure('account-deletion', job, error)
    if (job === undefined || !isTerminalFailure(job, error)) {
      logger.warn('Account deletion job failed', {
        jobId: job?.id,
        name: job?.name,
        attempt: job?.attemptsMade,
        error,
      })
      return
    }
    void recordPermanentFailure('account-deletion', job, error, errorId)
  })

  worker.on('error', (error: unknown) => {
    logger.error('Account deletion worker error', { error })
  })

  return worker
}
