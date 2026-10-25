/**
 * @file The Worker for the "billing" queue: handles each stored Razorpay
 * webhook event, syncs a workspace on request, cancels for a workspace just
 * suspended or archived, pushes a staff plan or grace edit to the open apps
 * of the workspaces it changed, and runs the frequent and
 * daily scheduler runs, two jobs at a time.
 * A retryable provider error (a timeout, a network failure, a 5xx or a 429)
 * is retried for about 24 hours, Razorpay's own webhook retry window, and
 * staff get one "still retrying" alert about an hour in. Any other failure,
 * such as a sync that kept meeting a concurrent write, is counted on its own
 * and stops the job at the eighth, about an hour after the first; a provider
 * refusal that a retry cannot change fails the job at once. A webhook job
 * that fails for good marks its event failed and alerts staff.
 */
import { UnrecoverableError, Worker, type Job } from 'bullmq'
import { ProviderError } from '@/errors/billing-provider-errors'
import {
  BILLING_LIFECYCLE_CANCEL_JOB,
  BILLING_OTHER_FAILURE_ATTEMPTS,
  BILLING_OUTAGE_ALERT_FAILURES,
  BILLING_PUBLISH_ENTITLEMENTS_JOB,
  BILLING_SCHEDULER_DAILY_JOB,
  BILLING_SCHEDULER_FREQUENT_JOB,
  BILLING_SYNC_TENANT_JOB,
  BILLING_WEBHOOK_JOB,
  billingRetryDelay,
  type BillingLifecycleCancelJobData,
  type BillingPublishEntitlementsJobData,
  type BillingRetryCounts,
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
  recordProviderOutageRetrying,
  recordWebhookJobFailure,
} from '@/services/billing/billing-webhook.service'
import { logger } from '@/services/logger.service'
import { publishEntitlementsChange } from '@/services/platform-billing.service'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'

/**
 * Store a job's failure counts for its next attempt. A failed write is
 * logged and the retry still happens; the count then starts lower.
 * @param job - The job.
 * @param counts - The counts after this failure.
 */
async function storeRetryCounts(job: Job, counts: BillingRetryCounts): Promise<void> {
  try {
    await job.updateData({ ...(job.data as object), ...counts })
  } catch (error) {
    logger.warn('Could not store a billing job retry count', { jobId: job.id, error })
  }
}

/**
 * Run one job's work and decide what a failure means. A provider refusal a
 * retry cannot change becomes `UnrecoverableError`, so BullMQ stops at once.
 * A provider outage (a retryable `ProviderError`) is rethrown for the retry
 * until the job's attempts run out, and its `BILLING_OUTAGE_ALERT_FAILURES`th
 * one alerts staff once. Any other failure is counted in the job's
 * `otherFailures`, and its `BILLING_OTHER_FAILURE_ATTEMPTS`th becomes
 * `UnrecoverableError`, however many outage failures came before.
 * @param job - The job, whose data carries the failure counts.
 * @param work - The job's work.
 * @returns Resolves once the work is done.
 * @throws {UnrecoverableError} For a failure that should not be retried, with it as the cause.
 */
async function withRetryPolicy(job: Job, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    const counts = job.data as BillingRetryCounts
    if (error instanceof ProviderError && error.retryable) {
      const outageFailures = (counts.outageFailures ?? 0) + 1
      await storeRetryCounts(job, { outageFailures })
      if (outageFailures === BILLING_OUTAGE_ALERT_FAILURES) {
        await recordProviderOutageRetrying(job)
      }
      throw error
    }
    const otherFailures = (counts.otherFailures ?? 0) + 1
    if (
      (error instanceof ProviderError && !error.retryable) ||
      otherFailures >= BILLING_OTHER_FAILURE_ATTEMPTS
    ) {
      const unrecoverable = new UnrecoverableError(
        error instanceof Error ? error.message : 'A billing job failed'
      )
      unrecoverable.cause = error
      throw unrecoverable
    }
    await storeRetryCounts(job, { otherFailures })
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
      // Never -1: that fails a job short of its attempts, which skips the final-failure handling.
      backoffStrategy: (attemptsMade: number) => billingRetryDelay(attemptsMade),
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
