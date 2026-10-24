/**
 * @file The Razorpay client behind billing. Every call uses HTTP Basic auth
 * with the key id and secret, refuses redirects, and fails after
 * `RAZORPAY_API_TIMEOUT_MS`. A failure throws `ProviderError`: a timeout, a
 * network failure or a 5xx is retryable, a 4xx is not. Mutating calls on one
 * subscription run one at a time in this process, since Razorpay answers 400
 * to concurrent changes. Nothing here logs a request body, a response body or
 * a credential; errors carry ids, the status and Razorpay's error code only.
 */
import type { BillingProviderConfig } from '@/configs/billing.config'
import {
  RAZORPAY_API_BASE_URL,
  RAZORPAY_API_TIMEOUT_MS,
  type BillingProviderMode,
} from '@/constants/billing.constants'
import { ProviderError } from '@/errors/billing-provider-errors'
import { logger } from '@/services/logger.service'
import type {
  BillingProviderClient,
  CheckoutConfirm,
  CreateSubscriptionInput,
  InvoiceView,
  ProviderInvoicePage,
  ProviderPlanPrice,
  ProviderRefund,
  ProviderSubscription,
  ProviderSubscriptionStatus,
} from '@/types/billing'
import {
  isValidCheckoutSignature,
  isValidWebhookSignature,
} from '@/utilities/billing-signature.utilities'

/**
 * Every subscription status Razorpay reports.
 */
const SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set<ProviderSubscriptionStatus>([
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'paused',
  'cancelled',
  'completed',
  'expired',
])

/**
 * Razorpay invoice statuses and the owner-facing status each maps to; a
 * draft or deleted invoice is not shown.
 */
const INVOICE_STATUSES: Readonly<Record<string, InvoiceView['status']>> = {
  issued: 'issued',
  partially_paid: 'issued',
  paid: 'paid',
  cancelled: 'cancelled',
  expired: 'expired',
}

/**
 * How many subscriptions one reconcile page reads (Razorpay's maximum).
 */
const SUBSCRIPTION_PAGE_SIZE = 100

/**
 * The most subscription pages one reconcile sweep reads.
 */
const MAX_SUBSCRIPTION_PAGES = 100

/**
 * How many invoices one owner page reads.
 */
const INVOICE_PAGE_SIZE = 20

/**
 * How many of a subscription's newest invoices the paid check reads.
 */
const RECENT_INVOICE_COUNT = 25

/**
 * A parsed JSON object.
 */
type JsonRecord = Record<string, unknown>

/**
 * The value as an object, or an empty one.
 * @param value - A parsed JSON value.
 * @returns The object, or `{}` for anything else.
 */
function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

/**
 * A unix-seconds field as a date.
 * @param value - The field.
 * @returns The date, or null when the field is not a number.
 */
function dateFrom(value: unknown): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null
}

/**
 * A field as a string.
 * @param value - The field.
 * @returns The string, or null when the field is not one.
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Notes as a string map. Razorpay sends `[]` for empty notes.
 * @param value - The `notes` field.
 * @returns Each note as a string.
 */
function notesFrom(value: unknown): Record<string, string> {
  const notes: Record<string, string> = {}
  for (const [key, note] of Object.entries(asRecord(value))) {
    if (typeof note === 'string') notes[key] = note
    else if (typeof note === 'number' || typeof note === 'boolean') notes[key] = String(note)
  }
  return notes
}

/**
 * The `items` of a collection answer.
 * @param value - The parsed answer.
 * @returns Each item as an object.
 */
function itemsOf(value: unknown): JsonRecord[] {
  const items = asRecord(value).items
  return Array.isArray(items) ? items.map((item) => asRecord(item)) : []
}

/**
 * The invoice that decides whether the current cycle is paid: only the one
 * whose billing period starts at the cycle's start. Razorpay moves the cycle
 * forward before it is paid, and a charge-now issues a newer invoice at once,
 * so neither the newest nor an older paid invoice says anything about this
 * cycle. With no match the answer is undefined, which reads as unpaid.
 * @param invoices - The subscription's invoices.
 * @param currentStart - The cycle start in unix seconds, if any.
 * @returns The invoice, or undefined when no invoice belongs to the cycle.
 */
function currentCycleInvoice(
  invoices: JsonRecord[],
  currentStart: unknown
): JsonRecord | undefined {
  if (typeof currentStart !== 'number') return undefined
  return invoices.find((invoice) => invoice.billing_start === currentStart)
}

/**
 * Map a Razorpay invoice for owners.
 * @param invoice - The invoice.
 * @returns The view, or null for a draft, a deleted or a malformed invoice.
 */
