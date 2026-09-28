/**
 * @file Against the real Redis, Mailpit, and per-worker Postgres: proves
 * the whole path `email.job.ts`'s `addEmailJob` writes into Redis is
 * actually picked up and processed by a real BullMQ Worker
 * (`email.worker.ts`) — enqueue, Worker pulls the job, real `sendMail`,
 * real Mailpit delivery / real `email_logs` row. The PII constraint (the
 * worker must not put PII in the thrown error message) is proven here, not
 * just in `tests/unit/workers/email.worker.test.ts`: the unit test only
 * proves the Error `processEmailJob` throws in-process, not what BullMQ
 * itself wrote to Redis's own `failedReason` field, a second, independent
 * serialization step. Runs under this worker's own `REDIS_KEY_PREFIX`
 * (`tests/helpers/setup-global.ts`), so jobs this file adds never collide
 * with another vitest worker's keyspace.
 */
import { randomUUID } from 'node:crypto'
import { Job, type Worker } from 'bullmq'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getMailTransporter } from '@/configs/mailer.config'
import { addEmailJob, type EmailJobData } from '@/jobs/email.job'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { closeQueue, getEmailQueue } from '@/services/queue.service'
import { startEmailWorker } from '@/workers/email.worker'
import { deleteMailpitMessage, findMailpitMessages } from '../../helpers/mailpit'
import { withMutatedMethod } from '../../helpers/mutate'
import { waitForLoggedCall } from '../../helpers/queue-jobs'

const emailLogRepository = new EmailLogRepository()

/**
 * A disposable recipient address, unique to one test.
 * @param label - Names the case, embedded in the address.
 * @returns A unique `@example.test` address.
 */
function uniqueRecipient(label: string): string {
  return `email-worker-${label}-${randomUUID()}@example.test`
}

/**
 * A real, valid `password_reset` message body for one recipient.
 * @param to - The recipient.
 * @returns The `addEmailJob` payload.
 */
function passwordResetMessage(to: string): Parameters<typeof addEmailJob>[0] {
  return {
    to,
    templateKey: 'password_reset',
    variables: {
      firstName: 'Ada',
      resetUrl: `https://example.test/reset?token=${randomUUID()}`,
      appName: 'Test App',
    },
  }
}

/**
 * Nodemailer's own `sendMail` is an overloaded method, so a stub needs this
 * cast to stand in for it (same reasoning as
 * `tests/integration/services/mailer.service.test.ts`'s `StubbedSendMail`).
 */
type StubbedSendMail = (mailOptions: unknown) => Promise<never>

const rejectWithConnectionError: StubbedSendMail = () => {
  const error = Object.assign(new Error('Connection refused'), { code: 'ECONNECTION' })
  return Promise.reject(error)
}

/**
 * `updateData` swapped on the prototype to record which attempt scrubbed,
 * declared with a `this` type, as `worker-outage.test.ts` does for Worker.
 */
type JobInternals = { updateData: (this: Job, data: unknown) => Promise<void> }
const jobPrototype = Job.prototype as unknown as JobInternals
const originalUpdateData = jobPrototype.updateData

/**
 * Wait for one specific job id to reach a terminal state on `worker`.
 * Scoped to a single job id, not "the next completed/failed event", so two
 * tests running their own job through the same shared Worker instance can
 * never resolve each other's promise.
 * @param worker - The Worker to listen on.
 * @param jobId - The job to watch.
 * @returns Which event fired first for that job.
 */
