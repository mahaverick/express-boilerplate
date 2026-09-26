// src/jobs/notification.job.ts
//
// The one place a notification job's payload shape and default options are
// defined — mirrors email.job.ts's own "one place" framing exactly, for the
// queue notification.worker.ts fans a single job out to two channels
// (in-app row, email) from.
import { type Job, type JobsOptions } from 'bullmq'
import type { NotificationType } from '@/constants/notification.constants'
import { JobPriority } from '@/constants/queue.constants'
import type { MailMessage } from '@/services/mailer.service'
import { addJob, getNotificationQueue } from '@/services/queue.service'

/**
 * The payload stored on a notification job. `email` carries the FULL
 * `MailMessage` discriminated union — not decomposed into flat fields — so
 * `notification.worker.ts` can hand it straight to `addEmailJob(email,
 * userId)` with no `as MailMessage` cast anywhere on this path, the same
 * reasoning `EmailJobData` (email.job.ts) already applies to `MailMessage`
 * itself. `email` is optional: a purely in-app notification (no paired
 * email) simply omits it.
 */
export interface NotificationJobData {
  /**
   * The notification's owner — whose in-app inbox the row belongs to, and
   * who `addEmailJob` records the paired email against.
   */
  userId: string
  /**
   * Which notification type this is — governs both the persisted row's
   * `type` column and which `notification_preferences` row (if any) gates
   * delivery on each channel.
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
   * template rendered the paired email). MUST NOT carry a `variables` key —
   * `notification.worker.ts` strips one if present before the database
   * insert, since a raw verification/reset token lives there, but a caller
   * should not rely on that as licence to pass it deliberately.
   */
  metadata?: Record<string, unknown>
  /**
   * The paired email to send, if this notification type has one. Passed
   * through unmodified to `addEmailJob` — never persisted to the
   * `notifications` table (see `metadata`'s own comment) — so a raw token
   * inside `email.variables` never reaches Postgres, only the transient
   * BullMQ job this queue stores it on.
   */
  email?: MailMessage
}

/**
 * Default BullMQ job options for every notification job, applied by
 * `addNotificationJob` before any caller-supplied `options` override them.
 *
 * `attempts: 3` with exponential backoff — a notification is not as
 * latency-sensitive as an email (no user-facing token/link expiring while
 * it retries), so a shorter retry budget than `emailJobDefaults`' own 5 is
 * enough to ride out a transient database blip.
 *
 * `removeOnComplete: true` — same reasoning as `emailJobDefaults`: on
 * success there is nothing in this job's Redis payload worth keeping
 * (`email.variables`, when present, carries a raw token; the in-app row
 * itself already lives durably in Postgres by the time this job completes).
 *
 * `removeOnFail: { age: 3 * 24 * 3600 }` — keep failed jobs for 3 days so an
 * operator can inspect `failedReason`, shorter than email's 7 since a failed
 * notification job has no independent per-recipient audit trail
 * (`email_logs`) the way a failed email job does. `email.variables`' token
 * stays in Redis only while retries are pending (`recordPermanentFailure`,
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
 * Enqueue a notification job. The job name is the notification's own
 * `type` (e.g. `'verify_email'`) — same "job name = the thing that
 * discriminates handling" convention `addEmailJob` already follows with
 * `message.templateKey`, even though `notification.worker.ts` currently has
 * only one handler regardless of name.
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
