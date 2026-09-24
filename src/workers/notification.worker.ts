// src/workers/notification.worker.ts
//
// The one place a notification job is actually processed — creates and owns
// the BullMQ Worker for the "notification" queue defined in
// notification.job.ts. Fans one job out to up to two channels, each gated
// by its own `notification_preferences` check:
//
//   - in-app: insert a row into `notifications` via `NotificationRepository`,
//     then publish it through `notification-emitter.service.ts` so a live
//     `GET /api/v1/notifications/stream` connection on any replica
//     (notification-stream.controller.ts) sees it immediately, without
//     polling.
//   - email: enqueue onto the "email" queue via `addEmailJob` — this worker
//     never calls `sendMail` directly, the same "go through the queue"
//     convention CLAUDE.md documents for every other email send.
//
// A FAILED CHANNEL FAILS THE JOB, AND A RETRY IS SAFE. The in-app insert is
// keyed by `notification-job-<jobId>-<jobTimestamp>` (`createOnce`, ON
// CONFLICT DO NOTHING), so a retry never inserts or emits a second row. The
// email is enqueued with a matching BullMQ jobId, so a retry while that job
// is still queued adds nothing. Enqueue failures therefore propagate and
// BullMQ retries (`notificationJobDefaults`). `job.timestamp` is part of both
// keys because job ids restart at 1 when the queue's Redis keys are flushed.
// One gap is accepted: email jobs are removed on completion, so a retry after
// the email was already sent can send it again.
import { Worker, type Job } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import { addEmailJob } from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { redactedForLog } from '@/middlewares/error.middleware'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import { NotificationRepository } from '@/repositories/notification.repository'
import { logger } from '@/services/logger.service'
import { emitNotification } from '@/services/notification-emitter.service'
import { getQueueConnection } from '@/services/queue.service'

const notificationRepository = new NotificationRepository()
const preferenceRepository = new NotificationPreferenceRepository()

/**
 * `metadata` with its `variables` key removed, if it had one. A raw
 * verification/reset token lives in `email.variables` (mailer.service.ts's
 * own `MailMessage`), never in `metadata` — but nothing upstream of this
 * worker is trusted to have kept the two separate, so this is the one place
 * that enforces it before anything reaches Postgres, regardless of whether
 * a caller put `variables` in `metadata` on purpose or by copying
 * `email.variables` there by mistake.
 * @param metadata - The job's own metadata, exactly as received.
 * @returns `metadata` without its `variables` key. Every other key is kept, including one also literally named `variables` nested deeper — only the top-level key is stripped, since that's the only shape a caller could plausibly produce by accident here.
 */
function metadataWithoutVariables(metadata: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...metadata }
  delete rest.variables
  return rest
}

/**
 * The job's id, which both idempotency keys are built from.
 * @param job - The notification job.
 * @returns `job.id`.
 * @throws {Error} When the job has no id, which BullMQ never does for a processed job.
 */
function idOf(job: Job<NotificationJobData>): string {
  if (job.id === undefined) throw new Error('Notification job has no id')
  return job.id
}

/**
 * The idempotency key for this job's in-app row. Stable across retries of
 * one job; the timestamp keeps it unique if job ids restart.
 * @param job - The notification job.
 * @returns The `notifications.dedupe_key` value.
 */
function dedupeKeyFor(job: Job<NotificationJobData>): string {
  return `notification-job-${idOf(job)}-${job.timestamp}`
}

/**
 * The BullMQ jobId for this job's email. BullMQ rejects a custom id
 * containing ':' (other than its own 3-part form), so this uses '-'.
 * @param job - The notification job.
 * @returns The email job id.
 */
function emailJobIdFor(job: Job<NotificationJobData>): string {
  return `notification-email-${idOf(job)}-${job.timestamp}`
}

