/**
 * @file Structural inputs for the pure billing rules. A billing record
 * satisfies each of these, so the rules take only the fields they read.
 */
import type { BillingState, PlanKey } from '@/constants/billing.constants'
import type { EntitlementKey, EntitlementValue } from '@/constants/entitlements.constants'

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
