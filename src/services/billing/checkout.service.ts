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
  NO_SUBSCRIPTION_CODE,
  PAYMENT_PROVIDER_UNAVAILABLE_CODE,
  SAME_INTERVAL_CODE,
  SUBSCRIPTION_EXISTS_CODE,
  SWITCH_BEFORE_FIRST_CHARGE_CODE,
  type BillingInterval,
} from '@/constants/billing.constants'
import type {
  NewTenantBilling,
  PlanPrice,
  TenantBillingRecord,
} from '@/database/models/billing.model'
import { ProviderError } from '@/errors/billing-provider-errors'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import {
  displayName,
  toPriceView,
  type CheckoutPurpose,
  type CheckoutSession,
  type TenantBillingView,
} from '@/presenters/billing.presenter'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { emitBillingDiff } from '@/services/billing/billing-events.service'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import {
  BillingSyncConflictError,
  syncTenantBilling,
} from '@/services/billing/billing-sync.service'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { lockBilling } from '@/services/billing/trial.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { lockActorRole } from '@/services/tenant-membership.service'
import type { Actor } from '@/types/actor'
import type {
  BillingProviderClient,
  CheckoutConfirm,
  InvoiceView,
  ProviderSubscription,
} from '@/types/billing'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { bindScope, listScope, signCursor, verifyCursor } from '@/utilities/list-cursor.utilities'
import type { ListPage } from '@/utilities/list-page.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()
const membershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * How many times a write reads, calls the provider and writes before it
 * gives up on a row that keeps moving.
 */
const WRITE_ATTEMPTS = 3

/**
 * How long a client waits before retrying a write that found the provider
 * down or the row busy.
 */
const RETRY_AFTER_SECONDS = 30

/**
 * The sort and list name the invoice cursor is bound to.
 */
const INVOICE_LIST = 'tenant-billing-invoices'

/**
 * The longest provider page cursor an invoice cursor may carry.
 */
const MAX_PROVIDER_CURSOR_LENGTH = 64

/**
 * Statuses after which a subscription can no longer be cancelled.
 */
const ENDED_STATUSES: ReadonlySet<ProviderSubscription['status']> = new Set([
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
function billingBusy(): HttpError {
  return new HttpError(
    'Your billing is updating right now. Try again in 30 seconds.',
    503,
    BILLING_BUSY_CODE,
    undefined,
    { retryAfterSeconds: RETRY_AFTER_SECONDS }
  )
}

/**
 * A provider failure as the HTTP answer: 503 with a retry wait when the
 * provider may answer later, 502 when it refused the call. Either reports
 * the failure as its cause; nothing was written.
 * @param error - What the provider call threw.
 * @returns The error to throw.
 */
function providerFailure(error: unknown): Error {
  if (!(error instanceof ProviderError)) {
    return error instanceof Error ? error : new Error('A billing step failed', { cause: error })
  }
  return new HttpError(
    error.retryable
      ? 'Our payment provider did not answer. Try again in 30 seconds.'
      : 'Our payment provider declined this change. Contact support if it happens again.',
    error.retryable ? 503 : 502,
    PAYMENT_PROVIDER_UNAVAILABLE_CODE,
    undefined,
    { cause: error, ...(error.retryable && { retryAfterSeconds: RETRY_AFTER_SECONDS }) }
  )
}

/**
 * Run a provider call, mapping its failure to the HTTP answer.
 * @param call - The call.
 * @returns What the call returns.
 */
async function callProvider<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw providerFailure(error)
  }
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
 * Refuse a write on a live row of another provider or mode: the running
 * provider cannot read or change its subscription, so staff must.
 * @param row - The row.
 * @param provider - The running provider.
 * @param code - The refusal's code.
 * @throws {HttpError} 409 with `code`.
 */
function assertOwnProviderWhenLive(
  row: TenantBillingRecord,
  provider: BillingProviderClient,
  code: string
): void {
  if (!isOtherProvider(row, provider)) return
  logger.warn('An owner billing write met a row of another provider or mode', {
    tenantId: row.tenantId,
    rowProvider: row.provider,
    rowMode: row.providerMode,
    provider: provider.kind,
    mode: provider.mode,
  })
  throw new HttpError(
    'Your subscription is with another payment account. Contact support to change it.',
    409,
    code
  )
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
 * Where an upgrade checkout goes, or why it is refused. A live current
 * subscription refuses it, unless it is cancelling with paid time left: then
 * it is a resubscribe that starts at the period end.
 * @param row - The row.
 * @param provider - The running provider.
 * @param now - The current time.
 * @returns The slot.
 * @throws {HttpError} 409 `SUBSCRIPTION_EXISTS`.
 */
function upgradeSlot(
  row: TenantBillingRecord,
  provider: BillingProviderClient,
  now: Date
): CheckoutSlot {
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
      return { slot: 'next', startAt: row.currentPeriodEnd, isTakeover: false }
    }
  }
  return { slot: 'pending', startAt: trialStart(row, now), isTakeover: false }
}

