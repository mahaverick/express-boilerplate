/**
 * @file Billing as the staff routes answer it. A tenant's billing: the
 * billing view a member reads, without the owner-only fields, plus the
 * provider's ids, the effective entitlements with where each value came
 * from, the grants, and the newest state changes and provider events. A
 * provider event shows its type, times and error only, never its payload.
 * A staff invoice drops the owner's link. Then the plans with their prices and counts, a plan change's preview, the
 * billing settings and the alerts. Dates go out as
 * `Date`s, which the JSON response writes as ISO strings.
 */
import type {
  BillingAlertKind,
  BillingHistorySource,
  BillingProvider,
  BillingProviderMode,
  BillingState,
  PlanKey,
} from '@/constants/billing.constants'
import type { EntitlementValue } from '@/constants/entitlements.constants'
import type {
  BillingAlertRecord,
  BillingEventRecord,
  BillingStateHistoryRecord,
  EntitlementGrant,
  PlanPrice,
} from '@/database/models/billing.model'
import { toPriceView, type PriceView, type TenantBillingView } from '@/presenters/billing.presenter'
import type { SourcedEntitlements } from '@/types/billing'
import type { LinkedInvoice } from '@/types/tax'

/**
 * Where a grant stands: in force, past its expiry, or revoked by staff.
 */
type GrantStatus = 'active' | 'expired' | 'revoked'

/**
 * A staff grant as Apex shows it.
 */
export interface GrantView {
  id: string
  key: string
  value: EntitlementValue
  reason: string
  /**
   * The staff member who granted it, or null when no account is on record
   * (purged, or the grant was written by a script). The name falls back to
   * their email when they have none.
   */
  grantedBy: { userId: string; name: string } | null
  createdAt: Date
  expiresAt: Date | null
  revokedAt: Date | null
  status: GrantStatus
}

/**
 * A tenant's billing as staff read it.
 */
export interface StaffTenantBillingView extends TenantBillingView {
  provider: BillingProvider | null
  providerMode: BillingProviderMode | null
  providerSubscriptionId: string | null
  pendingSubscriptionId: string | null
  nextSubscriptionId: string | null
  syncedAt: Date | null
  disputeOpen: boolean
  entitlements: Omit<SourcedEntitlements, 'sources'>
  sources: SourcedEntitlements['sources']
  grants: GrantView[]
  history: {
    from: BillingState | null
    to: BillingState
    cause: string
    source: BillingHistorySource
    at: Date
  }[]
  events: { type: string; receivedAt: Date; processedAt: Date | null; error: string | null }[]
  /**
   * The workspace's unresolved held SEZ charges, for the "Held: SEZ" badge.
   */
  openHeldCharges: number
  /**
   * Whether the workspace has any held SEZ charge, open or resolved: its
   * held-charge routes answer while registration is off, so its history
   * stays reachable.
   */
  hasHeldCharges: boolean
}

/**
 * Project a grant for staff.
 * @param grant - The grant row.
 * @param grantedBy - The staff member who granted it, or null.
 * @param now - The time its expiry is judged at.
 * @returns The grant with its status.
 */
export function toGrantView(
  grant: EntitlementGrant,
  grantedBy: GrantView['grantedBy'],
  now: Date
): GrantView {
  let status: GrantStatus = 'active'
  if (grant.revokedAt !== null) status = 'revoked'
  else if (grant.expiresAt !== null && grant.expiresAt <= now) status = 'expired'
  return {
    id: grant.id,
    key: grant.key,
    value: grant.value ?? null,
    reason: grant.reason,
    grantedBy,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    status,
  }
}

/**
 * Project a state change for staff.
 * @param entry - The history row.
 * @returns Its states, cause, source and time.
 */
export function toHistoryView(
  entry: BillingStateHistoryRecord
): StaffTenantBillingView['history'][number] {
  return {
    from: entry.fromState,
    to: entry.toState,
    cause: entry.cause,
    source: entry.source,
    at: entry.at,
  }
}

/**
 * Project a provider event for staff: its type, times and error, never its
 * ids or payload.
 * @param event - The event row.
 * @returns The event's type and times.
 */
export function toEventView(event: BillingEventRecord): StaffTenantBillingView['events'][number] {
  return {
    type: event.type,
    receivedAt: event.receivedAt,
    processedAt: event.processedAt,
    error: event.error,
  }
}

