/**
 * @file Against the real Redis and per-worker Postgres: proves the whole
 * path `addNotificationJob` writes into Redis is actually picked up and
 * processed by a real BullMQ Worker (`notification.worker.ts`) — enqueue,
 * Worker pulls the job, real `NotificationRepository` insert / real
 * `addEmailJob` enqueue onto the "email" queue. Does not also start the
 * email worker: this file's scope is the notification worker's fan-out
 * contract, that a real enqueue eventually leaves a matching job on the
 * real "email" queue, not that Mailpit delivery also works end to end.
 */
import { randomUUID } from 'node:crypto'
import { UnrecoverableError, type Job, type Worker } from 'bullmq'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { EmailJobData } from '@/jobs/email.job'
import { addNotificationJob, type NotificationJobData } from '@/jobs/notification.job'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import { NotificationRepository } from '@/repositories/notification.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { startNotificationWorker } from '@/workers/notification.worker'
import { withMutatedMethod } from '../../helpers/mutate'
import { waitForLoggedCall } from '../../helpers/queue-jobs'

/**
 * The email queue's currently queued/settled jobs, typed as `EmailJobData`:
 * `getEmailQueue()` returns a bare, ungenericised `Queue`, so `.getJobs()`
 * on it is `Job<any>[]` without this assertion.
 * @returns Every job currently on the "email" queue in a non-terminal or completed state.
 */
async function emailQueueJobs(): Promise<Job<EmailJobData>[]> {
  // 'prioritized', not just 'waiting': every email job carries an explicit priority (JobPriority.high), which BullMQ routes into its own list rather than "waiting" until a worker pulls it.
  return getEmailQueue().getJobs([
    'waiting',
    'active',
    'completed',
    'delayed',
    'prioritized',
  ]) as Promise<Job<EmailJobData>[]>
}

const notificationRepository = new NotificationRepository()
const preferenceRepository = new NotificationPreferenceRepository()
const userRepository = new UserRepository()

/**
 * A disposable email, unique to one call — same shape as
 * notification.repository.test.ts's own `uniqueEmail` helper, parameterised
 * with a label so a failing assertion's recipient string also says which
 * test/role produced it.
 * @param label - A short tag identifying which test/role this address is for.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(label: string): string {
  return `notification-worker-${label}-${randomUUID()}@example.test`
}

/**
 * Wait for one specific job id to reach a terminal state on `worker`,
 * resolving with which event fired. Scoped to a single job id, same
 * reasoning as email.worker.test.ts's own `waitForJobSettled`: two tests
 * running their own job through the same shared Worker instance must never
 * resolve each other's promise.
 * @param worker - The running notification Worker to listen on.
 * @param jobId - The job id to wait for.
 * @returns Resolves with `'completed'` or `'failed'` once that job settles.
 */
function waitForJobSettled(
  worker: Worker<NotificationJobData>,
  jobId: string
): Promise<'completed' | 'failed'> {
  return new Promise((resolve) => {
    const onCompleted = (job: Job<NotificationJobData>): void => {
      if (job.id !== jobId) return
      cleanup()
      resolve('completed')
    }
    const onFailed = (job: Job<NotificationJobData> | undefined): void => {
      if (job?.id !== jobId) return
      cleanup()
      resolve('failed')
    }
    const cleanup = (): void => {
      worker.off('completed', onCompleted)
      worker.off('failed', onFailed)
    }
    worker.on('completed', onCompleted)
    worker.on('failed', onFailed)
  })
}

