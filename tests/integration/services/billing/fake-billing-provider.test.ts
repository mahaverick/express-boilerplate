/**
 * @file The fake payment provider keeps its subscriptions in Redis, so a
 * second instance (another process) reads what the first wrote; its test
 * hooks move a subscription between states and sign a checkout its own
 * `verifyCheckout` accepts.
 */
import { createHmac } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test'
import { billingProviderConfig, type BillingProviderConfig } from '@/configs/billing.config'
import { ProviderError } from '@/errors/billing-provider-errors'
import { FakeBillingProvider } from '@/services/billing/fake-billing-provider.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import type { ProviderPlanPrice } from '@/types/billing'

/**
 * The fake provider's config, as the app builds it with the fake switched on.
 * @returns The config.
 */
function fakeConfig(): BillingProviderConfig {
  const config = billingProviderConfig({
    BILLING_FAKE_PROVIDER: true,
    BILLING_GST_REGISTERED: false,
    RAZORPAY_KEY_ID: undefined,
    RAZORPAY_KEY_SECRET: undefined,
    RAZORPAY_WEBHOOK_SECRET: undefined,
    RAZORPAY_WEBHOOK_SECRET_PREVIOUS: undefined,
  })
  if (config === null) throw new Error('the fake config is missing')
  return config
}

