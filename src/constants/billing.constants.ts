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
  'tax_held_sez',
  'tax_issue_failed',
  'tax_invoice_late',
  'tax_credit_note_late',
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
 * How long before its first charge a checkout that starts at the current
 * period end (an interval switch or a resubscribe) must lapse: a payment
 * that lands after the current subscription renewed would charge twice.
 */
export const NEXT_CHECKOUT_MARGIN_MS = 60 * 60 * 1000

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
 * Error code: an interval switch so close to the current renewal that its
 * checkout could still be paid after the renewal charged.
 */
export const SWITCH_TOO_CLOSE_TO_RENEWAL_CODE = 'SWITCH_TOO_CLOSE_TO_RENEWAL'

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
 * Where a stored provider event stands: `processed` was handled and the
 * workspace synced (the sync may have changed nothing); `unused` was handled
 * and changed nothing, its error saying why; `failed` gave up after every
 * retry and staff were alerted, so nothing retries it (resync the
 * workspace); `pending` is not handled yet, including while its job retries,
 * since a retried attempt writes nothing to the row.
 */
export const BILLING_EVENT_STATUSES = ['processed', 'unused', 'failed', 'pending'] as const

/**
 * One status of a stored provider event.
 */
export type BillingEventStatus = (typeof BILLING_EVENT_STATUSES)[number]

/**
 * The statuses an invoice is shown with; a draft or deleted invoice is not shown.
 */
export const INVOICE_STATUSES = ['issued', 'paid', 'cancelled', 'expired'] as const

/**
 * One shown invoice status.
 */
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

/**
 * What a held subscription is to its workspace now: the billing row's
 * current, pending or next subscription, or an earlier one.
 */
export type BillingSubscriptionStanding = 'current' | 'pending' | 'next' | 'earlier'

/**
 * When a staff cancel ends a subscription: at its cycle end, or now.
 */
export const STAFF_CANCEL_WHEN = ['cycle_end', 'now'] as const

/**
 * One choice of when a staff cancel ends a subscription.
 */
export type StaffCancelWhen = (typeof STAFF_CANCEL_WHEN)[number]

/**
 * Error code: a staff plan or billing settings edit sent a `version` someone
 * else's edit has since replaced.
 */
export const PLAN_VERSION_CONFLICT_CODE = 'PLAN_VERSION_CONFLICT'

/**
 * A price above this many paise (₹15,000) is allowed, but Apex asks staff to
 * confirm it, in case of a slipped digit.
 */
export const PRICE_WARNING_ABOVE_MINOR = 1_500_000

/**
 * What anyone but an owner by membership reads when they ask for tax
 * details or tax documents, staff acting through platform access included.
 */
export const TAX_DOCUMENTS_OWNER_ONLY_MESSAGE =
  'Only a workspace owner can see tax documents. Ask an owner.'

/**
 * What anyone but an owner by membership reads when they try to change tax
 * details, staff acting through platform access included.
 */
export const TAX_DETAILS_OWNER_ONLY_MESSAGE =
  'Only a workspace owner can change tax details. Ask an owner.'

/**
 * The tax documents 404 on a read while registration is off and the
 * workspace has no documents.
 */
export const TAX_DOCUMENTS_READ_DISABLED_MESSAGE =
  'Tax documents are off, and this workspace has none to download.'

/**
 * The tax documents 404 on a write (tax details, a manual credit note) while
 * registration is off.
 */
export const TAX_DOCUMENTS_WRITE_DISABLED_MESSAGE =
  "Tax documents are off, so tax details and credit notes can't change. Issued documents stay available to download."

/**
 * The tax export's 404 while registration is off and no workspace has a
 * tax document.
 */
export const TAX_DOCUMENTS_EXPORT_DISABLED_MESSAGE =
  'Tax documents are off, and no workspace has any, so there is nothing to export.'

/**
 * The field error for a tax export period that is missing or malformed.
 */
export const TAX_EXPORT_PERIOD_MESSAGE =
  'Use YYYY-MM for a month or YYYY-Q1 to YYYY-Q4 for a quarter.'

/**
 * Error code: a tax details PATCH sent a `version` that no longer matches:
 * stale, null when details exist, or a number when none exist.
 */
export const TAX_DETAILS_VERSION_CONFLICT_CODE = 'TAX_DETAILS_VERSION_CONFLICT'

/**
 * What a tax details PATCH with a stale version reads.
 */
export const TAX_DETAILS_VERSION_CONFLICT_MESSAGE =
  'Someone changed these tax details since you opened them. Reload to see them, then save again.'

/**
 * What an owner reads after saving tax details.
 */
export const TAX_DETAILS_SAVED_MESSAGE =
  'Tax details saved. They apply to invoices issued from now on.'

/**
 * What staff read after saving a workspace's tax details.
 * @param workspaceName - The workspace's name.
 * @returns The message.
 */
export function staffTaxDetailsSavedMessage(workspaceName: string): string {
  return `Tax details for ${workspaceName} saved. They apply to invoices issued from now on.`
}

/**
 * Error code: a manual credit note named a credit note, not an invoice.
 */
export const NOT_AN_INVOICE_CODE = 'NOT_AN_INVOICE'

