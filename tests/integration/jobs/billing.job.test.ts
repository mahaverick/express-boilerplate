/**
 * @file The billing queue end to end: a signed Razorpay delivery posted to
 * the app is queued, and the billing Worker runs the sync for it against a
 * fake Razorpay API. The state follows what the API reports, never the event;
 * a retryable provider error or a sync conflict leaves the event unprocessed
 * for BullMQ's retry; a subscription no row holds is adopted only when its
 * notes name an existing workspace in this environment; a row of another
 * provider is left alone; disputes set and clear a flag without changing the
 * state; a job that fails for good marks its event and raises one alert.
 */
import { randomUUID } from 'node:crypto'
import { UnrecoverableError, type Job, type Worker } from 'bullmq'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { BILLING_SYNC_TENANT_JOB, type BillingWebhookJobData } from '@/jobs/billing.job'
import { RazorpayProvider } from '@/services/billing/razorpay-provider.service'
import { sql } from '@/services/database.service'
import { closeQueue, getBillingQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import type { BillingProviderClient, ProviderSubscription } from '@/types/billing'
import { processBillingJob, startBillingWorker } from '@/workers/billing.worker'
import {
  billingColumn,
  deleteTrackedTenants,
  forgetProviderPlans,
  loadPlans,
  plans,
  readBilling,
  setBilling,
  workspace,
} from '../../helpers/billing-api'
import { startFakeRazorpay, type FakeRazorpay } from '../../helpers/fake-razorpay'
import { withMutatedMethod } from '../../helpers/mutate'
import { deleteTrackedUsers } from '../../helpers/platform-users'
import { queuedJobs } from '../../helpers/queue-jobs'
import {
  apiPaidInvoices,
  apiSubscription,
  razorpayTestProvider,
  signedWebhook,
  type WebhookRewrite,
} from '../../helpers/razorpay-fixtures'
import { request } from '../../helpers/request'
import { waitUntil } from '../../helpers/timing'

/**
 * Which provider the mocked `getBillingProvider` answers with.
 */
const providerState = vi.hoisted(() => ({
  current: undefined as BillingProviderClient | null | undefined,
}))

vi.mock('@/services/billing/billing-provider.service', () => ({
  getBillingProvider: () => providerState.current ?? null,
}))

const app = createApp()
const eventIds: string[] = []
const namedIds: string[] = []
let api: FakeRazorpay
let worker: Worker

/**
 * A stored event as the test reads it.
 */
interface EventRow {
  id: string
  tenant_id: string | null
  processed_at: string | null
  attempts: number
  error: string | null
}

/**
 * A fresh subscription id this file cleans up after.
 * @returns The id.
 */
function subscriptionId(): string {
  const id = `sub_TEST${randomUUID().replaceAll('-', '').slice(0, 12)}`
  namedIds.push(id)
  return id
}

/**
 * A fresh payment id this file cleans up after.
 * @returns The id.
 */
function paymentId(): string {
  const id = `pay_TEST${randomUUID().replaceAll('-', '').slice(0, 12)}`
  namedIds.push(id)
  return id
}

/**
 * Serve a subscription, and its paid invoice when it is active, from the fake API.
 * @param input - The subscription.
 * @param input.id - Its id.
 * @param input.tenantId - The workspace its notes name.
 * @param input.status - Its status; defaults to `active`.
 * @param input.appEnv - The environment its notes name.
 * @param input.paidCount - Its paid cycles.
 */
function serveSubscription(input: {
  id: string
  tenantId: string
  status?: string
  appEnv?: string
  paidCount?: number
}): void {
  const { json, currentStart } = apiSubscription({ ...input, priceId: plans.monthPriceId })
  api.reply('GET', `/subscriptions/${input.id}`, 200, json)
  api.reply('GET', '/invoices', 200, apiPaidInvoices(input.id, currentStart))
}

/**
 * Serve the payment-to-subscription lookup a dispute needs.
 * @param payment - The payment id.
 * @param subscription - The subscription its invoice belongs to.
 */
function servePayment(payment: string, subscription: string): void {
  const invoiceId = `inv_TEST${payment.slice(-8)}`
  api.reply('GET', `/payments/${payment}`, 200, { id: payment, invoice_id: invoiceId })
  api.reply('GET', `/invoices/${invoiceId}`, 200, { id: invoiceId, subscription_id: subscription })
}

/**
 * Post a signed fixture delivery to the app and return its stored event.
 * @param fixture - The fixture name.
 * @param rewrite - The ids to put in it.
 * @returns The stored event's id.
 */
async function deliver(fixture: string, rewrite: WebhookRewrite): Promise<string> {
  const delivery = signedWebhook(fixture, rewrite)
  eventIds.push(delivery.eventId)
  const response = await request(app)
    .post('/api/v1/webhooks/razorpay')
    .set(delivery.headers)
    .send(delivery.body)
  expect(response.status).toBe(200)
  const [row] = await sql<{ id: string }[]>`
    select id from billing_events where provider_event_id = ${delivery.eventId}`
  if (row === undefined) throw new Error('the delivery stored no event')
  return row.id
}

/**
 * A stored event.
 * @param id - Its id.
 * @returns The row.
 */
async function eventRow(id: string): Promise<EventRow> {
  const [row] = await sql<EventRow[]>`
    select id, tenant_id, processed_at, attempts, error from billing_events where id = ${id}`
  if (row === undefined) throw new Error('no such event')
  return row
}

/**
 * Wait until the Worker marked an event processed.
 * @param id - The stored event's id.
 * @returns The row.
 */
async function processed(id: string): Promise<EventRow> {
  return waitUntil(
    async () => {
      const row = await eventRow(id)
      return row.processed_at === null ? null : row
    },
    { message: 'the billing worker processes the event' }
  )
}

/**
 * The webhook job of a stored event.
 * @param eventRowId - The stored event's id.
 * @returns The job.
 */
async function jobOf(eventRowId: string): Promise<Job<BillingWebhookJobData>> {
  const jobs = await getBillingQueue().getJobs(['waiting', 'active', 'delayed', 'failed'])
  const job = (jobs as Job<BillingWebhookJobData>[]).find(
    (candidate) => candidate.data.eventRowId === eventRowId
  )
  if (job === undefined) throw new Error('no job for the event')
  return job
}

/**
 * Wait until a stored event's job has failed its first attempt and waits to retry.
 * @param eventRowId - The stored event's id.
 * @returns The job.
 */
async function retrying(eventRowId: string): Promise<Job<BillingWebhookJobData>> {
  return waitUntil(
    async () => {
      const jobs = await queuedJobs<BillingWebhookJobData>(getBillingQueue())
      const job = jobs.find((candidate) => candidate.data.eventRowId === eventRowId)
      if (job === undefined || job.attemptsMade < 1) return null
      return (await job.getState()) === 'delayed' ? job : null
    },
    { message: 'the job waits for its retry' }
  )
}

/**
 * The alerts of a kind whose message names a text.
 * @param kind - The alert kind.
 * @param text - The text.
 * @returns Each alert's tenant.
 */
function alertsNaming(kind: string, text: string) {
  return sql<{ tenant_id: string | null }[]>`
    select tenant_id from billing_alerts where kind = ${kind} and strpos(message, ${text}) > 0`
}

beforeAll(async () => {
  api = await startFakeRazorpay()
  providerState.current = razorpayTestProvider(api.baseUrl)
  await loadPlans()
  worker = startBillingWorker()
})

afterEach(async () => {
  api.reset()
  if (eventIds.length > 0) {
    await sql`delete from billing_events where provider_event_id = any(${eventIds})`
    eventIds.length = 0
  }
  for (const id of namedIds) await sql`delete from billing_alerts where strpos(message, ${id}) > 0`
  namedIds.length = 0
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await worker.close()
  await getBillingQueue().obliterate({ force: true })
  await closeQueue()
  await api.close()
  await forgetProviderPlans()
  await closeRedis()
})

describe('billing webhook jobs', () => {
  it('makes a workspace active when its checkout is charged', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    await setBilling(tenant.id, { pendingSubscriptionId: sub })
    serveSubscription({ id: sub, tenantId: tenant.id })

    const id = await deliver('webhook-subscription.charged-synthetic', {
      subscriptionId: sub,
      tenantId: tenant.id,
    })

    const row = await processed(id)
    expect(row).toMatchObject({ tenant_id: tenant.id, error: null })
    const billing = await readBilling(tenant.id)
    expect(billing).toMatchObject({
      state: 'active',
      providerSubscriptionId: sub,
      pendingSubscriptionId: null,
      provider: 'razorpay',
      providerMode: 'test',
    })
  })

  it('follows the fetched status, not the event, when a pending event lands after it is active', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    await setBilling(tenant.id, { pendingSubscriptionId: sub })
    serveSubscription({ id: sub, tenantId: tenant.id })
    await processed(
      await deliver('webhook-subscription.activated-synthetic', {
        subscriptionId: sub,
        tenantId: tenant.id,
      })
    )

    const late = await deliver('webhook-subscription.pending-20261024T034219', {
      subscriptionId: sub,
      tenantId: tenant.id,
    })

    expect(await processed(late)).toMatchObject({ error: null })
    const billing = await readBilling(tenant.id)
    expect(billing.state).toBe('active')
    expect(billing.pastDueSince).toBeNull()
  })

  it('leaves the event unprocessed for a retry when the provider answers 5xx', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    await setBilling(tenant.id, { pendingSubscriptionId: sub })
    api.reply('GET', `/subscriptions/${sub}`, 503, { error: { code: 'SERVER_ERROR' } })

    const id = await deliver('webhook-subscription.charged-synthetic', {
      subscriptionId: sub,
      tenantId: tenant.id,
    })

    const job = await retrying(id)
    expect(job.attemptsMade).toBe(1)
    expect(await eventRow(id)).toMatchObject({ processed_at: null, attempts: 0, error: null })
    expect(await billingColumn(tenant.id, 'state')).toBe('free')
    await job.remove()
  })

  it('retries a sync that kept meeting a concurrent write', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    await setBilling(tenant.id, { pendingSubscriptionId: sub })
    serveSubscription({ id: sub, tenantId: tenant.id })

    const fetchSubscription = RazorpayProvider.prototype.fetchSubscription
    await withMutatedMethod(
      RazorpayProvider.prototype,
      'fetchSubscription',
      async function (this: RazorpayProvider, id: string): Promise<ProviderSubscription> {
        // Another writer moves the row between every read and its lock.
        await sql`update tenant_billing set version = version + 1 where tenant_id = ${tenant.id}`
        return fetchSubscription.call(this, id)
      },
      async () => {
        const id = await deliver('webhook-subscription.charged-synthetic', {
          subscriptionId: sub,
          tenantId: tenant.id,
        })
        const job = await retrying(id)
        expect(await eventRow(id)).toMatchObject({ processed_at: null, error: null })
        await job.remove()
      }
    )
  })

  it('adopts a paid subscription no row holds when its notes name a workspace here', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    serveSubscription({ id: sub, tenantId: tenant.id })

    const id = await deliver('webhook-subscription.charged-synthetic', {
      subscriptionId: sub,
      tenantId: tenant.id,
    })

    expect(await processed(id)).toMatchObject({ tenant_id: tenant.id, error: null })
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: sub,
    })
  })

  it('marks a paid subscription for no known workspace unknown and alerts once', async () => {
    const sub = subscriptionId()
    serveSubscription({ id: sub, tenantId: randomUUID() })

    const first = await deliver('webhook-subscription.charged-synthetic', { subscriptionId: sub })
    expect(await processed(first)).toMatchObject({
      tenant_id: null,
      error: 'unknown_subscription',
    })
    const second = await deliver('webhook-subscription.charged-synthetic', { subscriptionId: sub })
    await processed(second)

    const alerts = await alertsNaming('reconcile_repair', sub)
    expect(alerts).toEqual([{ tenant_id: null }])
  })

  it('does not adopt a subscription whose fetched notes name another environment', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    serveSubscription({ id: sub, tenantId: tenant.id, appEnv: 'qa' })

    const id = await deliver('webhook-subscription.charged-synthetic', {
      subscriptionId: sub,
      tenantId: tenant.id,
    })

    expect(await processed(id)).toMatchObject({ error: 'unknown_subscription' })
    expect(await billingColumn(tenant.id, 'state')).toBe('free')
  })

  it('raises no alert for an unpaid subscription no workspace holds', async () => {
    const sub = subscriptionId()
    serveSubscription({ id: sub, tenantId: randomUUID(), status: 'created', paidCount: 0 })

    const id = await deliver('webhook-subscription.charged-synthetic', { subscriptionId: sub })

    expect(await processed(id)).toMatchObject({ error: 'unknown_subscription' })
    expect(await alertsNaming('reconcile_repair', sub)).toEqual([])
  })

  it('leaves a row of another provider alone and marks the event provider_mismatch', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    await setBilling(tenant.id, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      providerSubscriptionId: sub,
      provider: 'fake',
      providerMode: 'test',
    })
    const before = await readBilling(tenant.id)

    const id = await deliver('webhook-subscription.halted-synthetic', {
      subscriptionId: sub,
      tenantId: tenant.id,
    })

    expect(await processed(id)).toMatchObject({ error: 'provider_mismatch' })
    expect(await billingColumn(tenant.id, 'version')).toBe(before.version)
    expect(api.requests).toHaveLength(0)
  })

  it('sets the dispute flag and alerts on a dispute, then clears it, never changing the state', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    const payment = paymentId()
    await setBilling(tenant.id, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      providerSubscriptionId: sub,
      provider: 'razorpay',
      providerMode: 'test',
    })
    servePayment(payment, sub)

    const opened = await deliver('webhook-payment.dispute.created-synthetic', {
      paymentId: payment,
    })
    expect(await processed(opened)).toMatchObject({ tenant_id: tenant.id, error: null })
    expect(await readBilling(tenant.id)).toMatchObject({ disputeOpen: true, state: 'active' })
    expect(await alertsNaming('dispute', payment)).toEqual([{ tenant_id: tenant.id }])

    const won = await deliver('webhook-payment.dispute.won-synthetic', { paymentId: payment })
    expect(await processed(won)).toMatchObject({ error: null })
    expect(await readBilling(tenant.id)).toMatchObject({ disputeOpen: false, state: 'active' })
    expect(await alertsNaming('dispute', payment)).toHaveLength(1)
  })

  it('alerts with no workspace on a dispute whose payment no workspace holds', async () => {
    const payment = paymentId()
    servePayment(payment, subscriptionId())

    const id = await deliver('webhook-payment.dispute.created-synthetic', { paymentId: payment })

    expect(await processed(id)).toMatchObject({ error: 'unknown_subscription' })
    expect(await alertsNaming('dispute', payment)).toEqual([{ tenant_id: null }])
  })

  it('syncs on an invoice.paid event through its subscription', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    await setBilling(tenant.id, { pendingSubscriptionId: sub })
    serveSubscription({ id: sub, tenantId: tenant.id })

    const id = await deliver('webhook-invoice.paid-synthetic', { subscriptionId: sub })

    expect(await processed(id)).toMatchObject({ tenant_id: tenant.id, error: null })
    expect(await billingColumn(tenant.id, 'state')).toBe('active')
  })

  it('marks the event failed and alerts once when a job fails for good', async () => {
    const { tenant } = await workspace()
    const sub = subscriptionId()
    await setBilling(tenant.id, { pendingSubscriptionId: sub })
    api.reply('GET', `/subscriptions/${sub}`, 400, { error: { code: 'BAD_REQUEST_ERROR' } })

    const delivery = signedWebhook('webhook-subscription.charged-synthetic', {
      subscriptionId: sub,
      tenantId: tenant.id,
    })
    eventIds.push(delivery.eventId)
    namedIds.push(delivery.eventId)
    await request(app).post('/api/v1/webhooks/razorpay').set(delivery.headers).send(delivery.body)

    const [stored] = await sql<{ id: string }[]>`
      select id from billing_events where provider_event_id = ${delivery.eventId}`
    const row = await waitUntil(
      async () => {
        const current = await eventRow(stored?.id ?? '')
        return current.error === null ? null : current
      },
      { message: 'the failed job marks its event' }
    )
    expect(row).toMatchObject({ processed_at: null, attempts: 1 })
    expect(row.error).toMatch(/^provider_error 400/)
    const alerts = await waitUntil(
      async () => {
        const found = await alertsNaming('webhook_failing', delivery.eventId)
        return found.length > 0 ? found : null
      },
      { message: 'the failed job raises an alert' }
    )
    expect(alerts).toEqual([{ tenant_id: tenant.id }])
    const failedJob = await jobOf(stored?.id ?? '')
    await failedJob.remove()
  })
})

describe('processBillingJob', () => {
  it('runs a sync for a sync-tenant job', async () => {
    const { tenant } = await workspace()
    const before = await readBilling(tenant.id)

    await processBillingJob({
      name: BILLING_SYNC_TENANT_JOB,
      data: { tenantId: tenant.id },
    } as Job)

    const after = await readBilling(tenant.id)
    expect(after.syncedAt).not.toBeNull()
    expect(after.version).toBeGreaterThan(before.version)
  })

  it('refuses a job name it has no handler for without a retry', async () => {
    await expect(processBillingJob({ name: 'nope', data: {} } as Job)).rejects.toBeInstanceOf(
      UnrecoverableError
    )
  })
})