/**
 * Where an interval switch goes, or why it is refused: it needs an active,
 * not cancelling subscription past its first charge, on another interval.
 * @param row - The row.
 * @param provider - The running provider.
 * @param now - The current time.
 * @param interval - The interval asked for.
 * @returns The slot: the next subscription, from the period end.
 * @throws {HttpError} 409 `NO_SUBSCRIPTION` or `SAME_INTERVAL`.
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
      `Your first payment is due when your trial ends at ${formatUtcDateTime(row.trialEndsAt)}. Switch the interval after that.`,
      409,
      SWITCH_BEFORE_FIRST_CHARGE_CODE
    )
  }
  if (row.currentPeriodEnd === null || row.currentPeriodEnd <= now) {
    throw noSubscription('Your renewal payment is still processing. Try again in 1 hour.')
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
 * the same price and first charge, and not about to lapse.
 * @param sub - The stored subscription.
 * @param priceId - The price asked for.
 * @param startAt - The first charge asked for.
 * @param now - The current time.
 * @returns True when it can be reused.
 */
function isReusable(
  sub: ProviderSubscription,
  priceId: string,
  startAt: Date | null,
  now: Date
): boolean {
  return (
    sub.status === 'created' &&
    sub.notes.priceId === priceId &&
    (sub.startAt?.getTime() ?? null) === (startAt?.getTime() ?? null) &&
    (sub.expireBy === null ||
      sub.expireBy.getTime() - now.getTime() > CHECKOUT_REUSE_MIN_REMAINING_MS)
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
            : `at ${formatUtcDateTime(read.currentPeriodEnd)}`
        throw subscriptionExists(
          purpose === 'switch'
            ? `An interval switch is already scheduled to start ${starts}. Cancel under Billing to choose again.`
            : `Your workspace already continues on Paid ${starts}. Cancel under Billing to change it.`
        )
      }
    }
    let chosen: ProviderSubscription
    if (held !== undefined && isReusable(held, price.id, slot.startAt, now)) chosen = held
    else if (created !== undefined && isReusable(created, price.id, slot.startAt, now)) {
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
          expireBy: new Date(now.getTime() + CHECKOUT_EXPIRY_MS),
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
    await emitBillingDiff(stored.before, stored.after, 'owner')
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
async function syncOrRetry(tenantId: string, source: 'confirm' | 'owner'): Promise<void> {
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
 * Confirm a checkout the browser finished: the posted subscription must be
 * this workspace's pending, next or (for a card change) current one, the
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
  if (stored === undefined || isOtherProvider(row, provider)) throw checkoutMismatch()
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

  const user = await userRepository.findById(actor.userId)
  if (user !== undefined) {
    const written = await withTransaction(async (tx) => {
      const locked = await lockOwnerAndBilling(actor, tenantId, tx)
      const isHeld = [
        locked.providerSubscriptionId,
        locked.pendingSubscriptionId,
        locked.nextSubscriptionId,
      ].includes(stored)
      const isCardChange =
        locked.providerSubscriptionId === stored && locked.cardChangeStartedAt !== null
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
    if (written !== undefined) await emitBillingDiff(written.before, written.after, 'owner')
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
 * Cancel Paid, as an owner by membership. A subscription past its first
 * charge is cancelled at its cycle end: the workspace keeps Paid until then
 * and reads cancelling, which this records itself, since the provider does
 * not show a scheduled cancel. A deferred start (upgraded during a trial, not
 * charged yet) cannot be cancelled at its cycle end, so it is cancelled now
 * and the workspace goes back to its trial, or to Free when the trial is
 * over. A scheduled switch or resubscribe is cancelled too.
 * @param actor - The signed-in owner.
 * @param tenantId - The workspace.
 * @returns The workspace's billing after the cancel.
 * @throws {HttpError} 404 when payments are off; 403 for anyone but a member owner; 409 `NO_SUBSCRIPTION` with nothing to cancel; 503 when the provider is down.
 */
export async function cancelPaid(actor: Actor, tenantId: string): Promise<TenantBillingView> {
  const provider = requireProvider()
  await assertCustomerTenant(tenantId)
  const row = await withTransaction((tx) => lockOwnerAndBilling(actor, tenantId, tx))
  assertOwnProviderWhenLive(row, provider, NO_SUBSCRIPTION_CODE)
  const currentId =
    hasCurrentSubscription(row) && !row.cancelAtPeriodEnd ? row.providerSubscriptionId : null
  const nextId = row.nextSubscriptionId
  if (currentId === null && nextId === null) {
    throw noSubscription(
      row.cancelAtPeriodEnd && row.currentPeriodEnd !== null
        ? `Your subscription already ends at ${formatUtcDateTime(row.currentPeriodEnd)}. To keep Paid after that, upgrade again under Billing.`
        : 'Your workspace has no subscription to cancel. There is nothing to do.'
    )
  }

  let currentCancel: 'cycle_end' | 'now' | undefined
  if (currentId !== null) {
    const current = await callProvider(() => provider.fetchSubscription(currentId))
    if (ENDED_STATUSES.has(current.status) && nextId === null) {
      // It ended at the provider already: the sync records that, and there is nothing to cancel.
      await syncOrRetry(tenantId, 'owner')
      return getTenantBilling(actor, tenantId)
    }
    if (!ENDED_STATUSES.has(current.status)) {
      currentCancel = 'cycle_end'
      if (current.status === 'authenticated') {
        // Read again just before cancelling now: a first charge that landed meanwhile makes it a cycle-end cancel.
        const latest = await callProvider(() => provider.fetchSubscription(currentId))
        if (latest.status === 'authenticated') currentCancel = 'now'
      }
      await cancelOrEnded(provider, currentId, currentCancel === 'cycle_end')
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
    const locked = await lockOwnerAndBilling(actor, tenantId, tx)
    const patch: Partial<NewTenantBilling> = {}
    const isSameCurrent = currentId !== null && locked.providerSubscriptionId === currentId
    if (isSameCurrent && currentCancel === 'cycle_end') patch.cancelAtPeriodEnd = true
    if (isSameCurrent && currentCancel === 'now' && locked.state === 'active') {
      const isTrialLeft = locked.trialEndsAt !== null && locked.trialEndsAt > now
      patch.state = isTrialLeft ? 'trialing' : 'free'
      patch.priceId = null
      patch.currentPeriodEnd = null
      patch.cancelAtPeriodEnd = false
      if (!isTrialLeft) {
        const free = await planRepository.findPlanByKey('free', tx)
        if (free === undefined) throw new HttpError('The free plan is missing', 500)
        patch.planId = free.id
      }
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
        {
          tenantId,
          fromState: locked.state,
          toState: patch.state,
          cause: 'cancelled',
          source: 'owner',
        },
        tx
      )
    }
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
    return { before: locked, after }
  })
  await emitBillingDiff(written.before, written.after, 'owner')
  if (nextFailure !== undefined) throw nextFailure
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
 * The payer, and whether they are still a member.
 * @param tenantId - The workspace.
 * @param payerUserId - The payer, or null.
 * @returns The payer, or null when there is none or their account is gone.
 */
async function payerOf(
  tenantId: string,
  payerUserId: string | null
): Promise<TenantBillingView['payer']> {
  if (payerUserId === null) return null
  const user = await userRepository.findById(payerUserId)
  if (user === undefined) return null
  const membership = await membershipRepository.findByUserAndTenant(payerUserId, tenantId)
  return { userId: user.id, name: displayName(user), isMember: membership !== undefined }
}

/**
 * A workspace's billing as the actor may see it. Any member and staff with
 * platform access read it; the billing email is shown only to an owner by
 * membership. The state and plan are the effective ones, as entitlements
 * read them. A scheduled switch or resubscribe shows once its subscription
 * is authenticated, which the sync stamps in `nextAuthenticatedAt`.
 * @param actor - The signed-in user.
 * @param tenantId - The workspace.
 * @returns The billing view.
 * @throws {HttpError} The unknown-route 404 for the platform workspace.
 */
export async function getTenantBilling(actor: Actor, tenantId: string): Promise<TenantBillingView> {
  const row = await billingRepository.findByTenantId(tenantId)
  if (row === undefined) {
    await assertCustomerTenant(tenantId)
    logger.error('A customer workspace has no billing row; serving it Free', { tenantId })
  }
  const entitlements = await getEffectiveEntitlements(tenantId)
  const isOwner = await isMemberOwner(actor, tenantId)
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
    payer: await payerOf(tenantId, row?.payerUserId ?? null),
    billingEmail: isOwner ? (row?.billingEmail ?? null) : null,
    paymentsEnabled: getBillingProvider() !== null,
    dismissedBanners: await billingRepository.listDismissals(actor.userId, tenantId),
  }
}

/**
 * The scope an invoice cursor is bound to: the list, the workspace and the
 * subscriptions it pages through, so a cursor from another workspace, or from
 * before the subscriptions changed, is refused.
 * @param tenantId - The workspace.
 * @param subscriptionIds - The subscriptions listed.
 * @returns The scope hash.
 */
function invoiceScope(tenantId: string, subscriptionIds: readonly string[]): string {
  return bindScope(listScope({ search: undefined, sort: INVOICE_LIST, filters: {} }), {
    list: INVOICE_LIST,
    tenantId,
    subscriptions: subscriptionIds.join(','),
  })
}

/**
 * One page of a workspace's invoices, newest subscription first, for an
 * owner by membership. The provider's own page cursor travels signed.
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
): Promise<ListPage<InvoiceView>> {
  const provider = requireProvider()
  await assertCustomerTenant(tenantId)
  if (!(await isMemberOwner(actor, tenantId))) {
    throw new HttpError(INVOICES_OWNER_ONLY_MESSAGE, 403)
  }
  const row = await billingRepository.findByTenantId(tenantId)
  const subscriptionIds =
    row === undefined || isOtherProvider(row, provider)
      ? []
      : [row.nextSubscriptionId, row.providerSubscriptionId].filter(
          (id): id is string => id !== null
        )
  const scope = invoiceScope(tenantId, subscriptionIds)
  let providerCursor: string | null = null
  if (cursor !== undefined) {
    const [key] = verifyCursor(cursor, {
      sort: INVOICE_LIST,
      scope,
      keys: [z.string().min(1).max(MAX_PROVIDER_CURSOR_LENGTH)],
    })
    providerCursor = String(key)
  }
  const page = await callProvider(() => provider.listInvoices(subscriptionIds, providerCursor))
  return {
    items: page.items,
    page: {
      nextCursor:
        page.nextCursor === null ? null : signCursor(INVOICE_LIST, scope, [page.nextCursor]),
      prevCursor: null,
      hasNext: page.nextCursor !== null,
      hasPrev: cursor !== undefined,
      limit: INVOICE_PAGE_SIZE,
    },
  }
}
