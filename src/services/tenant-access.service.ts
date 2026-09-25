// src/services/tenant-access.service.ts
//
// The actor's effective access to a tenant, re-read under lock inside the
// caller's transaction, so a demotion or removal after resolveTenant still
// counts. Membership wins; without one, the actor's platform role applies.
// A platform role is a membership of the platform tenant, so that tenant's
// non-members have none to fall back on: it stays members-only.
//
// Lock order: the tenant's owners, then memberships (by user_id), then the
// actor's platform membership FOR SHARE. Only the last step reaches a
// second tenant, and nothing locks the platform tenant before a customer
// tenant, so the order has no cycle.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import { HttpError } from '@/errors/http-error'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import type { DbTransaction } from '@/services/database.service'
import type { Actor, TenantAccess } from '@/types/actor'

const userMembershipRepository = new UserMembershipRepository()

/**
 * The role an actor acts with in a tenant, and how they reached it.
 */
export interface ActorAccess {
  role: MembershipRole
  access: TenantAccess
}

/**
 * An actor's access, with every membership in the tenant that was locked on the way.
 */
export interface LockedTenantAccess {
  actor: ActorAccess
  memberships: UserMembership[]
}

/**
 * Lock the tenant's owners, then the memberships of the actor and
 * `otherUserIds`, then (for an actor with no membership) the actor's
 * platform membership, and return the actor's access as it is now.
 * @param actor - The signed-in user.
 * @param tenantId - The tenant acted on.
 * @param otherUserIds - Other members to lock in the same statement, such as a target.
 * @param tx - The transaction to hold the locks in.
 * @returns The actor's access and the locked memberships that exist, in `user_id` order.
 * @throws {HttpError} 404 `Tenant not found` when the actor is neither a member nor staff, as `resolveTenant` answers.
 */
export async function lockTenantAccess(
  actor: Actor,
  tenantId: string,
  otherUserIds: readonly string[],
  tx: DbTransaction
): Promise<LockedTenantAccess> {
  await userMembershipRepository.lockOwners(tenantId, tx)
  const memberships = await userMembershipRepository.lockMemberships(
    tenantId,
    [actor.userId, ...otherUserIds],
    tx
  )
  const own = memberships.find((membership) => membership.userId === actor.userId)
  if (own) return { actor: { role: own.role, access: 'member' }, memberships }

  const platformRole = await userMembershipRepository.lockPlatformRole(actor.userId, tx)
  if (!platformRole) throw new HttpError('Tenant not found', 404)
  return { actor: { role: platformRole, access: 'platform' }, memberships }
}

/**
 * The actor's effective role and access in a tenant, re-read under lock.
 * @param actor - The signed-in user.
 * @param tenantId - The tenant acted on.
 * @param tx - The transaction to hold the locks in.
 * @returns The role the actor acts with and how they reached the tenant.
 * @throws {HttpError} 404 `Tenant not found` when the actor is neither a member nor staff.
 */
export async function resolveActorAccess(
  actor: Actor,
  tenantId: string,
  tx: DbTransaction
): Promise<ActorAccess> {
  const locked = await lockTenantAccess(actor, tenantId, [], tx)
  return locked.actor
}
