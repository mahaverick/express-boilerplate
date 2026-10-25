/**
 * @file The Worker for the "billing" queue: handles each stored Razorpay
 * webhook event, syncs a workspace on request, cancels for a workspace just
 * suspended or archived, pushes a staff plan or grace edit to the open apps
 * of the workspaces it changed, and runs the frequent and
 * daily scheduler runs, two jobs at a time.
 * A retryable provider error (a timeout, a network failure, a 5xx or a 429)
 * is retried for about 24 hours, Razorpay's own webhook retry window; any
 * other failure, such as a sync that kept meeting a concurrent write, for
 * about an hour; a provider refusal that a retry cannot change fails the
 * job at once. A webhook job that fails for good marks its event failed and
 * alerts staff.
 */
import { UnrecoverableError, Worker, type Job } from 'bullmq'
import { ProviderError } from '@/errors/billing-provider-errors'
import {
  BILLING_BACKOFF_TYPE,
  BILLING_LIFECYCLE_CANCEL_JOB,
  BILLING_OTHER_FAILURE_ATTEMPTS,
  BILLING_PUBLISH_ENTITLEMENTS_JOB,
  BILLING_SCHEDULER_DAILY_JOB,
  BILLING_SCHEDULER_FREQUENT_JOB,
  BILLING_SYNC_TENANT_JOB,
  BILLING_WEBHOOK_JOB,
  billingRetryDelay,
  type BillingLifecycleCancelJobData,
  type BillingPublishEntitlementsJobData,
  type BillingSyncTenantJobData,
  type BillingWebhookJobData,
} from '@/jobs/billing.job'
import {
  isTerminalFailure,
  recordPermanentFailure,
  reportFinalJobFailure,
} from '@/jobs/job-failure.job'
import {
  runDailyBilling,
  runFrequentBilling,
  runLifecycleCancelFor,
} from '@/services/billing/billing-scheduler.service'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import {
  processBillingWebhookEvent,
  recordWebhookJobFailure,
} from '@/services/billing/billing-webhook.service'
import { logger } from '@/services/logger.service'
import { publishEntitlementsChange } from '@/services/platform-billing.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'

/**
 * Run one job's work, turning a failure that should not be retried into
 * `UnrecoverableError`, so BullMQ stops at once: a provider refusal a retry
 * cannot change, and any failure but a retryable provider error once the
 * job has had `BILLING_OTHER_FAILURE_ATTEMPTS`. A retryable provider error
 * is rethrown for the retry until the job's own attempts run out.
 * @param job - The job, for its attempt count.
 * @param work - The job's work.
 * @returns Resolves once the work is done.
 * @throws {UnrecoverableError} For a non-retryable failure, with it as the cause.
 */
async function withRetryPolicy(job: Job, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    const isProviderOutage = error instanceof ProviderError && error.retryable
    const attempt = job.attemptsMade + 1
    if (
      (error instanceof ProviderError && !error.retryable) ||
      (!isProviderOutage && attempt >= BILLING_OTHER_FAILURE_ATTEMPTS)
    ) {
      const unrecoverable = new UnrecoverableError(
        error instanceof Error ? error.message : 'A billing job failed'
      )
      unrecoverable.cause = error
      throw unrecoverable
    }
    throw error
  }
}

/**
 * Process one billing job. Exported for testing.
 * @param job - The job: a `webhook` job carries a stored event, a `sync-tenant` or `lifecycle-cancel` job a workspace, a `publish-entitlements` job a staff edit, a scheduler job nothing.
 * @returns Resolves once the job's work is done.
 * @throws {UnrecoverableError} For a job name this worker has no handler for, or a provider refusal.
 * @throws {Error} A retryable failure, so BullMQ retries.
 */
export async function processBillingJob(job: Job): Promise<void> {
  switch (job.name) {
    case BILLING_WEBHOOK_JOB: {
      const data = job.data as BillingWebhookJobData
      await withRetryPolicy(job, () => processBillingWebhookEvent(data))
      return
    }
    case BILLING_SYNC_TENANT_JOB: {
      const data = job.data as BillingSyncTenantJobData
      await withRetryPolicy(job, () =>
        syncTenantBilling(data.tenantId, data.source ?? 'job', {
          extraSubscriptionIds: data.extraSubscriptionIds ?? [],
        })
      )
      return
    }
    case BILLING_LIFECYCLE_CANCEL_JOB: {
      const data = job.data as BillingLifecycleCancelJobData
      await withRetryPolicy(job, () => runLifecycleCancelFor(data.tenantId))
      return
    }
    case BILLING_PUBLISH_ENTITLEMENTS_JOB: {
      await withRetryPolicy(job, () =>
        publishEntitlementsChange(job.data as BillingPublishEntitlementsJobData)
      )
      return
    }
    case BILLING_SCHEDULER_FREQUENT_JOB: {
      await runFrequentBilling()
      return
    }
    case BILLING_SCHEDULER_DAILY_JOB: {
      await runDailyBilling()
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
    settings: {
      backoffStrategy: (attemptsMade: number, type?: string) =>
        type === BILLING_BACKOFF_TYPE ? billingRetryDelay(attemptsMade) : -1,
    },
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
