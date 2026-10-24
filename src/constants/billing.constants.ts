/**
 * @file Billing constants: the states a workspace subscription can be in,
 * the plans that exist, and the fixed windows the state rules use.
 */

/**
 * Every state a workspace's billing record can hold.
 */
const BILLING_STATES = ['trialing', 'free', 'active', 'past_due'] as const

/**
 * One state of a workspace's billing record.
 */
export type BillingState = (typeof BILLING_STATES)[number]

/**
 * The seeded plan keys.
 */
const PLAN_KEYS = ['free', 'paid'] as const

/**
 * The key of a seeded plan.
 */
export type PlanKey = (typeof PLAN_KEYS)[number]

/**
 * Days a cancelling subscription keeps Paid after its period ends, so a late
 * provider event never cuts access early.
 */
export const CANCEL_BUFFER_DAYS = 3
