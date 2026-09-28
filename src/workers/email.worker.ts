/**
 * @file The BullMQ Worker for the "email" queue defined in email.job.ts.
 */
import { Worker, type Job } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import type { EmailJobData } from '@/jobs/email.job'
import { isTerminalFailure, recordPermanentFailure } from '@/jobs/job-failure.job'
import { logger } from '@/services/logger.service'
import { sendMail } from '@/services/mailer.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'

/**
 * Process one email job. Exported for unit testing.
 *
 * `sendMail` never rejects; it resolves `'failed'` for every failure,
 * rendering and transport alike, so a deterministic failure cannot be told
 * from a transient one here. `'failed'` always throws a retryable `Error`,
 * and `emailJobDefaults` (email.job.ts) sets the retries.
 * @param job - The BullMQ job to process; `job.data` is a `MailMessage` (discriminated union) plus `userId`.
 * @returns Resolves once the email has been sent; rejects (so BullMQ retries) when `sendMail` reports `'failed'`.
 * @throws {Error} When `sendMail` resolves to `'failed'` — deliberately carries only `job.id` and `templateKey`, never the recipient address, since BullMQ persists this message in `failedReason` (Redis).
 */
export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const result = await sendMail(job.data)
  if (result === 'failed') {
    throw new Error(`Email job ${job.id} failed for template ${job.data.templateKey}`)
  }
}

/**
 * Start the email worker.
 * @returns The running Worker instance (for graceful shutdown).
 */
export function startEmailWorker(): Worker<EmailJobData> {
  const env = getEnv()
  const worker = new Worker<EmailJobData>('email', processEmailJob, {
    connection: getQueueConnection(),
    prefix: redisKey('bull'),
    concurrency: env.WORKER_CONCURRENCY,
    lockDuration: 30_000,
  })

  worker.on('completed', (job) => {
    logger.info('Email job completed', {
      jobId: job.id,
      templateKey: job.data.templateKey,
    })
  })

  worker.on('failed', (job, error) => {
    if (job === undefined || !isTerminalFailure(job, error)) {
      logger.warn('Email job failed', {
        jobId: job?.id,
        templateKey: job?.data.templateKey,
        attempt: job?.attemptsMade,
        error,
      })
      return
    }
    void recordPermanentFailure('email', job, error)
  })

  worker.on('error', (error: unknown) => {
    logger.error('Email worker error', { error })
  })

  return worker
}
