/**
 * @file Fills in `$groupidentify` markers at send time. The outbox stores a
 * marker as `$group_type` and `$group_key` only; the drainer calls
 * `resolveGroupMarkers` once per claimed batch, after the claim and before
 * the first send, and every marker goes out with the tenant's state as it
 * is then. A process drains one batch at a time, so on one Worker
 * whatever arrives at PostHog last carries the latest committed state, in
 * whatever order the markers were written or retried. Two Worker replicas
 * whose drains overlap can deliver an older resolved marker after a newer
 * one; the next marker for that tenant corrects it. A tenant with no row (purged) gets its
 * name cleared and its status set to `purged`.
 */
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { db, type DbExecutor } from '@/services/database.service'
import type { TenantGroupSnapshot } from '@/types/analytics'

const tenantRepository = new TenantRepository()

/**
 * The `$group_set` of a tenant group: its current name, status and creation
 * time, or for a purged tenant a null name (which clears the property in
 * PostHog) and the status `purged`.
 */
type TenantGroupSet =
  { name: string; status: string; created_at: string } | { name: null; status: 'purged' }

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
 * The `$group_set` for one tenant.
 * @param tenant - The tenant as it is now, or undefined when it has no row.
 * @returns The properties to set.
 */
function groupSetOf(tenant: TenantGroupSnapshot | undefined): TenantGroupSet {
  if (!tenant) {
    // eslint-disable-next-line unicorn/no-null -- null is what clears a group property in PostHog
    return { name: null, status: 'purged' }
  }
  return { name: tenant.name, status: tenant.status, created_at: tenant.createdAt.toISOString() }
}

/**
 * Give every tenant `$groupidentify` in a claimed batch the tenant's current
 * `$group_set`, read in one query for the batch's distinct tenants. A
 * `$group_set` stored by an older release is replaced, never sent. Every
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
  return rows.map((row) => {
    const key = tenantKeyOf(row)
    if (key === undefined) return row
    return { ...row, properties: { ...row.properties, $group_set: groupSetOf(byId.get(key)) } }
  })
}
