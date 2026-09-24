// src/services/tenant-membership.service.ts
//
// Membership changes that must keep a tenant owned. Each runs in one
// transaction: lock the owners, re-read the target, check, write. The first
// service-layer module; stream 4 generalises the executor pattern from here.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import { HttpError } from '@/middlewares/error.middleware'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { db, type DbExecutor } from '@/services/database.service'

const userMembershipRepository = new UserMembershipRepository()

/**
 * The target's membership, read inside the transaction after the owner lock.
 * @param tenantId - The tenant.
 * @param targetUserId - The member being changed or removed.
 * @param executor - The transaction.
 * @returns The membership row.
 * @throws {HttpError} 404, when the user is not a member of this tenant.
 */
async function lockedTarget(
  tenantId: string,
  targetUserId: string,
  executor: DbExecutor
): Promise<UserMembership> {
  const target = await userMembershipRepository.findByUserAndTenant(
    targetUserId,
    tenantId,
    executor
  )
  if (!target) throw new HttpError('Member not found', 404)
  return target
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
  executor: DbExecutor,
  message: string
): Promise<void> {
  const ownerCount = await userMembershipRepository.countOwners(tenantId, executor)
  if (ownerCount <= 1) throw new HttpError(message, 409)
}

/**
 * Change a member's role; demoting the last live owner is refused. Atomic
 * against a concurrent demotion or removal of another owner.
 * @param tenantId - The tenant.
 * @param targetUserId - The member whose role changes.
 * @param role - The new role.
 * @returns The updated membership.
 * @throws {HttpError} 404 when the target is not a member, 409 when it is the last live owner and `role` is not owner.
 */
export async function changeRole(
  tenantId: string,
  targetUserId: string,
  role: MembershipRole
): Promise<UserMembership> {
  return db.transaction(async (tx) => {
    await userMembershipRepository.lockOwners(tenantId, tx)
    const target = await lockedTarget(tenantId, targetUserId, tx)
    if (role !== 'owner' && target.role === 'owner') {
      await assertAnotherOwnerRemains(tenantId, tx, 'Cannot change role: you are the last owner')
    }
    const updated = await userMembershipRepository.updateRole(target.id, role, tx)
    if (!updated) throw new HttpError('Member not found', 404)
    return updated
  })
}

/**
 * Remove a member; removing the last live owner is refused. Atomic against
 * a concurrent demotion or removal of another owner.
 * @param tenantId - The tenant.
 * @param targetUserId - The member to remove.
 * @throws {HttpError} 404 when the target is not a member, 409 when it is the last live owner.
 */
export async function removeMember(tenantId: string, targetUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await userMembershipRepository.lockOwners(tenantId, tx)
    const target = await lockedTarget(tenantId, targetUserId, tx)
    if (target.role === 'owner') {
      await assertAnotherOwnerRemains(tenantId, tx, 'Cannot remove the last owner')
    }
    const wasDeleted = await userMembershipRepository.delete(target.id, tx)
    if (!wasDeleted) throw new HttpError('Member not found', 404)
  })
}
