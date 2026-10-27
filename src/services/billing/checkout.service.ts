/**
 * @file A workspace owner's billing: the checkout for Paid, its confirm, the
 * interval switch, the card change, the cancel, the billing read and the
 * invoice list. Every write takes the owner's membership (never platform
 * access) under lock, then the billing row, in the documented lock order.
 * Provider calls never run inside a transaction: a write reads the row in
 * one short transaction, calls the provider, then writes in a second short
 * transaction that re-locks the row and starts over when the row moved in
 * between. Provider state reaches the row only through `syncTenantBilling`,
 * except what the provider does not show: a cycle-end cancel, the pending or
 * next checkout's id, and the payer.
 *
 * A checkout while the current subscription is cancelling is a resubscribe:
 * the new subscription starts at the period end and is stored as the next
 * one, which the sync hands over to when the current one ends. A row left
 * with another provider or mode is taken over only while it has no live
 * subscription.
 */
import { z } from 'zod'
import { gstSellerConfig } from '@/configs/billing.config'
import { getEnv } from '@/configs/env.config'
import {
  BILLING_BUSY_CODE,
  BILLING_OWNER_ONLY_MESSAGE,
  CHECKOUT_EXPIRY_MS,
  CHECKOUT_MISMATCH_CODE,
  CHECKOUT_REUSE_MIN_REMAINING_MS,
  CHECKOUT_TOTAL_COUNT,
  INVOICE_PAGE_SIZE,
  INVOICES_OWNER_ONLY_MESSAGE,
  NEXT_CHECKOUT_MARGIN_MS,
  NO_SUBSCRIPTION_CODE,
  SAME_INTERVAL_CODE,
  SUBSCRIPTION_EXISTS_CODE,
  SWITCH_BEFORE_FIRST_CHARGE_CODE,
  SWITCH_TOO_CLOSE_TO_RENEWAL_CODE,
  type BillingInterval,
  type InvoiceStatus,
  type StaffCancelWhen,
} from '@/constants/billing.constants'
import type {
  NewTenantBilling,
  PlanPrice,
  TenantBillingRecord,
} from '@/database/models/billing.model'
import { HttpError } from '@/errors/http-error'
import { InvalidCursorError } from '@/errors/list-errors'
import { notFoundError } from '@/errors/not-found-errors'
import {
  displayName,
  nameOrEmail,
  toPriceView,
  type CheckoutPurpose,
  type CheckoutSession,
  type TenantBillingView,
} from '@/presenters/billing.presenter'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TaxRepository } from '@/repositories/tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import {
  trackCheckoutConfirmed,
  trackCheckoutStarted,
} from '@/services/billing/billing-analytics.service'
import { formatBillingDate } from '@/services/billing/billing-dates.service'
import { emitBillingDiff } from '@/services/billing/billing-events.service'
import {
  callProvider,
  getBillingProvider,
  providerFailure,
  RETRY_AFTER_SECONDS,
} from '@/services/billing/billing-provider.service'
import {
  BillingSyncConflictError,
  syncTenantBilling,
} from '@/services/billing/billing-sync.service'
import { clearCancelMarker, markCancel } from '@/services/billing/cancel-marker.service'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { lockBilling } from '@/services/billing/trial.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { lockActorRole } from '@/services/tenant-membership.service'
import type { Actor } from '@/types/actor'
import type {
  BillingProviderClient,
  CheckoutConfirm,
  InvoiceListOptions,
  ProviderInvoice,
  ProviderSubscription,
  SourcedEntitlements,
} from '@/types/billing'
import type { LinkedInvoice, OwnerInvoiceView } from '@/types/tax'
import { taxStatusOf } from '@/utilities/gst.utilities'
import { bindScope, listScope, signCursor, verifyCursor } from '@/utilities/list-cursor.utilities'
import type { ListPage } from '@/utilities/list-page.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()
const membershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()
const taxRepository = new TaxRepository()

/**
 * How many times a write reads, calls the provider and writes before it
 * gives up on a row that keeps moving.
 */
const WRITE_ATTEMPTS = 3

/**
 * The sort and list name the invoice cursor is bound to.
 */
const INVOICE_LIST = 'tenant-billing-invoices'

/**
 * The sort and list name the staff invoice cursor is bound to.
 */
const STAFF_INVOICE_LIST = 'platform-tenant-billing-invoices'

/**
 * The most provider calls one staff invoice page makes before it answers
 * short with a cursor.
 */
const STAFF_INVOICE_MAX_READS = 10

/**
 * The most subscriptions the invoice list reads, newest first.
 */
const MAX_INVOICE_SUBSCRIPTIONS = 50

/**
 * The longest provider page cursor an invoice cursor may carry.
 */
const MAX_PROVIDER_CURSOR_LENGTH = 64

/**
 * Statuses after which a subscription can no longer be cancelled.
 */
export const ENDED_STATUSES: ReadonlySet<ProviderSubscription['status']> = new Set([
  'cancelled',
  'completed',
  'expired',
])

/**
 * The 400 for a confirm that is not this workspace's own checkout.
 * @returns The error.
 */
function checkoutMismatch(): HttpError {
  return new HttpError(
    "This payment doesn't match your workspace's checkout. Start the checkout again from Billing.",
    400,
    CHECKOUT_MISMATCH_CODE
  )
}

/**
 * The 400 for a confirm of this workspace's own checkout that a newer one
 * replaced.
 * @returns The error.
 */
function checkoutReplaced(): HttpError {
  return new HttpError(
    'This checkout was replaced. Open Billing to see the current one.',
    400,
    CHECKOUT_MISMATCH_CODE
  )
}

/**
 * The refusal of a confirm whose subscription the row does not hold: the
 * replaced one when the provider signed it and its notes name this
 * workspace (a checkout a newer one replaced), else the mismatch. A failed
 * read answers the mismatch.
 * @param provider - The running provider.
 * @param tenantId - The workspace.
 * @param body - What the provider's checkout handed the browser.
 * @returns The error.
 */
async function unheldConfirmRefusal(
  provider: BillingProviderClient,
  tenantId: string,
  body: CheckoutConfirm
): Promise<HttpError> {
  const posted = body.razorpay_subscription_id
  if (!provider.verifyCheckout(body, posted)) return checkoutMismatch()
  try {
    const sub = await provider.fetchSubscription(posted)
    return sub.notes.tenantId === tenantId ? checkoutReplaced() : checkoutMismatch()
  } catch (error) {
    logger.warn('Could not read a confirmed checkout the workspace does not hold', {
      error,
      tenantId,
      subscriptionId: posted,
    })
    return checkoutMismatch()
  }
}

/**
 * The 409 for a checkout while a live subscription runs.
 * @param message - What the owner reads.
 * @returns The error.
 */
function subscriptionExists(message: string): HttpError {
  return new HttpError(message, 409, SUBSCRIPTION_EXISTS_CODE)
}

/**
 * The 409 for a write that needs a subscription the workspace does not have.
 * @param message - What the owner reads.
 * @returns The error.
 */
function noSubscription(message: string): HttpError {
  return new HttpError(message, 409, NO_SUBSCRIPTION_CODE)
}

/**
 * The 503 for a write that found the billing row busy on every attempt.
 * @returns The error.
 */
export function billingBusy(): HttpError {
  return new HttpError(
    'Your billing is updating right now. Try again in 30 seconds.',
    503,
    BILLING_BUSY_CODE,
    undefined,
    { retryAfterSeconds: RETRY_AFTER_SECONDS }
  )
}

/**
 * The configured provider.
 * @returns The provider.
 * @throws {HttpError} The unknown-route 404 when payments are off.
 */
function requireProvider(): BillingProviderClient {
  const provider = getBillingProvider()
  if (provider === null) throw notFoundError('route')
  return provider
}

/**
 * Refuse the platform workspace, which has no billing.
 * @param tenantId - The workspace.
 * @throws {HttpError} The unknown-route 404 for the platform workspace.
 */
async function assertCustomerTenant(tenantId: string): Promise<void> {
  const tenant = await tenantRepository.findById(tenantId)
  if (tenant === undefined) throw notFoundError('tenant')
  if (tenant.isPlatform) throw notFoundError('route')
}

