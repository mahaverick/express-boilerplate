// src/presenters/tenant.presenter.ts
//
// Tenant rows to their wire shapes. `role` and `access` on the detail are
// reported as resolveTenant found them; nothing is authorized on them here.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { TenantAccess } from '@/types/actor'

/**
 * One row of `GET /tenants`.
 */
export interface TenantListRow {
  tenant: Tenant
  role: MembershipRole
  isPlatform: boolean
}

/**
 * `GET /tenants/:slug`: the tenant plus the caller's effective role and access.
 */
export type TenantDetail = Tenant & { role: MembershipRole; access: TenantAccess }

/**
 * Map one of the caller's memberships to its list row.
 * @param entry - The tenant and the caller's role in it.
 * @param entry.tenant - The tenant row.
 * @param entry.role - The caller's role in it.
 * @returns The row, with `isPlatform` lifted to the top level.
 */
export function toTenantListRow(entry: { tenant: Tenant; role: MembershipRole }): TenantListRow {
  return { tenant: entry.tenant, role: entry.role, isPlatform: entry.tenant.isPlatform }
}

/**
 * Map a tenant and the caller's access to the detail shape.
 * @param tenant - The tenant row.
 * @param caller - The caller's effective role and how they reached the tenant.
 * @param caller.role - The effective role.
 * @param caller.access - `'member'` or `'platform'`.
 * @returns The tenant fields plus `role` and `access`.
 */
export function toTenantDetail(
  tenant: Tenant,
  caller: { role: MembershipRole; access: TenantAccess }
): TenantDetail {
  return { ...tenant, role: caller.role, access: caller.access }
}
