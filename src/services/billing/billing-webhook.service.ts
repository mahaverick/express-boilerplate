/**
 * @file Razorpay webhooks: the receipt the route runs and the handling the
 * billing Worker runs.
 *
 * The receipt has Razorpay's 5 s to answer, so it only verifies, records and
 * queues: the signature over the raw bytes (current or previous secret), the
 * event id from the `x-razorpay-event-id` header (the body has none), then an
 * `INSERT … ON CONFLICT DO NOTHING` into `billing_events` and one job. An
 * event for another environment is acknowledged and not recorded; a type
 * billing does not use is recorded as processed and not queued.
 *
 * The handling never trusts the event's own status: it finds the workspace
 * that holds the subscription and runs `syncTenantBilling`, which fetches
 * every subscription itself, so order and duplicates never matter. A
 * dispute only sets or clears the workspace's `dispute_open` flag and alerts
 * staff; it never changes the billing state.
 *
 * Only ids, the type and the outcome are stored or logged: a payload carries
 * the payer's address, phone and card ids, so the body is never kept, logged
 * or queued.
 */
import type { IncomingHttpHeaders } from 'node:http'
import { getEnv } from '@/configs/env.config'
import type { BillingAlertKind } from '@/constants/billing.constants'
import { ProviderError } from '@/errors/billing-provider-errors'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { addBillingWebhookJob, type BillingWebhookJobData } from '@/jobs/billing.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { withTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import type { BillingProviderClient, ProviderSubscription } from '@/types/billing'

const billingRepository = new BillingRepository()
const tenantRepository = new TenantRepository()

/**
 * The longest message `billing_alerts.message` stores.
 */
const ALERT_MESSAGE_MAX_LENGTH = 280

/**
 * The shape of a Razorpay id this app stores: a prefix, an underscore and
 * letters or digits, within the 64-character id columns.
 */
const PROVIDER_ID_PATTERN = /^[A-Za-z]+_[A-Za-z0-9]{1,58}$/

/**
 * The shape of the `x-razorpay-event-id` header this app stores. Razorpay
 * sends a bare id with no prefix (`TrbKyvYxfyP4cL`); it is only a dedupe key,
 * so any short id of safe characters is accepted.
 */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * The event types the sync acts on. Any other type is recorded and ignored.
 */
const SYNC_EVENT_TYPES: ReadonlySet<string> = new Set([
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.pending',
  'subscription.halted',
  'subscription.paused',
  'subscription.resumed',
  'subscription.cancelled',
  'subscription.completed',
  'subscription.updated',
  'payment.failed',
  'invoice.paid',
  'refund.processed',
])

/**
 * The dispute event that opens a dispute.
 */
const DISPUTE_OPENED = 'payment.dispute.created'

/**
 * The dispute events that end one.
 */
const DISPUTE_ENDED: ReadonlySet<string> = new Set([
  'payment.dispute.won',
  'payment.dispute.lost',
  'payment.dispute.closed',
])

/**
 * What the receipt did: `queued` a job, found a `duplicate` delivery, or
 * `ignored` an event of another environment or of a type billing does not use.
 */
type WebhookReceipt = 'queued' | 'duplicate' | 'ignored'

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
 * A value that has the shape of a provider id.
 * @param value - The value.
 * @returns The id, or null for anything else.
 */
function providerId(value: unknown): string | null {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value) ? value : null
}

/**
 * The entity of one part of an event's payload.
 * @param event - The parsed event.
 * @param part - The payload key, such as `subscription`.
 * @returns The entity, or `{}` when the event has no such part.
 */
function entityOf(event: JsonRecord, part: string): JsonRecord {
  return asRecord(asRecord(asRecord(event.payload)[part]).entity)
}

/**
 * The ids and the environment an event names.
 */
interface EventIds {
  type: string
  subscriptionId: string | null
  paymentId: string | null
  /**
   * The environment the subscription's or payment's notes name, if any.
   */
  appEnv: string | undefined
}

/**
 * Read the ids an event names. A subscription event names its
 * subscription; `invoice.paid` names it on the invoice; a refund, a dispute
 * or a payment event names a payment, which the Worker resolves.
 * @param event - The parsed event.
 * @returns The ids.
 */
