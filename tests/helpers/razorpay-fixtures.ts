/**
 * @file Loads the Razorpay fixtures in `tests/fixtures/razorpay/` for the
 * webhook tests: a webhook delivery rewritten to name a test's own
 * subscription, workspace and event id, signed again with the dummy
 * `probe_webhook_secret`, and the subscription and invoice answers a fake
 * Razorpay API serves to the sync, rewritten the same way.
 */
import { createHmac, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RazorpayProvider } from '@/services/billing/razorpay-provider.service'

const FIXTURES = path.resolve('tests/fixtures/razorpay')

/**
 * The dummy secret every webhook fixture is signed with.
 */
export const PROBE_WEBHOOK_SECRET = 'probe_webhook_secret'

/**
 * A parsed JSON object.
 */
type JsonRecord = Record<string, unknown>

/**
 * A webhook fixture file.
 */
interface WebhookFixture {
  headers: { 'x-razorpay-event-id': string; 'x-razorpay-signature': string }
  rawBody: string
}

/**
 * An API answer fixture file.
 */
interface ApiFixture {
  json: JsonRecord
}

/**
 * A webhook delivery ready to post.
 */
export interface SignedWebhook {
  /**
   * The exact body bytes.
   */
  body: string
  /**
   * The event id and signature headers, plus the JSON content type.
   */
  headers: Record<string, string>
  /**
   * The event id the delivery carries.
   */
  eventId: string
}

/**
 * What a test rewrites in a delivery.
 */
export interface WebhookRewrite {
  /**
   * The subscription id, in the subscription entity and the invoice.
   */
  subscriptionId?: string
  /**
   * The workspace the subscription's notes name.
   */
  tenantId?: string
  /**
   * The environment the subscription's notes name.
   */
  appEnv?: string
  /**
   * The payment id, in the payment, invoice, refund and dispute entities.
   */
  paymentId?: string
  /**
   * The dispute id, in the dispute entity.
   */
  disputeId?: string
  /**
   * The event id header; defaults to a fresh one.
   */
  eventId?: string
}

/**
 * Read one fixture file.
 * @param name - The file name without `.json`.
 * @returns The parsed file.
 */
function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as T
}

/**
 * The value as an object, or undefined.
 * @param value - A parsed JSON value.
 * @returns The object, or undefined for anything else.
 */
function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

/**
 * The entity of one payload part of an event.
 * @param body - The event.
 * @param part - The payload key, such as `subscription`.
 * @returns The entity, or undefined when the event has no such part.
 */
function entityOf(body: JsonRecord, part: string): JsonRecord | undefined {
  return record(record(record(body.payload)?.[part])?.entity)
}

/**
 * The hex HMAC-SHA256 Razorpay sends for a body.
 * @param body - The exact body.
 * @param secret - The webhook secret; defaults to the dummy probe secret.
 * @returns The signature.
 */
export function razorpaySignature(body: string, secret = PROBE_WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * A fresh event id in Razorpay's shape: 14 letters and digits, no prefix.
 * @returns The id.
 */
function freshEventId(): string {
  return `T${randomUUID().replaceAll('-', '').slice(0, 13)}`
}

/**
 * A webhook fixture rewritten and signed again with the dummy probe secret.
 * @param name - The fixture file name without `.json`, such as `webhook-subscription.charged-synthetic`.
 * @param rewrite - The ids to put in it.
 * @returns The delivery.
 */
export function signedWebhook(name: string, rewrite: WebhookRewrite = {}): SignedWebhook {
  const fixture = readFixture<WebhookFixture>(name)
  const body = JSON.parse(fixture.rawBody) as JsonRecord
  const subscription = entityOf(body, 'subscription')
  if (subscription !== undefined) {
    if (rewrite.subscriptionId !== undefined) subscription.id = rewrite.subscriptionId
    const notes = record(subscription.notes) ?? {}
    if (rewrite.tenantId !== undefined) notes.tenantId = rewrite.tenantId
    if (rewrite.appEnv !== undefined) notes.appEnv = rewrite.appEnv
    subscription.notes = notes
  }
  const invoice = entityOf(body, 'invoice')
  if (invoice !== undefined && rewrite.subscriptionId !== undefined) {
    invoice.subscription_id = rewrite.subscriptionId
  }
  if (rewrite.paymentId !== undefined) {
    const payment = entityOf(body, 'payment')
    if (payment !== undefined) payment.id = rewrite.paymentId
    if (invoice !== undefined) invoice.payment_id = rewrite.paymentId
    for (const part of ['refund', 'dispute']) {
      const entity = entityOf(body, part)
      if (entity !== undefined) entity.payment_id = rewrite.paymentId
    }
  }
  const dispute = entityOf(body, 'dispute')
  if (dispute !== undefined && rewrite.disputeId !== undefined) dispute.id = rewrite.disputeId
  const raw = JSON.stringify(body)
  const eventId = rewrite.eventId ?? freshEventId()
  return {
    body: raw,
    eventId,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-event-id': eventId,
      'x-razorpay-signature': razorpaySignature(raw),
    },
  }
}

