/**
 * @file The one place an email job's payload shape and default options are
 * defined, where each email's `email_messages` row is created, and where its
 * queue is picked: auth mail goes to `auth-email`, which full maintenance
 * never pauses, and everything else to `email`.
 */
import { type Job, type JobsOptions, type Queue } from 'bullmq'
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
import { addJob, getAuthEmailQueue, getEmailQueue } from '@/services/queue.service'
import type { EmailContext } from '@/types/email-context'
import type { EmailTemplateKey } from '@/utilities/email-template.utilities'

/**
 * The templates a person needs to sign in, confirm it's them, or join a
 * workspace (the invitation and its confirm link). They go on the `auth-email` queue, so full maintenance, which
 * pauses every other queue, cannot hold them.
 */
export const AUTH_EMAIL_TEMPLATE_KEYS = [
  'sign_in_link',
  'step_up_link',
  'welcome',
  'tenant_invitation',
  'invitation_confirm',
  'passkey_created',
  'passkey_deleted',
] as const satisfies readonly EmailTemplateKey[]

/**
 * `AUTH_EMAIL_TEMPLATE_KEYS` as a set, for the lookup.
 */
const AUTH_EMAIL_TEMPLATES: ReadonlySet<EmailTemplateKey> = new Set(AUTH_EMAIL_TEMPLATE_KEYS)

/**
 * The queue a template's jobs go on: `auth-email` for an auth template, `email` for the rest.
 * @param templateKey - The template.
 * @returns The queue.
 */
export function emailQueueFor(templateKey: EmailTemplateKey): Queue {
  return AUTH_EMAIL_TEMPLATES.has(templateKey) ? getAuthEmailQueue() : getEmailQueue()
}

/**
 * The payload stored on an email job. `MailMessage` (mailer.service.ts) is a
 * discriminated union on `templateKey`; intersecting it with `{ userId,
 * messageId }` keeps the union intact, so `email.worker.ts` calls
 * `sendMail(job.data, …)` with no cast. `messageId` is the `email_messages`
 * row; a job queued without one gets its row from the worker.
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
 * `…Url` and `…Token` value, and every address key's value, with
 * `[redacted]` (`recordPermanentFailure`, job-failure.job.ts).
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
    // oxlint-disable-next-line preserve-caught-error -- the original is deliberately not attached: it carries the address
    throw new Error(`Creating the message row for a ${message.templateKey} email failed`)
  }
}

/**
 * Enqueue the job for a message row `createTrackedEmail` created, on the
 * template's queue (`emailQueueFor`). When the add fails the row is marked
 * `failed` with `failure_origin = 'enqueue'` first, unless that write fails
 * too, which is logged.
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
      emailQueueFor(message.templateKey),
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
 * @param message - The email to send.
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
