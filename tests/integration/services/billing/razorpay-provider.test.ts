/**
 * @file The Razorpay client against a fake Razorpay on 127.0.0.1: request
 * shapes, the mapping of every captured subscription fixture, error and
 * timeout classification, the per-subscription mutation chain, and both
 * signature checks. No call leaves the machine.
 */
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { BillingProviderConfig } from '@/configs/billing.config'
import { RAZORPAY_API_TIMEOUT_MS } from '@/constants/billing.constants'
import { ProviderError } from '@/errors/billing-provider-errors'
import { RazorpayProvider } from '@/services/billing/razorpay-provider.service'
import type { ProviderPlanPrice } from '@/types/billing'
import { startFakeRazorpay, type FakeRazorpay } from '../../../helpers/fake-razorpay'

/**
 * One captured API answer.
 */
interface ApiFixture {
  method: string
  path: string
  status: number
  json: Record<string, unknown>
}

/**
 * One captured webhook delivery.
 */
interface WebhookFixture {
  headers: Record<string, string>
  rawBody: string
}

const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures/razorpay')

/**
 * Read one captured fixture.
 * @param name - The file name without `.json`.
 * @returns The parsed fixture.
 */
function fixture<T = ApiFixture>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as T
}

const KEY_SECRET = 'rzp_secret_FAKE_for_tests'

/**
 * A config with fake keys and the probe webhook secret.
 * @param webhookSecrets - The webhook secrets, current first.
 * @returns The config.
 */
function config(webhookSecrets = ['probe_webhook_secret']): BillingProviderConfig {
  return {
    kind: 'razorpay',
    mode: 'test',
    keyId: 'rzp_test_FAKEkey123',
    keySecret: KEY_SECRET,
    webhookSecrets,
  }
}

/**
 * The error a call rejects with.
 * @param call - The call.
 * @returns What it rejected with.
 * @throws {Error} When the call resolves.
 */
async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call
  } catch (error) {
    return error
  }
  throw new Error('The call resolved')
}

let fake: FakeRazorpay
let provider: RazorpayProvider

beforeAll(async () => {
  fake = await startFakeRazorpay()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  fake.reset()
  provider = new RazorpayProvider(config(), { baseUrl: fake.baseUrl })
})

/**
 * Answer a subscription read and its invoice list.
 * @param id - The subscription id.
 * @param subscription - The subscription body.
 * @param invoices - The invoice list body.
 */
function serveSubscription(id: string, subscription: unknown, invoices: unknown): void {
  fake.reply('GET', `/subscriptions/${id}`, 200, subscription)
  fake.reply('GET', '/invoices', 200, invoices)
}

describe('createSubscription', () => {
  it('sends the plan, the cycle count, expire_by in unix seconds, the notes and customer_notify', async () => {
    fake.reply('POST', '/subscriptions', 200, {
      ...fixture('api-subscription-authenticated-deferred').json,
      status: 'created',
    })
    const expireBy = new Date('2026-11-01T10:00:00.000Z')
    const startAt = new Date('2026-11-14T00:00:00.000Z')
    const created = await provider.createSubscription({
      providerPlanId: 'plan_ABC',
      totalCount: 60,
      expireBy,
      startAt,
      notes: { tenantId: 't-1', priceId: 'p-1' },
    })
    expect(created.status).toBe('created')
    const sent = fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/subscriptions')
    expect(sent?.json).toStrictEqual({
      plan_id: 'plan_ABC',
      total_count: 60,
      expire_by: expireBy.getTime() / 1000,
      start_at: startAt.getTime() / 1000,
      customer_notify: 1,
      notes: { tenantId: 't-1', priceId: 'p-1' },
    })
    const expected = `Basic ${Buffer.from(`rzp_test_FAKEkey123:${KEY_SECRET}`).toString('base64')}`
    expect(sent?.headers.authorization).toBe(expected)
  })

  it('leaves start_at out when the first charge is at checkout', async () => {
    fake.reply('POST', '/subscriptions', 200, {
      ...fixture('api-subscription-active').json,
      status: 'created',
    })
    await provider.createSubscription({
      providerPlanId: 'plan_ABC',
      totalCount: 5,
      expireBy: new Date('2026-11-01T10:00:00.000Z'),
      startAt: null,
      notes: {},
    })
    const sent = fake.requests.find((r) => r.method === 'POST')
    expect(sent?.json).not.toHaveProperty('start_at')
  })
})