const price: ProviderPlanPrice = {
  id: 'price-fake-1',
  interval: 'month',
  amountMinor: 99_900,
  currency: 'INR',
  provider: null,
  providerMode: null,
  providerPlanId: null,
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

let provider: FakeBillingProvider

beforeEach(async () => {
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
  provider = new FakeBillingProvider(fakeConfig())
})

afterAll(async () => {
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
  await closeRedis()
})

/**
 * Create a monthly subscription on the fake.
 * @param startAt - The deferred first charge, or null.
 * @returns The new subscription's id.
 */
async function createOne(startAt: Date | null = null): Promise<string> {
  const planId = await provider.ensurePlan(price, 'Paid monthly')
  const created = await provider.createSubscription({
    providerPlanId: planId,
    totalCount: 60,
    expireBy: new Date(Date.now() + 3_600_000),
    startAt,
    notes: { tenantId: 't-1' },
  })
  return created.id
}

describe('FakeBillingProvider', () => {
  it('reports itself as the fake in test mode', () => {
    expect(provider.kind).toBe('fake')
    expect(provider.mode).toBe('test')
    expect(provider.keyId).toBe('rzp_test_FAKE')
  })

  it('creates a subscription another instance can read', async () => {
    const id = await createOne()
    expect(id).toMatch(/^sub_FAKE/)
    const other = new FakeBillingProvider(fakeConfig())
    const read = await other.fetchSubscription(id)
    expect(read).toMatchObject({
      id,
      status: 'created',
      notes: { tenantId: 't-1' },
      paidCount: 0,
      latestInvoicePaid: false,
    })
  })

  it('returns the stored plan id for a price that has one', async () => {
    const planId = await provider.ensurePlan(price, 'Paid monthly')
    expect(planId).toMatch(/^plan_FAKE/)
    const stored = {
      ...price,
      provider: 'fake' as const,
      providerMode: 'test' as const,
      providerPlanId: 'plan_KEPT',
    }
    expect(await provider.ensurePlan(stored, 'Paid monthly')).toBe('plan_KEPT')
  })

  it('throws a non-retryable ProviderError for an unknown subscription', async () => {
    const error = await rejectionOf(provider.fetchSubscription('sub_FAKEnope'))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ status: 400, retryable: false })
  })

  it('activates a subscription with a paid cycle and an invoice', async () => {
    const id = await createOne()
    await provider.fakeAdvance(id, 'active')
    const active = await provider.fetchSubscription(id)
    expect(active).toMatchObject({ status: 'active', paidCount: 1, latestInvoicePaid: true })
    expect(active.currentStart).not.toBeNull()
    expect(active.currentEnd?.getTime()).toBeGreaterThan(active.currentStart?.getTime() ?? 0)
    const page = await provider.listInvoices([id], null)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ status: 'paid', amountMinor: 99_900, currency: 'INR' })
  })

  it('lists invoices with the subscription they bill, only of the statuses asked for', async () => {
    const id = await createOne()
    await provider.fakeAdvance(id, 'active')

    const paid = await provider.listInvoices([id], null, { statuses: ['paid', 'issued'] })
    const issued = await provider.listInvoices([id], null, { statuses: ['issued'] })

    expect(paid.items).toStrictEqual([
      expect.objectContaining({ status: 'paid', subscriptionId: id }) as unknown,
    ])
    expect(issued).toStrictEqual({ items: [], nextCursor: null })
  })

  it("starts a deferred start's first cycle at its start, not at the moment it is charged", async () => {
    const startAt = new Date('2026-12-01T00:00:00.000Z')
    const id = await createOne(startAt)
    await provider.fakeAdvance(id, 'authenticated')

    const first = await provider.fakeAdvance(id, 'active')

    expect(first.currentStart?.getTime()).toBe(startAt.getTime())
    expect(first.currentEnd?.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    expect(first.paidCount).toBe(1)
  })

  it('marks a pending or halted cycle unpaid', async () => {
    const id = await createOne()
    await provider.fakeAdvance(id, 'active')
    await provider.fakeAdvance(id, 'halted')
    expect(await provider.fetchSubscription(id)).toMatchObject({
      status: 'halted',
      latestInvoicePaid: false,
    })
  })

  it('refuses a cycle-end cancel of a deferred start, as Razorpay does', async () => {
    const id = await createOne(new Date(Date.now() + 86_400_000))
    await provider.fakeAdvance(id, 'authenticated')
    const error = await rejectionOf(provider.cancelSubscription(id, true))
    expect(error).toMatchObject({ status: 400, retryable: false })
    const answer = await provider.cancelSubscription(id, false)
    expect(answer.status).toBe('cancelled')
  })

  it('keeps a cycle-end cancel active and ends an immediate one', async () => {
    const id = await createOne()
    await provider.fakeAdvance(id, 'active')
    const answer = await provider.cancelSubscription(id, true)
    expect(answer.status).toBe('active')
    const ended = await provider.cancelSubscription(id, false)
    expect(ended.status).toBe('cancelled')
    expect(ended.endedAt).not.toBeNull()
  })

  it('refunds the latest payment, or answers nothing_paid when nothing was paid', async () => {
    const id = await createOne()
    expect(await provider.refundLatestPayment(id)).toStrictEqual({ status: 'nothing_paid' })
    await provider.fakeAdvance(id, 'active')
    expect(await provider.refundLatestPayment(id)).toStrictEqual({
      status: 'refunded',
      refundId: expect.stringMatching(/^rfnd_FAKE/) as unknown,
      amountMinor: 99_900,
    })
  })

  it('refunds a payment once, even when two callers refund it at once', async () => {
    const id = await createOne()
    await provider.fakeAdvance(id, 'active')
    const other = new FakeBillingProvider(fakeConfig())
    const refunds = await Promise.all([
      provider.refundLatestPayment(id),
      other.refundLatestPayment(id),
    ])
    expect(refunds.map((refund) => refund.status).toSorted()).toStrictEqual([
      'already_refunded',
      'refunded',
    ])
    expect(await provider.refundLatestPayment(id)).toStrictEqual({ status: 'already_refunded' })
  })

  it('finds the subscription a payment it took belongs to, or null for an unknown payment', async () => {
    const id = await createOne()
    await provider.fakeAdvance(id, 'active')
    const redis = await getRedis()
    const stored = await redis.hGet(redisKey('billing-fake'), `sub:${id}`)
    const { payments } = JSON.parse(stored ?? '{}') as { payments: { paymentId: string }[] }
    const paymentId = payments[0]?.paymentId ?? ''

    expect(await provider.findSubscriptionIdForPayment(paymentId)).toBe(id)
    expect(await provider.findSubscriptionIdForPayment('pay_FAKEunknown')).toBeNull()
  })

  it('answers a stored dispute’s status, and a 400 for an unknown dispute', async () => {
    const disputeId = `disp_FAKE${String(Date.now())}`
    await provider.fakeSetDispute(disputeId, 'under_review')

    expect(await provider.fetchDisputeStatus(disputeId)).toBe('under_review')
    const error = await rejectionOf(provider.fetchDisputeStatus('disp_FAKEunknown'))
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).retryable).toBe(false)
  })

  it('lists subscriptions created since a time', async () => {
    const before = new Date(Date.now() - 1000)
    const id = await createOne()
    const recent = await provider.listRecentSubscriptions(before)
    expect(recent.map((s) => s.id)).toContain(id)
    const later = new Date(Date.now() + 60_000)
    expect(await provider.listRecentSubscriptions(later)).toStrictEqual([])
  })

  it('signs a checkout its verifyCheckout accepts, for that subscription only', () => {
    const signature = provider.fakeSignCheckout('pay_FAKE1', 'sub_FAKE1')
    const confirm = {
      razorpay_payment_id: 'pay_FAKE1',
      razorpay_subscription_id: 'sub_FAKE1',
      razorpay_signature: signature,
    }
    expect(provider.verifyCheckout(confirm, 'sub_FAKE1')).toBe(true)
    expect(provider.verifyCheckout(confirm, 'sub_FAKE2')).toBe(false)
    expect(provider.verifyCheckout({ ...confirm, razorpay_signature: '' }, 'sub_FAKE1')).toBe(false)
  })

  it('verifies a webhook signed with the fake webhook secret', () => {
    const body = Buffer.from('{"event":"subscription.activated"}')
    const signature = createHmac('sha256', 'fake_webhook_secret').update(body).digest('hex')
    expect(provider.verifyWebhook(body, signature)).toBe(true)
    expect(provider.verifyWebhook(body, undefined)).toBe(false)
  })
})
