// tests/helpers/queue-jobs.ts
//
// Read jobs straight off the BullMQ queues, for test files that start no
// Worker. 'prioritized' is included: email and notification jobs carry a
// priority, and BullMQ keeps them there until a Worker pulls them.
import type { Job, Queue } from 'bullmq'
import { expect } from 'vitest'
import type { EmailJobData } from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { EMAIL_VERIFICATION_TEMPLATE_KEY } from '@/templates/email/email-verification.template'
import {
  TENANT_INVITATION_TEMPLATE_KEY,
  type TenantInvitationVariables,
} from '@/templates/email/tenant-invitation.template'

const JOB_STATES = ['waiting', 'active', 'completed', 'delayed', 'prioritized'] as const
const POLL_INTERVAL_MS = 25
const DEFAULT_TIMEOUT_MS = 5000
// How long `expectNoJob` waits for a fire-and-forget enqueue that should not happen.
const NO_JOB_SETTLE_MS = 300

/**
 * Resolve after `ms` milliseconds.
 * @param ms - How long to wait.
 * @returns A promise that resolves once the time has passed.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Every job currently on `queue` in a non-failed state, typed as `TData`.
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
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`waitForJob: no matching job on "${queue.name}" within ${timeoutMs}ms`)
}

/**
 * Wait `NO_JOB_SETTLE_MS`, then assert no job on `queue` matches. A
 * negative check against a fire-and-forget enqueue can only ever be
 * time-bounded.
 * @param queue - The queue to read.
 * @param isMatch - The job that must not exist.
 */
export async function expectNoJob<TData>(
  queue: Queue,
  isMatch: (data: TData) => boolean
): Promise<void> {
  await sleep(NO_JOB_SETTLE_MS)
  const jobs = await queuedJobs<TData>(queue)
  expect(jobs.some((job) => isMatch(job.data))).toBe(false)
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
 * Wait for an invitation email to `to` whose token is not one already seen.
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
 * Wait for the `verify_email` notification job registration enqueues for
 * `userId`, and return the raw token from its verification link.
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
