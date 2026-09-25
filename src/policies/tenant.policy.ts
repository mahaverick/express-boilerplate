// src/policies/tenant.policy.ts
//
// Pure tenant authorization rules. Each returns a boolean and never throws;
// the service that calls it throws the HttpError. Member and invitation
// services call them with the actor's role as read inside their transaction.
//
// Under platform access the actor's role is their platform role, so staff
// face the same rules as members. Tenant lifecycle endpoints (suspend,
// archive), when added, must require role owner or admin and, under
// platform access, a platform owner or admin as well.
import { MEMBERSHIP_ROLES, type MembershipRole } from '@/constants/tenant.constants'

/**
 * Whether `role` ranks at or above `required` in `MEMBERSHIP_ROLES`
 * (owner > admin > manager > editor > viewer).
 * @param role - The role held.
 * @param required - The lowest role that qualifies.
 * @returns True when `role` is `required` or ranks above it.
 */
export function isRoleAtLeast(role: MembershipRole, required: MembershipRole): boolean {
  return MEMBERSHIP_ROLES.indexOf(role) <= MEMBERSHIP_ROLES.indexOf(required)
}

/**
 * Whether `actorRole` may change or remove an existing member currently
 * holding `targetRole`:
 *
 * | Actor \ Target | owner     | admin | manager/editor/viewer |
 * | -------------- | --------- | ----- | ---------------------- |
 * | owner          | self-only | yes   | yes                    |
 * | admin          | no        | no    | yes                    |
 * | anyone else    | no        | no    | no                     |
 *
 * The last-owner rule is not part of this; tenant-membership.service checks
 * it under the owner lock.
 * @param actorRole - The actor's role in the tenant.
 * @param targetRole - The target member's current role.
 * @param isSelf - Whether the actor and the target are the same user.
 * @returns True when the actor may act on a member holding `targetRole`.
 */
export function canActorModifyTarget(
  actorRole: MembershipRole,
  targetRole: MembershipRole,
  isSelf: boolean
): boolean {
  if (targetRole === 'owner') return actorRole === 'owner' && isSelf
  if (targetRole === 'admin') return actorRole === 'owner'
  return actorRole === 'owner' || actorRole === 'admin'
}

/**
 * Whether `actorRole` may grant `role` through an invitation. Owners may
 * grant any role, admins only manager, editor or viewer, and nobody else
 * any role. Separate from `canActorModifyTarget`: a grant has no current
 * target role, and without this an admin could invite a new admin or owner.
 * @param actorRole - The actor's role in the tenant.
 * @param role - The role being offered.
 * @returns True when the actor may grant `role`.
 */
export function canActorGrantRole(actorRole: MembershipRole, role: MembershipRole): boolean {
  if (actorRole === 'owner') return true
  if (actorRole === 'admin') return role !== 'owner' && role !== 'admin'
  return false
}
