/**
 * @file The billing queue's jobs: one per Razorpay webhook event, a sync of
 * one workspace, and the two scheduler runs: the frequent one every 15
 * minutes and the daily one at 03:30 UTC. Each job carries ids only, never a
 * payload body, an address or card details. A webhook job's id is derived
 * from its stored event, so a second delivery of the same event queues
 * nothing new while the first job is still on the queue. The schedulers live
 * in Redis under `REDIS_KEY_PREFIX`, so every replica that upserts them
 * shares one schedule.
 */
import type { JobSchedulerTemplateOptions, JobsOptions } from 'bullmq'
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
 * The job that cancels one suspended or archived workspace's subscriptions
 * now, instead of on the next frequent run.
 */
export const BILLING_LIFECYCLE_CANCEL_JOB = 'lifecycle-cancel'

/**
 * The frequent billing run's job name, and the id of its scheduler.
 */
export const BILLING_SCHEDULER_FREQUENT_JOB = 'scheduler-frequent'

/**
 * The daily billing run's job name, and the id of its scheduler.
 */
export const BILLING_SCHEDULER_DAILY_JOB = 'scheduler-daily'

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
  /**
   * The dispute a dispute event names, whose current status decides the flag.
   */
  disputeId: string | null
}

/**
 * A sync job's payload.
 */
export interface BillingSyncTenantJobData {
  /**
   * The workspace to sync.
   */
  tenantId: string
  /**
   * What asked for the sync, for the history; `job` when absent.
   */
  source?: 'job' | 'reconcile'
  /**
   * Subscriptions the reconcile found whose notes name this workspace but
   * that its row does not hold.
   */
  extraSubscriptionIds?: string[]
}

/**
 * A prompt cancel job's payload.
 */
export interface BillingLifecycleCancelJobData {
  /**
   * The workspace just suspended or archived.
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

/**
 * Queue a sync of one workspace. It carries no job id: a failed job is kept
 * a week, and a reused id would refuse the next day's sync.
 * @param data - The workspace, the source and any subscriptions the reconcile found.
 * @returns Resolves once the job is in Redis.
 */
export async function addBillingSyncJob(data: BillingSyncTenantJobData): Promise<void> {
  await addJob(getBillingQueue(), BILLING_SYNC_TENANT_JOB, data, BILLING_JOB_OPTIONS)
}

/**
 * Queue the prompt cancel of a workspace just suspended or archived. It
 * carries no job id, for the reason a sync carries none: a suspend's failed
 * job, kept a week, would refuse the archive that follows it.
 * @param data - The workspace.
 * @returns Resolves once the job is in Redis.
 */
export async function addBillingLifecycleCancelJob(
  data: BillingLifecycleCancelJobData
): Promise<void> {
  await addJob(getBillingQueue(), BILLING_LIFECYCLE_CANCEL_JOB, data, BILLING_JOB_OPTIONS)
}

/**
 * Options for every scheduler run. One attempt: each step catches its own
 * failure, and the next tick is the retry. The last 100 failures are kept.
 */
const billingSchedulerJobDefaults: JobSchedulerTemplateOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { count: 100 },
}

/**
 * Register the frequent run, every 15 minutes, and the daily run, at 03:30
 * UTC. Idempotent: every call upserts the same scheduler ids.
 * @returns Resolves once both schedulers and their next jobs are stored in Redis.
 */
export async function ensureBillingSchedules(): Promise<void> {
  const queue = getBillingQueue()
  await queue.upsertJobScheduler(
    BILLING_SCHEDULER_FREQUENT_JOB,
    { every: 15 * 60_000 },
    { name: BILLING_SCHEDULER_FREQUENT_JOB, opts: billingSchedulerJobDefaults }
  )
  await queue.upsertJobScheduler(
    BILLING_SCHEDULER_DAILY_JOB,
    { pattern: '30 3 * * *', tz: 'UTC' },
    { name: BILLING_SCHEDULER_DAILY_JOB, opts: billingSchedulerJobDefaults }
  )
}