function invoiceView(invoice: JsonRecord): InvoiceView | null {
  const status = INVOICE_STATUSES[String(invoice.status)]
  const issuedAt = dateFrom(invoice.issued_at) ?? dateFrom(invoice.created_at)
  if (status === undefined || typeof invoice.id !== 'string' || issuedAt === null) return null
  return {
    id: invoice.id,
    amountMinor: typeof invoice.amount === 'number' ? invoice.amount : 0,
    currency: 'INR',
    status,
    issuedAt: issuedAt.toISOString(),
    paidAt: dateFrom(invoice.paid_at)?.toISOString() ?? null,
    url: stringOrNull(invoice.short_url),
  }
}

/**
 * Parse an owner invoice cursor: `<subscription index>:<skip>`.
 * @param cursor - The cursor, or null for the first page.
 * @param count - How many subscriptions the caller passed.
 * @returns The subscription index and how many invoices to skip.
 * @throws {ProviderError} A non-retryable 400 for a cursor this client did not make.
 */
function parseInvoiceCursor(cursor: string | null, count: number): { index: number; skip: number } {
  if (cursor === null) return { index: 0, skip: 0 }
  const match = /^(\d{1,4}):(\d{1,6})$/.exec(cursor)
  const index = Number(match?.[1])
  const skip = Number(match?.[2])
  if (match === null || index >= count) {
    throw new ProviderError('listInvoices', 400, { code: 'INVALID_CURSOR' })
  }
  return { index, skip }
}

/**
 * Whether an error is `AbortSignal.timeout`'s.
 * @param error - What `fetch` or the body read threw.
 * @returns True for a `TimeoutError`.
 */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

/**
 * Parse a response body as JSON.
 * @param text - The body.
 * @returns The value, or undefined when empty or not JSON.
 */
