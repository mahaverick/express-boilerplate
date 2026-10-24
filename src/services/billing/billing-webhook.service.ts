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
 * dispute only sets or clears the workspace's `dispute_open` flag, from the
 * dispute's current status, and alerts staff; it never changes the billing
 * state. A subscription whose notes name another environment, read when no
 * row here holds it, marks the event `other_environment` with no alert.
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
 * The dispute events billing acts on. Each reads the dispute's current
 * status, so a late delivery cannot reopen a closed dispute.
 */
const DISPUTE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'payment.dispute.created',
  'payment.dispute.won',
  'payment.dispute.lost',
  'payment.dispute.closed',
])

/**
 * Dispute statuses that leave a dispute open.
 */
const OPEN_DISPUTE_STATUSES: ReadonlySet<string> = new Set(['open', 'under_review'])

/**
 * Dispute statuses that end a dispute.
 */
const ENDED_DISPUTE_STATUSES: ReadonlySet<string> = new Set(['won', 'lost', 'closed'])

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
  disputeId: string | null
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
    disputeId: providerId(entityOf(event, 'dispute').id),
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
  return SYNC_EVENT_TYPES.has(type) || DISPUTE_EVENT_TYPES.has(type)
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
      disputeId: ids.disputeId,
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
 * Whether a provider error says only that the id does not exist: a 404, or
 * the 400 `BAD_REQUEST_ERROR` Razorpay (and the fake) answer for an unknown
 * id. A 401, a 403 or an unexpected answer is not: it means the call itself
 * failed, and must fail the job loudly rather than read as "unknown".
 * @param error - What the read threw.
 * @returns True for an unknown-id answer.
 */
function isUnknownIdError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false
  return error.status === 404 || (error.status === 400 && error.code === 'BAD_REQUEST_ERROR')
}

/**
 * Run a provider read whose unknown-id answer means the provider does not
 * know the id. Every other failure throws: a retryable one for the job's
 * retry, any other one to fail the job, mark the event and alert staff.
 * @param read - The provider read.
 * @returns What it answered, or undefined when the provider does not know the id.
 * @throws {ProviderError} For any failure but an unknown id.
 */
async function unlessUnknown<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    if (isUnknownIdError(error)) return undefined
    throw error
  }
}

/**
 * Read a dispute's status. When a new dispute's status cannot be read for any
 * reason but an unknown id, staff are alerted once per payment with no
 * workspace before the job fails, so a response deadline is never silent.
 * @param provider - The payment provider.
 * @param data - The job's payload.
 * @param disputeId - The dispute.
 * @returns The status, or undefined when the provider does not know the dispute.
 * @throws {ProviderError} For any failure but an unknown id.
 */
async function readDisputeStatus(
  provider: BillingProviderClient,
  data: BillingWebhookJobData,
  disputeId: string
): Promise<string | undefined> {
  try {
    return await unlessUnknown(() => provider.fetchDisputeStatus(disputeId))
  } catch (error) {
    if (data.eventType === 'payment.dispute.created') {
      const named = data.paymentId ?? disputeId
      await alertOnce(
        null,
        'dispute',
        named,
        `Payment ${named} has a new dispute, and reading its status at the provider failed. Respond there before its deadline.`
      )
    }
    throw error
  }
}

/**
 * Whether a subscription's notes name another environment: a test account
 * shared by several environments delivers every one's events to each.
 * @param sub - The fetched subscription.
 * @returns True when the notes name an environment other than this one.
 */