/**
 * Lock the actor's access to the workspace and refuse anyone but an owner by
 * membership, staff acting through a platform role included, with the
 * billing refusal the route's gate gives.
 * @param actor - The signed-in user.
 * @param tenantId - The workspace.
 * @param tx - The transaction to hold the locks in.
 * @throws {HttpError} 404 when the actor lost access; 403 below owner or through platform access.
 */
async function lockMemberOwner(actor: Actor, tenantId: string, tx: DbTransaction): Promise<void> {
  const { role, access } = await lockActorRole(actor, tenantId, 'owner', tx).catch(
    (error: unknown) => {
      // A role below owner reads the billing refusal, as the route's gate answers it.
      if (error instanceof HttpError && error.statusCode === 403) {
        throw new HttpError(BILLING_OWNER_ONLY_MESSAGE, 403)
      }
      throw error
    }
  )
  if (access !== 'member' || role !== 'owner') throw new HttpError(BILLING_OWNER_ONLY_MESSAGE, 403)
}

/**
 * Lock the owner's access, then the billing row.
 * @param actor - The signed-in owner.
 * @param tenantId - The workspace.
 * @param tx - The transaction to hold the locks in.
 * @returns The locked billing row.
 */
async function lockOwnerAndBilling(
  actor: Actor,
  tenantId: string,
  tx: DbTransaction
): Promise<TenantBillingRecord> {
  await lockMemberOwner(actor, tenantId, tx)
  return lockBilling(tenantId, tx)
}

/**
 * Whether a row's subscriptions live with another provider or mode than the
 * running one, whose ids this provider cannot read.
 * @param row - The row.
 * @param provider - The running provider.
 * @returns True when the row names a different provider or mode.
 */
function isOtherProvider(row: TenantBillingRecord, provider: BillingProviderClient): boolean {
  return (
    (row.provider !== null && row.provider !== provider.kind) ||
    (row.providerMode !== null && row.providerMode !== provider.mode)
  )
}

/**
 * Whether the row holds a current subscription that bills the workspace.
 * @param row - The row.
 * @returns True for an active or past-due row with a current subscription.
 */
function hasCurrentSubscription(row: TenantBillingRecord): boolean {
  return row.providerSubscriptionId !== null && (row.state === 'active' || row.state === 'past_due')
}

/**
 * What an owner reads when their row belongs to another provider or mode.
 */
const OTHER_PROVIDER_OWNER_MESSAGE =
  'Your subscription is with another payment account. Contact support to change it.'

/**
 * Refuse a write on a live row of another provider or mode: the running
 * provider cannot read or change its subscription, so staff must.
 * @param row - The row.
 * @param provider - The running provider.
 * @param code - The refusal's code.
 * @param message - What the caller reads.
 * @throws {HttpError} 409 with `code`.
 */
function assertOwnProviderWhenLive(
  row: TenantBillingRecord,
  provider: BillingProviderClient,
  code: string,
  message = OTHER_PROVIDER_OWNER_MESSAGE
): void {
  if (!isOtherProvider(row, provider)) return
  logger.warn('A billing write met a row of another provider or mode', {
    tenantId: row.tenantId,
    rowProvider: row.provider,
    rowMode: row.providerMode,
    provider: provider.kind,
    mode: provider.mode,
  })
  throw new HttpError(message, 409, code)
}

/**
 * The seeded Paid plan's active price for an interval.
 * @param interval - The interval.
 * @returns The price and the plan's name.
 * @throws {HttpError} 500 when the seed is missing.
 */
async function paidPrice(
  interval: BillingInterval
): Promise<{ price: PlanPrice; planName: string }> {
  const plan = await planRepository.findPlanByKey('paid')
  if (plan === undefined) throw new HttpError('The paid plan is missing', 500)
  const price = await planRepository.activePrice(plan.id, 'INR', interval)
  if (price === undefined) throw new HttpError(`The paid ${interval} price is missing`, 500)
  return { price, planName: plan.name }
}

/**
 * A price by id.
 * @param priceId - The price, or null.
 * @returns The price, or undefined.
 */
async function priceById(priceId: string | null): Promise<PlanPrice | undefined> {
  if (priceId === null) return undefined
  const [price] = await planRepository.findPricesByIds([priceId])
  return price
}

/**
 * The provider plan for a price, created once and stored on the price. The
 * provider call runs with no lock held; the store re-reads the price under
 * its lock and keeps a plan another caller stored first.
 * @param provider - The running provider.
 * @param price - The price, as read.
 * @param planName - The name the provider plan carries.
 * @returns The provider plan id.
 */
async function providerPlanFor(
  provider: BillingProviderClient,
  price: PlanPrice,
  planName: string
): Promise<string> {
  const created = await callProvider(() => provider.ensurePlan(price, planName))
  if (created === price.providerPlanId) return created
  return withTransaction(async (tx) => {
    const locked = await planRepository.lockPrice(price.id, tx)
    if (
      locked?.providerPlanId !== null &&
      locked?.providerPlanId !== undefined &&
      locked.provider === provider.kind &&
      locked.providerMode === provider.mode
    ) {
      return locked.providerPlanId
    }
    await planRepository.setProviderPlanId(price.id, provider.kind, provider.mode, created, tx)
    return created
  })
}

/**
 * The checkout form's prefill: the signed-in owner's name and address.
 * @param actor - The signed-in owner.
 * @returns The name and address.
 * @throws {HttpError} 401 when the account is gone.
 */
async function prefillFor(actor: Actor): Promise<{ name: string; email: string }> {
  const user = await userRepository.findById(actor.userId)
  if (user === undefined) throw new HttpError('Sign in to continue.', 401)
  return { name: displayName(user), email: user.email }
}

/**
 * Cancel an unpaid checkout no one holds any more, so it cannot be paid. It
 * lapses on its own at its expiry, so a failure is only logged. A checkout
 * that is not `created` is never cancelled here, and none reaches it: the
 * callers pass a subscription they created and never handed out, which no one
 * can have paid, or a replaced one `retireReplaced` just re-read as
 * `created`. A paid one is brought in by a sync instead.
 * @param provider - The running provider.
 * @param tenantId - The workspace.
 * @param sub - The subscription.
 */
async function discardCheckout(
  provider: BillingProviderClient,
  tenantId: string,
  sub: ProviderSubscription
): Promise<void> {
  // Unreachable for a paid one; see the JSDoc.
  if (sub.status !== 'created') return
  try {
    await provider.cancelSubscription(sub.id, false)
  } catch (error) {
    logger.warn('Could not cancel an unused checkout; it lapses at its expiry', {
      error,
      tenantId,
      subscriptionId: sub.id,
    })
  }
}

/**
 * Retire a stored checkout a new one replaced: read it again, cancel it while
 * it is still unpaid, and bring it in with a sync when it was paid in the
 * meantime, so the sync adopts it or refunds it as a duplicate. Never rejects:
 * the new checkout is stored, and the reconcile finds whatever this misses.
 * @param provider - The running provider.
 * @param tenantId - The workspace.
 * @param subscriptionId - The replaced subscription.
 */
async function retireReplaced(
  provider: BillingProviderClient,
  tenantId: string,
  subscriptionId: string
): Promise<void> {
  try {
    const sub = await provider.fetchSubscription(subscriptionId)
    if (sub.status === 'created') {
      await discardCheckout(provider, tenantId, sub)
      return
    }
    if (sub.status === 'authenticated' || sub.status === 'active') {
      await syncTenantBilling(tenantId, 'owner', { extraSubscriptionIds: [subscriptionId] })
    }
  } catch (error) {
    logger.warn('Could not retire a replaced checkout; the reconcile picks it up', {
      error,
      tenantId,
      subscriptionId,
    })
  }
}

/**
 * Where a new checkout goes on the row and when it charges first.
 */
interface CheckoutSlot {
  /**
   * `pending` for a checkout that becomes current; `next` for one that
   * starts when the current one ends.
   */
  slot: 'pending' | 'next'
  /**
   * The deferred first charge, or null to charge at checkout.
   */
  startAt: Date | null
  /**
   * The row belongs to another provider or mode and has no live
   * subscription: its stale ids are cleared and it moves to this provider.
   */
  isTakeover: boolean
}

/**
 * The row columns a checkout decides from; a change to any of them between
 * the read and the write means the decision is stale.
 */
