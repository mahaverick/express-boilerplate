/**
 * @file Billing types: the structural inputs of the pure billing rules (a
 * billing record satisfies each, so the rules take only the fields they
 * read), and the payment provider's contract with its answers.
 */
import type {
  BillingProvider,
  BillingProviderMode,
  BillingState,
  PlanKey,
} from '@/constants/billing.constants'
import type { EntitlementKey, EntitlementValue } from '@/constants/entitlements.constants'
import type { PlanPrice } from '@/database/models/billing.model'

/**
 * The fields that decide a workspace's effective state.
 */
export interface BillingStateInput {
  /**
   * The stored state.
   */
  state: BillingState
  /**
   * When the trial ends, if there is one.
   */
  trialEndsAt: Date | null
  /**
   * When the paid period ends.
   */
  currentPeriodEnd: Date | null
  /**
   * Whether the subscription ends at the period end.
   */
  cancelAtPeriodEnd: boolean
  /**
   * When the provider halted the subscription.
   */
  haltedAt: Date | null
  /**
   * When the subscription was paused.
   */
  pausedAt: Date | null
}

/**
 * The fields that start the grace window.
 */
export type BillingGraceInput = Pick<BillingStateInput, 'haltedAt' | 'pausedAt'>

/**
 * One entitlement grant a staff member gave a workspace.
 */
export interface EntitlementGrantInput {
  /**
   * The registry key.
   */
  key: string
  /**
   * The value the grant gives.
   */
  value: EntitlementValue
  /**
   * When the grant lapses, or null for never.
   */
  expiresAt: Date | null
  /**
   * When the grant was revoked, or null if it stands.
   */
  revokedAt: Date | null
}

/**
 * How close a count is to its limit.
 */
export interface LimitUsage {
  /**
   * The cap, or null for none.
   */
  limit: number | null
  /**
   * The count in use.
   */
  used: number
  /**
   * Whether the count is inside the warning band below the cap.
   */
  approaching: boolean
}

/**
 * A workspace whose payment failed, while it keeps Paid.
 */
export interface PastDue {
  /**
   * When the payment first failed.
   */
  since: Date
  /**
   * When Paid ends unless a payment lands, or null while the provider still retries.
   */
  graceEndsAt: Date | null
  /**
   * Whether the subscription is paused.
   */
  paused: boolean
}

/**
 * What a workspace may use now: its effective plan and state, and every
 * feature and limit with how much of each limit is used.
 */
interface TenantEntitlements {
  /**
   * The plan the effective state is served from: Paid while trialing, active or past due.
   */
  plan: { key: PlanKey; name: string }
  /**
   * The effective state: a trial or paid period that has ended reads `free`
   * before any job catches up.
   */
  state: BillingState
  /**
   * When the trial ends, if there is one.
   */
  trialEndsAt: Date | null
  /**
   * When the paid period ends.
   */
  currentPeriodEnd: Date | null
  /**
   * Whether the subscription ends at the period end.
   */
  cancelAtPeriodEnd: boolean
  /**
   * The failed payment, while the workspace is past due.
   */
  pastDue: PastDue | null
  /**
   * Each feature key and whether the workspace has it.
   */
  features: Record<string, boolean>
  /**
   * Each limit key with its cap and use.
   */
  limits: Record<string, LimitUsage>
}

/**
 * A workspace's entitlements with where each value came from: its plan or a staff grant.
 */
export type SourcedEntitlements = TenantEntitlements & {
  /**
   * Each registry key and whether the plan or a grant set its value.
   */
  sources: Record<EntitlementKey, 'plan' | 'grant'>
}

/**
 * Every status a provider subscription can report.
 */
export type ProviderSubscriptionStatus =
  | 'created'
  | 'authenticated'
  | 'active'
  | 'pending'
  | 'halted'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'expired'

/**
 * A subscription as the payment provider reports it.
 */
export interface ProviderSubscription {
  /**
   * The provider's subscription id.
   */
  id: string
  /**
   * The provider's status.
   */
  status: ProviderSubscriptionStatus
  /**
   * The provider plan it bills.
   */
  planId: string
  /**
   * When the current cycle started, or null before the first charge.
   */
  currentStart: Date | null
  /**
   * When the current cycle ends. It moves forward before the cycle is paid,
   * so it is not "paid through" on its own: read it with `latestInvoicePaid`.
   */
  currentEnd: Date | null
  /**
   * When the first charge is (or was) due.
   */
  startAt: Date | null
  /**
   * When the subscription ended, or null while it runs.
   */
  endedAt: Date | null
  /**
   * When the next charge is due, or null when none is scheduled.
   */
  chargeAt: Date | null
  /**
   * The notes the subscription was created with.
   */
  notes: Record<string, string>
  /**
   * How many cycles have been paid.
   */
  paidCount: number
  /**
   * The provider's customer id, once the payer authenticated.
   */
  customerId: string | null
  /**
   * When an unpaid checkout lapses, or null when it never does.
   */
  expireBy: Date | null
  /**
   * Whether a plan or quantity change is scheduled.
   */
  hasScheduledChanges: boolean
  /**
   * Whether the invoice of the current cycle, the one whose billing period
   * starts at `currentStart`, is paid. It fails closed: false when no invoice
   * matches the cycle, when there is no cycle yet (a deferred start), and for
   * every status but `active`, which is read without asking for invoices,
   * since the period end only counts while the subscription is active.
   */
  latestInvoicePaid: boolean
}

