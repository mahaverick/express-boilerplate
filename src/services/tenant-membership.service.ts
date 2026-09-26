// src/services/tenant-membership.service.ts
//
// Membership changes that must keep a tenant owned. Each runs in one
// transaction: lock the tenant's owners, then the actor's and the target's
// memberships, then (for staff) the actor's platform membership; authorize
// the actor's current effective role against the target's current role;
// check the last-owner rule; write; record the audit entry.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import { HttpError } from '@/errors/http-error'
import { canActorModifyTarget, isRoleAtLeast } from '@/policies/tenant.policy'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { record } from '@/services/audit.service'
import { db, type DbTransaction } from '@/services/database.service'
import {
  lockTenantAccess,
  resolveActorAccess,
  type ActorAccess,
} from '@/services/tenant-access.service'
import type { Actor, TenantAccess } from '@/types/actor'
import type { RowLockMode } from '@/types/lock-mode'

const userMembershipRepository = new UserMembershipRepository()

/**
 * Refuse an actor whose current role is below the route's `requireRole` bar.
 * @param access - The actor's access as locked in this transaction.
 * @param minimum - The lowest role the route admits.
 * @throws {HttpError} 403 `Insufficient permissions`, `requireRole`'s answer.
 */
function assertRoleAtLeast(access: ActorAccess, minimum: MembershipRole): void {
  if (!isRoleAtLeast(access.role, minimum)) {
    throw new HttpError('Insufficient permissions', 403)
  }
}

/**
 * Lock the actor's access to the tenant (owners, then memberships, then the
 * platform membership) and return it as it is now. The route's
 * `requireRole` saw an earlier read.
 * @param actor - The signed-in user acting on the tenant.
 * @param tenantId - The tenant.
 * @param minimum - The lowest role the route admits.
 * @param executor - The transaction to hold the locks in.
 * @returns The actor's current effective role, at least `minimum`, and how they reached the tenant.
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access; 403 `Insufficient permissions` when their role is now below `minimum`.
 */
export async function lockActorRole(
  actor: Actor,
  tenantId: string,
  minimum: MembershipRole,
  executor: DbTransaction
): Promise<ActorAccess> {
  const access = await resolveActorAccess(actor, tenantId, executor)
  assertRoleAtLeast(access, minimum)
  return access
}

/**
 * Lock the actor's access and the target's membership, in the same lock
 * order, and return both as they are now.
 * @param actor - The signed-in user acting on the tenant.
 * @param tenantId - The tenant.
 * @param targetUserId - The member being changed or removed.
 * @param minimum - The lowest role the route admits.
 * @param mode - `'update'` when the caller deletes the target's membership.
 * @param executor - The transaction to hold the locks in.
 * @returns The actor's current effective role, how they reached the tenant, and the target's membership.
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access; 403 `Insufficient permissions` when their role is now below `minimum`; 404 `Member not found` when the target is not a member.
 */
async function lockActorAndTarget(
  actor: Actor,
  tenantId: string,
  targetUserId: string,
  minimum: MembershipRole,
  mode: RowLockMode,
  executor: DbTransaction
): Promise<{ actorRole: MembershipRole; access: TenantAccess; target: UserMembership }> {
  const locked = await lockTenantAccess(actor, tenantId, [targetUserId], mode, executor)
  assertRoleAtLeast(locked.actor, minimum)
  const target = locked.memberships.find((membership) => membership.userId === targetUserId)
  if (!target) throw new HttpError('Member not found', 404)
  return { actorRole: locked.actor.role, access: locked.actor.access, target }
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
 * actor's access is re-read under lock, so a demotion that lands after
 * `resolveTenant` still counts. Atomic against a concurrent role change or
 * removal of an owner.
 * @param actor - The signed-in user making the change.
 * @param tenantId - The tenant.
 * @param targetUserId - The member whose role changes.
 * @param role - The new role.
 * @returns The updated membership.
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access; 403 when the actor is no longer an owner or the matrix refuses; 404 `Member not found` when the target is not a member; 409 when the target is the last live owner and `role` is not owner.
 */
export async function changeRole(
  actor: Actor,
  tenantId: string,
  targetUserId: string,
  role: MembershipRole
): Promise<UserMembership> {
  return db.transaction(async (tx) => {
    const { actorRole, access, target } = await lockActorAndTarget(
      actor,
      tenantId,
      targetUserId,
      'owner',
      'no key update',
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
    await record(
      {
        action: 'member.role_changed',
        actor,
        access,
        tenantId,
        targetId: updated.id,
        metadata: { userId: targetUserId, from: target.role, to: role },
      },
      tx
    )
    return updated
  })
}

/**
 * Remove a member; removing the last live owner is refused. The actor's
 * access is re-read under lock. Atomic against a concurrent role change or
 * removal of an owner.
 * @param actor - The signed-in user removing the member.
 * @param tenantId - The tenant.
 * @param targetUserId - The member to remove.
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access; 403 when the actor is now below admin or the matrix refuses; 404 `Member not found` when the target is not a member; 409 when the target is the last live owner.
 */
export async function removeMember(
  actor: Actor,
  tenantId: string,
  targetUserId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    // FOR UPDATE: this transaction deletes the target's membership row.
    const { actorRole, access, target } = await lockActorAndTarget(
      actor,
      tenantId,
      targetUserId,
      'admin',
      'update',
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
    await record(
      {
        action: 'member.removed',
        actor,
        access,
        tenantId,
        targetId: target.id,
        metadata: { userId: targetUserId, role: target.role, self: targetUserId === actor.userId },
      },
      tx
    )
  })
}
