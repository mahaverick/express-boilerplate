// src/services/tenant-membership.service.ts
//
// Membership changes that must keep a tenant owned. Each runs in one
// transaction: lock the tenant's owners, re-read the target, authorize the
// actor against that fresh row, check the last-owner rule, write.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import { HttpError } from '@/errors/http-error'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { db, type DbExecutor } from '@/services/database.service'

const userMembershipRepository = new UserMembershipRepository()

/**
 * The caller's permission check, run on the target as read inside the
 * transaction. Throws (403) to refuse. The target's owner status cannot
 * change under it: every owner transition takes the owner lock first.
 */
export type AuthorizeTarget = (target: UserMembership) => void

/**
 * The target's membership, read inside the transaction after the owner lock
 * (the row itself is not locked unless it is an owner's).
 * @param tenantId - The tenant.
 * @param targetUserId - The member being changed or removed.
 * @param executor - The transaction.
 * @returns The membership row.
 * @throws {HttpError} 404, when the user is not a member of this tenant.
 */
async function currentTarget(
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
 * against a concurrent role change or removal of an owner.
 * @param tenantId - The tenant.
 * @param targetUserId - The member whose role changes.
 * @param role - The new role.
 * @param authorize - The caller's permission check, run on the fresh target.
 * @returns The updated membership.
 * @throws {HttpError} 404 when the target is not a member, whatever `authorize` throws, 409 when it is the last live owner and `role` is not owner.
 */
export async function changeRole(
  tenantId: string,
  targetUserId: string,
  role: MembershipRole,
  authorize: AuthorizeTarget
): Promise<UserMembership> {
  return db.transaction(async (tx) => {
    await userMembershipRepository.lockOwners(tenantId, tx)
    const target = await currentTarget(tenantId, targetUserId, tx)
    authorize(target)
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
 * a concurrent role change or removal of an owner.
 * @param tenantId - The tenant.
 * @param targetUserId - The member to remove.
 * @param authorize - The caller's permission check, run on the fresh target.
 * @throws {HttpError} 404 when the target is not a member, whatever `authorize` throws, 409 when it is the last live owner.
 */
export async function removeMember(
  tenantId: string,
  targetUserId: string,
  authorize: AuthorizeTarget
): Promise<void> {
  await db.transaction(async (tx) => {
    await userMembershipRepository.lockOwners(tenantId, tx)
    const target = await currentTarget(tenantId, targetUserId, tx)
    authorize(target)
    if (target.role === 'owner') {
      await assertAnotherOwnerRemains(tenantId, tx, 'Cannot remove the last owner')
    }
    const wasDeleted = await userMembershipRepository.delete(target.id, tx)
    if (!wasDeleted) throw new HttpError('Member not found', 404)
  })
}
