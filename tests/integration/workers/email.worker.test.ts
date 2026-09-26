// tests/integration/workers/email.worker.test.ts
//
// Integration test against the real Redis, Mailpit, and per-worker Postgres
// started by docker-compose — proves the whole path email.job.ts's
// addEmailJob writes into Redis is actually picked up and processed by a
// real BullMQ Worker (email.worker.ts): enqueue -> Worker pulls the job ->
// real sendMail -> real Mailpit delivery / real email_logs row.
//
// The PII constraint from task-2-brief.md ("the worker MUST NOT put PII in
// the thrown error message — BullMQ persists failedReason in Redis") is
// proven here, not just in tests/unit/workers/email.worker.test.ts: the
// unit test only proves the Error object processEmailJob throws in-process;
// it says nothing about what BullMQ actually wrote to Redis's own
// `failedReason` field, which is a second, independent serialization step.
// Same "a compile-time/in-process guarantee is not a runtime one until
// something also checks it there" ethos as mailer.service.ts's own header
// comment.
//
// Runs under this worker's own REDIS_KEY_PREFIX (tests/helpers/setup-global.ts
// sets `test-w${VITEST_POOL_ID}`), same as
// tests/integration/services/queue.service.test.ts, so jobs this file adds
// never collide with another vitest worker's keyspace.
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

// A disposable recipient address, unique to one test — same shape as
// tests/integration/services/mailer.service.test.ts's own helper.
function uniqueRecipient(label: string): string {
  return `email-worker-${label}-${randomUUID()}@example.test`
}

// A real, valid password_reset message body for one recipient.
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

// Nodemailer's own sendMail is an overloaded method — see
// tests/integration/services/mailer.service.test.ts's identical comment on
// StubbedSendMail for why the cast below is required to stub it.
type StubbedSendMail = (mailOptions: unknown) => Promise<never>

const rejectWithConnectionError: StubbedSendMail = () => {
  const error = Object.assign(new Error('Connection refused'), { code: 'ECONNECTION' })
  return Promise.reject(error)
}

// updateData is swapped on the prototype to record which attempt scrubbed.
// Declared with a `this` type, as worker-outage.test.ts does for Worker.
type JobInternals = { updateData: (this: Job, data: unknown) => Promise<void> }
const jobPrototype = Job.prototype as unknown as JobInternals
const originalUpdateData = jobPrototype.updateData

// Wait for one specific job id to reach a terminal state on `worker`,
// resolving with which event fired. Scoped to a single job id (not "the
// next completed/failed event") so two tests running their own job through
// the same shared Worker instance can never resolve each other's promise.
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
    // Worker shutdown ordering per task-1-report.md's own forward note:
    // worker.close() first (drains the current job), then the queue, then
    // the shared connection — closeQueue()'s own connection.quit() is what
    // actually closes the socket, since BullMQ never quits a connection it
    // was handed pre-built (Task 1's "shared connection" finding).
    await worker.close()
    // Left-over jobs from this file (or an earlier run against this same
    // shared compose Redis) would otherwise sit under this worker's prefix
    // and be picked up by the very next test run's worker on start —
    // mirrors queue.service.test.ts's own reasoning for the identical call.
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
        // attempts: 1 — this test asserts the terminal failed state, not
        // the retry schedule (emailJobDefaults' own 5 attempts / 75s of
        // exponential backoff is exercised by inspection of
        // email.job.ts's own defaults, not by waiting through it here).
        const job = await addEmailJob(passwordResetMessage(recipient), 'user-failure-path', {
          attempts: 1,
        })
        if (!job.id) throw new Error('expected addEmailJob to assign a job id')

        await expect(waitForJobSettled(worker, job.id)).resolves.toBe('failed')

        // The load-bearing assertion: what BullMQ itself persisted to
        // Redis as failedReason, not merely the Error thrown in-process
        // (tests/unit/workers/email.worker.test.ts already covers that
        // half) — proving the PII constraint holds after BullMQ's own
        // serialization, too.
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

  // An unlistened 'error' event on an EventEmitter crashes the process
  // (email.worker.ts's own comment on why worker.on('error', ...) is
  // mandatory) — this proves the listener is actually attached and routes
  // to the logger, rather than merely existing in source with nothing ever
  // exercising it (this repo's own standard for what counts as tested; see
  // mailer.service.ts's callFramesOf comment on the same theme).
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
