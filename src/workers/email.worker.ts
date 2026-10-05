/**
 * @file The BullMQ Worker for the "email" queue defined in email.job.ts. Each
 * job sends one tracked email: it checks the suppression list first, and
 * moves the job's `email_messages` row as the send goes.
 */
import { Worker, type Job } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import type { EmailMessage } from '@/database/models/email-message.model'
import { redactedForLog } from '@/errors/postgres-errors'
import type { EmailJobData } from '@/jobs/email.job'
import {
  isTerminalFailure,
  recordPermanentFailure,
  reportFinalJobFailure,
} from '@/jobs/job-failure.job'
import {
  createQueuedMessage,
  findMessage,
  isRecipientSuppressed,
  markMessageSent,
  markMessageSuppressed,
} from '@/services/email-message.service'
import { logger } from '@/services/logger.service'
import { sendMail } from '@/services/mailer.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'

/**
 * The message row for a job queued by a replica without tracking, created
 * here. Keyed by the job's id and timestamp, so the job's retries get the
 * same row, and a job id reused after a Redis flush does not. The id is
 * written into the job's data, best-effort, so `recordPermanentFailure`
 * finds it.
 * @param job - The email job, whose data has no `messageId`.
 * @returns The created (or, on a retry, the existing) row.
 * @throws {Error} When the job has no id, or the insert fails.
 */
async function createMessageForUntrackedJob(job: Job<EmailJobData>): Promise<EmailMessage> {
  if (job.id === undefined) throw new Error('Email job has no id')
  const created = await createQueuedMessage(job.data, job.data.userId, {
    jobKey: `email-job-${job.id}-${String(job.timestamp)}`,
  })
  try {
    await job.updateData({ ...job.data, messageId: created.id })
  } catch (error) {
    logger.warn('Storing the message id on an email job failed', {
      jobId: job.id,
      error,
    })
  }
  return created
}

/**
 * Process one email job. Exported for unit testing.
 *
 * In order: find the job's message row (creating it for an untracked
 * job); skip the send when the row is gone (purged since the job was
 * queued) or the recipient is suppressed, which marks the row `suppressed`
 * and completes the job with no attempt row and no retry; otherwise send
 * with the row's Message-ID and record `sent`.
 *
 * `sendMail` never rejects; it resolves `'failed'` for every failure,
 * rendering and transport alike, so a deterministic failure cannot be told
 * from a transient one here. `'failed'` always throws a retryable `Error`,
 * and `emailJobDefaults` (email.job.ts) sets the retries. Recording `sent`
 * never throws: a retry after a real send would send the email again.
 * @param job - The BullMQ job to process; `job.data` is a `MailMessage` (discriminated union) plus `userId` and `messageId`.
 * @returns Resolves once the email has been sent or skipped; rejects (so BullMQ retries) when `sendMail` reports `'failed'`, or when a lookup before the send fails.
 * @throws {Error} When `sendMail` resolves to `'failed'`, or when the lookup, row creation, suppression check or suppressed mark before it throws (the original error is logged, redacted). Either message carries only `job.id` and `templateKey`, never the recipient address, since BullMQ persists it in `failedReason` (Redis).
 */
export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { messageId, templateKey } = job.data
  let message: EmailMessage | undefined
  try {
    message =
      messageId === undefined
        ? await createMessageForUntrackedJob(job)
        : await findMessage(messageId)
    if (message !== undefined && (await isRecipientSuppressed(job.data.to))) {
      await markMessageSuppressed(message.id)
      logger.info('Email job skipped: the recipient is suppressed', {
        jobId: job.id,
        templateKey,
        messageId: message.id,
      })
      return
    }
  } catch (error) {
    // A query error's message carries its bound parameters (the address); BullMQ keeps this message in Redis.
    logger.error('Email job failed before sending', {
      error: redactedForLog(error),
      jobId: job.id,
      templateKey,
    })
    // eslint-disable-next-line preserve-caught-error -- the original is deliberately not attached: it carries the address
    throw new Error(`Email job ${job.id} failed before sending, for template ${templateKey}`)
  }
  if (message === undefined) {
    logger.info('Email job skipped: its message no longer exists', { jobId: job.id, templateKey })
    return
  }

  const result = await sendMail(job.data, {
    messageId: message.id,
    messageIdHeader: message.messageIdHeader,
  })
  if (result === 'failed') {
    throw new Error(`Email job ${job.id} failed for template ${templateKey}`)
  }
  try {
    await markMessageSent(message.id)
  } catch (error) {
    logger.error('Recording a sent email failed', {
      error: redactedForLog(error),
      jobId: job.id,
      messageId: message.id,
    })
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
    const errorId = reportFinalJobFailure('email', job, error)
    if (job === undefined || !isTerminalFailure(job, error)) {
      logger.warn('Email job failed', {
        jobId: job?.id,
        templateKey: job?.data.templateKey,
        attempt: job?.attemptsMade,
        error,
      })
      return
    }
    void recordPermanentFailure('email', job, error, errorId)
  })

  worker.on('error', (error: unknown) => {
    logger.error('Email worker error', { error })
  })

  return worker
}