/**
 * Process one notification job: insert an in-app row when the `in_app`
 * channel is enabled for this user and type, and enqueue the paired email
 * when both an `email` payload is present on the job AND the `email`
 * channel is enabled. Exported for unit testing — see this file's own
 * header comment for why a failure in either channel fails the job.
 * @param job - The BullMQ job to process; `job.data` is a `NotificationJobData`.
 * @returns Resolves once both channels have been handled; rejects when either the insert or the email enqueue fails, so BullMQ retries.
 * @throws {Error} Whatever `createOnce` or `addEmailJob` throws — not caught; retries are safe (see header).
 */
export async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  const { userId, type, title, body, metadata, email } = job.data

  const isInAppEnabled = await preferenceRepository.isChannelEnabled(userId, type, 'in_app')
  if (isInAppEnabled) {
    // Built as two calls, not one with `metadata: metadata && ...`:
    // `exactOptionalPropertyTypes` (tsconfig.json) treats `metadata?: T` as
    // "present with type T, or the key entirely absent" — never "present
    // with value `undefined`" — so an optional field this codebase actually
    // wants to omit must be left out of the object literal, the same
    // conditional-construction pattern `NotificationRepository.list` already
    // uses for `nextCursor` (notification.repository.ts).
    const dedupeKey = dedupeKeyFor(job)
    const created = metadata
      ? await notificationRepository.createOnce({
          userId,
          type,
          title,
          body,
          metadata: metadataWithoutVariables(metadata),
          dedupeKey,
        })
      : await notificationRepository.createOnce({ userId, type, title, body, dedupeKey })

    // Fire only after the insert has actually committed — never before, and
    // never for a channel that is disabled — so an SSE connection can never
    // observe a notification via the live stream before `GET
    // /api/v1/notifications` (or a reconnect's replay burst) can also see
    // it. Live delivery is best effort (notification-emitter.service.ts's
    // header): a connection with nothing subscribed just misses it, the same
    // as any other client that was not listening at the time.
    //
    // Caught, not left to propagate: the row is already committed, so a
    // failure to publish it live is not a reason to retry the job.
    //
    // undefined: a retry, and this row was already inserted; its emit was
    // already attempted.
    if (created) {
      try {
        emitNotification(userId, created)
      } catch (error) {
        logger.error('Failed to publish notification to the SSE emitter', {
          error: redactedForLog(error),
          notificationId: created.id,
          type,
        })
      }
    }
  }

  if (!email) return

  const isEmailEnabled = await preferenceRepository.isChannelEnabled(userId, type, 'email')
  if (!isEmailEnabled) return

  // Propagates on failure so BullMQ retries; see this file's header.
  await addEmailJob(email, userId, { jobId: emailJobIdFor(job) })
}

/**
 * Start the notification worker.
 * @returns The running Worker instance (for graceful shutdown).
 */
export function startNotificationWorker(): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>('notification', processNotificationJob, {
    connection: getQueueConnection(),
    prefix: getEnv().QUEUE_PREFIX,
    concurrency: 5,
    lockDuration: 30_000,
  })

  worker.on('completed', (job) => {
    logger.info('Notification job completed', { jobId: job.id, type: job.data.type })
  })

  worker.on('failed', (job, error) => {
    // redactedForLog, not the raw error: unlike email.worker.ts's own
    // `failed` handler (processEmailJob only ever throws a plain `Error` it
    // constructs itself), the retry path here can fail with whatever
    // `NotificationRepository.createOnce` propagates — a real
    // `DrizzleQueryError`, which carries enumerable `query`/`params`
    // (CLAUDE.md's own "never log bound query parameters" rule, already
    // applied for the identical reason in mailer.service.ts's
    // `recordDelivery`). Nothing here is a raw token — `metadataWithoutVariables`
    // already stripped `variables` before the insert — but the bound params
    // still include title/body/userId. An `addEmailJob` rejection's ioredis
    // `command.args` hold the token; the logger keeps only name/message/stack.
    logger.error('Notification job failed', {
      jobId: job?.id,
      type: job?.data.type,
      attempt: job?.attemptsMade,
      error: redactedForLog(error),
    })
  })

  worker.on('error', (error: unknown) => {
    logger.error('Notification worker error', { error })
  })

  return worker
}
