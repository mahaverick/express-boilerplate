/**
 * @file Tenant rows to their wire shapes. `role` and `access` on the detail are
 * reported as `resolveTenant` found them; nothing is authorized on them here.
 * The onboarding columns never leave through these shapes: a member reads
 * onboarding only through `GET /tenants/:slug/onboarding`.
 */
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { TenantAccess } from '@/types/actor'

/**
 * A tenant row without its onboarding columns, as every customer response carries it.
 */
export type PublicTenant = Omit<
  Tenant,
  'onboardingTracked' | 'onboardingStartedAt' | 'onboardingDismissedAt' | 'onboardingDismissedBy'
>

/**
 * One row of `GET /tenants`.
 */
export interface TenantListRow {
  tenant: PublicTenant
  role: MembershipRole
  isPlatform: boolean
}

/**
 * `GET /tenants/:slug`: the tenant plus the caller's effective role and access.
 */
export type TenantDetail = PublicTenant & { role: MembershipRole; access: TenantAccess }

/**
 * A tenant row's public columns, listed one by one so a column added to
 * `tenants` stays out of every response until it is listed here (the
 * `PublicTenant` return type fails to compile until then).
 * @param tenant - The tenant row.
 * @returns Every column but the onboarding ones.
 */
export function toPublicTenant(tenant: Tenant): PublicTenant {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    description: tenant.description,
    logo: tenant.logo,
    website: tenant.website,
    lifecycleState: tenant.lifecycleState,
    isPlatform: tenant.isPlatform,
    deletedAt: tenant.deletedAt,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  }
}

/**
 * Map one of the caller's memberships to its list row.
 * @param entry - The tenant and the caller's role in it.
 * @param entry.tenant - The tenant row.
 * @param entry.role - The caller's role in it.
 * @returns The row, with `isPlatform` lifted to the top level.
 */
export function toTenantListRow(entry: { tenant: Tenant; role: MembershipRole }): TenantListRow {
  return {
    tenant: toPublicTenant(entry.tenant),
    role: entry.role,
    isPlatform: entry.tenant.isPlatform,
  }
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
  return { ...toPublicTenant(tenant), role: caller.role, access: caller.access }
}