function waitForJobSettled(
  worker: Worker<EmailJobData>,
  jobId: string
): Promise<'completed' | 'failed'> {
  return new Promise((resolve) => {
    const onCompleted = (job: Job<EmailJobData>): void => {
      if (job.id !== jobId) return
      cleanup()
      resolve('completed')
    }
    const onFailed = (job: Job<EmailJobData> | undefined): void => {
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

describe('email.worker', () => {
  const worker = startEmailWorker()
  const createdLogIds: string[] = []

  afterAll(async () => {
    if (createdLogIds.length > 0) {
      await sql`delete from email_logs where id = any(${createdLogIds})`
    }
    // worker.close() first drains the current job; closeQueue()'s connection.quit() is what actually closes the socket, since BullMQ skips quitting a connection it was handed pre-built.
    await worker.close()
    // Left-over jobs from this run would otherwise sit under this worker's prefix and be picked up by the very next run's worker on start.
    await getEmailQueue().obliterate({ force: true })
    await closeQueue()
  })

  it('processes a real enqueued job end to end: sends via Mailpit and records it as sent', async () => {
    const recipient = uniqueRecipient('happy-path')
    const job = await addEmailJob(passwordResetMessage(recipient), 'user-happy-path')
    if (!job.id) throw new Error('expected addEmailJob to assign a job id')

    await expect(waitForJobSettled(worker, job.id)).resolves.toBe('completed')

    const messages = await findMailpitMessages(recipient)
    expect(messages).toHaveLength(1)
    if (messages[0]) await deleteMailpitMessage(messages[0].ID)

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows[0]?.status).toBe('sent')
  }, 15_000)

  it("fails a job whose send fails, and never leaks the recipient into BullMQ's own failedReason", async () => {
    const transporter = getMailTransporter()
    const recipient = uniqueRecipient('failure-path')

    await withMutatedMethod(
      transporter,
      'sendMail',
      rejectWithConnectionError as (typeof transporter)['sendMail'],
      async () => {
        // attempts: 1 — this asserts the terminal failed state, not the retry schedule (emailJobDefaults' own defaults are exercised by inspection, not by waiting through them here).
        const job = await addEmailJob(passwordResetMessage(recipient), 'user-failure-path', {
          attempts: 1,
        })
        if (!job.id) throw new Error('expected addEmailJob to assign a job id')

        await expect(waitForJobSettled(worker, job.id)).resolves.toBe('failed')

        // The load-bearing assertion: what BullMQ itself persisted to Redis as failedReason, not merely the Error thrown in-process.
        const failedJob = await getEmailQueue().getJob(job.id)
        expect(failedJob?.failedReason).toBeDefined()
        expect(failedJob?.failedReason).not.toContain(recipient)
        expect(failedJob?.failedReason).toContain(job.id)
      }
    )

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows[0]?.status).toBe('failed')
  }, 15_000)

  it('scrubs the stored job and logs one error only after its last attempt', async () => {
    const transporter = getMailTransporter()
    const recipient = uniqueRecipient('scrub')
    const token = randomUUID()
    const scrubs: { jobId: string | undefined; attemptsMade: number }[] = []
    function recordingUpdateData(this: Job, data: unknown): Promise<void> {
      scrubs.push({ jobId: this.id, attemptsMade: this.attemptsMade })
      return originalUpdateData.call(this, data)
    }
    const loggerError = vi.spyOn(logger, 'error')
    const loggerWarn = vi.spyOn(logger, 'warn')

    try {
      await withMutatedMethod(
        transporter,
        'sendMail',
        rejectWithConnectionError as (typeof transporter)['sendMail'],
        async () => {
          await withMutatedMethod(jobPrototype, 'updateData', recordingUpdateData, async () => {
            const job = await addEmailJob(
              {
                to: recipient,
                templateKey: 'password_reset',
                variables: {
                  firstName: 'Ada',
                  resetUrl: `https://example.test/reset?token=${token}`,
                  appName: 'Test App',
                },
              },
              'user-scrub',
              { attempts: 2, backoff: { type: 'fixed', delay: 10 } }
            )
            if (!job.id) throw new Error('expected addEmailJob to assign a job id')
            const jobId = job.id

            await waitForLoggedCall(
              loggerError,
              (message, meta) => message === 'job failed permanently' && meta?.jobId === jobId,
              10_000
            )

            const stored = await getEmailQueue().getJob(jobId)
            expect(stored?.attemptsMade).toBe(2)
            expect(stored?.data).toMatchObject({
              templateKey: 'password_reset',
              variables: { firstName: 'Ada', resetUrl: '[redacted]', appName: 'Test App' },
            })
            expect(JSON.stringify(stored?.data)).not.toContain(token)
            // The first, retryable attempt did not scrub: the retry needed the link.
            expect(scrubs.filter((scrub) => scrub.jobId === jobId)).toEqual([
              { jobId, attemptsMade: 2 },
            ])
            expect(
              loggerError.mock.calls
                .filter(([, meta]) => meta?.jobId === jobId)
                .map(([message]) => message)
            ).toEqual(['job failed permanently'])
            expect(loggerError).toHaveBeenCalledWith(
              'job failed permanently',
              expect.objectContaining({
                queue: 'email',
                jobId,
                name: 'password_reset',
                template: 'password_reset',
                userId: 'user-scrub',
                attemptsMade: 2,
              })
            )
            expect(
              loggerWarn.mock.calls.filter(
                ([message, meta]) => message === 'Email job failed' && meta?.jobId === jobId
              )
            ).toHaveLength(1)
          })
        }
      )
    } finally {
      loggerError.mockRestore()
      loggerWarn.mockRestore()
    }

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
  }, 20_000)

  /**
   * An unlistened 'error' event on an EventEmitter crashes the process, so
   * this proves the listener is actually attached and routes to the
   * logger, not merely present in source.
   */
  it("worker.on('error') logs instead of crashing the process", () => {
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {
      // No-op: only the call itself is asserted below.
    })
    try {
      const syntheticError = new Error('synthetic worker error')
      worker.emit('error', syntheticError)
      expect(loggerErrorSpy).toHaveBeenCalledWith('Email worker error', { error: syntheticError })
    } finally {
      loggerErrorSpy.mockRestore()
    }
  })
})
