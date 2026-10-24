/**
 * @file Structural inputs for the pure billing rules. A billing record
 * satisfies each of these, so the rules take only the fields they read.
 */
import type { BillingState } from '@/constants/billing.constants'
import type { EntitlementValue } from '@/constants/entitlements.constants'

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
   * Whether the count has reached the cap.
   */
  reached: boolean
  /**
   * Whether the count is inside the warning band below the cap.
   */
  approaching: boolean
}
