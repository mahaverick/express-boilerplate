/**
 * @file The billing queue's jobs: one per Razorpay webhook event, a sync of
 * one workspace, the push of an entitlements change after a staff plan or
 * grace edit, and the two scheduler runs: the frequent one every 15
 * minutes and the daily one at 03:30 UTC. Each job carries ids only, never a
 * payload body, an address or card details. A webhook job's id is derived
 * from its stored event, so a second delivery of the same event queues
 * nothing new while the first job is still on the queue. The schedulers live
 * in Redis under `REDIS_KEY_PREFIX`, so every replica that upserts them
 * shares one schedule.
 */
import type { JobSchedulerTemplateOptions, JobsOptions } from 'bullmq'
import type { PlanKey } from '@/constants/billing.constants'
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
 * The job that tells the open apps of every workspace a staff plan or grace
 * edit changed, a page at a time, after the edit answered.
 */
export const BILLING_PUBLISH_ENTITLEMENTS_JOB = 'publish-entitlements'

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
 * An entitlements push's payload: what the staff edit changed, and when.
 * Which workspaces it reaches is read when the job runs, by their effective
 * state at `at`.
 */
export type BillingPublishEntitlementsJobData =
  | {
      /**
       * A plan edit: every workspace whose effective plan is `planKey`.
       */
      change: 'plan'
      planKey: PlanKey
      /**
       * When the edit committed, as an ISO time.
       */
      at: string
    }
  | {
      /**
       * A grace change: every workspace whose effective state differs
       * between `fromDays` and `toDays` of grace.
       */
      change: 'grace'
      fromDays: number
      toDays: number
      /**
       * When the change committed, as an ISO time.
       */
      at: string
    }

/**
 * The name of the billing queue's backoff, which the billing Worker
 * implements with `billingRetryDelay`.
 */
export const BILLING_BACKOFF_TYPE = 'billing-capped-exponential'

/**
 * The first retry's wait; each later one doubles it.
 */
const BILLING_RETRY_BASE_MS = 30_000

/**
 * The longest wait between two attempts, so retries stay an hour apart at most.
 */
export const BILLING_RETRY_MAX_DELAY_MS = 3_600_000

/**
 * How many attempts a billing job gets while the provider times out, drops
 * the connection or answers 5xx or 429: the waits between them
 * (`billingRetryDelay`) add up to just over 24 hours, the time Razorpay
 * itself retries a webhook for.
 */
export const BILLING_JOB_ATTEMPTS = 31

/**
 * How many attempts a billing job gets for any other failure, such as a
 * sync that kept meeting a concurrent write or a database error: about an
 * hour of waits (30 s × 127), so a fault that a provider outage does not
 * explain reaches staff within the hour.
 */
export const BILLING_OTHER_FAILURE_ATTEMPTS = 8

/**
 * The wait before the next attempt of a billing job: 30 s doubling with
 * each failed attempt, capped at an hour.
 * @param attemptsMade - The attempts made so far, the one that just failed included (1 after the first).
 * @returns The wait in milliseconds.
 */
export function billingRetryDelay(attemptsMade: number): number {
  const doublings = Math.max(0, attemptsMade - 1)
  return Math.min(BILLING_RETRY_BASE_MS * 2 ** doublings, BILLING_RETRY_MAX_DELAY_MS)
}

/**
 * Options for every billing job. A failed sync changes nothing, so a retry
 * is always safe. A provider outage gets `BILLING_JOB_ATTEMPTS` with waits
 * from `billingRetryDelay`, about 24 hours; the Worker stops any other
 * failure after `BILLING_OTHER_FAILURE_ATTEMPTS`. Failed jobs are kept a week.
 */
const BILLING_JOB_OPTIONS = {
  attempts: BILLING_JOB_ATTEMPTS,
  backoff: { type: BILLING_BACKOFF_TYPE },
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
 * Queue the push of a staff plan or grace edit to the workspaces it changed.
 * It carries no job id, for the reason a sync carries none. A retry pushes
 * again, which only makes an open app read its entitlements once more.
 * @param data - What the edit changed, and when.
 * @returns Resolves once the job is in Redis.
 */
export async function addBillingPublishEntitlementsJob(
  data: BillingPublishEntitlementsJobData
): Promise<void> {
  await addJob(getBillingQueue(), BILLING_PUBLISH_ENTITLEMENTS_JOB, data, BILLING_JOB_OPTIONS)
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
 * Queue one frequent run now, besides the scheduled ones, for
 * `pnpm billing:time-travel`. Its options are a scheduled run's.
 * @returns Resolves once the job is in Redis.
 */
export async function addBillingFrequentRunJob(): Promise<void> {
  await addJob(getBillingQueue(), BILLING_SCHEDULER_FREQUENT_JOB, {}, billingSchedulerJobDefaults)
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
