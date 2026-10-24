/**
 * @file Billing constants: the states a workspace subscription can be in,
 * the plans that exist, and the fixed windows the state rules use.
 */

/**
 * Every state a workspace's billing record can hold.
 */
export const BILLING_STATES = ['trialing', 'free', 'active', 'past_due'] as const

/**
 * One state of a workspace's billing record.
 */
export type BillingState = (typeof BILLING_STATES)[number]

/**
 * The seeded plan keys.
 */
export const PLAN_KEYS = ['free', 'paid'] as const

/**
 * The key of a seeded plan.
 */
export type PlanKey = (typeof PLAN_KEYS)[number]

/**
 * How often a price bills.
 */
export const BILLING_INTERVALS = ['month', 'year'] as const

/**
 * One billing interval.
 */
export type BillingInterval = (typeof BILLING_INTERVALS)[number]

/**
 * The payment providers a subscription can live with. `fake` is the local
 * stand-in for development and end-to-end runs.
 */
export const BILLING_PROVIDERS = ['razorpay', 'fake'] as const

/**
 * One payment provider.
 */
export type BillingProvider = (typeof BILLING_PROVIDERS)[number]

/**
 * The provider account a row belongs to: its test or its live keys.
 */
export const BILLING_PROVIDER_MODES = ['test', 'live'] as const

/**
 * One provider mode.
 */
export type BillingProviderMode = (typeof BILLING_PROVIDER_MODES)[number]

/**
 * What moved a workspace from one billing state to another.
 */
export const BILLING_HISTORY_SOURCES = [
  'webhook',
  'confirm',
  'reconcile',
  'job',
  'staff',
  'owner',
] as const

/**
 * One source of a billing state change.
 */
export type BillingHistorySource = (typeof BILLING_HISTORY_SOURCES)[number]

/**
 * The kinds of billing alert staff see.
 */
export const BILLING_ALERT_KINDS = [
  'duplicate_refunded',
  'webhook_failing',
  'reconcile_repair',
  'dispute',
  'subscription_completed',
] as const

/**
 * One kind of billing alert.
 */
export type BillingAlertKind = (typeof BILLING_ALERT_KINDS)[number]

/**
 * Days a cancelling subscription keeps Paid after its period ends, so a late
 * provider event never cuts access early.
 */
export const CANCEL_BUFFER_DAYS = 3

/**
 * Error code: a write would take a plan limit past its cap.
 */
export const PLAN_LIMIT_REACHED_CODE = 'PLAN_LIMIT_REACHED'

/**
 * Error code: the workspace's plan does not include the feature a route needs.
 */
export const PLAN_FEATURE_REQUIRED_CODE = 'PLAN_FEATURE_REQUIRED'