describe('fetchSubscription', () => {
  it('maps an active subscription whose current cycle is paid', async () => {
    const sub = fixture('api-subscription-active').json
    serveSubscription(String(sub.id), sub, fixture('api-invoices-paid').json)
    const mapped = await provider.fetchSubscription(String(sub.id))
    expect(mapped).toStrictEqual({
      id: 'sub_Trax7OfeENGU9N',
      status: 'active',
      planId: 'plan_TralqajqAn8poP',
      currentStart: new Date(1_792_812_180_000),
      currentEnd: new Date(1_795_458_600_000),
      startAt: new Date(1_792_812_180_000),
      endedAt: null,
      chargeAt: new Date(1_795_458_600_000),
      notes: { tenantId: 'probe-t2', appEnv: 'local', priceId: 'probe-p1' },
      paidCount: 1,
      customerId: 'cust_FIXTURE',
      hasScheduledChanges: false,
      latestInvoicePaid: true,
    })
    const invoiceCall = fake.requests.find((r) => r.path.startsWith('/v1/invoices'))
    expect(invoiceCall?.path).toContain('subscription_id=sub_Trax7OfeENGU9N')
  })

  it.each([
    ['api-subscription-active', 'active'],
    ['api-subscription-authenticated-deferred', 'authenticated'],
    ['api-subscription-cancelled', 'cancelled'],
    ['api-subscription-pending', 'pending'],
    ['api-pause', 'paused'],
    ['api-cancel-cycle-end-response', 'active'],
  ])('maps the status of %s', async (name, status) => {
    const sub = fixture(name).json
    serveSubscription(String(sub.id), sub, fixture('api-invoices-deferred-empty').json)
    const mapped = await provider.fetchSubscription(String(sub.id))
    expect(mapped.status).toBe(status)
    expect(mapped.id).toBe(sub.id)
  })

  it('reads a deferred start with no invoices as unpaid with no cycle', async () => {
    const sub = fixture('api-subscription-authenticated-deferred').json
    serveSubscription(String(sub.id), sub, fixture('api-invoices-deferred-empty').json)
    const mapped = await provider.fetchSubscription(String(sub.id))
    expect(mapped.latestInvoicePaid).toBe(false)
    expect(mapped.currentStart).toBeNull()
    expect(mapped.currentEnd).toBeNull()
    expect(mapped.startAt).toStrictEqual(new Date(1_792_984_871_000))
  })

  it('reads the invoice of the current cycle, not a newer issued one', async () => {
    const sub = fixture('api-subscription-active').json
    const paid = (fixture('api-invoices-paid').json.items as Record<string, unknown>[])[0]
    const newerIssued = {
      ...paid,
      id: 'inv_NEWER',
      status: 'issued',
      paid_at: null,
      billing_start: 1_795_458_600,
      created_at: 1_792_900_000,
    }
    serveSubscription(String(sub.id), sub, { entity: 'collection', items: [newerIssued, paid] })
    const answer = await provider.fetchSubscription(String(sub.id))
    expect(answer.latestInvoicePaid).toBe(true)
  })

  it('reads a cycle whose invoice is only issued as unpaid', async () => {
    const sub = fixture('api-subscription-pending').json
    const paid = (fixture('api-invoices-paid').json.items as Record<string, unknown>[])[0]
    const issued = {
      ...paid,
      id: 'inv_CURRENT',
      status: 'issued',
      paid_at: null,
      billing_start: sub.current_start,
      created_at: 1_805_826_600,
    }
    serveSubscription(String(sub.id), sub, { entity: 'collection', items: [paid, issued] })
    const answer = await provider.fetchSubscription(String(sub.id))
    expect(answer.latestInvoicePaid).toBe(false)
  })

  it('maps notes that arrive as an empty array to an empty object', async () => {
    const sub: Record<string, unknown> = { ...fixture('api-subscription-active').json, notes: [] }
    serveSubscription(String(sub.id), sub, fixture('api-invoices-paid').json)
    const answer = await provider.fetchSubscription(String(sub.id))
    expect(answer.notes).toStrictEqual({})
  })
})