const SLOT_KEYS = [
  'state',
  'cancelAtPeriodEnd',
  'trialEndsAt',
  'currentPeriodEnd',
  'priceId',
  'provider',
  'providerMode',
  'providerSubscriptionId',
  'pendingSubscriptionId',
  'nextSubscriptionId',
] as const satisfies readonly (keyof TenantBillingRecord)[]

/**
 * Whether the row still matches the one a checkout was decided from.
 * @param read - The row as read.
 * @param locked - The row under the write's lock.
 * @returns True when every deciding column is the same.
 */
function isSameSlotState(read: TenantBillingRecord, locked: TenantBillingRecord): boolean {
  return SLOT_KEYS.every((key) => {
    const a = read[key]
    const b = locked[key]
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
    return a === b
  })
}

/**
 * The deferred first charge of an upgrade: the trial end while a trial runs.
 * @param row - The row.
 * @param now - The current time.
 * @returns The trial end, or null to charge at checkout.
 */
function trialStart(row: TenantBillingRecord, now: Date): Date | null {
  return row.state === 'trialing' && row.trialEndsAt !== null && row.trialEndsAt > now
    ? row.trialEndsAt
    : null
}

/**
 * The latest a checkout may lapse: an hour after it opens, and for one that
 * starts at the current period end, no later than the margin before that
 * start, so it can never be paid after the current subscription renewed.
 * @param slot - Where the checkout goes.
 * @param now - The current time.
 * @returns The expiry.
 */
function checkoutExpiry(slot: CheckoutSlot, now: Date): Date {
  const usual = now.getTime() + CHECKOUT_EXPIRY_MS
  if (slot.slot !== 'next' || slot.startAt === null) return new Date(usual)
  return new Date(Math.min(usual, slot.startAt.getTime() - NEXT_CHECKOUT_MARGIN_MS))
}

/**
 * Where an upgrade checkout goes, or why it is refused. A live current
 * subscription refuses it, unless it is cancelling with paid time left: then
 * it is a resubscribe that starts at the period end, refused when its
 * checkout would have too little time left before the margin it must lapse by.
 * @param row - The row.
 * @param provider - The running provider.
 * @param now - The current time.
 * @returns The slot.
 * @throws {HttpError} 409 `SUBSCRIPTION_EXISTS`.
 */
async function upgradeSlot(
  row: TenantBillingRecord,
  provider: BillingProviderClient,
  now: Date
): Promise<CheckoutSlot> {
  if (isOtherProvider(row, provider) && (row.state === 'free' || row.state === 'trialing')) {
    return { slot: 'pending', startAt: trialStart(row, now), isTakeover: true }
  }
  assertOwnProviderWhenLive(row, provider, SUBSCRIPTION_EXISTS_CODE)
  if (hasCurrentSubscription(row)) {
    if (row.state === 'past_due') {
      throw subscriptionExists(
        'Your last payment failed. Update your card under Billing to keep Paid.'
      )
    }
    if (!row.cancelAtPeriodEnd) {
      throw subscriptionExists('Your workspace is already on Paid. Manage it under Billing.')
    }
    if (row.currentPeriodEnd !== null && row.currentPeriodEnd > now) {
      const slot: CheckoutSlot = { slot: 'next', startAt: row.currentPeriodEnd, isTakeover: false }
      if (checkoutExpiry(slot, now).getTime() - now.getTime() < CHECKOUT_REUSE_MIN_REMAINING_MS) {
        throw subscriptionExists(
          `Your subscription ends on ${await formatBillingDate(row.tenantId, row.currentPeriodEnd)}. Upgrade again after that.`
        )
      }
      return slot
    }
  }
  return { slot: 'pending', startAt: trialStart(row, now), isTakeover: false }
}

/**
 * Where an interval switch goes, or why it is refused: it needs an active,
 * not cancelling subscription past its first charge, on another interval,
 * and a renewal far enough away that the switch's checkout, open an hour,
 * lapses the margin before it: a checkout paid after the renewal charged
 * would bill both subscriptions.
 * @param row - The row.
 * @param provider - The running provider.
 * @param now - The current time.
 * @param interval - The interval asked for.
 * @returns The slot: the next subscription, from the period end.
 * @throws {HttpError} 409 `NO_SUBSCRIPTION`, `SAME_INTERVAL` or `SWITCH_TOO_CLOSE_TO_RENEWAL`.
 */
async function switchSlot(
  row: TenantBillingRecord,
  provider: BillingProviderClient,
  now: Date,
  interval: BillingInterval
): Promise<CheckoutSlot> {
  if (!hasCurrentSubscription(row)) {
    throw noSubscription('Your workspace has no subscription to switch. Upgrade to Paid first.')
  }
  assertOwnProviderWhenLive(row, provider, NO_SUBSCRIPTION_CODE)
  if (row.state === 'past_due') {
    throw noSubscription('Your last payment failed. Update your card, then switch the interval.')
  }
  if (row.cancelAtPeriodEnd) {
    throw noSubscription(
      'Your subscription ends at the end of this period. Upgrade again to choose an interval.'
    )
  }
  if (row.trialEndsAt !== null && row.trialEndsAt > now) {
    throw new HttpError(
      `Your first payment is due when your trial ends on ${await formatBillingDate(row.tenantId, row.trialEndsAt)}. Switch the interval after that.`,
      409,
      SWITCH_BEFORE_FIRST_CHARGE_CODE
    )
  }
  if (row.currentPeriodEnd === null || row.currentPeriodEnd <= now) {
    throw noSubscription('Your renewal payment is still processing. Try again in 1 hour.')
  }
  if (
    row.currentPeriodEnd.getTime() - now.getTime() <
    CHECKOUT_EXPIRY_MS + NEXT_CHECKOUT_MARGIN_MS
  ) {
    throw new HttpError(
      `You can switch after your renewal on ${await formatBillingDate(row.tenantId, row.currentPeriodEnd)}.`,
      409,
      SWITCH_TOO_CLOSE_TO_RENEWAL_CODE
    )
  }
  const current = await priceById(row.priceId)
  if (current?.interval === interval) {
    throw new HttpError(
      `Your workspace is already billed every ${interval}. Choose the other interval.`,
      409,
      SAME_INTERVAL_CODE
    )
  }
  return { slot: 'next', startAt: row.currentPeriodEnd, isTakeover: false }
}

/**
 * Whether a stored checkout can be handed to the browser again: unpaid, for
 * the same price and first charge, not about to lapse, and lapsing no later
 * than a new checkout for the slot would.
 * @param sub - The stored subscription.
 * @param priceId - The price asked for.
 * @param slot - The slot and first charge asked for.
 * @param now - The current time.
 * @returns True when it can be reused.
 */
function isReusable(
  sub: ProviderSubscription,
  priceId: string,
  slot: CheckoutSlot,
  now: Date
): boolean {
  const { startAt } = slot
  return (
    sub.status === 'created' &&
    sub.notes.priceId === priceId &&
    (sub.startAt?.getTime() ?? null) === (startAt?.getTime() ?? null) &&
    (sub.expireBy === null
      ? slot.slot !== 'next'
      : sub.expireBy.getTime() - now.getTime() > CHECKOUT_REUSE_MIN_REMAINING_MS &&
        sub.expireBy <= checkoutExpiry(slot, now))
  )
}

/**
 * What a checkout write needs from its caller.
 */
interface CheckoutRequest {
  actor: Actor
  tenantId: string
  interval: BillingInterval
  purpose: Exclude<CheckoutPurpose, 'card_change'>
  /**
   * Decide the slot from the row as read, or refuse.
   */
  decide: (row: TenantBillingRecord, now: Date) => CheckoutSlot | Promise<CheckoutSlot>
}

/**
 * Open a checkout: read and decide, reuse the stored unpaid checkout or
 * create one with no lock held, then store it under the lock unless the row
 * moved, in which case the whole step runs again. Two calls at once end on
 * one stored subscription: the later one finds the earlier one's checkout on
 * its second pass and hands that back, cancelling its own.
 * @param provider - The running provider.
 * @param input - The caller, workspace, interval, purpose and slot rule.
 * @returns The session.
 * @throws {HttpError} The slot rule's refusal; 503 when the row kept moving or the provider is down.
 */
