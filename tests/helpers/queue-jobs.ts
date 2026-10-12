/**
 * @file Reads jobs straight off the BullMQ queues, for test files that
 * start no Worker, waits for a Worker's log line, and waits for a job to settle. `'prioritized'` is a
 * job state included in every read here: email and notification jobs carry
 * a priority, and BullMQ keeps them there until a Worker pulls them.
 */
import { randomUUID } from 'node:crypto'
import { Job, type Queue, type Worker } from 'bullmq'
import { expect, type MockInstance } from 'vitest'
import type { EmailJobData } from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { addJob, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { EMAIL_VERIFICATION_TEMPLATE_KEY } from '@/templates/email/email-verification.template'
import {
  TENANT_INVITATION_TEMPLATE_KEY,
  type TenantInvitationVariables,
} from '@/templates/email/tenant-invitation.template'
import { settle } from './timing'

const JOB_STATES = ['waiting', 'active', 'completed', 'delayed', 'prioritized'] as const
const POLL_INTERVAL_MS = 25
const DEFAULT_TIMEOUT_MS = 5000

/**
 * Every job on `queue` that is waiting, active, completed, delayed or prioritized, typed as `TData`.
 * @param queue - The queue to read.
 * @returns The jobs.
 */
export async function queuedJobs<TData>(queue: Queue): Promise<Job<TData>[]> {
  return queue.getJobs([...JOB_STATES]) as Promise<Job<TData>[]>
}

/**
 * Poll `queue` until a job whose data matches appears.
 * @param queue - The queue to read.
 * @param isMatch - Which job to wait for.
 * @param timeoutMs - How long to poll before failing.
 * @returns The first matching job.
 * @throws {Error} When no job matches within `timeoutMs`.
 */
export async function waitForJob<TData>(
  queue: Queue,
  isMatch: (data: TData) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Job<TData>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const jobs = await queuedJobs<TData>(queue)
    const match = jobs.find((job) => isMatch(job.data))
    if (match) return match
    await settle(POLL_INTERVAL_MS, 'poll interval')
  }
  throw new Error(`waitForJob: no matching job on "${queue.name}" within ${timeoutMs}ms`)
}

/**
 * Assert that no job on `queue` matches. It first adds and removes a sentinel
 * job, so every add issued before it has reached Redis when the queue is read.
 *
 * Call it only after observing another job the action enqueues in the same
 * synchronous step as the one that must not exist (every caller waits for the
 * invitation email first), so that job's add was issued before the sentinel's.
 * @param queue - The queue to read. No Worker may consume it.
 * @param isMatch - The job that must not exist.
 */
export async function expectNoJob<TData>(
  queue: Queue,
  isMatch: (data: TData) => boolean
): Promise<void> {
  // One Queue on one connection: an add issued before this one reaches Redis first.
  const sentinel = await addJob(queue, 'expect-no-job-sentinel', { sentinel: randomUUID() })
  await sentinel.remove()
  const jobs = await queuedJobs<TData>(queue)
  expect(jobs.some((job) => isMatch(job.data))).toBe(false)
}

/**
 * Poll a logger spy until one of its calls matches. A Worker's 'failed'
 * handler scrubs and logs after the event that settles a job, so a test that
 * reads the scrubbed job waits for the log line, not the event.
 * @param spy - A `vi.spyOn(logger, level)` spy.
 * @param isMatch - Which call to wait for, given its message and meta.
 * @param timeoutMs - How long to poll before failing.
 * @returns Resolves once a matching call has been made.
 * @throws {Error} When no call matches within `timeoutMs`.
 */
export async function waitForLoggedCall(
  spy: MockInstance<(message: string, meta?: Record<string, unknown>) => void>,
  isMatch: (message: string, meta: Record<string, unknown> | undefined) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (spy.mock.calls.some(([message, meta]) => isMatch(message, meta))) return
    await settle(POLL_INTERVAL_MS, 'poll interval')
  }
  throw new Error(`waitForLoggedCall: no matching log call within ${timeoutMs}ms`)
}

/**
 * The raw token in an invitation email job's accept link.
 * @param data - An email job's payload.
 * @returns The token, or an empty string for any other template.
 */
function acceptTokenOf(data: EmailJobData): string {
  if (data.templateKey !== TENANT_INVITATION_TEMPLATE_KEY) return ''
  return new URL(data.variables.acceptUrl).searchParams.get('token') ?? ''
}

/**
 * An invitation email as it sits on the email queue.
 */