describe('errors', () => {
  it('throws a retryable ProviderError on a 502', async () => {
    fake.respondWith(502, { error: { code: 'SERVER_ERROR', description: 'down' } })
    const error = await rejectionOf(provider.fetchSubscription('sub_X'))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ status: 502, retryable: true })
  })

  it('throws a non-retryable ProviderError carrying the provider code on a 400', async () => {
    const refused = fixture('api-cancel-cycle-end-on-authenticated-refused')
    fake.reply('POST', '/subscriptions/sub_X/cancel', refused.status, refused.json)
    const error = await rejectionOf(provider.cancelSubscription('sub_X', true))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ status: 400, retryable: false, code: 'BAD_REQUEST_ERROR' })
  })

  it('times out a call that hangs past its timeout as retryable', async () => {
    const quick = new RazorpayProvider(config(), { baseUrl: fake.baseUrl, timeoutMs: 50 })
    fake.hang(2000)
    const error = await rejectionOf(quick.fetchSubscription('sub_X'))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ status: 'timeout', retryable: true })
  })

  it('gives each call a 10 second timeout by default', async () => {
    expect(RAZORPAY_API_TIMEOUT_MS).toBe(10_000)
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const sub = fixture('api-subscription-active').json
    serveSubscription(String(sub.id), sub, fixture('api-invoices-paid').json)
    await provider.fetchSubscription(String(sub.id))
    expect(spy).toHaveBeenCalledWith(10_000)
    spy.mockRestore()
  })

  it('throws a retryable network ProviderError when nothing answers', async () => {
    const closed = await startFakeRazorpay()
    const baseUrl = closed.baseUrl
    await closed.close()
    const offline = new RazorpayProvider(config(), { baseUrl })
    const error = await rejectionOf(offline.fetchSubscription('sub_X'))
    expect(error).toMatchObject({ status: 'network', retryable: true })
  })

  it('never puts the key secret in an error', async () => {
    fake.respondWith(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'auth failed' } })
    const error = await rejectionOf(provider.fetchSubscription('sub_X'))
    const { inspect } = await import('node:util')
    expect(inspect(error, { depth: null })).not.toContain(KEY_SECRET)
  })
})

describe('cancelSubscription', () => {
  it('sends cancel_at_cycle_end and maps the answer', async () => {
    const answer = fixture('api-cancel-cycle-end-response')
    fake.reply('POST', '/subscriptions/sub_Trb43UbblkcQCh/cancel', 200, answer.json)
    fake.reply('GET', '/invoices', 200, fixture('api-invoices-deferred-empty').json)
    const cancelled = await provider.cancelSubscription('sub_Trb43UbblkcQCh', true)
    expect(cancelled.status).toBe('active')
    const sent = fake.requests.find((r) => r.method === 'POST')
    expect(sent?.json).toStrictEqual({ cancel_at_cycle_end: 1 })
  })

  it('sends one cancel at a time for the same subscription', async () => {
    const answer = fixture('api-cancel-cycle-end-response')
    fake.reply('POST', '/subscriptions/sub_Trb43UbblkcQCh/cancel', 200, answer.json)
    fake.reply('GET', '/invoices', 200, fixture('api-invoices-deferred-empty').json)
    fake.hang(100)
    const first = provider.cancelSubscription('sub_Trb43UbblkcQCh', false)
    const second = provider.cancelSubscription('sub_Trb43UbblkcQCh', false)
    await first
    // The second cancel has not been sent while the first was in flight.
    const cancelsAfterFirst = fake.requests.filter((r) => r.method === 'POST').length
    await second
    expect(cancelsAfterFirst).toBe(1)
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(2)
  })

  it('still sends the next cancel after one fails', async () => {
    fake.reply('POST', '/subscriptions/sub_Y/cancel', 400, { error: { code: 'BAD_REQUEST_ERROR' } })
    await expect(provider.cancelSubscription('sub_Y', true)).rejects.toBeInstanceOf(ProviderError)
    fake.reply('POST', '/subscriptions/sub_Y/cancel', 200, {
      ...fixture('api-subscription-cancelled').json,
      id: 'sub_Y',
    })
    fake.reply('GET', '/invoices', 200, fixture('api-invoices-paid').json)
    const answer = await provider.cancelSubscription('sub_Y', false)
    expect(answer.status).toBe('cancelled')
  })
})