/**
 * What a new subscription is created with.
 */
export interface CreateSubscriptionInput {
  /**
   * The provider plan, from `ensurePlan`.
   */
  providerPlanId: string
  /**
   * How many cycles it bills before it completes.
   */
  totalCount: number
  /**
   * When an unpaid checkout lapses.
   */
  expireBy: Date
  /**
   * When the first charge is due, or null to charge at checkout.
   */
  startAt: Date | null
  /**
   * Ids that tie the subscription back to the workspace and price.
   */
  notes: Record<string, string>
}

/**
 * The ids the provider's checkout hands the browser after a payment.
 */
export interface CheckoutConfirm {
  razorpay_payment_id: string
  razorpay_subscription_id: string
  razorpay_signature: string
}

/**
 * One invoice as an owner sees it.
 */
export interface InvoiceView {
  id: string
  amountMinor: number
  currency: 'INR'
  status: 'issued' | 'paid' | 'cancelled' | 'expired'
  issuedAt: string
  paidAt: string | null
  url: string | null
}

/**
 * The price fields `ensurePlan` reads.
 */
export type ProviderPlanPrice = Pick<
  PlanPrice,
  'id' | 'interval' | 'amountMinor' | 'currency' | 'provider' | 'providerMode' | 'providerPlanId'
>

/**
 * What a refund of a subscription's latest payment did: `refunded` with the
 * refund the provider accepted; `nothing_paid` when no payment exists;
 * `already_refunded` when the payment was refunded in full before;
 * `partly_refunded` when part of it was, so nothing more was refunded.
 */
export type ProviderRefundOutcome =
  | {
      status: 'refunded'
      /**
       * The provider's refund id.
       */
      refundId: string
      /**
       * The amount refunded, in the currency's minor unit.
       */
      amountMinor: number
    }
  | { status: 'nothing_paid' }
  | { status: 'already_refunded' }
  | { status: 'partly_refunded' }

/**
 * One page of invoices.
 */
export interface ProviderInvoicePage {
  /**
   * The invoices on this page.
   */
  items: InvoiceView[]
  /**
   * The cursor for the next page, or null on the last one.
   */
  nextCursor: string | null
}

/**
 * The calls billing makes to its payment provider. Each failed call throws
 * `ProviderError`; none reads a failure as a subscription state.
 */
export interface BillingProviderClient {
  /**
   * Which provider answers.
   */
  readonly kind: BillingProvider
  /**
   * The provider account's mode.
   */
  readonly mode: BillingProviderMode
  /**
   * The public key id the browser checkout opens with.
   */
  readonly keyId: string
  /**
   * The provider plan for a price: the stored id when it belongs to this
   * provider and mode, else a new plan. The caller stores a new id.
   * @param price - The price.
   * @param planName - The name the plan's item carries.
   * @returns The provider plan id.
   */
  ensurePlan(price: ProviderPlanPrice, planName: string): Promise<string>
  /**
   * Create a subscription for checkout.
   * @param input - The plan, cycle count, checkout expiry, deferred start and notes.
   * @returns The new subscription.
   */
  createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription>
  /**
   * Read one subscription.
   * @param id - The provider's subscription id.
   * @returns The subscription.
   */
  fetchSubscription(id: string): Promise<ProviderSubscription>
  /**
   * Every subscription created since a time, all pages read.
   * @param since - The earliest creation time.
   * @returns The subscriptions.
   */
  listRecentSubscriptions(since: Date): Promise<ProviderSubscription[]>
  /**
   * Cancel a subscription now or at the end of its cycle.
   * @param id - The provider's subscription id.
   * @param isAtCycleEnd - True to keep it until the cycle ends.
   * @returns The subscription after the cancel.
   */
  cancelSubscription(id: string, isAtCycleEnd: boolean): Promise<ProviderSubscription>
  /**
   * Refund the subscription's latest paid payment in full, once: a payment
   * that already has a refund, in full or in part, is not refunded again.
   * @param subscriptionId - The provider's subscription id.
   * @returns What the refund did.
   */
  refundLatestPayment(subscriptionId: string): Promise<ProviderRefundOutcome>
  /**
   * One page of the invoices of some subscriptions, in the order given.
   * @param subscriptionIds - The subscriptions, newest first.
   * @param cursor - The previous page's `nextCursor`, or null for the first page.
   * @returns The page.
   */
  listInvoices(subscriptionIds: string[], cursor: string | null): Promise<ProviderInvoicePage>
  /**
   * The subscription a payment was taken for, through the payment's invoice:
   * a dispute or a refund names only the payment.
   * @param paymentId - The provider's payment id.
   * @returns The subscription id, or null when the payment belongs to no subscription.
   */
  findSubscriptionIdForPayment(paymentId: string): Promise<string | null>
  /**
   * Whether a checkout's signature was made by the provider for the expected
   * subscription.
   * @param input - What the browser posted.
   * @param expectedSubscriptionId - The subscription this checkout must be for.
   * @returns True only for a matching signature over the expected subscription.
   */
  verifyCheckout(input: CheckoutConfirm, expectedSubscriptionId: string): boolean
  /**
   * Whether a webhook body was signed with a current or previous webhook secret.
   * @param rawBody - The exact request bytes.
   * @param signature - The signature header, if any.
   * @returns True for a matching signature.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean
}
