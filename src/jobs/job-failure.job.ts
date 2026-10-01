/**
 * @file What a Worker's `'failed'` handler does once a job will not be
 * retried: replace the stored payload's links and tokens, mark an email
 * job's message `failed`, then log one error line. Until then the payload
 * keeps them, because a retry has to send them.
 */
import { UnrecoverableError, type Job } from 'bullmq'
import { redactedForLog } from '@/errors/postgres-errors'
import { markMessageSendFailed } from '@/services/email-message.service'
import { logger } from '@/services/logger.service'

const REDACTED = '[redacted]'

/**
 * Keys whose values are scrubbed: verificationUrl, resetUrl and acceptUrl
 * carry a raw token in their query string.
 */
const SECRET_KEY_PATTERN = /(?:Url|Token)$/

/**
 * Whether a value is a non-array object, not null. It matches any such
 * object, a Date included; job data arrives JSON round-tripped, so here
 * that means a JSON object.
 * @param value - Anything read from a job's data.
 * @returns True for any non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A copy of a JSON value with every secret-named key's value replaced.
 * @param value - Part of a job's data.
 * @returns The scrubbed copy.
 */
function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => scrubValue(item))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? REDACTED : scrubValue(child),
    ])
  )
}

/**
 * The email template a job's data names: an email job's own `templateKey`, or a notification job's paired email's.
 * @param data - The job's data.
 * @returns The template key, or undefined when the job has none.
 */
function templateOf(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  if (typeof data.templateKey === 'string') return data.templateKey
  const email = data.email
  return isRecord(email) && typeof email.templateKey === 'string' ? email.templateKey : undefined
}

/**
 * Whether a failed attempt was the job's last, so BullMQ will not retry it.
 * BullMQ counts the attempt before it emits 'failed', so attemptsMade already includes it.
 * @param job - The failed job as the 'failed' event passes it; undefined when BullMQ could not load it.
 * @param error - What the attempt threw.
 * @returns True when its attempts are used up or it threw UnrecoverableError; false for an undefined job.
 */
export function isTerminalFailure(job: Job | undefined, error: Error): boolean {
  if (job === undefined) return false
  if (error instanceof UnrecoverableError || error.name === 'UnrecoverableError') return true
  return job.attemptsMade >= (job.opts.attempts ?? 1)
}

/**
 * A copy of a job's data in which every key ending in `Url` or `Token`, at any depth, is `'[redacted]'`.
 * @param data - The job's data.
 * @returns The scrubbed copy; the argument is not changed.
 */
export function scrubJobData<T>(data: T): T {
  return scrubValue(data) as T
}

/**
 * Log a job's final failure: one error line, `job failed permanently`.
 * `reason` is the raw error: the logger's serializer drops a query error's parameters.
 * @param queue - The queue's name.
 * @param job - The job that will not be retried.
 * @param error - What its last attempt threw.
 */
export function logPermanentFailure(queue: string, job: Job, error: Error): void {
  const data: unknown = job.data
  const meta: Record<string, unknown> = {
    queue,
    jobId: job.id,
    name: job.name,
    userId: isRecord(data) ? data.userId : undefined,
    attemptsMade: job.attemptsMade,
    reason: error,
  }
  const template = templateOf(data)
  if (template !== undefined) meta.template = template
  logger.error('job failed permanently', meta)
}

/**
 * Mark an email job's message `failed` (`failure_origin = 'send'`): every
 * attempt failed. A job with no `messageId` has no row to mark. A failure
 * here is logged, never thrown.
 * @param queue - The queue's name.
 * @param job - The email job that will not be retried.
 * @returns Resolves once the row is marked, or the failure to mark it is logged.
 */
async function markEmailMessageFailed(queue: string, job: Job): Promise<void> {
  const data: unknown = job.data
  const messageId = isRecord(data) ? data.messageId : undefined
  if (typeof messageId !== 'string') return
  try {
    await markMessageSendFailed(messageId)
  } catch (markError) {
    logger.error("Marking a failed email's message failed", {
      queue,
      jobId: job.id,
      messageId,
      error: redactedForLog(markError),
    })
  }
}

/**
 * Scrub a job that will not be retried, mark an email job's message
 * `failed`, then log its failure once.
 * Never rejects: it runs from a Worker's 'failed' listener, where a rejection would be unhandled.
 * @param queue - The queue's name; `'email'` marks the job's message.
 * @param job - The job that will not be retried.
 * @param error - What its last attempt threw.
 * @returns Resolves once the scrubbed data is stored and the message marked (or each failure logged) and the failure is logged.
 */
export async function recordPermanentFailure(queue: string, job: Job, error: Error): Promise<void> {
  try {
    const data: unknown = job.data
    await job.updateData(scrubJobData(data))
  } catch (scrubError) {
    logger.error("Scrubbing a failed job's data failed", {
      queue,
      jobId: job.id,
      error: scrubError,
    })
  }
  if (queue === 'email') await markEmailMessageFailed(queue, job)
  logPermanentFailure(queue, job, error)
}
