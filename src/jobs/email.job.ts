/**
 * @file The one place an email job's payload shape and default options are
 * defined, and where each email's `email_messages` row is created.
 */
import { type Job, type JobsOptions } from 'bullmq'
import { JobPriority } from '@/constants/queue.constants'
import type { EmailMessage } from '@/database/models/email-message.model'
import { redactedForLog } from '@/errors/postgres-errors'
import type { DbExecutor } from '@/services/database.service'
import {
  createQueuedMessage,
  markMessageEnqueueFailed,
  type NewMessageOrigin,
} from '@/services/email-message.service'
import { logger } from '@/services/logger.service'
import type { MailMessage } from '@/services/mailer.service'
import { addJob, getEmailQueue } from '@/services/queue.service'
import type { EmailContext } from '@/types/email-context'

/**
 * The payload stored on an email job. `MailMessage` (mailer.service.ts) is a
 * discriminated union on `templateKey`; intersecting it with `{ userId,
 * messageId }` keeps the union intact, so `email.worker.ts` calls
 * `sendMail(job.data, …)` with no cast. `messageId` is the `email_messages`
 * row; a job queued by a replica without tracking has none, and the worker
 * creates the row itself.
 */
export type EmailJobData = MailMessage & { userId: string; messageId?: string }

/**
 * What `addEmailJob` accepts besides the message: BullMQ job options, and
 * the context stored on the message row (never passed to BullMQ).
 */
export type EmailJobOptions = Partial<JobsOptions> & { context?: EmailContext }

/**
 * Default BullMQ job options for every email job, applied by `addEmailJob`
 * before any caller-supplied `opts` override them. Five attempts, with
 * exponential waits of 5s, 10s, 20s and 40s.
 *
 * `removeOnComplete: true`: a raw token lives in `variables` (for example
 * `variables.verificationUrl`), so a completed job is deleted at once rather
 * than keeping the token readable in Redis. `email_logs` is the audit trail.
 *
 * `removeOnFail: { age: 7 * 24 * 3600 }`: failed jobs stay 7 days so an
 * operator can inspect `failedReason`. The token stays only while retries
 * are pending: once the job will not be retried, the worker replaces every
 * `…Url` and `…Token` value with `[redacted]` (`recordPermanentFailure`,
 * job-failure.job.ts).
 */
export const emailJobDefaults: JobsOptions = {
  priority: JobPriority.high,
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 5000,
  },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
}

/**
 * Create the email's `email_messages` row in `queued`, without enqueueing
 * its job. `addEmailJob` runs it on the pool; a caller that must commit the
 * row with its own writes runs it in that transaction and calls
 * `enqueueTrackedEmail` once the transaction has committed, so the worker
 * never dequeues a job whose row it cannot see yet.
 * @param message - The MailMessage.
 * @param userId - The user this email is for; `''` when there is none, stored as NULL.
 * @param origin - The context stored on the row, and the fixed job id, if any.
 * @param executor - Where to run the insert: the caller's transaction, or omitted for the pool.
 * @returns The message row.
 * @throws {Error} A fresh error naming only the template (the original is logged, redacted: it can carry the address).
 */
export async function createTrackedEmail(
  message: MailMessage,
  userId: string,
  origin: NewMessageOrigin = {},
  executor?: DbExecutor
): Promise<EmailMessage> {
  try {
    return await createQueuedMessage(message, userId, origin, executor)
  } catch (error) {
    // A query error's message carries its bound parameters (the address), and a notification job's failure reason is stored in Redis.
    logger.error('Creating an email message failed', {
      error: redactedForLog(error),
      templateKey: message.templateKey,
    })
    // eslint-disable-next-line preserve-caught-error -- the original is deliberately not attached: it carries the address
    throw new Error(`Creating the message row for a ${message.templateKey} email failed`)
  }
}

/**
 * Enqueue the job for a message row `createTrackedEmail` created. When the
 * add fails the row is marked `failed` with `failure_origin = 'enqueue'`
 * first, unless that write fails too, which is logged.
 * @param message - The MailMessage the row was created for.
 * @param userId - The user this email is for; `''` when there is none.
 * @param messageId - The row's id.
 * @param jobOptions - Override default job options.
 * @returns The created job, or the existing one for a `jobId` already queued.
 * @throws {Error} Whatever the queue add throws.
 */
export async function enqueueTrackedEmail(
  message: MailMessage,
  userId: string,
  messageId: string,
  jobOptions: Partial<JobsOptions> = {}
): Promise<Job<EmailJobData>> {
  try {
    return await addJob(
      getEmailQueue(),
      message.templateKey,
      { ...message, userId, messageId },
      { ...emailJobDefaults, ...jobOptions }
    )
  } catch (error) {
    try {
      await markMessageEnqueueFailed(messageId)
    } catch (markError) {
      logger.error('Marking an unqueued email failed', {
        error: redactedForLog(markError),
        messageId,
      })
    }
    throw error
  }
}

/**
 * Create the email's `email_messages` row, then enqueue its job carrying
 * the row's id. With `options.jobId` (the notification path), the id is
 * also the row's `job_key`: a retried enqueue gets the same row back and
 * BullMQ skips the duplicate add, so a retry leaves no orphan.
 *
 * Rejects when either step fails, as callers rely on: a notification job
 * retries, and a staff action reports `emailSent: false`. When the insert
 * fails no job is added. When the add fails the row is marked `failed` with
 * `failure_origin = 'enqueue'` first, unless that write fails too, which is
 * logged; a retry with the same `jobId` puts it back to `queued`.
 * @param message - The MailMessage (discriminated union — type-safe template + variables).
 * @param userId - The user this email is for; `''` when there is none, stored as NULL.
 * @param options - Override default job options; `context` goes on the message row.
 * @returns The created job, or the existing one for a `jobId` already queued.
 * @throws {Error} When the row insert fails, a fresh error naming only the template (the original is logged, redacted: it can carry the address); whatever the queue add throws.
 */
export async function addEmailJob(
  message: MailMessage,
  userId: string,
  options: EmailJobOptions = {}
): Promise<Job<EmailJobData>> {
  const { context, ...jobOptions } = options
  const tracked = await createTrackedEmail(message, userId, { context, jobKey: jobOptions.jobId })
  return enqueueTrackedEmail(message, userId, tracked.id, jobOptions)
}
