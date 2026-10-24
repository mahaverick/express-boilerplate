/**
 * @file POST /api/v1/webhooks/razorpay through the real app, database and
 * queue: a correctly signed delivery is recorded once and queued once; a
 * delivery signed with the previous secret is accepted; a bad signature, a
 * missing event id and an oversized body are refused before any row is
 * written; another environment's event is acknowledged and not recorded; an
 * event type billing does not use is recorded and not queued; payments off
 * or the fake provider answer the unknown-route 404; full maintenance lets
 * the route through. No worker runs here, so the queued jobs stay put.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { BILLING_WEBHOOK_JOB, type BillingWebhookJobData } from '@/jobs/billing.job'
import { sql } from '@/services/database.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { closeQueue, getBillingQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import type { BillingProviderClient } from '@/types/billing'
import { fake as fakeBillingProvider } from '../../helpers/billing-api'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { queuedJobs } from '../../helpers/queue-jobs'
import {
  PROBE_WEBHOOK_SECRET,
  razorpaySignature,
  razorpayTestProvider,
  signedWebhook,
} from '../../helpers/razorpay-fixtures'
import { request } from '../../helpers/request'

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
const URL = '/api/v1/webhooks/razorpay'
const CHARGED = 'webhook-subscription.charged-synthetic'
const eventIds: string[] = []

/**
 * Orders strings alphabetically.
 */
const byText = (a: string | undefined, b: string | undefined): number =>
  (a ?? '').localeCompare(b ?? '')

/**
 * The parts of an answer's body these tests read.
 */
interface WebhookAnswer {
  data?: { result: string }
  code?: string
  details?: unknown
}

/**
 * An answer's body, typed for the fields these tests read.
 * @param response - The response.
 * @param response.body - Its parsed body.
 * @returns The body.
 */
function answerOf(response: { body: unknown }): WebhookAnswer {
  return response.body as WebhookAnswer
}

/**
 * Post a delivery.
 * @param delivery - The body and headers.
 * @param delivery.body - The exact body.
 * @param delivery.headers - The headers.
 * @returns The response.
 */
function post(delivery: { body: string; headers: Record<string, string> }) {
  return request(app).post(URL).set(delivery.headers).send(delivery.body)
}

/**
 * A signed charged delivery whose event id this file cleans up.
 * @param rewrite - Extra ids to put in it.
 * @param rewrite.appEnv - The environment its notes name.
 * @returns The delivery.
 */
function charged(rewrite: { appEnv?: string } = {}) {
  const delivery = signedWebhook(CHARGED, { subscriptionId: 'sub_TESTwebhookroute', ...rewrite })
  eventIds.push(delivery.eventId)
  return delivery
}

/**
 * The stored rows of an event id.
 * @param eventId - The provider event id.
 * @returns Each row's id, type, subscription id and processed time.
 */
function rowsOf(eventId: string) {
  return sql<
    { id: string; type: string; subscription_id: string | null; processed_at: string | null }[]
  >`select id, type, subscription_id, processed_at from billing_events where provider_event_id = ${eventId}`
}

/**
 * The queued webhook jobs for a stored event.
 * @param eventRowId - The stored event's id.
 * @returns The jobs.
 */
async function jobsFor(eventRowId: string) {
  const jobs = await queuedJobs<BillingWebhookJobData>(getBillingQueue())
  return jobs.filter(
    (job) => job.name === BILLING_WEBHOOK_JOB && job.data.eventRowId === eventRowId
  )
}

beforeAll(() => {
  providerState.current = razorpayTestProvider('http://127.0.0.1:1/v1')
})

afterEach(async () => {
  providerState.current = razorpayTestProvider('http://127.0.0.1:1/v1')
  if (eventIds.length > 0) {
    await sql`delete from billing_events where provider_event_id = any(${eventIds})`
    eventIds.length = 0
  }
})

afterAll(async () => {
  await getBillingQueue().obliterate({ force: true })
  await closeQueue()
  await closeRedis()
})

