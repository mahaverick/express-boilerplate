// src/workers/notification.worker.ts
//
// The one place a notification job is actually processed — creates and owns
// the BullMQ Worker for the "notification" queue defined in
// notification.job.ts. Fans one job out to up to two channels, each gated
// by its own `notification_preferences` check:
//
//   - in-app: insert a row into `notifications` via `NotificationRepository`,
//     then publish it to `notification-emitter.service.ts`'s in-process
//     emitter so a live `GET /api/v1/notifications/stream` connection
//     (notification-stream.controller.ts) sees it immediately, without
//     polling.
//   - email: enqueue onto the "email" queue via `addEmailJob` — this worker
//     never calls `sendMail` directly, the same "go through the queue"
//     convention CLAUDE.md documents for every other email send.
//
// THE TWO CHANNELS FAIL DIFFERENTLY, DELIBERATELY. An in-app insert failure
// throws, so BullMQ's own `attempts`/`backoff` (`notificationJobDefaults`,
// notification.job.ts) retries the whole job — the in-app row is this
// worker's own durable side effect, with nothing else to retry it if this
// job is marked complete without one. An email enqueue failure is instead
// caught and logged: `addEmailJob` only writes to Redis (the "email" queue
// itself), which has its own independent `attempts`/`backoff`
// (`emailJobDefaults`, email.job.ts) once the job actually lands there — a
// failure to enqueue in the first place is rare (a Redis blip) and retrying
// the OUTER notification job over it would risk a duplicate in-app row (the
// insert above already succeeded) for the sake of a channel with its own
// retry mechanism already.
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
 * Process one notification job: insert an in-app row when the `in_app`
 * channel is enabled for this user and type, and enqueue the paired email
 * when both an `email` payload is present on the job AND the `email`
 * channel is enabled. Exported for unit testing — see this file's own
 * header comment for why the two channels are handled so differently on
 * failure.
 * @param job - The BullMQ job to process; `job.data` is a `NotificationJobData`.
 * @returns Resolves once both channels have been attempted; rejects (so BullMQ retries the whole job) only when the in-app insert itself fails.
 * @throws {Error} Whatever `NotificationRepository.create` throws — deliberately not caught, so BullMQ's own `attempts`/`backoff` (`notificationJobDefaults`, notification.job.ts) retries. Never thrown for an email-enqueue failure — see this file's header comment.
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
    const created = metadata
      ? await notificationRepository.create({
          userId,
          type,
          title,
          body,
          metadata: metadataWithoutVariables(metadata),
        })
      : await notificationRepository.create({ userId, type, title, body })

    // Fire only after the insert has actually committed — never before, and
    // never for a channel that is disabled — so an SSE connection can never
    // observe a notification via the live stream before `GET
    // /api/v1/notifications` (or a reconnect's replay burst) can also see
    // it. See notification-emitter.service.ts's own header comment for why
    // this is a same-process, in-memory emit rather than something durable:
    // a connection with nothing subscribed just misses it, the same as any
    // other client that was not listening at the time.
    //
    // Caught, not left to propagate — same "the insert already committed,
    // so nothing after it may fail the job" reasoning this file's header
    // comment gives for the email channel. `EventEmitter#emit` runs every
    // subscribed SSE connection's listener synchronously and re-throws
    // whatever the first one throws; an uncaught throw here would reject
    // this job and BullMQ would retry the WHOLE thing, producing a second
    // in-app row for a failure that has nothing to do with the insert that
    // already succeeded.
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

  if (!email) return

  const isEmailEnabled = await preferenceRepository.isChannelEnabled(userId, type, 'email')
  if (!isEmailEnabled) return

  try {
    // `email` is `MailMessage` — email.job.ts's own discriminated union
    // — passed straight through with zero casts, per task-2-brief.md's
    // own design decision.
    await addEmailJob(email, userId)
  } catch (error) {
    logger.error('Failed to enqueue email from notification worker', {
      error,
      jobId: job.id,
      type,
    })
  }
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
    // `NotificationRepository.create` propagates — a real
    // `DrizzleQueryError`, which carries enumerable `query`/`params`
    // (CLAUDE.md's own "never log bound query parameters" rule, already
    // applied for the identical reason in mailer.service.ts's
    // `recordDelivery`). Nothing here is a raw token — `metadataWithoutVariables`
    // already stripped `variables` before the insert this error came from —
    // but the bound params still include title/body/userId, and this is the
    // one place in this file they could otherwise reach the log stream.
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