async function openCheckout(
  provider: BillingProviderClient,
  input: CheckoutRequest
): Promise<CheckoutSession> {
  const { actor, tenantId, interval } = input
  await assertCustomerTenant(tenantId)
  const { price, planName } = await paidPrice(interval)
  const prefill = await prefillFor(actor)
  const state: { created?: ProviderSubscription } = {}
  try {
    return await checkoutAttempts(provider, input, price, planName, prefill, state)
  } catch (error) {
    // A subscription created on a pass that then failed or was refused is never handed out.
    if (state.created !== undefined) await discardCheckout(provider, tenantId, state.created)
    throw error
  }
}

/**
 * The passes of `openCheckout`. Records the subscription a pass created in
 * `state`, so the caller can cancel it when a later pass throws.
 * @param provider - The running provider.
 * @param input - The caller, workspace, interval, purpose and slot rule.
 * @param price - The price asked for.
 * @param planName - The name the provider plan carries.
 * @param prefill - The checkout form's prefill.
 * @param state - Where the created subscription is recorded.
 * @param state.created - The subscription a pass created and has not handed out.
 * @returns The session.
 */
async function checkoutAttempts(
  provider: BillingProviderClient,
  input: CheckoutRequest,
  price: PlanPrice,
  planName: string,
  prefill: CheckoutSession['prefill'],
  state: { created?: ProviderSubscription }
): Promise<CheckoutSession> {
  const { actor, tenantId, interval, purpose } = input
  let created: ProviderSubscription | undefined
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const read = await withTransaction((tx) => lockOwnerAndBilling(actor, tenantId, tx))
    const now = new Date()
    const slot = await input.decide(read, now)
    const heldId = slot.slot === 'pending' ? read.pendingSubscriptionId : read.nextSubscriptionId
    let held: ProviderSubscription | undefined
    if (!slot.isTakeover && heldId !== null) {
      held = await callProvider(() => provider.fetchSubscription(heldId))
      const isPaid = held.status === 'authenticated' || held.status === 'active'
      if (isPaid && slot.slot === 'pending') {
        // Paid, and the provider's event has not landed yet: never replace it, bring it in now.
        await syncOrRetry(tenantId, 'owner')
        throw subscriptionExists('We already have your payment. Refresh Billing to see Paid.')
      }
      if (isPaid) {
        const starts =
          read.currentPeriodEnd === null
            ? 'at the end of this period'
            : `on ${await formatBillingDate(tenantId, read.currentPeriodEnd)}`
        throw subscriptionExists(
          purpose === 'switch'
            ? `An interval switch is already scheduled to start ${starts}. Cancel under Billing to choose again.`
            : `Your workspace already continues on Paid ${starts}. Cancel under Billing to change it.`
        )
      }
    }
    let chosen: ProviderSubscription
    if (held !== undefined && isReusable(held, price.id, slot, now)) chosen = held
    else if (created !== undefined && isReusable(created, price.id, slot, now)) {
      chosen = created
    } else {
      // A previous pass's checkout no longer fits (its first charge moved): it is never handed out.
      if (created !== undefined) {
        await discardCheckout(provider, tenantId, created)
        delete state.created
      }
      const providerPlanId = await providerPlanFor(provider, price, planName)
      created = await callProvider(() =>
        provider.createSubscription({
          providerPlanId,
          totalCount: CHECKOUT_TOTAL_COUNT[interval],
          expireBy: checkoutExpiry(slot, now),
          startAt: slot.startAt,
          notes: { tenantId, appEnv: getEnv().APP_ENV, priceId: price.id },
        })
      )
      chosen = created
      state.created = created
    }

    const stored = await withTransaction(async (tx) => {
      const locked = await lockOwnerAndBilling(actor, tenantId, tx)
      if (!isSameSlotState(read, locked)) return
      const patch: Partial<NewTenantBilling> =
        slot.slot === 'pending'
          ? {
              pendingSubscriptionId: chosen.id,
              checkoutStartedBy: actor.userId,
              provider: provider.kind,
              providerMode: provider.mode,
              // A new checkout's payer is not known yet: an earlier payer, and their billing address, pay for nothing now. The confirm records who paid.
              ...(chosen.id !== locked.pendingSubscriptionId && {
                payerUserId: null,
                billingEmail: null,
              }),
              ...(slot.isTakeover && {
                providerSubscriptionId: null,
                nextSubscriptionId: null,
                nextPriceId: null,
                nextAuthenticatedAt: null,
              }),
            }
          : {
              nextSubscriptionId: chosen.id,
              nextPriceId: price.id,
              nextAuthenticatedAt: null,
              checkoutStartedBy: actor.userId,
            }
      const after = await billingRepository.updateVersioned(tenantId, locked.version, patch, tx)
      if (after === undefined) return
      await record(
        {
          action:
            purpose === 'switch' ? 'billing.interval_switch_scheduled' : 'billing.checkout_started',
          actor,
          access: 'member',
          tenantId,
          targetId: tenantId,
          metadata: { interval },
        },
        tx
      )
      return { before: locked, after }
    })
    if (stored === undefined) continue

    if (held !== undefined && held.id !== chosen.id) {
      await retireReplaced(provider, tenantId, held.id)
    }
    if (created !== undefined && created.id !== chosen.id) {
      await discardCheckout(provider, tenantId, created)
    }
    delete state.created
    await emitBillingDiff(stored.before, stored.after, 'owner', { actorUserId: actor.userId })
    if (purpose === 'upgrade') {
      await trackCheckoutStarted(stored.after, {
        userId: actor.userId,
        interval,
        amountMinor: price.amountMinor,
        currency: price.currency,
        duringTrial: stored.before.state === 'trialing',
      })
    }
    return {
      purpose,
      keyId: provider.keyId,
      subscriptionId: chosen.id,
      amountMinor: price.amountMinor,
      currency: 'INR',
      interval,
      startsAt: slot.startAt,
      prefill,
    }
  }
  throw billingBusy()
}

/**
 * Start a checkout for Paid, as an owner by membership. A stored unpaid
 * checkout for the same interval is handed back. While a trial runs the
 * first charge waits for its end; while the current subscription is
 * cancelling, this resubscribes from the period end.
 * @param actor - The signed-in owner.
 * @param tenantId - The workspace.
 * @param interval - How often to bill.
 * @returns The session the browser opens the provider's checkout with.
 * @throws {HttpError} 404 when payments are off; 403 for anyone but a member owner; 409 `SUBSCRIPTION_EXISTS` while a live subscription runs; 503 when the provider is down.
 */
export async function startCheckout(
  actor: Actor,
  tenantId: string,
  interval: BillingInterval
): Promise<CheckoutSession> {
  const provider = requireProvider()
  return openCheckout(provider, {
    actor,
    tenantId,
    interval,
    purpose: 'upgrade',
    decide: (row, now) => upgradeSlot(row, provider, now),
  })
}

/**
 * Schedule a move to the other interval from the end of the paid period: a
 * new subscription starts then, and the current one is cancelled at its
 * cycle end once the new one is authenticated (the sync does that).
 * @param actor - The signed-in owner.
 * @param tenantId - The workspace.
 * @param interval - The interval to move to.
 * @returns The session, purpose `switch`.
 * @throws {HttpError} 404 when payments are off; 403 for anyone but a member owner; 409 `NO_SUBSCRIPTION` or `SAME_INTERVAL`; 503 when the provider is down.
 */
export async function startIntervalSwitch(
  actor: Actor,
  tenantId: string,
  interval: BillingInterval
): Promise<CheckoutSession> {
  const provider = requireProvider()
  return openCheckout(provider, {
    actor,
    tenantId,
    interval,
    purpose: 'switch',
    decide: (row, now) => switchSlot(row, provider, now, interval),
  })
}

/**
 * Open the current subscription for a card change. The confirm records the
 * owner who changed it as the payer.
 * @param actor - The signed-in owner.
 * @param tenantId - The workspace.
 * @returns The session, purpose `card_change`, for the current subscription.
 * @throws {HttpError} 404 when payments are off; 403 for anyone but a member owner; 409 `NO_SUBSCRIPTION`.
 */
