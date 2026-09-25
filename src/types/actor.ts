// src/types/actor.ts
//
// The authenticated caller of a service call, once request handling has
// resolved to "who is making this call" — services take this instead of
// Request/Response — and the tenant-scoped principal `resolveTenant`
// attaches to the request.
import type { MembershipRole } from '@/constants/tenant.constants'

/**
 * The authenticated caller of a service call.
 */
export interface Actor {
  userId: string
}

/**
 * How a caller reached a tenant: as a member, or through their platform role.
 */
export type TenantAccess = 'member' | 'platform'

/**
 * The tenant-scoped identity `resolveTenant` attaches to `request.principal`
 * once a caller is confirmed to have access to the tenant the route names.
 */
export interface RequestPrincipal {
  tenantId: string
  tenantSlug: string
  isPlatformTenant: boolean
  /**
   * The effective role: what `requireRole` and the policies check.
   */
  role: MembershipRole
  /**
   * The caller's membership role, or null when they reach the tenant through their platform role.
   */
  memberRole: MembershipRole | null
  /**
   * The platform role that grants access, or null for a member (membership wins).
   */
  platformRole: MembershipRole | null
  access: TenantAccess
}