describe('refundLatestPayment', () => {
  it('refunds the payment of the newest paid invoice in full', async () => {
    fake.reply('GET', '/invoices', 200, fixture('api-invoices-paid').json)
    fake.reply('POST', '/payments/pay_Traz18reMgTm3F/refund', 200, fixture('api-refund').json)
    expect(await provider.refundLatestPayment('sub_Trax7OfeENGU9N')).toStrictEqual({
      refundId: 'rfnd_Trb9vbIbmrD1wK',
      amountMinor: 99_900,
    })
  })

  it('answers null when nothing has been paid', async () => {
    fake.reply('GET', '/invoices', 200, fixture('api-invoices-deferred-empty').json)
    expect(await provider.refundLatestPayment('sub_Trax8W0l3PHuDR')).toBeNull()
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
  })
})

describe('listInvoices', () => {
  it('maps invoices for owners', async () => {
    fake.reply('GET', '/invoices', 200, fixture('api-invoices-paid').json)
    const page = await provider.listInvoices(['sub_Trax7OfeENGU9N'], null)
    expect(page).toStrictEqual({
      items: [
        {
          id: 'inv_Trax80lboN4a8X',
          amountMinor: 99_900,
          currency: 'INR',
          status: 'paid',
          issuedAt: new Date(1_792_812_072_000).toISOString(),
          paidAt: new Date(1_792_812_308_000).toISOString(),
          url: 'https://rzp.io/rzp/uvAO0vx',
        },
      ],
      nextCursor: null,
    })
  })

  it('answers an empty page for no subscriptions without a call', async () => {
    expect(await provider.listInvoices([], null)).toStrictEqual({ items: [], nextCursor: null })
    expect(fake.requests).toHaveLength(0)
  })
})

describe('listRecentSubscriptions', () => {
  it('reads every page created since the time given', async () => {
    const sub = fixture('api-subscription-active').json
    fake.reply('GET', '/subscriptions', 200, { entity: 'collection', count: 1, items: [sub] })
    fake.reply('GET', '/invoices', 200, fixture('api-invoices-paid').json)
    const since = new Date('2026-10-01T00:00:00.000Z')
    const found = await provider.listRecentSubscriptions(since)
    expect(found.map((s) => s.id)).toStrictEqual(['sub_Trax7OfeENGU9N'])
    expect(found[0]?.latestInvoicePaid).toBe(true)
    const list = fake.requests.find((r) => r.path.startsWith('/v1/subscriptions?'))
    expect(list?.path).toContain(`from=${String(since.getTime() / 1000)}`)
  })
})