export async function startCardChange(actor: Actor, tenantId: string): Promise<CheckoutSession> {
  const provider = requireProvider()
  await assertCustomerTenant(tenantId)
  const prefill = await prefillFor(actor)
  const row = await withTransaction(async (tx) => {
    const locked = await lockOwnerAndBilling(actor, tenantId, tx)
    if (!hasCurrentSubscription(locked)) {
      throw noSubscription(
        'Your workspace has no subscription to change the card for. Upgrade to Paid under Billing first.'
      )
    }
    assertOwnProviderWhenLive(locked, provider, NO_SUBSCRIPTION_CODE)
    const after = await billingRepository.updateVersioned(
      tenantId,
      locked.version,
      { cardChangeStartedAt: new Date(), cardChangeStartedBy: actor.userId },
      tx
    )
    if (after === undefined) throw new HttpError('The billing record changed under its lock', 500)
    await record(
      {
        action: 'billing.card_change_started',
        actor,
        access: 'member',
        tenantId,
        targetId: tenantId,
        metadata: {},
      },
      tx
    )
    return locked
  })
  const price = await priceById(row.priceId)
  if (price === undefined || row.providerSubscriptionId === null) {
    throw new HttpError('The billing record has no price', 500)
  }
  return {
    purpose: 'card_change',
    keyId: provider.keyId,
    subscriptionId: row.providerSubscriptionId,
    amountMinor: price.amountMinor,
    currency: 'INR',
    interval: price.interval,
    startsAt: null,
    prefill,
  }
}

/**
 * Whether the actor opened a card change on the current subscription that
 * can still be confirmed: they started it, within the checkout expiry.
 * @param row - The row.
 * @param actor - The signed-in owner.
 * @param now - The current time.
 * @returns True when the current subscription may be confirmed as a card change.
 */
function isCardChangeOpen(row: TenantBillingRecord, actor: Actor, now: Date): boolean {
  return (
    hasCurrentSubscription(row) &&
    row.cardChangeStartedBy === actor.userId &&
    row.cardChangeStartedAt !== null &&
    now.getTime() - row.cardChangeStartedAt.getTime() < CHECKOUT_EXPIRY_MS
  )
}

/**
 * Sync the workspace, trying once more when the row moved under it.
 * @param tenantId - The workspace.
 * @param source - What asked for the sync, for the history.
 * @throws {HttpError} 503 when the row kept moving or the provider is down.
 */
export async function syncOrRetry(
  tenantId: string,
  source: 'confirm' | 'owner' | 'staff'
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await syncTenantBilling(tenantId, source)
      return
    } catch (error) {
      if (!(error instanceof BillingSyncConflictError)) throw providerFailure(error)
    }
  }
  throw billingBusy()
}

/**
 * How old a subscription an adopted confirm may name: a checkout's life, plus
 * the margin a payment made near its end may take to reach the browser's
 * confirm. The path takes no payer, so the margin costs no access.
 */
const ADOPTED_CONFIRM_MAX_AGE_MS = CHECKOUT_EXPIRY_MS + NEXT_CHECKOUT_MARGIN_MS

/**
 * The subscription a confirm names when the webhook adopted this owner's
 * checkout before the browser's confirm arrived: the row still bills on it,
 * the provider signed it, the owner started that checkout, and the
 * subscription is no older than `ADOPTED_CONFIRM_MAX_AGE_MS`. Payment
 * webhooks usually beat the browser, so this is the common path, not a
 * replay.
 * @param provider - The running provider.
 * @param row - The billing row as locked.
 * @param actor - The confirming owner.
 * @param body - What the provider's checkout handed the browser.
 * @returns The subscription as the provider read it, or undefined when the confirm is not the adopted checkout's own.
 */
async function adoptedOwnCheckout(
  provider: BillingProviderClient,
  row: TenantBillingRecord,
  actor: Actor,
  body: CheckoutConfirm
): Promise<ProviderSubscription | undefined> {
  const posted = body.razorpay_subscription_id
  if (
    !hasCurrentSubscription(row) ||
    row.providerSubscriptionId !== posted ||
    row.checkoutStartedBy !== actor.userId
  ) {
    return undefined
  }
  if (!provider.verifyCheckout(body, posted)) return undefined
  const sub = await callProvider(() => provider.fetchSubscription(posted))
  const isOwnAndRecent =
    sub.notes.tenantId === row.tenantId &&
    sub.createdAt !== null &&
    Date.now() - sub.createdAt.getTime() < ADOPTED_CONFIRM_MAX_AGE_MS
  return isOwnAndRecent ? sub : undefined
}

/**
 * Answer a confirm whose checkout the webhook already adopted: sync, record
 * the confirmation (deduped per subscription), and record the confirming
 * owner's address as the billing address, the one thing the adoption leaves
 * to the confirm. Only while the subscription is still current and the owner
 * is still its payer: the payer is never written here, so a replay after
 * another owner's card change takes nothing back.
 * @param actor - The confirming owner.
 * @param tenantId - The workspace.
 * @param sub - The adopted subscription, as the guard read it.
 * @returns The workspace's billing.
 */
async function acknowledgeAdoptedCheckout(
  actor: Actor,
  tenantId: string,
  sub: ProviderSubscription
): Promise<TenantBillingView> {
  await syncOrRetry(tenantId, 'confirm')
  await trackCheckoutConfirmed(tenantId, actor.userId, sub)
  const user = await userRepository.findById(actor.userId)
  if (user !== undefined) {
    const written = await withTransaction(async (tx) => {
      const locked = await lockOwnerAndBilling(actor, tenantId, tx)
      if (
        locked.providerSubscriptionId !== sub.id ||
        locked.payerUserId !== actor.userId ||
        locked.billingEmail === user.email
      ) {
        return
      }
      const after = await billingRepository.updateVersioned(
        tenantId,
        locked.version,
        { billingEmail: user.email },
        tx
      )
      return after === undefined ? undefined : { before: locked, after }
    })
    if (written !== undefined) {
      await emitBillingDiff(written.before, written.after, 'owner', { actorUserId: actor.userId })
    }
  }
  return getTenantBilling(actor, tenantId)
}

/**
 * Confirm a checkout the browser finished: the posted subscription must be
 * this workspace's pending, next or (for a card change) current one, or
 * the current one when the webhook already adopted this owner's checkout
 * (which syncs, records the confirmation and the billing address, and never
 * the payer), the
 * signature must be the provider's over that stored id, and the
 * subscription's notes must name this workspace. Only then is the workspace
 * synced and the caller recorded as the payer. Any mismatch changes nothing.
 * @param actor - The signed-in owner.
 * @param tenantId - The workspace.
 * @param body - What the provider's checkout handed the browser.
 * @returns The workspace's billing after the sync.
 * @throws {HttpError} 404 when payments are off; 403 for anyone but a member owner; 400 `CHECKOUT_MISMATCH`; 503 when the provider is down or the row kept moving.
 */
export async function confirmCheckout(
  actor: Actor,
  tenantId: string,
  body: CheckoutConfirm
): Promise<TenantBillingView> {
  const provider = requireProvider()
  await assertCustomerTenant(tenantId)
  const row = await withTransaction((tx) => lockOwnerAndBilling(actor, tenantId, tx))
  const posted = body.razorpay_subscription_id
  const stored = [
    row.pendingSubscriptionId,
    row.nextSubscriptionId,
    isCardChangeOpen(row, actor, new Date()) ? row.providerSubscriptionId : null,
  ].find((id): id is string => id !== null && id === posted)
  if (isOtherProvider(row, provider)) throw checkoutMismatch()
  if (stored === undefined) {
    const adopted = await adoptedOwnCheckout(provider, row, actor, body)
    if (adopted !== undefined) return acknowledgeAdoptedCheckout(actor, tenantId, adopted)
  }
  if (stored === undefined) throw await unheldConfirmRefusal(provider, tenantId, body)
  if (!provider.verifyCheckout(body, stored)) throw checkoutMismatch()
  const sub = await callProvider(() => provider.fetchSubscription(stored))
  if (sub.notes.tenantId !== tenantId) {
    logger.warn('A checkout confirm named a subscription of another workspace', {
      tenantId,
      subscriptionId: stored,
    })
    throw checkoutMismatch()
  }

  await syncOrRetry(tenantId, 'confirm')
  if (stored === row.pendingSubscriptionId) {
    await trackCheckoutConfirmed(tenantId, actor.userId, sub)
  }

  const user = await userRepository.findById(actor.userId)
  if (user !== undefined) {
    const written = await withTransaction(async (tx) => {
      const locked = await lockOwnerAndBilling(actor, tenantId, tx)
      const isHeld = [
        locked.providerSubscriptionId,
        locked.pendingSubscriptionId,
        locked.nextSubscriptionId,
      ].includes(stored)
      // Only the owner who opened the card change closes it; another owner's confirm leaves it open.
      const isCardChange =
        locked.providerSubscriptionId === stored && locked.cardChangeStartedBy === user.id
      const patch: Partial<NewTenantBilling> = {
        ...(isHeld &&
          (locked.payerUserId !== user.id || locked.billingEmail !== user.email) && {
            payerUserId: user.id,
            billingEmail: user.email,
          }),
        // A card change is confirmed once: a re-post needs a fresh start.
        ...(isCardChange && { cardChangeStartedAt: null, cardChangeStartedBy: null }),
      }
      if (Object.keys(patch).length === 0) return
      const after = await billingRepository.updateVersioned(tenantId, locked.version, patch, tx)
      return after === undefined ? undefined : { before: locked, after }
    })
    if (written !== undefined) {
      await emitBillingDiff(written.before, written.after, 'owner', { actorUserId: actor.userId })
    }
  }
  return getTenantBilling(actor, tenantId)
}