describe('notification.worker', () => {
  const worker = startNotificationWorker()
  const createdUserIds: string[] = []

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await sql`delete from users where id = any(${createdUserIds})`
    }
    // Close the worker first (drains the current job), then obliterate both queues this file could have left jobs on, then the shared connection.
    await worker.close()
    await getNotificationQueue().obliterate({ force: true })
    await getEmailQueue().obliterate({ force: true })
    await closeQueue()
  })

  /**
   * A fresh user for a test to own notifications with, tracked for cleanup
   * — `notifications.userId`/`notification_preferences.userId` both carry
   * `ON DELETE CASCADE` (notification.model.ts), so deleting the user in
   * `afterAll` is enough to remove everything this file inserts.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail('owner') })
    createdUserIds.push(user.id)
    return user.id
  }

  it('creates an in-app row (metadata stripped of variables) and enqueues the paired email', async () => {
    const userId = await createUser()
    const recipient = uniqueEmail('recipient')
    const rawToken = `secret-${randomUUID()}`

    const job = await addNotificationJob({
      userId,
      type: 'verify_email',
      title: 'Verify your email',
      body: 'Click the link to verify your email address.',
      metadata: {
        templateKey: 'email_verification',
        variables: { verificationUrl: `https://example.test/verify?token=${rawToken}` },
      },
      email: {
        to: recipient,
        templateKey: 'email_verification',
        variables: {
          firstName: 'Ada',
          verificationUrl: `https://example.test/verify?token=${rawToken}`,
          appName: 'Test App',
        },
      },
    })
    if (!job.id) throw new Error('expected addNotificationJob to assign a job id')

    await expect(waitForJobSettled(worker, job.id)).resolves.toBe('completed')

    const { notifications } = await notificationRepository.list(userId, { limit: 10 })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.title).toBe('Verify your email')
    // The load-bearing assertion: what was actually persisted to Postgres, not merely what the worker was asked to strip in-process.
    expect(notifications[0]?.metadata).toEqual({ templateKey: 'email_verification' })
    expect(notifications[0]?.metadata).not.toHaveProperty('variables')
    expect(JSON.stringify(notifications[0]?.metadata)).not.toContain(rawToken)

    const emailJobs = await emailQueueJobs()
    const matchingEmailJob = emailJobs.find((emailQueueJob) => emailQueueJob.data.to === recipient)
    expect(matchingEmailJob).toBeDefined()
    expect(matchingEmailJob?.data.userId).toBe(userId)
  }, 15_000)

  it('skips the in-app row when the in_app channel is disabled, but still enqueues the email', async () => {
    const userId = await createUser()
    await preferenceRepository.upsert(userId, 'verify_email', {
      emailEnabled: true,
      inAppEnabled: false,
    })
    const recipient = uniqueEmail('in-app-disabled')

    const job = await addNotificationJob({
      userId,
      type: 'verify_email',
      title: 'Verify your email',
      body: 'body',
      email: {
        to: recipient,
        templateKey: 'email_verification',
        variables: {
          firstName: 'Ada',
          verificationUrl: 'https://example.test/verify?token=abc',
          appName: 'Test',
        },
      },
    })
    if (!job.id) throw new Error('expected addNotificationJob to assign a job id')

    await expect(waitForJobSettled(worker, job.id)).resolves.toBe('completed')

    const { notifications } = await notificationRepository.list(userId, { limit: 10 })
    expect(notifications).toEqual([])

    const emailJobs = await emailQueueJobs()
    expect(emailJobs.some((emailQueueJob) => emailQueueJob.data.to === recipient)).toBe(true)
  }, 15_000)

  it('does not enqueue an email when no email payload is present, but still creates the in-app row', async () => {
    const userId = await createUser()

    const job = await addNotificationJob({
      userId,
      type: 'verify_email',
      title: 'Verify your email',
      body: 'body',
    })
    if (!job.id) throw new Error('expected addNotificationJob to assign a job id')

    await expect(waitForJobSettled(worker, job.id)).resolves.toBe('completed')

    const { notifications } = await notificationRepository.list(userId, { limit: 10 })
    expect(notifications).toHaveLength(1)

    const emailJobs = await emailQueueJobs()
    expect(emailJobs.some((emailQueueJob) => emailQueueJob.data.userId === userId)).toBe(false)
  }, 15_000)

  it('fails the job (so BullMQ can retry) when the in-app insert violates the user foreign key', async () => {
    // Deliberately never inserted into users: the foreign-key violation proves processNotificationJob actually lets it propagate rather than swallowing it. attempts: 1 asserts the terminal failed state, not the retry schedule.
    const bogusUserId = randomUUID()

    const job = await addNotificationJob(
      { userId: bogusUserId, type: 'verify_email', title: 'Verify your email', body: 'body' },
      { attempts: 1 }
    )
    if (!job.id) throw new Error('expected addNotificationJob to assign a job id')

    await expect(waitForJobSettled(worker, job.id)).resolves.toBe('failed')

    const failedJob = await getNotificationQueue().getJob(job.id)
    expect(failedJob?.failedReason).toBeDefined()
  }, 15_000)

  it('scrubs the stored job on its first attempt when it throws UnrecoverableError', async () => {
    const userId = await createUser()
    const token = `secret-${randomUUID()}`
    const loggerError = vi.spyOn(logger, 'error')

    try {
      await withMutatedMethod(
        NotificationPreferenceRepository.prototype,
        'isChannelEnabled',
        () => Promise.reject(new UnrecoverableError('preferences unavailable')),
        async () => {
          // notificationJobDefaults allows 3 attempts; only the error type ends it at 1.
          const job = await addNotificationJob({
            userId,
            type: 'verify_email',
            title: 'Verify your email',
            body: 'body',
            metadata: { templateKey: 'email_verification' },
            email: {
              to: uniqueEmail('unrecoverable'),
              templateKey: 'email_verification',
              variables: {
                firstName: 'Ada',
                verificationUrl: `https://example.test/verify?token=${token}`,
                appName: 'Test App',
              },
            },
          })
          if (!job.id) throw new Error('expected addNotificationJob to assign a job id')
          const jobId = job.id

          await waitForLoggedCall(
            loggerError,
            (message, meta) => message === 'job failed permanently' && meta?.jobId === jobId,
            10_000
          )

          const stored = await getNotificationQueue().getJob(jobId)
          expect(stored?.attemptsMade).toBe(1)
          expect(stored?.data).toMatchObject({
            userId,
            metadata: { templateKey: 'email_verification' },
            email: {
              templateKey: 'email_verification',
              variables: { firstName: 'Ada', verificationUrl: '[redacted]', appName: 'Test App' },
            },
          })
          expect(JSON.stringify(stored?.data)).not.toContain(token)
          expect(loggerError).toHaveBeenCalledWith(
            'job failed permanently',
            expect.objectContaining({
              queue: 'notification',
              jobId,
              name: 'verify_email',
              template: 'email_verification',
              userId,
              attemptsMade: 1,
            })
          )
        }
      )
    } finally {
      loggerError.mockRestore()
    }
  }, 15_000)
})
