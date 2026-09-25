// src/services/tenant-membership.service.ts
//
// Membership changes that must keep a tenant owned. Each runs in one
// transaction: lock the tenant's owners, then the actor's and the target's
// memberships; authorize the actor's current role against the target's
// current role; check the last-owner rule; write.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import { HttpError } from '@/errors/http-error'
import { canActorModifyTarget, isRoleAtLeast } from '@/policies/tenant.policy'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { db, type DbTransaction } from '@/services/database.service'
import type { Actor } from '@/types/actor'

const userMembershipRepository = new UserMembershipRepository()

/**
 * The actor's current role, checked against the route's `requireRole` bar.
 * @param membership - The actor's membership as locked in this transaction, if any.
 * @param minimum - The lowest role the route admits.
 * @returns The actor's current role.
 * @throws {HttpError} 404 `Tenant not found` when the actor is no longer a member, as `resolveTenant` answers a non-member; 403 `Insufficient permissions`, `requireRole`'s answer, when their role is now below `minimum`.
 */
function currentActorRole(
  membership: UserMembership | undefined,
  minimum: MembershipRole
): MembershipRole {
  if (!membership) throw new HttpError('Tenant not found', 404)
  if (!isRoleAtLeast(membership.role, minimum)) {
    throw new HttpError('Insufficient permissions', 403)
  }
  return membership.role
}

/**
 * Lock the tenant's owners, then the actor's membership, and return the
 * actor's role as it is now. The route's `requireRole` saw an earlier read.
 * @param actor - The signed-in user acting on the tenant.
 * @param tenantId - The tenant.
 * @param minimum - The lowest role the route admits.
 * @param executor - The transaction to hold the locks in.
 * @returns The actor's current role, at least `minimum`.
 * @throws {HttpError} 404 `Tenant not found` when the actor is no longer a member; 403 `Insufficient permissions` when their role is now below `minimum`.
 */
export async function lockActorRole(
  actor: Actor,
  tenantId: string,
  minimum: MembershipRole,
  executor: DbTransaction
): Promise<MembershipRole> {
  await userMembershipRepository.lockOwners(tenantId, executor)
  const [membership] = await userMembershipRepository.lockMemberships(
    tenantId,
    [actor.userId],
    executor
  )
  return currentActorRole(membership, minimum)
}

/**
 * Lock the tenant's owners, then the actor's and the target's memberships
 * in one statement, and return both as they are now.
 * @param actor - The signed-in user acting on the tenant.
 * @param tenantId - The tenant.
 * @param targetUserId - The member being changed or removed.
 * @param minimum - The lowest role the route admits.
 * @param executor - The transaction to hold the locks in.
 * @returns The actor's current role and the target's membership.
 * @throws {HttpError} 404 `Tenant not found` when the actor is no longer a member; 403 `Insufficient permissions` when their role is now below `minimum`; 404 `Member not found` when the target is not a member.
 */
async function lockActorAndTarget(
  actor: Actor,
  tenantId: string,
  targetUserId: string,
  minimum: MembershipRole,
  executor: DbTransaction
): Promise<{ actorRole: MembershipRole; target: UserMembership }> {
  await userMembershipRepository.lockOwners(tenantId, executor)
  const locked = await userMembershipRepository.lockMemberships(
    tenantId,
    [actor.userId, targetUserId],
    executor
  )
  const actorRole = currentActorRole(
    locked.find((membership) => membership.userId === actor.userId),
    minimum
  )
  const target = locked.find((membership) => membership.userId === targetUserId)
  if (!target) throw new HttpError('Member not found', 404)
  return { actorRole, target }
}

/**
 * Refuse a change that would take away the tenant's last live owner.
 * @param tenantId - The tenant.
 * @param executor - The transaction holding the owner lock.
 * @param message - The 409 message to use.
 * @throws {HttpError} 409, when at most one live owner remains.
 */
async function assertAnotherOwnerRemains(
  tenantId: string,
  executor: DbTransaction,
  message: string
): Promise<void> {
  const ownerCount = await userMembershipRepository.countOwners(tenantId, executor)
  if (ownerCount <= 1) throw new HttpError(message, 409)
}

/**
 * Change a member's role; demoting the last live owner is refused. The
 * actor's role is re-read under lock, so a demotion that lands after
 * `resolveTenant` still counts. Atomic against a concurrent role change or
 * removal of an owner.
 * @param actor - The signed-in user making the change.
 * @param tenantId - The tenant.
 * @param targetUserId - The member whose role changes.
 * @param role - The new role.
 * @returns The updated membership.
 * @throws {HttpError} 404 `Tenant not found` when the actor is no longer a member; 403 when the actor is no longer an owner or the matrix refuses; 404 `Member not found` when the target is not a member; 409 when the target is the last live owner and `role` is not owner.
 */
export async function changeRole(
  actor: Actor,
  tenantId: string,
  targetUserId: string,
  role: MembershipRole
): Promise<UserMembership> {
  return db.transaction(async (tx) => {
    const { actorRole, target } = await lockActorAndTarget(
      actor,
      tenantId,
      targetUserId,
      'owner',
      tx
    )
    if (!canActorModifyTarget(actorRole, target.role, targetUserId === actor.userId)) {
      throw new HttpError("Insufficient permissions to change this member's role", 403)
    }
    if (role !== 'owner' && target.role === 'owner') {
      await assertAnotherOwnerRemains(tenantId, tx, 'Cannot change role: you are the last owner')
    }
    const updated = await userMembershipRepository.updateRole(target.id, role, tx)
    if (!updated) throw new HttpError('Member not found', 404)
    return updated
  })
}

/**
 * Remove a member; removing the last live owner is refused. The actor's
 * role is re-read under lock. Atomic against a concurrent role change or
 * removal of an owner.
 * @param actor - The signed-in user removing the member.
 * @param tenantId - The tenant.
 * @param targetUserId - The member to remove.
 * @throws {HttpError} 404 `Tenant not found` when the actor is no longer a member; 403 when the actor is now below admin or the matrix refuses; 404 `Member not found` when the target is not a member; 409 when the target is the last live owner.
 */
export async function removeMember(
  actor: Actor,
  tenantId: string,
  targetUserId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const { actorRole, target } = await lockActorAndTarget(
      actor,
      tenantId,
      targetUserId,
      'admin',
      tx
    )
    if (!canActorModifyTarget(actorRole, target.role, targetUserId === actor.userId)) {
      throw new HttpError('Insufficient permissions to remove this member', 403)
    }
    if (target.role === 'owner') {
      await assertAnotherOwnerRemains(tenantId, tx, 'Cannot remove the last owner')
    }
    const wasDeleted = await userMembershipRepository.delete(target.id, tx)
    if (!wasDeleted) throw new HttpError('Member not found', 404)
  })
}
