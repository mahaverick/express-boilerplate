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

/**
 * The Razorpay API every real provider call goes to.
 */
export const RAZORPAY_API_BASE_URL = 'https://api.razorpay.com/v1'

/**
 * How long one Razorpay call, body included, may take before it fails as a
 * retryable timeout.
 */
export const RAZORPAY_API_TIMEOUT_MS = 10_000

/**
 * How many cycles a checkout's subscription bills before it completes, per
 * interval: five years either way, below every cap the provider documents.
 */
export const CHECKOUT_TOTAL_COUNT = { month: 60, year: 5 } as const satisfies Record<
  BillingInterval,
  number
>

/**
 * How long an unpaid checkout's subscription lives before the provider expires it.
 */
export const CHECKOUT_EXPIRY_MS = 60 * 60 * 1000

/**
 * How long a stored unpaid checkout must still have before it is handed to
 * the browser again, so a payer is never sent to one that lapses mid-payment.
 */
export const CHECKOUT_REUSE_MIN_REMAINING_MS = 10 * 60 * 1000

/**
 * How many invoices one page of a workspace's invoice list holds.
 */
export const INVOICE_PAGE_SIZE = 20

/**
 * Error code: a checkout while the workspace already has a live subscription.
 */
export const SUBSCRIPTION_EXISTS_CODE = 'SUBSCRIPTION_EXISTS'

/**
 * Error code: a cancel, interval switch or card change with no subscription to act on.
 */
export const NO_SUBSCRIPTION_CODE = 'NO_SUBSCRIPTION'

/**
 * Error code: an interval switch to the interval already billed.
 */
export const SAME_INTERVAL_CODE = 'SAME_INTERVAL'

/**
 * Error code: a checkout confirm whose ids or signature do not match the
 * workspace's stored checkout.
 */
export const CHECKOUT_MISMATCH_CODE = 'CHECKOUT_MISMATCH'

/**
 * Error code: the payment provider did not answer, so nothing changed.
 */
export const PAYMENT_PROVIDER_UNAVAILABLE_CODE = 'PAYMENT_PROVIDER_UNAVAILABLE'

/**
 * Error code: the billing record kept changing under a write, so nothing changed.
 */
export const BILLING_BUSY_CODE = 'BILLING_BUSY'

/**
 * What anyone but an owner by membership reads when they try to change
 * billing, staff acting through platform access included.
 */
export const BILLING_OWNER_ONLY_MESSAGE = 'Only a workspace owner can change billing. Ask an owner.'

/**
 * What anyone but an owner by membership reads when they ask for invoices.
 */
export const INVOICES_OWNER_ONLY_MESSAGE = 'Only a workspace owner can see invoices. Ask an owner.'

/**
 * Error code: an interval switch before a deferred start's first charge.
 */
export const SWITCH_BEFORE_FIRST_CHARGE_CODE = 'SWITCH_BEFORE_FIRST_CHARGE'

/**
 * Where in the product a member asked an owner to upgrade.
 */
export const UPGRADE_SURFACES = ['limit', 'feature', 'banner', 'billing_page', 'pricing'] as const

/**
 * One place a member can ask to upgrade from.
 */
export type UpgradeSurface = (typeof UPGRADE_SURFACES)[number]

/**
 * Days an open upgrade request lasts before it lapses.
 */
export const UPGRADE_REQUEST_EXPIRY_DAYS = 30

/**
 * The billing banners a member can dismiss for a workspace.
 */
export const DISMISSIBLE_BANNERS = ['trial_ended'] as const

/**
 * Error code: an upgrade request for a workspace already paying for Paid.
 */
export const ALREADY_PAID_CODE = 'ALREADY_PAID'

/**
 * What an owner reads when they ask to upgrade: they can do it themselves.
 */
export const UPGRADE_REQUEST_OWNER_MESSAGE = 'Owners can upgrade from Billing.'

/**
 * What staff acting through platform access read when they ask to upgrade
 * a workspace: only its members can.
 */
export const UPGRADE_REQUEST_MEMBERS_ONLY_MESSAGE =
  'Only workspace members can ask to upgrade. Ask an owner of the workspace.'

/**
 * What anyone but an owner by membership reads when they ask for the
 * workspace's upgrade requests.
 */
export const UPGRADE_REQUESTS_OWNER_ONLY_MESSAGE =
  'Only a workspace owner can see upgrade requests. Ask an owner.'

/**
 * What a member reads when they ask to upgrade a workspace already on Paid.
 */
export const ALREADY_PAID_MESSAGE =
  'This workspace is already on Paid. Refresh the page to see its features.'

/**
 * Error code: a staff trial extension on a workspace that is paying or past due.
 */
export const TRIAL_NOT_EXTENDABLE_CODE = 'TRIAL_NOT_EXTENDABLE'

/**
 * The most days a trial may be set to, or one staff extension may add. It
 * caps each extension, not the trial's total length: extensions add up.
 */
export const MAX_TRIAL_DAYS = 90

/**
 * How many state changes and provider events the staff billing view lists, newest first.
 */
export const STAFF_BILLING_LIST_LIMIT = 20

/**
 * When a staff cancel ends a subscription: at its cycle end, or now.
 */
export const STAFF_CANCEL_WHEN = ['cycle_end', 'now'] as const

/**
 * One choice of when a staff cancel ends a subscription.
 */
export type StaffCancelWhen = (typeof STAFF_CANCEL_WHEN)[number]
