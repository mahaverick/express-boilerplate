/**
 * @file What a Worker's `'failed'` handler does once a job will not be
 * retried: report it to error tracking, replace the stored payload's links,
 * tokens and recipient addresses, mark an email job's message `failed`,
 * then log one error line. Until then the payload keeps them, because a
 * retry has to send them.
 */
import { UnrecoverableError, type Job } from 'bullmq'
import { redactedForLog } from '@/errors/postgres-errors'
import { markMessageSendFailed } from '@/services/email-message.service'
import { reportError } from '@/services/errors/error-reporter.service'
import { logger } from '@/services/logger.service'

const REDACTED = '[redacted]'

/**
 * Keys whose values are scrubbed: verificationUrl, resetUrl and acceptUrl
 * carry a raw token in their query string.
 */
const SECRET_KEY_PATTERN = /(?:Url|Token)$/

/**
 * Keys whose values hold an address, lowercased: an email job's `to` (also
 * on a notification job's paired `email`) and any `cc`, `bcc`, `replyTo`
 * (`reply_to`), `recipient` or `recipients`, matched in any letter case. A
 * failed job is kept for days; the `email_messages` row already holds the
 * recipient.
 */
const ADDRESS_KEYS: ReadonlySet<string> = new Set([
  'to',
  'cc',
  'bcc',
  'replyto',
  'reply_to',
  'recipient',
  'recipients',
])

/**
 * Whether a key's whole value is replaced: a link, token or address key's
 * is, whatever its type (a string, a list, an object, nested any depth), so
 * an address in an unexpected shape fails closed instead of surviving
 * under a key no rule names.
 * @param key - The key.
 * @returns True when the value becomes `'[redacted]'`.
 */
function isRedactedEntry(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || ADDRESS_KEYS.has(key.toLowerCase())
}

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
 * A copy of a JSON value with every secret-named and address key's value replaced.
 * @param value - Part of a job's data.
 * @returns The scrubbed copy.
 */
function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => scrubValue(item))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isRedactedEntry(key) ? REDACTED : scrubValue(child),
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
 * Report a job's final failure to error tracking: once, on the attempt after
 * which BullMQ will not retry (`isTerminalFailure`), with the queue, the job
 * name and the attempt count. The job's data is never attached. Never throws.
 * @param queue - The queue's name.
 * @param job - The failed job as the 'failed' event passes it; undefined when BullMQ could not load it.
 * @param error - What the attempt threw.
 * @returns The report's `errorId`, for the failure's log line; undefined when nothing was reported.
 */
export function reportFinalJobFailure(
  queue: string,
  job: Job | undefined,
  error: Error
): string | undefined {
  if (job === undefined || !isTerminalFailure(job, error)) return undefined
  return reportError(error, {
    capturePoint: 'job',
    handled: true,
    job: { queue, name: job.name, attemptsMade: job.attemptsMade },
  })
}

/**
 * A copy of a job's data in which every key ending in `Url` or `Token`, and
 * every address key (`to`, `cc`, `bcc`, `replyTo`, `reply_to`, `recipient`,
 * `recipients`, in any letter case), whatever its value's type, at any depth,
 * is `'[redacted]'`.
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
 * @param errorId - The failure's error-tracking report id (`reportFinalJobFailure`), when there is one.
 */
export function logPermanentFailure(queue: string, job: Job, error: Error, errorId?: string): void {
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
  if (errorId !== undefined) meta.errorId = errorId
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
 * @param errorId - The failure's error-tracking report id, put on the log line.
 * @returns Resolves once the scrubbed data is stored and the message marked (or each failure logged) and the failure is logged.
 */
export async function recordPermanentFailure(
  queue: string,
  job: Job,
  error: Error,
  errorId?: string
): Promise<void> {
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
  logPermanentFailure(queue, job, error, errorId)
}
