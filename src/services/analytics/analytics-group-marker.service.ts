/**
 * @file Fills in `$groupidentify` markers at send time. The outbox stores a
 * marker as `$group_type` and `$group_key` only; the drainer calls
 * `resolveGroupMarkers` once per claimed batch, after the claim and before
 * the first send, and every marker goes out with the tenant's state as it
 * is then. A process drains one batch at a time, so on one Worker
 * whatever arrives at PostHog last carries the latest committed state, in
 * whatever order the markers were written or retried. Two Worker replicas
 * whose drains overlap can deliver an older resolved marker after a newer
 * one; the next marker for that tenant corrects it. A tenant with no row
 * (purged) gets its name cleared and its status set to `purged`. A tenant
 * with a billing row also gets its plan properties: `plan`,
 * `billing_state`, `billing_interval`, the trial's dates and plan name,
 * `limit_hits_30d` (from Redis, `plan-limit-hits.service.ts`; left out when
 * it cannot be read), `open_upgrade_requests` and `paid_since`.
 */
import type { BillingInterval, BillingState, PlanKey } from '@/constants/billing.constants'
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { countLimitHits } from '@/services/billing/plan-limit-hits.service'
import { db, type DbExecutor } from '@/services/database.service'
import type { TenantGroupBilling, TenantGroupSnapshot } from '@/types/analytics'
import { planKeyForState } from '@/utilities/billing-rules.utilities'

const tenantRepository = new TenantRepository()

/**
 * The plan properties of a tenant group with a billing row. `limit_hits_30d`
 * is absent when its count could not be read, so no wrong count is sent.
 */
interface TenantGroupBillingSet {
  plan: PlanKey
  billing_state: BillingState
  billing_interval: BillingInterval | null
  trial_start_date: string | null
  trial_end_date: string | null
  trial_plan_name: string | null
  limit_hits_30d?: number
  open_upgrade_requests: number
  paid_since: string | null
}

/**
 * The `$group_set` of a tenant group: its current name, status and creation
 * time, and its plan properties when it has a billing row; or for a purged
 * tenant a null name (which clears the property in PostHog) and the status
 * `purged`.
 */
type TenantGroupSet =
  | ({ name: string; status: string; created_at: string } & Partial<TenantGroupBillingSet>)
  | { name: null; status: 'purged' }

/**
 * The tenant id a row is a tenant marker for.
 * @param row - A claimed outbox row.
 * @returns The `$group_key` of a tenant `$groupidentify`, else undefined.
 */
function tenantKeyOf(row: AnalyticsOutboxRow): string | undefined {
  if (row.event !== '$groupidentify' || row.properties.$group_type !== 'tenant') return undefined
  const key = row.properties.$group_key
  return typeof key === 'string' ? key : undefined
}

/**
 * The plan properties of a tenant group.
 * @param billing - Its billing facts.
 * @param limitHits - Its refusals in the last 30 days, when they could be read.
 * @returns The properties.
 */
function billingSetOf(
  billing: TenantGroupBilling,
  limitHits: number | undefined
): TenantGroupBillingSet {
  return {
    plan: planKeyForState(billing.state),
    billing_state: billing.state,
    billing_interval: billing.interval,
    trial_start_date: billing.trialStartedAt?.toISOString() ?? null,
    trial_end_date: billing.trialEndsAt?.toISOString() ?? null,
    trial_plan_name: billing.trialPlanName,
    ...(limitHits !== undefined && { limit_hits_30d: limitHits }),
    open_upgrade_requests: billing.openUpgradeRequests,
    paid_since: billing.paidSince?.toISOString() ?? null,
  }
}

/**
 * The `$group_set` for one tenant.
 * @param tenant - The tenant as it is now, or undefined when it has no row.
 * @param limitHits - Its refusals in the last 30 days, when they could be read.
 * @returns The properties to set.
 */
function groupSetOf(
  tenant: TenantGroupSnapshot | undefined,
  limitHits: number | undefined
): TenantGroupSet {
  if (!tenant) {
    return { name: null, status: 'purged' }
  }
  return {
    name: tenant.name,
    status: tenant.status,
    created_at: tenant.createdAt.toISOString(),
    ...(tenant.billing && billingSetOf(tenant.billing, limitHits)),
  }
}

/**
 * Give every tenant `$groupidentify` in a claimed batch the tenant's current
 * `$group_set`, read in one query for the batch's distinct tenants. A
 * `$group_set` already stored on the row is replaced, never sent. Every
 * other row is returned unchanged, and a batch with no marker runs no query.
 * @param rows - The claimed rows, in send order.
 * @param executor - Where to read the tenants. Defaults to the pool.
 * @returns The rows in the same order, markers resolved.
 * @throws {Error} When the tenant read fails; the drainer then retries every claimed row.
 */
export async function resolveGroupMarkers(
  rows: AnalyticsOutboxRow[],
  executor: DbExecutor = db
): Promise<AnalyticsOutboxRow[]> {
  const keys = [...new Set(rows.map((row) => tenantKeyOf(row)).filter((key) => key !== undefined))]
  if (keys.length === 0) return rows
  const tenants = await tenantRepository.listGroupSnapshotsByIds(keys, executor)
  const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]))
  const limitHits = await countLimitHits(
    tenants.filter((tenant) => tenant.billing).map((tenant) => tenant.id)
  )
  return rows.map((row) => {
    const key = tenantKeyOf(row)
    if (key === undefined) return row
    const groupSet = groupSetOf(byId.get(key), limitHits.get(key))
    return { ...row, properties: { ...row.properties, $group_set: groupSet } }
  })
}