function eventIdsOf(event: JsonRecord): EventIds {
  const subscription = entityOf(event, 'subscription')
  const invoice = entityOf(event, 'invoice')
  const payment = entityOf(event, 'payment')
  const paymentId =
    providerId(payment.id) ??
    providerId(entityOf(event, 'dispute').payment_id) ??
    providerId(entityOf(event, 'refund').payment_id)
  const notes = [asRecord(subscription.notes), asRecord(payment.notes)]
  const appEnv = notes.map((note) => note.appEnv).find((value) => typeof value === 'string')
  return {
    type: typeof event.event === 'string' ? event.event.slice(0, 64) : '',
    subscriptionId: providerId(subscription.id) ?? providerId(invoice.subscription_id),
    paymentId,
    appEnv: typeof appEnv === 'string' ? appEnv : undefined,
  }
}

/**
 * A header's single value.
 * @param headers - The request headers.
 * @param name - The lowercase header name.
 * @returns The value, or undefined when absent or repeated.
 */
function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * The provider that receives webhooks: Razorpay, never the fake.
 * @returns The client.
 * @throws {HttpError} The unknown-route 404 when payments are off or the provider is the fake.
 */
function webhookProvider(): BillingProviderClient {
  const provider = getBillingProvider()
  if (provider?.kind !== 'razorpay') throw notFoundError('route')
  return provider
}

/**
 * Whether billing acts on events of this type.
 * @param type - The event type.
 * @returns True for a sync or dispute event.
 */
function isHandledType(type: string): boolean {
  return SYNC_EVENT_TYPES.has(type) || type === DISPUTE_OPENED || DISPUTE_ENDED.has(type)
}

/**
 * Verify, record and queue one Razorpay webhook delivery.
 * @param rawBody - The exact body bytes, as Razorpay signed them.
 * @param headers - The request headers.
 * @returns What the receipt did.
 * @throws {HttpError} 404 when Razorpay is not the provider; 401 `INVALID_SIGNATURE`
 *   for a missing or wrong signature; 400 `INVALID_PAYLOAD` for a body that is
 *   not a JSON event or a missing event id. None writes a row.
 */
export async function receiveRazorpayWebhook(
  rawBody: Buffer,
  headers: IncomingHttpHeaders
): Promise<WebhookReceipt> {
  const provider = webhookProvider()
  if (!provider.verifyWebhook(rawBody, headerOf(headers, 'x-razorpay-signature'))) {
    logger.warn('Razorpay webhook signature rejected')
    throw new HttpError('Invalid signature', 401, 'INVALID_SIGNATURE')
  }
  let event: JsonRecord | undefined
  try {
    event = asRecord(JSON.parse(rawBody.toString('utf8')))
  } catch {
    event = undefined
  }
  if (typeof event?.event !== 'string') {
    logger.warn('Razorpay webhook payload rejected')
    throw new HttpError('Invalid payload', 400, 'INVALID_PAYLOAD')
  }
  const providerEventId = headerOf(headers, 'x-razorpay-event-id')
  if (providerEventId === undefined || !EVENT_ID_PATTERN.test(providerEventId)) {
    logger.warn('Razorpay webhook without an event id rejected')
    throw new HttpError('Missing event id', 400, 'INVALID_PAYLOAD')
  }
  const ids = eventIdsOf(event)
  if (ids.appEnv !== undefined && ids.appEnv !== getEnv().APP_ENV) {
    logger.debug('Razorpay webhook for another environment ignored', { providerEventId })
    return 'ignored'
  }

  const outcome = await billingRepository.recordEvent({
    provider: provider.kind,
    mode: provider.mode,
    providerEventId,
    type: ids.type,
    subscriptionId: ids.subscriptionId,
  })
  const stored = await billingRepository.findEvent(provider.kind, provider.mode, providerEventId)
  if (stored === undefined) throw new HttpError('Recorded event not found', 500)
  if (!isHandledType(ids.type)) {
    if (outcome === 'inserted') await billingRepository.markEventProcessed(stored.id)
    logger.info('Razorpay webhook of an unused type recorded', {
      providerEventId,
      type: ids.type,
    })
    return 'ignored'
  }
  // A duplicate whose first job never reached the queue is queued now; one that still waits is not queued twice.
  if (outcome === 'inserted' || stored.processedAt === null) {
    await addBillingWebhookJob({
      eventRowId: stored.id,
      providerEventId,
      eventType: ids.type,
      subscriptionId: ids.subscriptionId,
      paymentId: ids.paymentId,
    })
  }
  logger.info('Razorpay webhook received', { providerEventId, type: ids.type, outcome })
  return outcome === 'inserted' ? 'queued' : 'duplicate'
}

