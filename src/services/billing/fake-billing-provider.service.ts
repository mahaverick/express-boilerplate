/**
 * @file The local stand-in for Razorpay, on when `BILLING_FAKE_PROVIDER` is
 * set (local only: the dev seed and end-to-end runs). Its plans and
 * subscriptions live in one Redis hash under `redisKey('billing-fake')`, so
 * the API and the worker processes see the same state. It answers like
 * Razorpay where billing depends on it (a cycle-end cancel of a subscription
 * with no running cycle is a 400; an unknown id is a 400) and signs with the
 * same schemes, using the fake config's fixed secrets. `fakeAdvance` and
 * `fakeSignCheckout` are test hooks that only this class has.
 */
import { randomBytes } from 'node:crypto'
import type { BillingProviderConfig } from '@/configs/billing.config'
import type { BillingInterval } from '@/constants/billing.constants'
import { ProviderError } from '@/errors/billing-provider-errors'
import { withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import type {
  BillingProviderClient,
  CheckoutConfirm,
  CreateSubscriptionInput,
  InvoiceView,
  ProviderInvoice,
  ProviderInvoicePage,
  ProviderPlanPrice,
  ProviderRefundOutcome,
  ProviderSubscription,
  ProviderSubscriptionStatus,
} from '@/types/billing'
import {
  checkoutSignature,
  isValidCheckoutSignature,
  isValidWebhookSignature,
} from '@/utilities/billing-signature.utilities'

/**
 * A plan the fake created.
 */
interface FakePlan {
  amountMinor: number
  interval: BillingInterval
}

/**
 * A subscription as the fake stores it: dates as epoch milliseconds.
 */
interface FakeSubscriptionRecord {
  id: string
  status: ProviderSubscriptionStatus
  planId: string
  amountMinor: number
  interval: BillingInterval
  currentStart: number | null
  currentEnd: number | null
  startAt: number | null
  endedAt: number | null
  chargeAt: number | null
  notes: Record<string, string>
  paidCount: number
  customerId: string | null
  expireBy: number | null
  latestInvoicePaid: boolean
  cancelAtCycleEnd: boolean
  createdAt: number
  invoices: InvoiceView[]
  /**
   * Payments taken, oldest first.
   */
  payments: { paymentId: string; amountMinor: number }[]
}

/**
 * Statuses after which a subscription can no longer be cancelled.
 */
const ENDED_STATUSES: ReadonlySet<ProviderSubscriptionStatus> = new Set([
  'cancelled',
  'completed',
  'expired',
])

/**
 * A fake id: the prefix, `FAKE`, then random hex.
 * @param prefix - Razorpay's prefix for the kind of object, such as `sub`.
 * @returns The id.
 */
function fakeId(prefix: string): string {
  return `${prefix}_FAKE${randomBytes(7).toString('hex')}`
}

/**
 * A date from stored epoch milliseconds.
 * @param ms - The stored value.
 * @returns The date, or null.
 */
function dateOrNull(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms)
}

/**
 * The end of a cycle that starts at a time.
 * @param start - The cycle start in epoch milliseconds.
 * @param interval - The billing interval.
 * @returns The cycle end in epoch milliseconds.
 */
function cycleEnd(start: number, interval: BillingInterval): number {
  const end = new Date(start)
  if (interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1)
  else end.setUTCMonth(end.getUTCMonth() + 1)
  return end.getTime()
}

/**
 * Map a stored subscription to the provider shape.
 * @param record - The stored subscription.
 * @returns The subscription.
 */
function toSubscription(record: FakeSubscriptionRecord): ProviderSubscription {
  return {
    id: record.id,
    status: record.status,
    planId: record.planId,
    currentStart: dateOrNull(record.currentStart),
    currentEnd: dateOrNull(record.currentEnd),
    startAt: dateOrNull(record.startAt),
    createdAt: new Date(record.createdAt),
    endedAt: dateOrNull(record.endedAt),
    chargeAt: dateOrNull(record.chargeAt),
    notes: { ...record.notes },
    paidCount: record.paidCount,
    customerId: record.customerId,
    expireBy: dateOrNull(record.expireBy),
    hasScheduledChanges: false,
    latestInvoicePaid: record.status === 'active' && record.latestInvoicePaid,
  }
}

/**
 * The fake payment provider.
 */
export class FakeBillingProvider implements BillingProviderClient {
  readonly kind = 'fake' as const
  readonly mode = 'test' as const
  readonly keyId: string
  readonly #keySecret: string
  readonly #webhookSecrets: readonly string[]