describe('ensurePlan', () => {
  const price: ProviderPlanPrice = {
    id: 'price-1',
    interval: 'month',
    amountMinor: 99_900,
    currency: 'INR',
    provider: null,
    providerMode: null,
    providerPlanId: null,
  }

  it('creates a plan for a price with none, then returns the stored id without a call', async () => {
    fake.reply('POST', '/plans', 200, { id: 'plan_NEW1', entity: 'plan' })
    const id = await provider.ensurePlan(price, 'Paid monthly')
    expect(id).toBe('plan_NEW1')
    expect(fake.requests[0]?.json).toStrictEqual({
      period: 'monthly',
      interval: 1,
      item: { name: 'Paid monthly', amount: 99_900, currency: 'INR' },
      notes: { priceId: 'price-1' },
    })
    const stored: ProviderPlanPrice = {
      ...price,
      provider: 'razorpay',
      providerMode: 'test',
      providerPlanId: id,
    }
    expect(await provider.ensurePlan(stored, 'Paid monthly')).toBe('plan_NEW1')
    expect(fake.requests).toHaveLength(1)
  })

  it('creates a yearly plan for a yearly price', async () => {
    fake.reply('POST', '/plans', 200, { id: 'plan_YEAR', entity: 'plan' })
    await provider.ensurePlan({ ...price, interval: 'year', amountMinor: 999_000 }, 'Paid yearly')
    expect(fake.requests[0]?.json).toMatchObject({ period: 'yearly', interval: 1 })
  })

  it('creates a new plan when the stored id belongs to the other mode', async () => {
    fake.reply('POST', '/plans', 200, { id: 'plan_TEST', entity: 'plan' })
    const live: ProviderPlanPrice = {
      ...price,
      provider: 'razorpay',
      providerMode: 'live',
      providerPlanId: 'plan_LIVE',
    }
    expect(await provider.ensurePlan(live, 'Paid monthly')).toBe('plan_TEST')
  })
})

describe('verifyCheckout', () => {
  const paymentId = 'pay_FAKE123'
  const subscriptionId = 'sub_FAKE456'
  const signature = createHmac('sha256', KEY_SECRET)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex')
  const confirm = {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: signature,
  }

  it('accepts the signature over the expected subscription', () => {
    expect(provider.verifyCheckout(confirm, subscriptionId)).toBe(true)
  })

  it('refuses a signature made for a different subscription', () => {
    expect(provider.verifyCheckout(confirm, 'sub_OTHER')).toBe(false)
  })

  it('refuses a posted subscription id that differs from the expected one', () => {
    expect(
      provider.verifyCheckout({ ...confirm, razorpay_subscription_id: 'sub_OTHER' }, subscriptionId)
    ).toBe(false)
  })

  it('refuses a wrong-length signature', () => {
    expect(
      provider.verifyCheckout(
        { ...confirm, razorpay_signature: signature.slice(0, -2) },
        subscriptionId
      )
    ).toBe(false)
  })

  it('refuses an empty signature', () => {
    expect(provider.verifyCheckout({ ...confirm, razorpay_signature: '' }, subscriptionId)).toBe(
      false
    )
  })
})

describe('verifyWebhook', () => {
  const delivery = fixture<WebhookFixture>('webhook-subscription.pending-20261024T034219')
  const body = Buffer.from(delivery.rawBody, 'utf8')
  const signature = delivery.headers['x-razorpay-signature']

  it('accepts a delivery signed with the current secret', () => {
    expect(provider.verifyWebhook(body, signature)).toBe(true)
  })

  it('accepts a delivery signed with the previous secret', () => {
    const rotated = new RazorpayProvider(config(['new_webhook_secret', 'probe_webhook_secret']), {
      baseUrl: fake.baseUrl,
    })
    expect(rotated.verifyWebhook(body, signature)).toBe(true)
  })

  it('refuses a delivery signed with any other secret', () => {
    const other = new RazorpayProvider(config(['other_secret', 'older_secret']), {
      baseUrl: fake.baseUrl,
    })
    expect(other.verifyWebhook(body, signature)).toBe(false)
  })

  it('refuses a missing, empty or altered signature, or an altered body', () => {
    expect(provider.verifyWebhook(body, undefined)).toBe(false)
    expect(provider.verifyWebhook(body, '')).toBe(false)
    expect(provider.verifyWebhook(body, `${String(signature)}00`)).toBe(false)
    const altered = Buffer.concat([body, Buffer.from(' ')])
    expect(provider.verifyWebhook(altered, signature)).toBe(false)
  })
})
