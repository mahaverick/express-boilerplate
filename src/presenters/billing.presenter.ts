/**
 * @file A workspace's billing as the owner routes answer it: the billing view
 * every member reads, the checkout session the browser opens the provider's
 * checkout with, and a price's public fields. Dates go out as `Date`s, which
 * the JSON response writes as ISO strings.
 */
import type { BillingInterval, BillingState, PlanKey } from '@/constants/billing.constants'
import type { PlanPrice } from '@/database/models/billing.model'
import type { PastDue } from '@/types/billing'

/**
 * A price as clients see it: no provider ids.
 */
export interface PriceView {
  id: string
  interval: BillingInterval
  amountMinor: number
  currency: 'INR'
}

/**
 * Why a checkout session was opened.
 */
export type CheckoutPurpose = 'upgrade' | 'switch' | 'card_change'

/**
 * What the browser opens the provider's checkout with.
 */
export interface CheckoutSession {
  purpose: CheckoutPurpose
  /**
   * The provider's public key id.
   */
  keyId: string
  subscriptionId: string
  amountMinor: number
  currency: 'INR'
  interval: BillingInterval
  /**
   * The deferred first charge: the trial end or the period end, or null to charge now.
   */
  startsAt: Date | null
  /**
   * The signed-in owner's name and address, to fill in the checkout form.
   */
  prefill: { name: string; email: string }
}

/**
 * Who pays for the workspace.
 */
interface BillingPayer {
  userId: string
  /**
   * Their name, or their email when they have none (`nameOrEmail`).
   */
  name: string
  /**
   * False once the payer has left the workspace.
   */
  isMember: boolean
}

/**
 * A workspace's billing as a member reads it. `billingEmail` is the owner's alone.
 */
export interface TenantBillingView {
  state: BillingState
  plan: { key: PlanKey; name: string }
  interval: BillingInterval | null
  /**
   * The price the workspace pays, which may be a retired one.
   */
  price: PriceView | null
  trialEndsAt: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  pastDue: PastDue | null
  /**
   * The interval billed from the period end by a scheduled switch or
   * resubscribe, shown only once its subscription is authenticated
   * (`nextAuthenticatedAt`); null before, and for an abandoned checkout.
   */
  nextSwitch: { interval: BillingInterval; startsAt: Date } | null
  payer: BillingPayer | null
  billingEmail: string | null
  paymentsEnabled: boolean
  dismissedBanners: string[]
}

/**
 * Project a price for clients.
 * @param price - The price row.
 * @returns Its public fields.
 */
export function toPriceView(price: PlanPrice): PriceView {
  return {
    id: price.id,
    interval: price.interval,
    amountMinor: price.amountMinor,
    // Every seeded and staff-created price is INR; the column is wider for later currencies.
    currency: 'INR',
  }
}

/**
 * A person's display name, for a caller that words its own fallback (the
 * checkout prefill, and the owner emails' "A teammate").
 * @param person - The person's name fields.
 * @param person.firstName - The first name.
 * @param person.lastName - The last name.
 * @returns The names joined, or an empty string when there are none.
 */
export function displayName(person: { firstName: string | null; lastName: string | null }): string {
  return [person.firstName, person.lastName].filter(Boolean).join(' ').trim()
}

/**
 * A person as the billing API names them: their first and last name, or
 * their email when they have neither, as every new passwordless account
 * starts. Clients wrap it as PII either way.
 * @param person - The person.
 * @param person.firstName - The first name.
 * @param person.lastName - The last name.
 * @param person.email - The account's email.
 * @returns A non-empty name.
 */
export function nameOrEmail(person: {
  firstName: string | null
  lastName: string | null
  email: string
}): string {
  const name = displayName(person)
  return name === '' ? person.email : name
}
