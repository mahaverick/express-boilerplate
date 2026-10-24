/**
 * @file The billing queue's jobs: one per Razorpay webhook event, and a sync
 * of one workspace. Each job carries ids only, never a payload body, an
 * address or card details. A webhook job's id is derived from its stored
 * event, so a second delivery of the same event queues nothing new while the
 * first job is still on the queue.
 */
import type { JobsOptions } from 'bullmq'
import { addJob, getBillingQueue } from '@/services/queue.service'

/**
 * The job that handles one stored Razorpay webhook event.
 */
export const BILLING_WEBHOOK_JOB = 'webhook'

/**
 * The job that syncs one workspace with its provider subscriptions.
 */
export const BILLING_SYNC_TENANT_JOB = 'sync-tenant'

/**
 * A webhook job's payload: the stored event and the ids its body named.
 */
export interface BillingWebhookJobData {
  /**
   * The `billing_events` row.
   */
  eventRowId: string
  /**
   * Razorpay's event id, from the `x-razorpay-event-id` header.
   */
  providerEventId: string
  /**
   * The event type, such as `subscription.charged`.
   */
  eventType: string
  /**
   * The subscription the event names, when it names one.
   */
  subscriptionId: string | null
  /**
   * The payment the event names, when it names one: a dispute or a refund
   * reaches its subscription only through it.
   */
  paymentId: string | null
}

/**
 * A sync job's payload.
 */
export interface BillingSyncTenantJobData {
  /**
   * The workspace to sync.
   */
  tenantId: string
}

/**
 * Options for every billing job. A failed sync changes nothing, so a retry
 * is always safe: eight attempts with backoff doubling from 30 s span about
 * an hour of a provider outage (30 s × 127). Failed jobs are kept a week.
 */
const BILLING_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
} as const satisfies JobsOptions

/**
 * Queue the job for one stored webhook event. Its job id is the event row's,
 * so queueing the same event again while its job exists adds nothing.
 * @param data - The stored event and the ids its body named.
 * @returns Resolves once the job is in Redis.
 */
export async function addBillingWebhookJob(data: BillingWebhookJobData): Promise<void> {
  await addJob(getBillingQueue(), BILLING_WEBHOOK_JOB, data, {
    ...BILLING_JOB_OPTIONS,
    jobId: `webhook-${data.eventRowId}`,
  })
}