/**
 * One invoice as staff see it: the owner's view without its link, since the
 * provider's hosted invoice page shows the payer's contact details, and with
 * the subscription it bills and its tax links. The internal payment id is
 * left out too.
 */
export type StaffInvoiceView = Omit<LinkedInvoice, 'url'>

/**
 * Project a linked provider invoice for staff.
 * @param invoice - The invoice the provider listed, with its tax links.
 * @returns It without its link.
 */
export function toStaffInvoiceView(invoice: LinkedInvoice): StaffInvoiceView {
  return {
    id: invoice.id,
    subscriptionId: invoice.subscriptionId,
    amountMinor: invoice.amountMinor,
    currency: invoice.currency,
    status: invoice.status,
    issuedAt: invoice.issuedAt,
    paidAt: invoice.paidAt,
    taxDocument: invoice.taxDocument,
    creditNotes: invoice.creditNotes,
    taxStatus: invoice.taxStatus,
  }
}

/**
 * A price as staff see it: the public fields, whether it is the one new
 * checkouts get, when it was added and retired, and how many paying tenants
 * hold it.
 */
export interface StaffPriceView extends PriceView {
  active: boolean
  createdAt: Date
  retiredAt: Date | null
  subscribers: number
}

/**
 * Live customer tenants by billing state.
 */
export type TenantStateCounts = Record<BillingState, number>

/**
 * A plan as staff see it: every entitlement (a key the plan does not set
 * reads its registry default), every price, retired ones included, and how
 * many tenants it serves in each state.
 */
export interface StaffPlanView {
  id: string
  key: PlanKey
  name: string
  description: string
  version: number
  entitlements: Record<string, EntitlementValue>
  prices: StaffPriceView[]
  tenantCounts: TenantStateCounts
}

/**
 * One entitlement a plan edit would change, and which way.
 */
interface PlanChange {
  key: string
  from: EntitlementValue
  to: EntitlementValue
  direction: 'increase' | 'decrease'
}

/**
 * What a plan edit would change, and how many tenants it reaches.
 */
export interface PlanChangePreview {
  changes: PlanChange[]
  affected: TenantStateCounts
}

/**
 * The platform-wide trial and grace settings, with who changed them last.
 */
export interface BillingSettingsView {
  trialEnabled: boolean
  trialDays: number
  pastDueGraceDays: number
  version: number
  updatedAt: Date
  /**
   * Null before any staff edit, or when the account is no longer on record.
   * The name falls back to their email when they have none.
   */
  updatedBy: { userId: string; name: string } | null
  /**
   * GST registration is on.
   */
  taxDocumentsEnabled: boolean
  /**
   * At least one tax document exists on the platform, purged workspaces' included.
   */
  hasTaxDocuments: boolean
  /**
   * The configured first day tax documents cover (`YYYY-MM-DD`), whether or
   * not registration is on; null when unset.
   */
  gstEffectiveFrom: string | null
}

/**
 * A billing alert as staff see it: the tenant's id and name, never its slug.
 */
export interface BillingAlertView {
  id: string
  kind: BillingAlertKind
  /**
   * Null when the alert names no tenant, or the tenant is archived or gone.
   */
  tenant: { id: string; name: string } | null
  message: string
  at: Date
}

/**
 * Project a price for staff.
 * @param price - The price row.
 * @param subscribers - Paying tenants on it.
 * @returns The staff price view.
 */
export function toStaffPriceView(price: PlanPrice, subscribers: number): StaffPriceView {
  return {
    ...toPriceView(price),
    active: price.active,
    createdAt: price.createdAt,
    retiredAt: price.retiredAt,
    subscribers,
  }
}

/**
 * Project an alert row for staff.
 * @param row - The alert and the tenant it names.
 * @returns The alert view.
 */
export function toBillingAlertView(row: {
  alert: BillingAlertRecord
  tenant: { id: string; name: string } | null
}): BillingAlertView {
  return {
    id: row.alert.id,
    kind: row.alert.kind,
    tenant: row.tenant === null ? null : { id: row.tenant.id, name: row.tenant.name },
    message: row.alert.message,
    at: row.alert.at,
  }
}