function parsedJson(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * The Razorpay client.
 */
export class RazorpayProvider implements BillingProviderClient {
  readonly kind = 'razorpay' as const
  readonly mode: BillingProviderMode
  readonly keyId: string
  readonly #keySecret: string
  readonly #webhookSecrets: readonly string[]
  readonly #authorization: string
  readonly #baseUrl: string
  readonly #timeoutMs: number
  /**
   * The last mutation queued for each subscription id; each link never rejects.
   */
  readonly #chains = new Map<string, Promise<unknown>>()

  /**
   * @param config - The keys, mode and webhook secrets.
   * @param options - Test seams.
   * @param options.baseUrl - The API base; defaults to `RAZORPAY_API_BASE_URL`.
   * @param options.timeoutMs - The per-call timeout; defaults to `RAZORPAY_API_TIMEOUT_MS`.
   */
  constructor(
    config: BillingProviderConfig,
    options: { baseUrl?: string; timeoutMs?: number } = {}
  ) {
    this.mode = config.mode
    this.keyId = config.keyId
    this.#keySecret = config.keySecret
    this.#webhookSecrets = [...config.webhookSecrets]
    this.#authorization = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`
    this.#baseUrl = options.baseUrl ?? RAZORPAY_API_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? RAZORPAY_API_TIMEOUT_MS
  }

  /**
   * Call the API and answer the parsed JSON of a 2xx.
   * @param method - The HTTP method.
   * @param path - The path under the base, without a query.
   * @param options - The body and query.
   * @param options.body - A JSON body.
   * @param options.query - Query parameters.
   * @returns The parsed body.
   * @throws {ProviderError} On any non-2xx, a timeout or a network failure.
   */
  async #call(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; query?: Record<string, string> } = {}
  ): Promise<unknown> {
    const what = `${method} ${path}`
    const search =
      options.query === undefined ? '' : `?${new URLSearchParams(options.query).toString()}`
    const headers: Record<string, string> = {
      authorization: this.#authorization,
      accept: 'application/json',
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    let status: number
    let text: string
    try {
      const response = await fetch(`${this.#baseUrl}${path}${search}`, {
        method,
        headers,
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
      status = response.status
      text = await response.text()
    } catch (error) {
      throw new ProviderError(
        what,
        isTimeoutError(error) ? 'timeout' : 'network',
        {},
        { cause: error }
      )
    }
    const json = parsedJson(text)
    if (status < 200 || status >= 300) {
      const error = asRecord(asRecord(json).error)
      throw new ProviderError(what, status, {
        code: stringOrNull(error.code) ?? undefined,
        description: stringOrNull(error.description) ?? undefined,
      })
    }
    return json
  }

  /**
   * Run one mutation on a subscription after the ones queued before it.
   * @param subscriptionId - The subscription.
   * @param run - The mutation.
   * @returns The mutation's result.
   */
  async #serialised<T>(subscriptionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(subscriptionId) ?? Promise.resolve()
    const current = (async () => {
      await previous
      return run()
    })()
    const tail = (async () => {
      try {
        await current
      } catch {
        // The caller gets the failure; the next mutation still runs.
      }
    })()
    this.#chains.set(subscriptionId, tail)
    try {
      return await current
    } finally {
      if (this.#chains.get(subscriptionId) === tail) this.#chains.delete(subscriptionId)
    }
  }

  /**
   * A subscription's newest invoices.
   * @param subscriptionId - The subscription.
   * @returns The invoices.
   */
  async #recentInvoices(subscriptionId: string): Promise<JsonRecord[]> {
    const json = await this.#call('GET', '/invoices', {
      query: { subscription_id: subscriptionId, count: String(RECENT_INVOICE_COUNT) },
    })
    return itemsOf(json)
  }

  /**
   * Map a Razorpay subscription.
   * @param raw - The parsed subscription.
   * @param isLatestInvoicePaid - Whether its current cycle's invoice is paid.
   * @returns The subscription.
   * @throws {ProviderError} A non-retryable error when the answer is not a subscription.
   */
  #toSubscription(raw: unknown, isLatestInvoicePaid: boolean): ProviderSubscription {
    const record = asRecord(raw)
    const status = String(record.status)
    if (typeof record.id !== 'string' || !SUBSCRIPTION_STATUSES.has(status)) {
      throw new ProviderError('subscription answer', 200, { code: 'UNEXPECTED_ANSWER' })
    }
    return {
      id: record.id,
      status: status as ProviderSubscriptionStatus,
      planId: stringOrNull(record.plan_id) ?? '',
      currentStart: dateFrom(record.current_start),
      currentEnd: dateFrom(record.current_end),
      startAt: dateFrom(record.start_at),
      endedAt: dateFrom(record.ended_at),
      chargeAt: dateFrom(record.charge_at),
      notes: notesFrom(record.notes),
      paidCount: typeof record.paid_count === 'number' ? record.paid_count : 0,
      customerId: stringOrNull(record.customer_id),
      hasScheduledChanges: record.has_scheduled_changes === true,
      latestInvoicePaid: isLatestInvoicePaid,
    }
  }

  /**
   * Map a subscription, reading whether its current cycle is paid only while
   * it is `active`: every other status reads unpaid without an invoice call.
   * @param raw - The parsed subscription.
   * @returns The subscription.
   */
  async #withInvoiceState(raw: unknown): Promise<ProviderSubscription> {
    const record = asRecord(raw)
    const unchecked = this.#toSubscription(raw, false)
    if (unchecked.status !== 'active') return unchecked
    const invoice = currentCycleInvoice(
      await this.#recentInvoices(unchecked.id),
      record.current_start
    )
    return { ...unchecked, latestInvoicePaid: invoice?.status === 'paid' }
  }

  /**
   * The provider plan for a price: the stored id when it is this provider's
   * and mode's, else a new monthly or yearly plan. The caller stores a new id.
   * @param price - The price.
   * @param planName - The plan item's name.
   * @returns The provider plan id.
   */
  async ensurePlan(price: ProviderPlanPrice, planName: string): Promise<string> {
    if (
      price.providerPlanId !== null &&
      price.provider === this.kind &&
      price.providerMode === this.mode
    ) {
      return price.providerPlanId
    }
    const json = await this.#call('POST', '/plans', {
      body: {
        period: price.interval === 'year' ? 'yearly' : 'monthly',
        interval: 1,
        item: { name: planName, amount: price.amountMinor, currency: price.currency },
        notes: { priceId: price.id },
      },
    })
    const id = asRecord(json).id
    if (typeof id !== 'string') {
      throw new ProviderError('POST /plans', 200, { code: 'UNEXPECTED_ANSWER' })
    }
    return id
  }

  /**
   * Create a subscription for checkout. A new subscription has no paid invoice.
   * @param input - The plan, cycle count, checkout expiry, deferred start and notes.
   * @returns The new subscription.
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription> {
    const json = await this.#call('POST', '/subscriptions', {
      body: {
        plan_id: input.providerPlanId,
        total_count: input.totalCount,
        expire_by: Math.floor(input.expireBy.getTime() / 1000),
        ...(input.startAt !== null && { start_at: Math.floor(input.startAt.getTime() / 1000) }),
        customer_notify: 1,
        notes: input.notes,
      },
    })
    return this.#toSubscription(json, false)
  }

  /**
   * Read one subscription and whether its current cycle is paid.
   * @param id - The subscription id.
   * @returns The subscription.
   */
  async fetchSubscription(id: string): Promise<ProviderSubscription> {
    const json = await this.#call('GET', `/subscriptions/${encodeURIComponent(id)}`)
    return this.#withInvoiceState(json)
  }

  /**
   * Every subscription created since a time, every page read, each with
   * whether its current cycle is paid.
   * @param since - The earliest creation time.
   * @returns The subscriptions.
   */
  async listRecentSubscriptions(since: Date): Promise<ProviderSubscription[]> {
    const from = String(Math.floor(since.getTime() / 1000))
    const found: ProviderSubscription[] = []
    for (let page = 0; page < MAX_SUBSCRIPTION_PAGES; page += 1) {
      const items = itemsOf(
        await this.#call('GET', '/subscriptions', {
          query: {
            from,
            count: String(SUBSCRIPTION_PAGE_SIZE),
            skip: String(page * SUBSCRIPTION_PAGE_SIZE),
          },
        })
      )
      for (const item of items) found.push(await this.#withInvoiceState(item))
      if (items.length < SUBSCRIPTION_PAGE_SIZE) return found
    }
    logger.warn('The Razorpay reconcile sweep stopped at its page limit', {
      pages: MAX_SUBSCRIPTION_PAGES,
    })
    return found
  }

  /**
   * Cancel a subscription now or at its cycle end. When the cancel succeeds
   * but the invoice read after it fails, the cycle reads as unpaid, which
   * keeps the last paid period end.
   * @param id - The subscription id.
   * @param isAtCycleEnd - True to keep it until the cycle ends.
   * @returns The subscription after the cancel.
   */
  async cancelSubscription(id: string, isAtCycleEnd: boolean): Promise<ProviderSubscription> {
    return this.#serialised(id, async () => {
      const json = await this.#call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, {
        body: { cancel_at_cycle_end: isAtCycleEnd ? 1 : 0 },
      })
      try {
        return await this.#withInvoiceState(json)
      } catch (error) {
        if (!(error instanceof ProviderError) || error.status === 200) throw error
        logger.warn('Reading invoices after a Razorpay cancel failed', {
          subscriptionId: id,
          error,
        })
        return this.#toSubscription(json, false)
      }
    })
  }

  /**
   * Refund the payment of the subscription's newest paid invoice in full.
   * @param subscriptionId - The subscription id.
   * @returns The refund, or null when no invoice is paid.
   */
  async refundLatestPayment(subscriptionId: string): Promise<ProviderRefund | null> {
    return this.#serialised(subscriptionId, async () => {
      const invoices = await this.#recentInvoices(subscriptionId)
      const paid = invoices
        .filter((invoice) => invoice.status === 'paid' && typeof invoice.payment_id === 'string')
        .toSorted((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0]
      if (paid === undefined) return null
      const paymentId = String(paid.payment_id)
      const json = asRecord(
        await this.#call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { body: {} })
      )
      if (typeof json.id !== 'string' || typeof json.amount !== 'number') {
        throw new ProviderError('refund answer', 200, { code: 'UNEXPECTED_ANSWER' })
      }
      return { refundId: json.id, amountMinor: json.amount }
    })
  }

  /**
   * One page of invoices: the first subscription's pages, then the next one's.
   * @param subscriptionIds - The subscriptions, newest first.
   * @param cursor - The previous page's `nextCursor`, or null.
   * @returns The page.
   */
  async listInvoices(
    subscriptionIds: string[],
    cursor: string | null
  ): Promise<ProviderInvoicePage> {
    if (subscriptionIds.length === 0) return { items: [], nextCursor: null }
    const { index, skip } = parseInvoiceCursor(cursor, subscriptionIds.length)
    const items = itemsOf(
      await this.#call('GET', '/invoices', {
        query: {
          subscription_id: subscriptionIds[index] ?? '',
          count: String(INVOICE_PAGE_SIZE),
          skip: String(skip),
        },
      })
    )
    let nextCursor: string | null = null
    if (items.length >= INVOICE_PAGE_SIZE)
      nextCursor = `${String(index)}:${String(skip + items.length)}`
    else if (index + 1 < subscriptionIds.length) nextCursor = `${String(index + 1)}:0`
    return {
      items: items
        .map((item) => invoiceView(item))
        .filter((view): view is InvoiceView => view !== null),
      nextCursor,
    }
  }

  /**
   * Whether a checkout was signed with the key secret for the expected subscription.
   * @param input - What the browser posted.
   * @param expectedSubscriptionId - The subscription the checkout must be for.
   * @returns True for a matching signature.
   */
  verifyCheckout(input: CheckoutConfirm, expectedSubscriptionId: string): boolean {
    return isValidCheckoutSignature(input, expectedSubscriptionId, this.#keySecret)
  }

  /**
   * Whether a webhook body was signed with the current or previous secret.
   * @param rawBody - The exact request bytes.
   * @param signature - The signature header, if any.
   * @returns True for a matching signature.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    return isValidWebhookSignature(rawBody, signature, this.#webhookSecrets)
  }
}
