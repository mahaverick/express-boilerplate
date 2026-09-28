/**
 * @file The one place an email job's payload shape and default options are
 * defined.
 */
import { type Job, type JobsOptions } from 'bullmq'
import { JobPriority } from '@/constants/queue.constants'
import type { MailMessage } from '@/services/mailer.service'
import { addJob, getEmailQueue } from '@/services/queue.service'

/**
 * The payload stored on an email job. `MailMessage` (mailer.service.ts) is a
 * discriminated union on `templateKey`; intersecting it with `{ userId }`
 * keeps the union intact, so `email.worker.ts` calls `sendMail(job.data)`
 * with no cast.
 */
export type EmailJobData = MailMessage & { userId: string }

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
 * Enqueue an email job.
 * @param message - The MailMessage (discriminated union — type-safe template + variables).
 * @param userId - The user this email is for (logging/correlation, not a DB lookup).
 * @param options - Override default job options.
 * @returns The created job.
 */
export async function addEmailJob(
  message: MailMessage,
  userId: string,
  options?: Partial<JobsOptions>
): Promise<Job<EmailJobData>> {
  return addJob(
    getEmailQueue(),
    message.templateKey,
    { ...message, userId },
    { ...emailJobDefaults, ...options }
  )
}