/**
 * The fake API's answer for `GET /subscriptions/:id`, from the captured
 * active subscription, with its current cycle around now.
 * @param input - What to put in it.
 * @param input.id - The subscription id.
 * @param input.tenantId - The workspace its notes name.
 * @param input.priceId - The price its notes name.
 * @param input.status - Its status; defaults to `active`.
 * @param input.appEnv - The environment its notes name; defaults to `local`, the suite's.
 * @param input.paidCount - Its paid cycles; defaults to 1.
 * @returns The answer and the cycle start in unix seconds, for the invoice.
 */
export function apiSubscription(input: {
  id: string
  tenantId: string
  priceId: string
  status?: string
  appEnv?: string
  paidCount?: number
}): { json: JsonRecord; currentStart: number } {
  const { json } = readFixture<ApiFixture>('api-subscription-active')
  const now = Math.floor(Date.now() / 1000)
  const currentStart = now - 24 * 3600
  const currentEnd = now + 29 * 24 * 3600
  return {
    currentStart,
    json: {
      ...json,
      id: input.id,
      status: input.status ?? 'active',
      notes: { tenantId: input.tenantId, appEnv: input.appEnv ?? 'local', priceId: input.priceId },
      current_start: currentStart,
      current_end: currentEnd,
      charge_at: currentEnd,
      start_at: currentStart,
      paid_count: input.paidCount ?? 1,
    },
  }
}

/**
 * The fake API's answer for `GET /invoices?subscription_id=…`: the captured
 * paid invoice, for the subscription's current cycle.
 * @param subscriptionId - The subscription.
 * @param currentStart - The cycle start in unix seconds, as `apiSubscription` returned it.
 * @returns The answer.
 */
export function apiPaidInvoices(subscriptionId: string, currentStart: number): JsonRecord {
  const { json } = readFixture<ApiFixture>('api-invoices-paid')
  const items = Array.isArray(json.items) ? json.items : []
  return {
    ...json,
    items: items.map((item) => ({
      ...record(item),
      subscription_id: subscriptionId,
      billing_start: currentStart,
    })),
  }
}

/**
 * A Razorpay client for the webhook tests: fake test keys, the given webhook
 * secrets, and a fake API at `baseUrl`.
 * @param baseUrl - The fake API's base, from `startFakeRazorpay()`.
 * @param webhookSecrets - The webhook secrets, current first; defaults to the probe secret.
 * @returns The client.
 */
export function razorpayTestProvider(
  baseUrl: string,
  webhookSecrets: string[] = [PROBE_WEBHOOK_SECRET]
): RazorpayProvider {
  return new RazorpayProvider(
    {
      kind: 'razorpay',
      mode: 'test',
      keyId: 'rzp_test_FAKEwebhook1',
      keySecret: 'rzp_secret_FAKE_for_tests',
      webhookSecrets,
    },
    { baseUrl, timeoutMs: 2000 }
  )
}
