// src/workers/email.worker.ts
//
// The one place an email job is actually processed — creates and owns the
// BullMQ Worker for the "email" queue defined in email.job.ts.
import { Worker, type Job } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import type { EmailJobData } from '@/jobs/email.job'
import { logger } from '@/services/logger.service'
import { sendMail } from '@/services/mailer.service'
import { getQueueConnection } from '@/services/queue.service'

/**
 * Process one email job. Exported for unit testing.
 *
 * `sendMail` never rejects (Ruling G, mailer.service.ts) — it always
 * resolves to `'sent' | 'failed'`, collapsing every failure mode
 * (rendering error, transport rejection) into the same value. Because that
 * distinction isn't observable here, this function cannot single out a
 * deterministic failure (e.g. a missing template variable) from a transient
 * one (e.g. an SMTP outage) — a `'failed'` result always throws a plain,
 * retryable `Error`, and BullMQ's own `attempts`/`backoff`
 * (`emailJobDefaults`, email.job.ts) governs how many times it tries again.
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
    prefix: env.QUEUE_PREFIX,
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
    logger.error('Email job failed', {
      jobId: job?.id,
      templateKey: job?.data.templateKey,
      attempt: job?.attemptsMade,
      error,
    })
  })

  worker.on('error', (error: unknown) => {
    logger.error('Email worker error', { error })
  })

  return worker
}