  /**
   * @param config - The fake config `billingProviderConfig()` builds.
   */
  constructor(config: BillingProviderConfig) {
    this.keyId = config.keyId
    this.#keySecret = config.keySecret
    this.#webhookSecrets = [...config.webhookSecrets]
  }

  /**
   * Read one field of the fake's hash.
   * @param field - The field.
   * @returns The parsed value, or undefined when absent.
   */
  async #read<T>(field: string): Promise<T | undefined> {
    const value = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.hGet(redisKey('billing-fake'), field)
    }, 'fake billing read')
    return value === null ? undefined : (JSON.parse(value) as T)
  }

  /**
   * Write one field of the fake's hash.
   * @param field - The field.
   * @param value - The value, stored as JSON.
   */
  async #write(field: string, value: unknown): Promise<void> {
    await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.hSet(redisKey('billing-fake'), field, JSON.stringify(value))
    }, 'fake billing write')
  }

  /**
   * Read a stored subscription.
   * @param id - The subscription id.
   * @returns The stored subscription.
   * @throws {ProviderError} A non-retryable 400 for an unknown id, as Razorpay answers.
   */
  async #subscription(id: string): Promise<FakeSubscriptionRecord> {
    const record = await this.#read<FakeSubscriptionRecord>(`sub:${id}`)
    if (record === undefined) {
      throw new ProviderError(`GET /subscriptions/${id}`, 400, { code: 'BAD_REQUEST_ERROR' })
    }
    return record
  }

  /**
   * The stored plan id when the price has the fake's, else a new fake plan.
   * @param price - The price.
   * @param _planName - Unused; the fake keeps no names.
   * @returns The plan id.
   */
  async ensurePlan(price: ProviderPlanPrice, _planName: string): Promise<string> {
    if (
      price.providerPlanId !== null &&
      price.provider === this.kind &&
      price.providerMode === this.mode
    ) {
      return price.providerPlanId
    }
    const id = fakeId('plan')
    const plan: FakePlan = { amountMinor: price.amountMinor, interval: price.interval }
    await this.#write(`plan:${id}`, plan)
    return id
  }

  /**
   * Create a subscription in `created`, its id starting `sub_FAKE`.
   * @param input - The plan, deferred start and notes.
   * @returns The new subscription.
   * @throws {ProviderError} A non-retryable 400 for a plan the fake did not create.
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription> {
    const plan = await this.#read<FakePlan>(`plan:${input.providerPlanId}`)
    if (plan === undefined) {
      throw new ProviderError('POST /subscriptions', 400, { code: 'BAD_REQUEST_ERROR' })
    }
    const record: FakeSubscriptionRecord = {
      id: fakeId('sub'),
      status: 'created',
      planId: input.providerPlanId,
      amountMinor: plan.amountMinor,
      interval: plan.interval,
      currentStart: null,
      currentEnd: null,
      startAt: input.startAt?.getTime() ?? null,
      endedAt: null,
      chargeAt: input.startAt?.getTime() ?? null,
      notes: { ...input.notes },
      paidCount: 0,
      customerId: null,
      expireBy: input.expireBy.getTime(),
      latestInvoicePaid: false,
      cancelAtCycleEnd: false,
      createdAt: Date.now(),
      invoices: [],
      payments: [],
    }
    await this.#write(`sub:${record.id}`, record)
    return toSubscription(record)
  }

  /**
   * Read one subscription.
   * @param id - The subscription id.
   * @returns The subscription.
   */
  async fetchSubscription(id: string): Promise<ProviderSubscription> {
    return toSubscription(await this.#subscription(id))
  }

  /**
   * Every subscription created since a time.
   * @param since - The earliest creation time.
   * @returns The subscriptions.
   */
  async listRecentSubscriptions(since: Date): Promise<ProviderSubscription[]> {
    const all = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.hGetAll(redisKey('billing-fake'))
    }, 'fake billing list')
    return Object.entries(all)
      .filter(([field]) => field.startsWith('sub:'))
      .map(([, value]) => JSON.parse(value) as FakeSubscriptionRecord)
      .filter((record) => record.createdAt >= since.getTime())
      .map((record) => toSubscription(record))
  }

  /**
   * Cancel now, or mark a cycle-end cancel. A cycle-end cancel with no
   * running cycle, or any cancel of an ended subscription, is a 400.
   * @param id - The subscription id.
   * @param isAtCycleEnd - True to keep it until the cycle ends.
   * @returns The subscription after the cancel.
   * @throws {ProviderError} A non-retryable 400 when Razorpay would refuse.
   */
  async cancelSubscription(id: string, isAtCycleEnd: boolean): Promise<ProviderSubscription> {
    const record = await this.#subscription(id)
    const hasNoCycle = record.status === 'created' || record.status === 'authenticated'
    if (ENDED_STATUSES.has(record.status) || (isAtCycleEnd && hasNoCycle)) {
      throw new ProviderError(`POST /subscriptions/${id}/cancel`, 400, {
        code: 'BAD_REQUEST_ERROR',
      })
    }
    if (isAtCycleEnd) {
      record.cancelAtCycleEnd = true
    } else {
      record.status = 'cancelled'
      record.endedAt = Date.now()
      record.chargeAt = null
    }
    await this.#write(`sub:${id}`, record)
    return toSubscription(record)
  }

  /**
   * Refund the newest payment in full, once. The claim is one `HSETNX` on
   * the payment, so two callers at once cannot both refund it.
   * @param subscriptionId - The subscription id.
   * The fake refunds in full only, so it never answers `partly_refunded`.
   * @returns What the refund did.
   */
  async refundLatestPayment(subscriptionId: string): Promise<ProviderRefundOutcome> {
    const record = await this.#subscription(subscriptionId)
    const latest = record.payments.at(-1)
    if (latest === undefined) return { status: 'nothing_paid' }
    const refundId = fakeId('rfnd')
    const isClaimed = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.hSetNX(redisKey('billing-fake'), `refund:${latest.paymentId}`, refundId)
    }, 'fake billing refund')
    if (!isClaimed) return { status: 'already_refunded' }
    return { status: 'refunded', refundId, amountMinor: latest.amountMinor }
  }

  /**
   * Every invoice of the subscriptions, in the order given, newest first
   * within each, on one page; with `statuses`, only those of a listed status.
   * @param subscriptionIds - The subscriptions.
   * @param _cursor - Unused; the fake answers one page.
   * @param statuses - The statuses to list, or undefined for all.
   * @returns The page.
   */
  async listInvoices(
    subscriptionIds: string[],
    _cursor: string | null,
    statuses?: readonly InvoiceView['status'][]
  ): Promise<ProviderInvoicePage> {
    const items: ProviderInvoice[] = []
    for (const id of subscriptionIds) {
      const record = await this.#read<FakeSubscriptionRecord>(`sub:${id}`)
      if (record === undefined) continue
      for (const invoice of record.invoices.toReversed()) {
        if (statuses === undefined || statuses.includes(invoice.status)) {
          items.push({ ...invoice, subscriptionId: id })
        }
      }
    }
    return { items, nextCursor: null }
  }

  /**
   * The subscription that took a payment, from the stored subscriptions.
   * @param paymentId - The payment id.
   * @returns The subscription id, or null when no subscription took it.
   */
  async findSubscriptionIdForPayment(paymentId: string): Promise<string | null> {
    const all = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.hGetAll(redisKey('billing-fake'))
    }, 'fake billing payment lookup')
    for (const [field, value] of Object.entries(all)) {
      if (!field.startsWith('sub:')) continue
      const record = JSON.parse(value) as FakeSubscriptionRecord
      if (record.payments.some((payment) => payment.paymentId === paymentId)) return record.id
    }
    return null
  }

  /**
   * A stored dispute's status.
   * @param disputeId - The dispute id.
   * @returns The status.
   * @throws {ProviderError} A non-retryable 400 for an unknown dispute, as Razorpay answers.
   */
  async fetchDisputeStatus(disputeId: string): Promise<string> {
    const dispute = await this.#read<{ status: string }>(`dispute:${disputeId}`)
    if (dispute === undefined) {
      throw new ProviderError(`GET /disputes/${disputeId}`, 400, { code: 'BAD_REQUEST_ERROR' })
    }
    return dispute.status
  }

  /**
   * Test hook: store a dispute in a status, as Razorpay would after a
   * cardholder disputes a payment or the dispute ends.
   * @param disputeId - The dispute id.
   * @param status - Its status, such as `open` or `won`.
   */
  async fakeSetDispute(disputeId: string, status: string): Promise<void> {
    await this.#write(`dispute:${disputeId}`, { status })
  }

  /**
   * Whether a checkout was signed with the fake key secret for the expected subscription.
   * @param input - What the browser posted.
   * @param expectedSubscriptionId - The subscription the checkout must be for.
   * @returns True for a matching signature.
   */
  verifyCheckout(input: CheckoutConfirm, expectedSubscriptionId: string): boolean {
    return isValidCheckoutSignature(input, expectedSubscriptionId, this.#keySecret)
  }

  /**
   * Whether a webhook body was signed with the fake webhook secret.
   * @param rawBody - The exact request bytes.
   * @param signature - The signature header, if any.
   * @returns True for a matching signature.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    return isValidWebhookSignature(rawBody, signature, this.#webhookSecrets)
  }

  /**
   * Test hook: move a subscription to a status as Razorpay would. `active`
   * starts a new paid cycle with an invoice and a payment; `authenticated`
   * attaches a customer; `pending` and `halted` leave the cycle unpaid;
   * `paused` stops charging; an ended status stamps `endedAt`.
   * @param id - The subscription id.
   * @param status - The new status.
   * @returns The subscription after the move.
   */
  async fakeAdvance(id: string, status: ProviderSubscriptionStatus): Promise<ProviderSubscription> {
    const record = await this.#subscription(id)
    const now = Date.now()
    record.status = status
    if (status === 'authenticated' || status === 'active') record.customerId ??= fakeId('cust')
    if (status === 'active') {
      // A deferred start's first cycle begins at its start, as Razorpay's does, not when the test charges it.
      const start = record.paidCount === 0 && record.startAt !== null ? record.startAt : now
      const end = cycleEnd(start, record.interval)
      const paymentId = fakeId('pay')
      record.currentStart = start
      record.currentEnd = end
      record.chargeAt = record.cancelAtCycleEnd ? null : end
      record.startAt ??= now
      record.paidCount += 1
      record.latestInvoicePaid = true
      record.payments.push({ paymentId, amountMinor: record.amountMinor })
      record.invoices.push({
        id: fakeId('inv'),
        amountMinor: record.amountMinor,
        currency: 'INR',
        status: 'paid',
        issuedAt: new Date(now).toISOString(),
        paidAt: new Date(now).toISOString(),
        url: null,
      })
    } else if (status === 'pending' || status === 'halted') {
      record.latestInvoicePaid = false
    } else if (status === 'paused') {
      record.chargeAt = null
    } else if (ENDED_STATUSES.has(status)) {
      record.endedAt = now
      record.chargeAt = null
    }
    await this.#write(`sub:${id}`, record)
    return toSubscription(record)
  }

  /**
   * Test hook: move every date of a subscription back, as if it had been
   * created that much earlier, so `pnpm billing:time-travel` keeps the fake
   * in step with the workspace's row. An unknown id is skipped.
   * @param id - The subscription id.
   * @param ms - How far back, in milliseconds.
   */
  async fakeShiftBack(id: string, ms: number): Promise<void> {
    const record = await this.#read<FakeSubscriptionRecord>(`sub:${id}`)
    if (record === undefined) return
    /**
     * A stored epoch time, moved back.
     * @param value - The stored time, or null.
     * @returns The moved time, or null.
     */
    const shift = (value: number | null): number | null => (value === null ? null : value - ms)
    record.currentStart = shift(record.currentStart)
    record.currentEnd = shift(record.currentEnd)
    record.startAt = shift(record.startAt)
    record.endedAt = shift(record.endedAt)
    record.chargeAt = shift(record.chargeAt)
    record.expireBy = shift(record.expireBy)
    record.createdAt -= ms
    /**
     * A stored ISO time, moved back.
     * @param value - The stored time, or null.
     * @returns The moved time, or null.
     */
    const shiftIso = (value: string | null): string | null =>
      value === null ? null : new Date(Date.parse(value) - ms).toISOString()
    record.invoices = record.invoices.map((invoice) => ({
      ...invoice,
      issuedAt: shiftIso(invoice.issuedAt) ?? invoice.issuedAt,
      paidAt: shiftIso(invoice.paidAt),
    }))
    await this.#write(`sub:${id}`, record)
  }

  /**
   * Test hook: the checkout signature the browser would post for a payment.
   * @param paymentId - The payment id.
   * @param subscriptionId - The subscription id.
   * @returns The signature `verifyCheckout` accepts.
   */
  fakeSignCheckout(paymentId: string, subscriptionId: string): string {
    return checkoutSignature(paymentId, subscriptionId, this.#keySecret)
  }
}