export interface QueuedInvitationEmail {
  /**
   * The correlation id: the invitee's user id, or '' with no account.
   */
  userId: string
  /**
   * The template variables, exactly as enqueued.
   */
  variables: TenantInvitationVariables
  /**
   * The raw token from the accept link.
   */
  token: string
}

/**
 * Poll the email queue for an invitation email to `to` whose token is not one already seen.
 * @param to - The recipient address.
 * @param excludedTokens - Tokens from earlier emails to skip (e.g. before a resend).
 * @returns The queued email.
 */
export async function waitForInvitationEmail(
  to: string,
  excludedTokens: readonly string[] = []
): Promise<QueuedInvitationEmail> {
  const { data } = await waitForJob<EmailJobData>(
    getEmailQueue(),
    (candidate) =>
      candidate.to === to &&
      candidate.templateKey === TENANT_INVITATION_TEMPLATE_KEY &&
      !excludedTokens.includes(acceptTokenOf(candidate))
  )
  if (data.templateKey !== TENANT_INVITATION_TEMPLATE_KEY) {
    throw new Error('waitForInvitationEmail: matched a job of another template')
  }
  return { userId: data.userId, variables: data.variables, token: acceptTokenOf(data) }
}

/**
 * Poll the notification queue for the `verify_email` job registration
 * enqueues for `userId`, and return the raw token from its verification link.
 * @param userId - The registered user.
 * @returns The raw email-verification token.
 */
export async function waitForVerificationToken(userId: string): Promise<string> {
  const job = await waitForJob<NotificationJobData>(
    getNotificationQueue(),
    (data) => data.userId === userId && data.type === 'verify_email'
  )
  const { email } = job.data
  if (email?.templateKey !== EMAIL_VERIFICATION_TEMPLATE_KEY) {
    throw new Error('waitForVerificationToken: the job carries no verification email')
  }
  const token = new URL(email.variables.verificationUrl).searchParams.get('token')
  if (!token) throw new Error('waitForVerificationToken: the link carries no token')
  return token
}

/**
 * Resolves with `'completed'` or `'failed'` once the job `jobId` settles on `worker`, including
 * a job that settled before this call. The listeners attach first, then the job's current state
 * is read from `queue`, so a settle in the gap between `addJob` resolving and this call is
 * seen, not missed. It is scoped to one job id, so two tests sharing a Worker never resolve each
 * other's promise, and it detaches both listeners when it settles.
 *
 * A `jobId` missing from `queue` resolves `'completed'` at once, because the queues remove
 * completed jobs and keep failed ones. Callers must pass the id `addJob` returned. A job that failed with
 * attempts left is waiting or delayed, not failed, so the wait continues for its final outcome.
 * @param worker - The Worker running the job.
 * @param queue - The queue the Worker consumes, to read the job's current state.
 * @param jobId - The id `addJob` returned.
 * @returns How the job settled.
 */
export function waitForJobSettled<TData>(
  worker: Worker<TData>,
  queue: Queue,
  jobId: string
): Promise<'completed' | 'failed'> {
  return new Promise((resolve, reject) => {
    /**
     * Resolves the wait as 'completed' for `jobId`; other jobs on the shared Worker are ignored.
     */
    const onCompleted = (job: Job<TData>): void => {
      if (job.id !== jobId) return
      cleanup()
      resolve('completed')
    }
    /**
     * Resolves the wait as 'failed' for `jobId` on its final attempt; other jobs on the shared Worker are ignored.
     */
    const onFailed = (job: Job<TData> | undefined): void => {
      if (job?.id !== jobId) return
      // A failed attempt with attempts left is retried, not settled; BullMQ counts the attempt before it emits `failed`.
      if (job.attemptsMade < (job.opts.attempts ?? 1)) return
      cleanup()
      resolve('failed')
    }
    /**
     * Detaches both listeners, so a settled wait leaves nothing registered on the Worker.
     */
    const cleanup = (): void => {
      worker.off('completed', onCompleted)
      worker.off('failed', onFailed)
    }
    worker.on('completed', onCompleted)
    worker.on('failed', onFailed)
    // After attaching: a job that settled earlier fires no further event, so read where it stands.
    /**
     * Resolves the wait when the job already stands completed or failed; rejects when the read fails.
     */
    const checkCurrentState = async (): Promise<void> => {
      try {
        const job = await Job.fromId(queue, jobId)
        const state = job ? await job.getState() : 'completed'
        if (state !== 'completed' && state !== 'failed') return
        cleanup()
        resolve(state)
      } catch (error) {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    void checkCurrentState()
  })
}