describe('POST /webhooks/razorpay', () => {
  it('records a signed delivery once and queues one job for it', async () => {
    const delivery = charged()

    const response = await post(delivery)

    expect(response.status).toBe(200)
    expect(answerOf(response).data).toEqual({ result: 'queued' })
    const rows = await rowsOf(delivery.eventId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'subscription.charged',
      subscription_id: 'sub_TESTwebhookroute',
      processed_at: null,
    })
    const jobs = await jobsFor(rows[0]?.id ?? '')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.data).toEqual({
      eventRowId: rows[0]?.id,
      providerEventId: delivery.eventId,
      eventType: 'subscription.charged',
      subscriptionId: 'sub_TESTwebhookroute',
      paymentId: 'pay_FIXTUREsynth01',
      disputeId: null,
    })
    expect(jobs[0]?.opts.attempts).toBe(8)
    expect(jobs[0]?.opts.backoff).toEqual({ type: 'exponential', delay: 30_000 })
  })

  it('answers a second delivery of the same event 200 and queues nothing new', async () => {
    const delivery = charged()
    await post(delivery)

    const again = await post(delivery)

    expect(again.status).toBe(200)
    expect(answerOf(again).data).toEqual({ result: 'duplicate' })
    const rows = await rowsOf(delivery.eventId)
    expect(rows).toHaveLength(1)
    expect(await jobsFor(rows[0]?.id ?? '')).toHaveLength(1)
  })

  it('records and queues two identical deliveries that arrive at once only once', async () => {
    const delivery = charged()

    const answers = await Promise.all([post(delivery), post(delivery)])

    expect(answers.map((answer) => answer.status)).toEqual([200, 200])
    expect(answers.map((answer) => answerOf(answer).data?.result).toSorted(byText)).toEqual([
      'duplicate',
      'queued',
    ])
    const rows = await rowsOf(delivery.eventId)
    expect(rows).toHaveLength(1)
    expect(await jobsFor(rows[0]?.id ?? '')).toHaveLength(1)
  })

  it('accepts a delivery signed with the previous secret', async () => {
    providerState.current = razorpayTestProvider('http://127.0.0.1:1/v1', [
      'rotated_webhook_secret',
      PROBE_WEBHOOK_SECRET,
    ])
    const delivery = charged()

    const response = await post(delivery)

    expect(response.status).toBe(200)
    expect(answerOf(response).data).toEqual({ result: 'queued' })
  })

  it('refuses a bad signature with 401 and writes no row', async () => {
    const delivery = charged()

    const response = await post({
      body: delivery.body,
      headers: {
        ...delivery.headers,
        'x-razorpay-signature': razorpaySignature(delivery.body, 'not_the_secret'),
      },
    })

    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ success: false, code: 'INVALID_SIGNATURE' })
    expect(answerOf(response).details).toBeUndefined()
    expect(await rowsOf(delivery.eventId)).toHaveLength(0)
  })

  it('refuses a delivery with no signature header with 401', async () => {
    const delivery = charged()
    const { 'x-razorpay-signature': _signature, ...headers } = delivery.headers

    const response = await post({ body: delivery.body, headers })

    expect(response.status).toBe(401)
    expect(await rowsOf(delivery.eventId)).toHaveLength(0)
  })

  it('refuses a signed delivery with no event id with 400 and writes no row', async () => {
    const delivery = charged()
    const { 'x-razorpay-event-id': _eventId, ...headers } = delivery.headers
    const before = await sql<{ count: number }[]>`select count(*)::int as count from billing_events`

    const response = await post({ body: delivery.body, headers })

    expect(response.status).toBe(400)
    expect(answerOf(response).code).toBe('INVALID_PAYLOAD')
    const after = await sql<{ count: number }[]>`select count(*)::int as count from billing_events`
    expect(after[0]?.count).toBe(before[0]?.count)
  })

  it('accepts the bare event id Razorpay sends and refuses one of an unsafe shape', async () => {
    const delivery = signedWebhook(CHARGED, {
      subscriptionId: 'sub_TESTwebhookroute',
      eventId: 'TrbKyvYxfyP4cL',
    })
    eventIds.push(delivery.eventId)

    const accepted = await post(delivery)
    const refused = await post({
      body: delivery.body,
      headers: { ...delivery.headers, 'x-razorpay-event-id': 'evt id; drop' },
    })

    expect(accepted.status).toBe(200)
    expect(await rowsOf('TrbKyvYxfyP4cL')).toHaveLength(1)
    expect(refused.status).toBe(400)
  })

  it('refuses a signed body that is not JSON with 400', async () => {
    const body = 'not json'

    const response = await post({
      body,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': 'evt_TESTnotjson',
        'x-razorpay-signature': razorpaySignature(body),
      },
    })

    expect(response.status).toBe(400)
    expect(await rowsOf('evt_TESTnotjson')).toHaveLength(0)
  })

  it('refuses a body over 256kb with 413 before reading it', async () => {
    const body = JSON.stringify({ event: 'subscription.charged', padding: 'x'.repeat(300 * 1024) })

    const response = await post({
      body,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': 'evt_TESTtoolarge',
        'x-razorpay-signature': razorpaySignature(body),
      },
    })

    expect(response.status).toBe(413)
    expect(await rowsOf('evt_TESTtoolarge')).toHaveLength(0)
  })

  it('acknowledges another environment’s event without recording it', async () => {
    const delivery = charged({ appEnv: 'prod' })

    const response = await post(delivery)

    expect(response.status).toBe(200)
    expect(answerOf(response).data).toEqual({ result: 'ignored' })
    expect(await rowsOf(delivery.eventId)).toHaveLength(0)
  })

  it('records an event type billing does not use as processed and queues nothing', async () => {
    const delivery = signedWebhook('webhook-payment.authorized-20261024T034227')
    eventIds.push(delivery.eventId)

    const response = await post(delivery)

    expect(response.status).toBe(200)
    expect(answerOf(response).data).toEqual({ result: 'ignored' })
    const rows = await rowsOf(delivery.eventId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.processed_at).not.toBeNull()
    expect(await jobsFor(rows[0]?.id ?? '')).toHaveLength(0)
  })

  it('answers the unknown-route 404 while payments are off', async () => {
    providerState.current = null
    const delivery = charged()

    const response = await post(delivery)
    const unknown = await request(app).post('/api/v1/no-such-route').send({})

    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      ...(unknown.body as Record<string, unknown>),
      requestId: response.headers['x-request-id'] as string,
    })
    expect(response.headers['ratelimit-limit']).toBeUndefined()
    expect(await rowsOf(delivery.eventId)).toHaveLength(0)
  })

  it('answers 404 on the fake provider, which has no webhooks', async () => {
    providerState.current = fakeBillingProvider
    const delivery = charged()

    const response = await post(delivery)

    expect(response.status).toBe(404)
    expect(await rowsOf(delivery.eventId)).toHaveLength(0)
  })

  it('still accepts deliveries during full maintenance', async () => {
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()
    try {
      const delivery = charged()

      const response = await post(delivery)

      expect(response.status).toBe(200)
      expect(answerOf(response).data).toEqual({ result: 'queued' })
    } finally {
      await resetMaintenanceMode()
      await reloadMaintenanceMode()
    }
  })
})