/**
 * Cancel a subscription and say whether that took effect: one that had
 * already ended counts as cancelled.
 * @param provider - The running provider.
 * @param subscriptionId - The subscription.
 * @param isAtCycleEnd - True to keep it until its cycle ends.
 * @throws {HttpError} 503 or 502 when the provider refused and the subscription still runs.
 */
async function cancelOrEnded(
  provider: BillingProviderClient,
  subscriptionId: string,
  isAtCycleEnd: boolean
): Promise<void> {
  try {
    await provider.cancelSubscription(subscriptionId, isAtCycleEnd)
  } catch (error) {
    let sub: ProviderSubscription | undefined
    try {
      sub = await provider.fetchSubscription(subscriptionId)
    } catch {
      // The cancel's own failure is the one to answer with.
    }
    if (sub !== undefined && ENDED_STATUSES.has(sub.status)) return
    throw providerFailure(error)
  }
}

/**
 * What a cancel needs from its caller: the owner's or staff's own lock,
 * audit entry and refusals.
 */
export interface CancelRequest {
  tenantId: string
  /**
   * Who cancels, for the history and the events.
   */
  source: 'owner' | 'staff'
  /**
   * When the current subscription ends, or how to decide it from the row as
   * read. A deferred start that has not charged yet cannot be cancelled at
   * its cycle end, so it ends now either way.
   */
  when: StaffCancelWhen | ((row: TenantBillingRecord) => StaffCancelWhen)
  /**
   * The owner who cancels: their cancel is marked before the provider call,
   * and the change is sent as theirs. Absent for staff.
   */
  ownerUserId?: string
  /**
   * Take the caller's locks, then the billing row, in the documented order.
   */
  lock: (tx: DbTransaction) => Promise<TenantBillingRecord>
  /**
   * Record the cancel's audit entry in the write's transaction.
   */
  audit: (tx: DbTransaction) => Promise<void>
  /**
   * The refusal when there is nothing to cancel.
   */
  nothingToCancel: (row: TenantBillingRecord) => Promise<HttpError>
  /**
   * What the caller reads when the row belongs to another provider or mode.
   */
  otherProviderMessage: string
  /**
   * Record the audit entry even when the current subscription had already
   * ended at the provider and only a sync was needed: a staff cancel is
   * always on record, an owner's is not.
   */
  shouldAuditWhenEnded?: boolean
}

/**
 * Cancel a workspace's subscriptions: the current one at its cycle end or
 * now, and a scheduled switch or resubscribe. A subscription past its first
 * charge cancelled at its cycle end keeps Paid until then and reads
 * cancelling, which this records itself, since the provider does not show a
 * scheduled cancel. A deferred start (upgraded during a trial, not charged
 * yet) cannot be cancelled at its cycle end, so it is cancelled now and the
 * workspace goes back to its trial, or to Free when the trial is over. A
 * charged subscription cancelled now moves the workspace to Free at once.
 * Provider calls run with no lock held; a provider failure on the current
 * subscription writes nothing. A current subscription that had already
 * ended is only synced; if the row then holds a subscription this cancel
 * would end (a checkout adopted, a switch scheduled since the read), the
 * cancel starts over once on the moved row rather than report it done.
 * @param provider - The running provider.
 * @param request - The workspace, who cancels, when, and the caller's lock, audit and refusals.
 * @param attempt - Which start this is; the second gives up as busy.
 * @throws {HttpError} 409 `NO_SUBSCRIPTION` with nothing to cancel; 503 or 502 when the provider fails; 503 `BILLING_BUSY` when the row moved under both starts.
 */
export async function cancelSubscriptions(
  provider: BillingProviderClient,
  request: CancelRequest,
  attempt = 1
): Promise<void> {
  const { tenantId, source, ownerUserId } = request
  const row = await withTransaction((tx) => request.lock(tx))
  assertOwnProviderWhenLive(row, provider, NO_SUBSCRIPTION_CODE, request.otherProviderMessage)
  const when = typeof request.when === 'function' ? request.when(row) : request.when
  const currentId =
    hasCurrentSubscription(row) && (!row.cancelAtPeriodEnd || when === 'now')
      ? row.providerSubscriptionId
      : null
  const nextId = row.nextSubscriptionId
  if (currentId === null && nextId === null) throw await request.nothingToCancel(row)

  let currentCancel: StaffCancelWhen | undefined
  let isDeferredStart = false
  if (currentId !== null) {
    const current = await callProvider(() => provider.fetchSubscription(currentId))
    if (ENDED_STATUSES.has(current.status) && nextId === null) {
      // It ended at the provider already: the sync records that, and there is nothing to cancel.
      await syncOrRetry(tenantId, source)
      const isNothingLeft = await withTransaction(async (tx) => {
        const locked = await request.lock(tx)
        const isNewCurrent =
          hasCurrentSubscription(locked) && locked.providerSubscriptionId !== currentId
        if (isNewCurrent || locked.nextSubscriptionId !== null) return false
        if (request.shouldAuditWhenEnded === true) await request.audit(tx)
        return true
      })
      if (isNothingLeft) return
      if (attempt > 1) throw billingBusy()
      await cancelSubscriptions(provider, request, attempt + 1)
      return
    }
    if (!ENDED_STATUSES.has(current.status)) {
      // Before the provider call: its webhook may land before this write and must still read as this cancel.
      await markCancel(
        tenantId,
        currentId,
        ownerUserId === undefined ? { by: 'staff' } : { by: 'owner', userId: ownerUserId }
      )
      currentCancel = when
      try {
        if (current.status === 'authenticated') {
          // Read again just before cancelling now: a first charge that landed meanwhile makes it a charged subscription.
          const latest = await callProvider(() => provider.fetchSubscription(currentId))
          if (latest.status === 'authenticated') {
            currentCancel = 'now'
            isDeferredStart = true
          }
        }
        await cancelOrEnded(provider, currentId, currentCancel === 'cycle_end')
      } catch (error) {
        // This cancel did not happen: a later cancel of this subscription is not its caller's.
        await clearCancelMarker(tenantId, currentId)
        throw error
      }
    }
  }
  let nextFailure: Error | undefined
  if (nextId !== null) {
    try {
      await cancelOrEnded(provider, nextId, false)
    } catch (error) {
      nextFailure = providerFailure(error)
    }
  }
  const isNextCancelled = nextId !== null && nextFailure === undefined

  const now = new Date()
  const written = await withTransaction(async (tx) => {
    const locked = await request.lock(tx)
    const patch: Partial<NewTenantBilling> = {}
    const isSameCurrent = currentId !== null && locked.providerSubscriptionId === currentId
    if (isSameCurrent && currentCancel === 'cycle_end') patch.cancelAtPeriodEnd = true
    if (
      isSameCurrent &&
      currentCancel === 'now' &&
      (locked.state === 'active' || locked.state === 'past_due')
    ) {
      const isTrialLeft = isDeferredStart && locked.trialEndsAt !== null && locked.trialEndsAt > now
      patch.state = isTrialLeft ? 'trialing' : 'free'
      patch.priceId = null
      patch.currentPeriodEnd = null
      patch.cancelAtPeriodEnd = false
      if (!isTrialLeft) {
        const free = await planRepository.findPlanByKey('free', tx)
        if (free === undefined) throw new HttpError('The free plan is missing', 500)
        patch.planId = free.id
        patch.pastDueSince = null
        patch.haltedAt = null
        patch.pausedAt = null
      }
    }
    // The marker has done its work once this write lands: a later sync reads no cancel from it.
    if (currentId !== null && locked.cancelMarkerSubscriptionId === currentId) {
      patch.cancelMarkerSubscriptionId = null
      patch.cancelMarkerBy = null
      patch.cancelMarkerUserId = null
      patch.cancelMarkerAt = null
    }
    if (isNextCancelled && locked.nextSubscriptionId === nextId) {
      patch.nextSubscriptionId = null
      patch.nextPriceId = null
      patch.nextAuthenticatedAt = null
    }
    const after =
      Object.keys(patch).length === 0
        ? locked
        : await billingRepository.updateVersioned(tenantId, locked.version, patch, tx)
    if (after === undefined) throw new HttpError('The billing record changed under its lock', 500)
    if (patch.state !== undefined) {
      await billingRepository.appendHistory(
        { tenantId, fromState: locked.state, toState: patch.state, cause: 'cancelled', source },
        tx
      )
    }
    await request.audit(tx)
    return { before: locked, after }
  })
  await emitBillingDiff(
    written.before,
    written.after,
    source,
    ownerUserId === undefined ? { isStaffCancel: true } : { actorUserId: ownerUserId }
  )
  if (nextFailure !== undefined) throw nextFailure
}

