// src/jobs/email.job.ts
//
// The one place an email job's payload shape and default options are
// defined — mirrors queue.service.ts's own "one place" framing for the
// Queue/connection themselves.
import { type Job, type JobsOptions } from 'bullmq'
import { JobPriority } from '@/constants/queue.constants'
import type { MailMessage } from '@/services/mailer.service'
import { addJob, getEmailQueue } from '@/services/queue.service'

/**
 * The payload stored on an email job. `MailMessage` (mailer.service.ts) is a
 * discriminated union on `templateKey` — intersecting it with `{ userId:
 * string }` rather than flattening it into a new, hand-written shape keeps
 * that union intact, so `email.worker.ts` can call `sendMail(job.data)`
 * directly, with no `as MailMessage` cast anywhere on the path from
 * `addEmailJob` to the worker.
 */
export type EmailJobData = MailMessage & { userId: string }

/**
 * Default BullMQ job options for every email job, applied by `addEmailJob`
 * before any caller-supplied `opts` override them.
 *
 * `removeOnComplete: true` — delete the job from Redis immediately on
 * success. A raw verification/reset token lives in `variables` (e.g.
 * `variables.verificationUrl`), and `email_logs` (never the token itself) is
 * this codebase's audit trail — leaving a completed job sitting in Redis
 * would keep that token readable long after the email that carried it.
 *
 * `removeOnFail: { age: 7 * 24 * 3600 }` — keep failed jobs for 7 days so an
 * operator can inspect `failedReason` before they expire.
 */
export const emailJobDefaults: JobsOptions = {
  priority: JobPriority.high,
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 5000, // 4 waits: 5s, 10s, 20s, 40s
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
