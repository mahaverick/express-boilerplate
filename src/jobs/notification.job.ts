/**
 * @file The one place a notification job's payload shape and default options
 * are defined. notification.worker.ts fans each job out to an in-app row and,
 * when present, an email.
 */
import { type Job, type JobsOptions } from 'bullmq'
import type { NotificationType } from '@/constants/notification.constants'
import { JobPriority } from '@/constants/queue.constants'
import type { MailMessage } from '@/services/mailer.service'
import { addJob, getNotificationQueue } from '@/services/queue.service'

/**
 * The payload stored on a notification job. `email` carries the whole
 * `MailMessage` union, so notification.worker.ts hands it to `addEmailJob`
 * with no cast; a purely in-app notification omits it.
 */
export interface NotificationJobData {
  /**
   * The notification's owner: whose inbox the row belongs to, and who
   * `addEmailJob` records the paired email against.
   */
  userId: string
  /**
   * The notification type: the row's `type`, and which
   * `notification_preferences` row (if any) gates each channel.
   */
  type: NotificationType
  /**
   * The in-app notification's title, stored verbatim on the row.
   */
  title: string
  /**
   * The in-app notification's body, stored verbatim on the row.
   */
  body: string
  /**
   * Opaque, type-specific data to persist alongside the row (e.g. which
   * template rendered the paired email). Must not carry a `variables` key,
   * where a raw token lives; notification.worker.ts strips one before the
   * insert, but a caller must not rely on that.
   */
  metadata?: Record<string, unknown>
  /**
   * The paired email, if this type has one. Passed unmodified to
   * `addEmailJob` and never persisted to `notifications`, so a raw token in
   * `email.variables` never reaches Postgres, only the transient job.
   */
  email?: MailMessage
}

/**
 * Default BullMQ job options for every notification job, applied by
 * `addNotificationJob` before any caller-supplied `options` override them.
 *
 * `attempts: 3` with exponential backoff: fewer than email's 5, since no
 * mailed link expires while it retries, and enough to ride out a transient
 * database blip.
 *
 * `removeOnComplete: true`: `email.variables` may carry a raw token, and the
 * in-app row is already in Postgres.
 *
 * `removeOnFail: { age: 3 * 24 * 3600 }`: failed jobs stay 3 days for an
 * operator to inspect `failedReason`, fewer than email's 7, since a
 * notification job has no `email_logs` trail to keep in step with. A token in `email.variables` stays in
 * Redis only while retries are pending (`recordPermanentFailure`,
 * job-failure.job.ts).
 */
export const notificationJobDefaults: JobsOptions = {
  priority: JobPriority.normal,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: true,
  removeOnFail: { age: 3 * 24 * 3600 },
}

/**
 * Enqueue a notification job, named by its `type` (for example
 * `'verify_email'`), as `addEmailJob` names a job by its template key.
 * @param data - The notification's payload — who it's for, what it says, and the optional paired email.
 * @param options - Override default job options.
 * @returns The created job.
 */
export async function addNotificationJob(
  data: NotificationJobData,
  options?: Partial<JobsOptions>
): Promise<Job<NotificationJobData>> {
  return addJob(getNotificationQueue(), data.type, data, {
    ...notificationJobDefaults,
    ...options,
  })
}