/**
 * Cancel Paid, as an owner by membership: at the cycle end, or now for a
 * deferred start that has not charged yet (`cancelSubscriptions`) and for a
 * past-due subscription, whose paid time is over, so the workspace moves to
 * Free at once. A scheduled switch or resubscribe is cancelled too.
 * @param actor - The signed-in owner.
 * @param tenantId - The workspace.
 * @returns The workspace's billing after the cancel.
 * @throws {HttpError} 404 when payments are off; 403 for anyone but a member owner; 409 `NO_SUBSCRIPTION` with nothing to cancel; 503 when the provider is down.
 */
export async function cancelPaid(actor: Actor, tenantId: string): Promise<TenantBillingView> {
  const provider = requireProvider()
  await assertCustomerTenant(tenantId)
  await cancelSubscriptions(provider, {
    tenantId,
    source: 'owner',
    // A cycle-end cancel of a past-due subscription would leave a failed charge retrying until its cycle ends.
    when: (row) => (row.state === 'past_due' ? 'now' : 'cycle_end'),
    ownerUserId: actor.userId,
    lock: (tx) => lockOwnerAndBilling(actor, tenantId, tx),
    audit: async (tx) => {
      await record(
        {
          action: 'billing.cancel_scheduled',
          actor,
          access: 'member',
          tenantId,
          targetId: tenantId,
          metadata: {},
        },
        tx
      )
    },
    nothingToCancel: async (row) =>
      noSubscription(
        row.cancelAtPeriodEnd && row.currentPeriodEnd !== null
          ? `Your subscription already ends on ${await formatBillingDate(tenantId, row.currentPeriodEnd)}. To keep Paid after that, upgrade again under Billing.`
          : 'Your workspace has no subscription to cancel. There is nothing to do.'
      ),
    otherProviderMessage: OTHER_PROVIDER_OWNER_MESSAGE,
  })
  return getTenantBilling(actor, tenantId)
}

/**
 * Whether the actor is an owner of the workspace by membership. Read without
 * a lock: it decides only what a read shows.
 * @param actor - The signed-in user.
 * @param tenantId - The workspace.
 * @returns True for a member owner.
 */
async function isMemberOwner(actor: Actor, tenantId: string): Promise<boolean> {
  const membership = await membershipRepository.findByUserAndTenant(actor.userId, tenantId)
  return membership?.role === 'owner'
}

/**
 * The payer, and whether they are still a member. Staff read a payer with no
 * name by their email; members read an empty name, so a former member's
 * address never reaches the members who stayed.
 * @param tenantId - The workspace.
 * @param payerUserId - The payer, or null.
 * @param isStaff - Whether staff read the view.
 * @returns The payer, or null when there is none or their account is gone.
 */
async function payerOf(
  tenantId: string,
  payerUserId: string | null,
  isStaff: boolean
): Promise<TenantBillingView['payer']> {
  if (payerUserId === null) return null
  const user = await userRepository.findById(payerUserId)
  if (user === undefined) return null
  const membership = await membershipRepository.findByUserAndTenant(payerUserId, tenantId)
  const name = isStaff ? nameOrEmail(user) : displayName(user)
  return { userId: user.id, name, isMember: membership !== undefined }
}

/**
 * A workspace's billing as the actor may see it. Any member and staff with
 * platform access read it; the billing email is shown only to an owner by
 * membership, and so is whether it has tax documents (staff read that
 * too). The state and plan are the effective ones, as entitlements
 * read them. A scheduled switch or resubscribe shows once its subscription
 * is authenticated, which the sync stamps in `nextAuthenticatedAt`.
 * @param actor - The signed-in user.
 * @param tenantId - The workspace.
 * @returns The billing view.
 * @throws {HttpError} The unknown-route 404 for the platform workspace.
 */
export async function getTenantBilling(actor: Actor, tenantId: string): Promise<TenantBillingView> {
  return billingView(tenantId, {
    isOwner: await isMemberOwner(actor, tenantId),
    isStaff: false,
    dismissedBanners: await billingRepository.listDismissals(actor.userId, tenantId),
  })
}

/**
 * A workspace's billing as staff read it in Apex: the view every member
 * reads, with the owner-only fields empty and no banner dismissals, even
 * for a staff member who is also an owner of the workspace. A payer with no
 * name reads as their email.
 * @param tenantId - The customer workspace.
 * @param entitlements - Its effective entitlements, read once by the caller.
 * @returns The billing view.
 */
export async function getTenantBillingForStaff(
  tenantId: string,
  entitlements: SourcedEntitlements
): Promise<TenantBillingView> {
  return billingView(
    tenantId,
    { isOwner: false, isStaff: true, dismissedBanners: [] },
    entitlements
  )
}

/**
 * A workspace's billing view.
 * @param tenantId - The workspace.
 * @param viewer - What the reader may see: the billing email when an owner, and their own banner dismissals.
 * @param viewer.isOwner - Whether the reader is an owner by membership.
 * @param viewer.isStaff - Whether staff read it in Apex, which names a payer with no name by their email.
 * @param viewer.dismissedBanners - The reader's dismissed banners.
 * @param read - The effective entitlements when the caller already read them.
 * @returns The view.
 * @throws {HttpError} The unknown-route 404 for the platform workspace.
 */
async function billingView(
  tenantId: string,
  viewer: { isOwner: boolean; isStaff: boolean; dismissedBanners: string[] },
  read?: SourcedEntitlements
): Promise<TenantBillingView> {
  const row = await billingRepository.findByTenantId(tenantId)
  if (row === undefined) {
    await assertCustomerTenant(tenantId)
    logger.error('A customer workspace has no billing row; serving it Free', { tenantId })
  }
  const entitlements = read ?? (await getEffectiveEntitlements(tenantId))
  const price = await priceById(row?.priceId ?? null)
  let nextSwitch: TenantBillingView['nextSwitch'] = null
  if (
    row !== undefined &&
    row.nextSubscriptionId !== null &&
    row.nextAuthenticatedAt !== null &&
    row.currentPeriodEnd !== null
  ) {
    const nextPrice = await priceById(row.nextPriceId)
    if (nextPrice !== undefined) {
      nextSwitch = { interval: nextPrice.interval, startsAt: row.currentPeriodEnd }
    }
  }
  return {
    state: entitlements.state,
    plan: entitlements.plan,
    interval: price?.interval ?? null,
    price: price === undefined ? null : toPriceView(price),
    trialEndsAt: entitlements.trialEndsAt,
    currentPeriodEnd: entitlements.currentPeriodEnd,
    cancelAtPeriodEnd: entitlements.cancelAtPeriodEnd,
    pastDue: entitlements.pastDue,
    nextSwitch,
    payer: await payerOf(tenantId, row?.payerUserId ?? null, viewer.isStaff),
    billingEmail: viewer.isOwner ? (row?.billingEmail ?? null) : null,
    paymentsEnabled: getBillingProvider() !== null,
    taxDocumentsEnabled: gstSellerConfig() !== null,
    hasTaxDocuments:
      (viewer.isOwner || viewer.isStaff) && (await taxRepository.hasDocuments(tenantId)),
    dismissedBanners: viewer.dismissedBanners,
  }
}