/**
 * Insert a staff alert unless the same kind already names the text for the
 * same workspace (or for none). A failure is logged: the event's outcome is
 * already decided.
 * @param tenantId - The workspace, or null when none is known.
 * @param kind - The alert kind.
 * @param dedupeText - The id the message names, which a repeat would name too.
 * @param message - The message.
 */
async function alertOnce(
  tenantId: string | null,
  kind: BillingAlertKind,
  dedupeText: string,
  message: string
): Promise<void> {
  try {
    if (await billingRepository.hasAlertNaming(tenantId, kind, dedupeText)) return
    await billingRepository.insertAlert({
      kind,
      tenantId,
      message: message.slice(0, ALERT_MESSAGE_MAX_LENGTH),
    })
  } catch (error) {
    logger.error('Could not record a billing alert', { error, tenantId, kind })
  }
}

/**
 * Fetch a subscription no row holds. A non-retryable answer (an id the
 * provider does not know) reads as no subscription; a retryable one throws.
 * @param provider - The payment provider.
 * @param subscriptionId - The subscription.
 * @returns The subscription, or undefined when the provider does not know it.
 * @throws {ProviderError} When the provider could not answer; the job retries.
 */
async function fetchUnknown(
  provider: BillingProviderClient,
  subscriptionId: string
): Promise<ProviderSubscription | undefined> {
  try {
    return await provider.fetchSubscription(subscriptionId)
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) return undefined
    throw error
  }
}

/**
 * The workspace a subscription's notes name, when it is a customer
 * workspace and the notes are this environment's.
 * @param sub - The fetched subscription.
 * @returns The workspace id, or undefined.
 */
async function notedTenant(sub: ProviderSubscription): Promise<string | undefined> {
  const { tenantId, appEnv } = sub.notes
  if (tenantId === undefined || appEnv !== getEnv().APP_ENV) return undefined
  const tenant = await tenantRepository.findById(tenantId)
  return tenant === undefined || tenant.isPlatform ? undefined : tenant.id
}

/**
 * Sync the workspace a subscription event concerns, then mark the event.
 * The workspace is the one whose row holds the subscription; when none
 * does, the subscription's own notes may name it (a paid checkout whose
 * pending id was lost), and the sync's checks decide whether it is adopted.
 * @param provider - The payment provider.
 * @param data - The job's payload.
 * @param subscriptionId - The subscription the event concerns.
 */
async function syncForSubscription(
  provider: BillingProviderClient,
  data: BillingWebhookJobData,
  subscriptionId: string
): Promise<void> {
  const row = await billingRepository.findBySubscriptionId(subscriptionId)
  let tenantId = row?.tenantId
  let extraSubscriptionIds: string[] = []
  if (tenantId === undefined) {
    const sub = await fetchUnknown(provider, subscriptionId)
    tenantId = sub === undefined ? undefined : await notedTenant(sub)
    if (tenantId === undefined) {
      await billingRepository.markEventProcessed(data.eventRowId, {
        error: 'unknown_subscription',
      })
      logger.warn('A billing webhook names a subscription no workspace holds', {
        providerEventId: data.providerEventId,
        subscriptionId,
      })
      if (sub !== undefined && sub.paidCount > 0) {
        await alertOnce(
          null,
          'reconcile_repair',
          subscriptionId,
          `Subscription ${subscriptionId} is paid, and no workspace here holds it. Check its notes at the provider.`
        )
      }
      return
    }
    extraSubscriptionIds = [subscriptionId]
  }
  const result = await syncTenantBilling(tenantId, 'webhook', { extraSubscriptionIds })
  await billingRepository.markEventProcessed(data.eventRowId, {
    tenantId,
    ...(result.outcome !== 'synced' && { error: result.outcome }),
  })
}

/**
 * Set or clear a workspace's dispute flag under its row lock, leaving every
 * other column alone.
 * @param tenantId - The workspace.
 * @param isOpen - The flag's new value.
 */
async function setDisputeOpen(tenantId: string, isOpen: boolean): Promise<void> {
  await withTransaction(async (tx) => {
    const locked = await billingRepository.lockByTenantId(tenantId, tx)
    if (locked === undefined || locked.disputeOpen === isOpen) return
    await billingRepository.updateVersioned(tenantId, locked.version, { disputeOpen: isOpen }, tx)
  })
}