/**
 * What a manual credit note against a credit note reads.
 */
export const NOT_AN_INVOICE_MESSAGE = 'Credit notes reduce invoices only. Pick the invoice instead.'

/**
 * Error code: a manual credit note is more than what is left to credit on its
 * invoice; `details.remainingMinor` says what is left.
 */
export const CREDIT_EXCEEDS_INVOICE_CODE = 'CREDIT_EXCEEDS_INVOICE'

/**
 * What a manual credit note larger than what is left reads.
 * @param remaining - What is left to credit, in rupees as `formatRupees` writes them.
 * @returns The message.
 */
export function creditExceedsInvoiceMessage(remaining: string): string {
  return `This invoice has ₹${remaining} left to credit. Enter ₹${remaining} or less.`
}

/**
 * What staff read after issuing a credit note by hand.
 * @param number - The note's number.
 * @param amount - Its amount, in rupees as `formatRupees` writes them.
 * @returns The message.
 */
export function creditNoteIssuedMessage(number: string, amount: string): string {
  return `Credit note ${number} issued for ₹${amount}.`
}

/**
 * What a manual credit note amount outside the range reads.
 */
export const CREDIT_NOTE_AMOUNT_MESSAGE =
  'Enter the credit in paise as a whole number from 100 (₹1) to 1,00,00,000 (₹1,00,000).'

/**
 * Error code: a held charge staff tried to resolve is already resolved.
 */
export const HELD_CHARGE_RESOLVED_CODE = 'HELD_CHARGE_RESOLVED'

/**
 * What resolving an already resolved held charge reads.
 * @param date - The day it was resolved, as a person reads it.
 * @returns The message.
 */
export function heldChargeResolvedMessage(date: string): string {
  return `This held charge was resolved on ${date}. Nothing changed.`
}

/**
 * What staff read after marking a held charge resolved.
 */
export const HELD_CHARGE_MARKED_RESOLVED_MESSAGE = 'Held charge marked resolved.'

/**
 * Tax details: the legal name is missing on the first save, or sent blank.
 */
export const TAX_LEGAL_NAME_REQUIRED_MESSAGE = 'Enter the legal name to print on your tax invoices.'

/**
 * Tax details: a legal name or address line over 100 characters.
 */
export const TAX_TEXT_TOO_LONG_MESSAGE = 'Use 100 characters or fewer.'

/**
 * Tax details: a city over 60 characters.
 */
export const TAX_CITY_TOO_LONG_MESSAGE = 'Use 60 characters or fewer.'

/**
 * Tax details: a character the invoice font can't draw.
 */
export const TAX_TEXT_CHARACTERS_MESSAGE = 'Use English letters, digits and common punctuation.'

/**
 * Tax details: a GSTIN of the wrong shape.
 */
export const GSTIN_SHAPE_MESSAGE = 'Enter the 15-character GSTIN, such as 29ABCDE1234F1ZW.'

/**
 * Tax details: a GSTIN whose check character is wrong.
 */
export const GSTIN_CHECKSUM_MESSAGE =
  "This GSTIN's last character doesn't match the rest. Check it against your registration certificate."

/**
 * Tax details: a GSTIN whose first two digits are no selectable state.
 */
export const GSTIN_STATE_MESSAGE = "This GSTIN's first two digits aren't a state code."

/**
 * Tax details: address line 1 is missing with a GSTIN.
 */
export const TAX_ADDRESS_REQUIRED_MESSAGE =
  'Enter address line 1. Invoices with a GSTIN need your registered address.'

/**
 * Tax details: the city is missing with a GSTIN.
 */
export const TAX_CITY_REQUIRED_MESSAGE = 'Enter the city. Invoices with a GSTIN need it.'

/**
 * Tax details: the PIN code is missing with a GSTIN.
 */
export const TAX_PINCODE_REQUIRED_MESSAGE =
  'Enter the 6-digit PIN code. Invoices with a GSTIN need it.'

/**
 * Tax details: the state is missing on the first save, or sent null.
 */
export const TAX_STATE_REQUIRED_MESSAGE =
  'Choose the state of your billing address. It sets the tax split on your invoices.'

/**
 * Tax details: an unknown or retired state code.
 */
export const TAX_STATE_UNKNOWN_MESSAGE = 'Choose a state from the list.'

/**
 * Tax details: a PIN code that isn't six digits with a non-zero first.
 */
export const TAX_PINCODE_FORMAT_MESSAGE = 'Enter the 6-digit PIN code.'

/**
 * Tax details: an SEZ unit with no GSTIN.
 */
export const TAX_SEZ_NEEDS_GSTIN_MESSAGE = 'An SEZ unit has a GSTIN. Enter it first.'

/**
 * Tax details: a PATCH that changes nothing.
 */
export const TAX_DETAILS_NO_CHANGE_MESSAGE = 'Change at least one tax detail before saving.'

/**
 * Tax details: the GSTIN's state is not the chosen state.
 * @param stateName - The state the GSTIN is registered in.
 * @returns The message, on `stateCode`.
 */
export function gstinStateMismatchMessage(stateName: string): string {
  return `This GSTIN is registered in ${stateName}. Choose ${stateName} as the state.`
}
