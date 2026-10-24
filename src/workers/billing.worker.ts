/**
 * @file The Worker for the "billing" queue: handles each stored Razorpay
 * webhook event and syncs a workspace on request, two jobs at a time.
 * A retryable provider error or a sync that kept meeting a concurrent write
 * throws for BullMQ's backoff; a provider refusal that a retry cannot change
 * fails the job at once. A webhook job that fails for good marks its event
 * failed and alerts staff.
 */
import { UnrecoverableError, Worker, type Job } from 'bullmq'
import { ProviderError } from '@/errors/billing-provider-errors'
import {
  BILLING_SYNC_TENANT_JOB,
  BILLING_WEBHOOK_JOB,
  type BillingSyncTenantJobData,
  type BillingWebhookJobData,
} from '@/jobs/billing.job'
import {
  isTerminalFailure,
  recordPermanentFailure,
  reportFinalJobFailure,
} from '@/jobs/job-failure.job'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import {
  processBillingWebhookEvent,
  recordWebhookJobFailure,
} from '@/services/billing/billing-webhook.service'
import { logger } from '@/services/logger.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'

/**
 * Run one job's work, turning a provider refusal a retry cannot change into
 * `UnrecoverableError`, so BullMQ stops at once. Every other error, a
 * retryable provider error or a sync conflict included, is rethrown for the retry.
 * @param work - The job's work.
 * @returns Resolves once the work is done.
 * @throws {UnrecoverableError} For a non-retryable `ProviderError`, with it as the cause.
 */
async function withRetryPolicy(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      const unrecoverable = new UnrecoverableError(error.message)
      unrecoverable.cause = error
      throw unrecoverable
    }
    throw error
  }
}

/**
 * Process one billing job. Exported for testing.
 * @param job - The job: a `webhook` job carries a stored event, a `sync-tenant` job a workspace.
 * @returns Resolves once the job's work is done.
 * @throws {UnrecoverableError} For a job name this worker has no handler for, or a provider refusal.
 * @throws {Error} A retryable failure, so BullMQ retries.
 */
export async function processBillingJob(job: Job): Promise<void> {
  switch (job.name) {
    case BILLING_WEBHOOK_JOB: {
      const data = job.data as BillingWebhookJobData
      await withRetryPolicy(() => processBillingWebhookEvent(data))
      return
    }
    case BILLING_SYNC_TENANT_JOB: {
      const data = job.data as BillingSyncTenantJobData
      await withRetryPolicy(() => syncTenantBilling(data.tenantId, 'job'))
      return
    }
    default: {
      throw new UnrecoverableError(`Unknown billing job ${job.name}`)
    }
  }
}

/**
 * Start the Worker for the billing queue, two jobs at a time. The 'failed'
 * handler never rejects: a retryable failure logs a warning, and the last
 * attempt calls `recordPermanentFailure` and, for a webhook job,
 * `recordWebhookJobFailure`.
 * @returns The running Worker instance (for graceful shutdown).
 */
export function startBillingWorker(): Worker {
  const worker = new Worker('billing', processBillingJob, {
    connection: getQueueConnection(),
    prefix: redisKey('bull'),
    concurrency: 2,
    lockDuration: 60_000,
  })

  worker.on('completed', (job) => {
    logger.info('Billing job completed', { jobId: job.id, name: job.name })
  })

  worker.on('failed', (job, error) => {
    const errorId = reportFinalJobFailure('billing', job, error)
    if (job === undefined || !isTerminalFailure(job, error)) {
      logger.warn('Billing job failed', {
        jobId: job?.id,
        name: job?.name,
        attempt: job?.attemptsMade,
        error,
      })
      return
    }
    void recordPermanentFailure('billing', job, error, errorId)
    if (job.name === BILLING_WEBHOOK_JOB) {
      void recordWebhookJobFailure(job.data as BillingWebhookJobData, error)
    }
  })

  worker.on('error', (error: unknown) => {
    logger.error('Billing worker error', { error })
  })

  return worker
}