function isOtherEnvironment(sub: ProviderSubscription): boolean {
  const { appEnv } = sub.notes
  return appEnv !== undefined && appEnv !== getEnv().APP_ENV
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
 * Mark an event that belongs to another environment: processed, no alert.
 * @param data - The job's payload.
 */
async function markOtherEnvironment(data: BillingWebhookJobData): Promise<void> {
  await billingRepository.markEventProcessed(data.eventRowId, { error: 'other_environment' })
  logger.debug('A billing webhook for another environment ignored', {
    providerEventId: data.providerEventId,
  })
}

/**
 * Sync the workspace a subscription event concerns, then mark the event.
 * The workspace is the one whose row holds the subscription; when none
 * does, the subscription is fetched: one whose notes name another
 * environment is ignored, and one whose notes name a workspace here (a paid
 * checkout whose pending id was lost) is offered to that workspace's sync,
 * whose checks decide whether it is adopted.
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
    const sub = await unlessUnknown(() => provider.fetchSubscription(subscriptionId))
    if (sub !== undefined && isOtherEnvironment(sub)) {
      await markOtherEnvironment(data)
      return
    }
    tenantId = sub === undefined ? undefined : await notedTenant(sub)
    if (tenantId === undefined) {
      logger.warn('A billing webhook names a subscription no workspace holds', {
        providerEventId: data.providerEventId,
        subscriptionId,
      })
      // The alert goes before the mark: a processed event has finished everything it does.
      if (sub !== undefined && sub.paidCount > 0) {
        await alertOnce(
          null,
          'reconcile_repair',
          subscriptionId,
          `Subscription ${subscriptionId} is paid, and no workspace here holds it. Check its notes at the provider.`
        )
      }
      await billingRepository.markEventProcessed(data.eventRowId, {
        error: 'unknown_subscription',
      })
      return
    }
    extraSubscriptionIds = [subscriptionId]
  }
  await billingRepository.setEventTenant(data.eventRowId, tenantId)
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
 * The subscription a payment was taken for. A payment the provider refuses
 * to read reads as unknown.
 * @param provider - The payment provider.
 * @param paymentId - The payment, if the event named one.
 * @returns The subscription id; null when the payment has none; undefined when the payment is unknown.
 */
async function subscriptionOfPayment(
  provider: BillingProviderClient,
  paymentId: string | null
): Promise<string | null | undefined> {
  if (paymentId === null) return undefined
  return unlessUnknown(() => provider.findSubscriptionIdForPayment(paymentId))
}

/**
 * Flag or clear a dispute on the workspace that holds the disputed payment's
 * subscription. The dispute's current status decides, never the event type,
 * so a late `created` after a `closed` leaves the flag cleared. Staff are
 * alerted once per payment while it is open. A dispute whose subscription
 * names another environment is ignored; one no workspace here can be tied
 * to is alerted with no workspace.
 * @param provider - The payment provider.
 * @param data - The job's payload.
 */
async function handleDispute(
  provider: BillingProviderClient,
  data: BillingWebhookJobData
): Promise<void> {
  const { paymentId, disputeId } = data
  const status = disputeId === null ? undefined : await readDisputeStatus(provider, data, disputeId)
  const isOpen = status !== undefined && OPEN_DISPUTE_STATUSES.has(status)
  if (status === undefined || (!isOpen && !ENDED_DISPUTE_STATUSES.has(status))) {
    await billingRepository.markEventProcessed(data.eventRowId, { error: 'unknown_dispute' })
    logger.warn('A billing dispute webhook has no readable dispute status', {
      providerEventId: data.providerEventId,
    })
    return
  }
  const subscriptionId = await subscriptionOfPayment(provider, paymentId)
  const row =
    typeof subscriptionId === 'string'
      ? await billingRepository.findBySubscriptionId(subscriptionId)
      : undefined
  if (row === undefined) {
    const sub =
      typeof subscriptionId === 'string'
        ? await unlessUnknown(() => provider.fetchSubscription(subscriptionId))
        : undefined
    if (sub !== undefined && isOtherEnvironment(sub)) {
      await markOtherEnvironment(data)
      return
    }
    if (isOpen && paymentId !== null) {
      await alertOnce(
        null,
        'dispute',
        paymentId,
        `Payment ${paymentId} has an open dispute, and no workspace here holds its subscription. Respond at the provider.`
      )
    }
    await billingRepository.markEventProcessed(data.eventRowId, { error: 'unknown_subscription' })
    return
  }
  await billingRepository.setEventTenant(data.eventRowId, row.tenantId)
  await setDisputeOpen(row.tenantId, isOpen)
  if (isOpen && paymentId !== null) {
    await alertOnce(
      row.tenantId,
      'dispute',
      paymentId,
      `Payment ${paymentId} has an open dispute. Respond at the provider before its deadline.`
    )
  }
  await billingRepository.markEventProcessed(data.eventRowId, { tenantId: row.tenantId })
}

/**
 * Handle one stored webhook event: resolve its workspace and sync it, or
 * flag a dispute, then mark the event processed. An event whose payment
 * the provider does not know is marked `unknown_subscription`; one whose
 * payment belongs to no subscription, `no_subscription`.
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
  if (DISPUTE_EVENT_TYPES.has(data.eventType)) {
    await handleDispute(provider, data)
    return
  }
  const subscriptionId =
    data.subscriptionId ?? (await subscriptionOfPayment(provider, data.paymentId))
  if (subscriptionId === undefined) {
    await billingRepository.markEventProcessed(data.eventRowId, { error: 'unknown_subscription' })
    return
  }
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
    // An event resolved through its payment names no subscription; its row keeps the workspace it resolved to.
    const event =
      row === undefined ? await billingRepository.findEventById(data.eventRowId) : undefined
    const tenantId = row?.tenantId ?? event?.tenantId ?? null
    await alertOnce(
      tenantId,
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
