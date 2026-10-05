/**
 * @file The BullMQ Worker for the "notification" queue defined in
 * notification.job.ts. Each job fans out to up to two channels, each gated by
 * its `notification_preferences` check: an in-app row, published through
 * notification-emitter.service.ts to live SSE streams on every replica, and
 * an email enqueued with `addEmailJob`, never sent directly.
 */
import { Worker, type Job } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import { redactedForLog } from '@/errors/postgres-errors'
import { addEmailJob } from '@/jobs/email.job'
import {
  isTerminalFailure,
  recordPermanentFailure,
  reportFinalJobFailure,
} from '@/jobs/job-failure.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import { NotificationRepository } from '@/repositories/notification.repository'
import { logger } from '@/services/logger.service'
import { emitNotification } from '@/services/notification-emitter.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'

const notificationRepository = new NotificationRepository()
const preferenceRepository = new NotificationPreferenceRepository()

/**
 * `metadata` with its top-level `variables` key removed, if it had one. A raw
 * token lives in `email.variables`; nothing upstream is trusted to have kept
 * it out of `metadata`, so this is where that is enforced before Postgres.
 * @param metadata - The job's own metadata, exactly as received.
 * @returns `metadata` without its top-level `variables` key; nested keys are kept.
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
 * channel is enabled. Exported for unit testing.
 *
 * A failed channel fails the job, and a retry is safe. The in-app insert is
 * keyed by `notification-job-<jobId>-<jobTimestamp>` (`createOnce`, ON
 * CONFLICT DO NOTHING), so a retry never inserts or emits a second row; the
 * email is enqueued with a matching BullMQ jobId, so a retry while that job
 * is still queued adds nothing, and `addEmailJob` stores that id as the
 * message row's `job_key`, so the retry gets the same row back. The
 * timestamp is in both keys because job ids restart at 1 when the queue's
 * Redis keys are flushed. One gap is accepted: email jobs are removed on
 * completion, so a retry after the email was sent can send it again, as a
 * second attempt on the same message.
 *
 * The row is emitted only after its insert commits, so a live stream never
 * shows a notification that `GET /api/v1/notifications` or a replay cannot.
 * @param job - The BullMQ job to process; `job.data` is a `NotificationJobData`.
 * @returns Resolves once both channels have been handled; rejects when either the insert or the email enqueue fails, so BullMQ retries.
 * @throws {Error} Whatever `createOnce` or `addEmailJob` throws, uncaught, so BullMQ retries.
 */
export async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  const { userId, type, title, body, metadata, email, emailContext } = job.data

  const isInAppEnabled = await preferenceRepository.isChannelEnabled(userId, type, 'in_app')
  if (isInAppEnabled) {
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

    // undefined on a retry: the row exists and its emit was already attempted.
    if (created) {
      // Only serialising can throw; the row is committed, so this must not retry the job.
      try {
        emitNotification(userId, created)
      } catch (error) {
        logger.error('Failed to serialise notification for live delivery', {
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

  await addEmailJob(email, userId, {
    jobId: emailJobIdFor(job),
    ...(emailContext !== undefined && { context: emailContext }),
  })
}

/**
 * Start the notification worker.
 * @returns The running Worker instance (for graceful shutdown).
 */
export function startNotificationWorker(): Worker<NotificationJobData> {
  const env = getEnv()
  const worker = new Worker<NotificationJobData>('notification', processNotificationJob, {
    connection: getQueueConnection(),
    prefix: redisKey('bull'),
    concurrency: env.WORKER_CONCURRENCY,
    lockDuration: 30_000,
  })

  worker.on('completed', (job) => {
    logger.info('Notification job completed', { jobId: job.id, type: job.data.type })
  })

  worker.on('failed', (job, error) => {
    const errorId = reportFinalJobFailure('notification', job, error)
    if (job === undefined || !isTerminalFailure(job, error)) {
      // createOnce can fail with a DrizzleQueryError whose params hold title, body and userId.
      logger.warn('Notification job failed', {
        jobId: job?.id,
        type: job?.data.type,
        attempt: job?.attemptsMade,
        error: redactedForLog(error),
      })
      return
    }
    void recordPermanentFailure('notification', job, error, errorId)
  })

  worker.on('error', (error: unknown) => {
    logger.error('Notification worker error', { error })
  })

  return worker
}