/**
 * Flag or clear a dispute on the workspace that holds the disputed payment's
 * subscription, and alert staff once per payment when one opens. A payment
 * the provider cannot place is alerted with no workspace.
 * @param provider - The payment provider.
 * @param data - The job's payload.
 */
async function handleDispute(
  provider: BillingProviderClient,
  data: BillingWebhookJobData
): Promise<void> {
  const isOpened = data.eventType === DISPUTE_OPENED
  const { paymentId } = data
  let subscriptionId: string | null = null
  if (paymentId !== null) {
    try {
      subscriptionId = await provider.findSubscriptionIdForPayment(paymentId)
    } catch (error) {
      if (!(error instanceof ProviderError) || error.retryable) throw error
    }
  }
  const row =
    subscriptionId === null
      ? undefined
      : await billingRepository.findBySubscriptionId(subscriptionId)
  if (row === undefined) {
    await billingRepository.markEventProcessed(data.eventRowId, { error: 'unknown_subscription' })
    if (isOpened && paymentId !== null) {
      await alertOnce(
        null,
        'dispute',
        paymentId,
        `Payment ${paymentId} has a new dispute, and no workspace here holds its subscription. Respond at the provider.`
      )
    }
    return
  }
  await setDisputeOpen(row.tenantId, isOpened)
  await billingRepository.markEventProcessed(data.eventRowId, { tenantId: row.tenantId })
  if (isOpened && paymentId !== null) {
    await alertOnce(
      row.tenantId,
      'dispute',
      paymentId,
      `Payment ${paymentId} has a new dispute. Respond at the provider before its deadline.`
    )
  }
}

/**
 * Handle one stored webhook event: resolve its workspace and sync it, or
 * flag a dispute, then mark the event processed. An event that names no
 * subscription is marked processed with `no_subscription`.
 * @param data - The job's payload.
 * @throws {ProviderError} When the provider could not answer; nothing is marked, and the job retries when it is retryable.
 * @throws {BillingSyncConflictError} When the row kept changing; nothing is marked, and the job retries.
 */
export async function processBillingWebhookEvent(data: BillingWebhookJobData): Promise<void> {
  const provider = getBillingProvider()
  if (provider === null) {
    await billingRepository.markEventProcessed(data.eventRowId, { error: 'payments_off' })
    return
  }
  if (data.eventType === DISPUTE_OPENED || DISPUTE_ENDED.has(data.eventType)) {
    await handleDispute(provider, data)
    return
  }
  const subscriptionId =
    data.subscriptionId ??
    (data.paymentId === null ? null : await provider.findSubscriptionIdForPayment(data.paymentId))
  if (subscriptionId === null) {
    await billingRepository.markEventProcessed(data.eventRowId, { error: 'no_subscription' })
    return
  }
  await syncForSubscription(provider, data, subscriptionId)
}

/**
 * A short, id-only description of why a job failed, for `billing_events.error`.
 * @param error - What the last attempt threw.
 * @returns The status and code of a provider error, else the error's name.
 */
function failureSummary(error: Error): string {
  const cause = error.cause instanceof ProviderError ? error.cause : error
  if (cause instanceof ProviderError) {
    return `provider_error ${String(cause.status)}${cause.code === undefined ? '' : ` ${cause.code}`}`
  }
  return error.name
}

/**
 * Record a webhook job that will not be retried: mark its event failed and
 * alert staff once per event. Never rejects: it runs from the Worker's
 * `failed` listener.
 * @param data - The job's payload.
 * @param error - What its last attempt threw.
 */
export async function recordWebhookJobFailure(
  data: BillingWebhookJobData,
  error: Error
): Promise<void> {
  try {
    await billingRepository.markEventFailed(data.eventRowId, failureSummary(error))
    const row =
      data.subscriptionId === null
        ? undefined
        : await billingRepository.findBySubscriptionId(data.subscriptionId)
    await alertOnce(
      row?.tenantId ?? null,
      'webhook_failing',
      data.providerEventId,
      `Provider event ${data.providerEventId} (${data.eventType}) failed after every retry. Resync the workspace.`
    )
  } catch (recordError) {
    logger.error('Could not record a failed billing webhook job', {
      error: recordError,
      providerEventId: data.providerEventId,
    })
  }
}