/**
 * The scope an invoice cursor is bound to: the list, the workspace and the
 * subscriptions it pages through, and for the staff list the status filter,
 * so a cursor from another workspace, list or filter, or from before the
 * subscriptions changed, is refused.
 * @param list - The list's name, also the cursor's sort.
 * @param tenantId - The workspace.
 * @param subscriptionIds - The subscriptions listed.
 * @param statuses - The staff list's status filter, or undefined.
 * @returns The scope hash.
 */
function invoiceScope(
  list: string,
  tenantId: string,
  subscriptionIds: readonly string[],
  statuses: readonly InvoiceStatus[] | undefined
): string {
  return bindScope(listScope({ search: undefined, sort: list, filters: {} }), {
    list,
    tenantId,
    subscriptions: subscriptionIds.join(','),
    ...(statuses !== undefined && { statuses: statuses.join(',') }),
  })
}

/**
 * The subscriptions a workspace's invoices are read from: the scheduled
 * next subscription, the current one, then every earlier subscription the
 * workspace held with this provider and mode, newest first, at most
 * `MAX_INVOICE_SUBSCRIPTIONS`.
 * @param tenantId - The workspace.
 * @param provider - The running provider.
 * @returns The subscription ids.
 */
async function invoiceSubscriptionIds(
  tenantId: string,
  provider: BillingProviderClient
): Promise<string[]> {
  const row = await billingRepository.findByTenantId(tenantId)
  const live =
    row === undefined || isOtherProvider(row, provider)
      ? []
      : [row.nextSubscriptionId, row.providerSubscriptionId].filter(
          (id): id is string => id !== null
        )
  // Only ids recorded for this workspace (its current subscriptions, and before 0036 its resolved charge events), so another workspace's subscription is never listed.
  const held = await billingRepository.listHeldSubscriptionIds(
    tenantId,
    { kind: provider.kind, mode: provider.mode },
    MAX_INVOICE_SUBSCRIPTIONS
  )
  return [...new Set([...live, ...held])].slice(0, MAX_INVOICE_SUBSCRIPTIONS)
}

/**
 * Add each invoice's tax links and status, read for the page's payments in
 * one pass, then drop its payment id.
 * @param tenantId - The workspace.
 * @param provider - The running provider, whose kind and mode the documents carry.
 * @param invoices - The page's invoices.
 * @returns The invoices with their tax invoice, credit notes and tax status.
 */
async function withTaxLinks(
  tenantId: string,
  provider: BillingProviderClient,
  invoices: readonly ProviderInvoice[]
): Promise<LinkedInvoice[]> {
  const paymentIds = invoices.flatMap((invoice) =>
    invoice.paymentId === null ? [] : [invoice.paymentId]
  )
  const tax = await taxRepository.listForInvoiceRows(
    tenantId,
    { kind: provider.kind, mode: provider.mode },
    paymentIds
  )
  const seller = gstSellerConfig()
  return invoices.map(({ paymentId, ...invoice }) => {
    const references = paymentId === null ? undefined : tax.get(paymentId)
    return {
      ...invoice,
      taxDocument: references?.taxDocument ?? null,
      creditNotes: references?.creditNotes ?? [],
      taxStatus: taxStatusOf(
        { status: invoice.status, paymentId, paidAt: invoice.paidAt },
        references,
        seller
      ),
    }
  })
}

/**
 * One page of a workspace's invoices across the subscriptions it held, the
 * provider's own page cursor travelling signed under the list's scope.
 * Forward only: there is no previous-page cursor.
 * @param provider - The running provider.
 * @param tenantId - The workspace.
 * @param cursor - The previous page's `nextCursor`, if any.
 * @param list - The list's name.
 * @param options - The staff list's status filter and provider-call cap; neither for the owner's list.
 * @returns The page, each invoice with its tax links and without its payment id.
 * @throws {InvalidCursorError} When the cursor does not verify.
 * @throws {HttpError} 503 or 502 when the provider fails.
 */
async function invoicePage(
  provider: BillingProviderClient,
  tenantId: string,
  cursor: string | undefined,
  list: string,
  options: InvoiceListOptions
): Promise<ListPage<LinkedInvoice>> {
  const { statuses } = options
  const subscriptionIds = await invoiceSubscriptionIds(tenantId, provider)
  const scope = invoiceScope(list, tenantId, subscriptionIds, statuses)
  let providerCursor: string | null = null
  if (cursor !== undefined) {
    const [key] = verifyCursor(cursor, {
      sort: list,
      scope,
      keys: [z.string().min(1).max(MAX_PROVIDER_CURSOR_LENGTH)],
    })
    providerCursor = String(key)
  }
  const page = await callProvider(() =>
    provider.listInvoices(subscriptionIds, providerCursor, options)
  )
  return {
    items: await withTaxLinks(tenantId, provider, page.items),
    page: {
      nextCursor: page.nextCursor === null ? null : signCursor(list, scope, [page.nextCursor]),
      prevCursor: null,
      hasNext: page.nextCursor !== null,
      hasPrev: cursor !== undefined,
      limit: INVOICE_PAGE_SIZE,
    },
  }
}

/**
 * One page of a workspace's invoices, for an owner by membership: the
 * scheduled next subscription, the current one, then every earlier
 * subscription the workspace held with this provider and mode, newest
 * first, each with its tax invoice, credit notes and tax status. The
 * provider's own page cursor travels signed.
 * @param actor - The signed-in owner.
 * @param tenantId - The workspace.
 * @param cursor - The previous page's `nextCursor`, if any.
 * @returns The page.
 * @throws {HttpError} 404 when payments are off; 403 for anyone but a member owner; 400 `CURSOR_INVALID`; 503 when the provider is down.
 */
export async function listInvoices(
  actor: Actor,
  tenantId: string,
  cursor: string | undefined
): Promise<ListPage<OwnerInvoiceView>> {
  const provider = requireProvider()
  await assertCustomerTenant(tenantId)
  if (!(await isMemberOwner(actor, tenantId))) {
    throw new HttpError(INVOICES_OWNER_ONLY_MESSAGE, 403)
  }
  // No call cap: an owner's page fills across every subscription, as the contract promises.
  const page = await invoicePage(provider, tenantId, cursor, INVOICE_LIST, {})
  return {
    ...page,
    items: page.items.map(({ subscriptionId: _subscription, ...invoice }) => invoice),
  }
}

/**
 * One page of a customer workspace's invoices for staff, from the same
 * subscriptions as the owner's list, optionally only some statuses. Every
 * page makes at most `STAFF_INVOICE_MAX_READS` provider calls, filtered or
 * not, since any staff viewer can page any workspace. With payments off
 * there is no provider to read: the first page is empty, and any cursor is
 * refused, since no list it could resume exists. The caller has checked the
 * workspace and the staff role.
 * @param tenantId - The customer workspace.
 * @param cursor - The previous page's `nextCursor`, if any.
 * @param statuses - The statuses to list, or undefined for all.
 * @returns The page, each invoice with the subscription it bills and its tax links.
 * @throws {InvalidCursorError} When the cursor does not verify, or any cursor with payments off.
 * @throws {HttpError} 503 or 502 when the provider fails.
 */
export async function listInvoicesForStaff(
  tenantId: string,
  cursor: string | undefined,
  statuses: readonly InvoiceStatus[] | undefined
): Promise<ListPage<LinkedInvoice>> {
  const provider = getBillingProvider()
  if (provider === null) {
    if (cursor !== undefined) throw new InvalidCursorError()
    return {
      items: [],
      page: {
        nextCursor: null,
        prevCursor: null,
        hasNext: false,
        hasPrev: false,
        limit: INVOICE_PAGE_SIZE,
      },
    }
  }
  return invoicePage(provider, tenantId, cursor, STAFF_INVOICE_LIST, {
    ...(statuses !== undefined && { statuses }),
    maxReads: STAFF_INVOICE_MAX_READS,
  })
}
