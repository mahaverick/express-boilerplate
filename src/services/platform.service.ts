/**
 * @file Platform staff are the members of the one tenant with `is_platform` set.
 * This module reads a user's platform role, re-checks it inside a staff
 * write, and grants roles for the bootstrap script. Staff join only by
 * invitation or that grant.
 */
import type { MembershipRole } from '@/constants/tenant.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import { HttpError } from '@/errors/http-error'
import { isRoleAtLeast } from '@/policies/tenant.policy'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { withTransaction, type DbExecutor, type DbTransaction } from '@/services/database.service'
import {
  revokeInvitationsBeyondAuthorityElsewhere,
  revokeInvitationsSentIn,
  rolesUngrantableBy,
} from '@/services/tenant-membership.service'
import type { Actor } from '@/types/actor'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * The user's role in the platform tenant, read at call time with no cache, so a
 * revocation takes effect on the next request.
 * @param userId - The user.
 * @param executor - A transaction to read in; the pool when omitted.
 * @returns The platform role, or null when the user is not staff.
 */
export async function getPlatformMembership(
  userId: string,
  executor?: DbExecutor
): Promise<MembershipRole | null> {
  // No executor argument on the pool path: the stale-role race test hooks that call shape.
  return executor
    ? userMembershipRepository.findPlatformRole(userId, executor)
    : userMembershipRepository.findPlatformRole(userId)
}

/**
 * Refuse a staff write whose actor lost the platform role, or their account,
 * since the route's gates read them: inside the write's transaction the
 * actor's platform membership is re-read `FOR SHARE`, then the actor's user
 * row `FOR SHARE`, both held until commit, so a concurrent demotion or
 * deactivation waits for the write or is seen by it. Lock order: after any
 * customer tenant's owner rows (as `lockTenantAccess` does) and before the
 * target tenant's row.
 * @param actor - The staff user.
 * @param minimum - The platform role the route requires.
 * @param tx - The write's transaction.
 * @returns The actor's platform role, at least `minimum`.
 * @throws {HttpError} 404 when the actor's platform role is below `minimum`, as the route gate answers; 401 when the actor's account is inactive or soft-deleted, as `requireAuth` answers.
 */
export async function assertStillPlatformRole(
  actor: Actor,
  minimum: MembershipRole,
  tx: DbTransaction
): Promise<MembershipRole> {
  const role = await userMembershipRepository.lockPlatformRole(actor.userId, tx)
  if (role === null || !isRoleAtLeast(role, minimum)) throw new HttpError('Not found', 404)
  const actorUser = await userRepository.lockById(actor.userId, 'share', tx)
  if (!actorUser?.active) throw new HttpError('Account no longer exists or is inactive', 401)
  return role
}

/**
 * Change an existing platform membership's role, refusing to demote the
 * last platform owner. A lower role also revokes, as a system action, the
 * member's pending invitations it could not grant: on the platform tenant,
 * and in customer tenants where their remaining authority cannot grant them,
 * as `changeRole` (tenant-membership.service.ts) does for the member route.
 * @param existing - The membership, locked in this transaction.
 * @param role - The new role.
 * @param tx - The transaction holding the owner and membership locks.
 * @returns The updated membership.
 * @throws {HttpError} 409 when `existing` is the last platform owner and `role` is not owner.
 */
async function regrant(
  existing: UserMembership,
  role: MembershipRole,
  tx: DbTransaction
): Promise<UserMembership> {
  if (role !== 'owner' && existing.role === 'owner') {
    const owners = await userMembershipRepository.countOwners(existing.tenantId, tx)
    if (owners <= 1) throw new HttpError('Cannot demote the last platform owner', 409)
  }
  const updated = await userMembershipRepository.updateRole(existing.id, role, tx)
  if (!updated) throw new HttpError('Membership not found', 404)
  if (!isRoleAtLeast(role, existing.role)) {
    const ungrantable = rolesUngrantableBy(role)
    await revokeInvitationsSentIn(
      'system',
      'system',
      existing.tenantId,
      existing.userId,
      ungrantable,
      {},
      tx
    )
    await revokeInvitationsBeyondAuthorityElsewhere('system', existing.userId, role, tx)
  }
  return updated
}

/**
 * Give an existing, verified user a role in the platform tenant, creating
 * or changing their membership, audited as a system grant. For the
 * bootstrap script: nobody can invite before the first platform owner exists.
 * @param email - The user's address, in any case.
 * @param role - The platform role to hold.
 * @returns The membership after the change.
 * @throws {HttpError} 404 when no account uses `email`; 409 when it is unverified, or when the change would leave the platform tenant without an owner; 500 when the platform tenant is missing.
 */
export async function bootstrapGrant(email: string, role: MembershipRole): Promise<UserMembership> {
  return withTransaction(async (tx) => {
    const user = await userRepository.findByEmail(email, {}, tx)
    if (!user) throw new HttpError('No account uses that email address', 404)
    if (user.emailVerifiedAt === null) {
      throw new HttpError('That account has not verified its email address', 409)
    }
    const platform = await tenantRepository.findPlatformTenant(tx)
    if (!platform) throw new HttpError('The platform tenant is missing', 500)

    await userMembershipRepository.lockOwners(platform.id, 'no key update', tx)
    const [existing] = await userMembershipRepository.lockMemberships(
      platform.id,
      [user.id],
      'no key update',
      tx
    )
    const membership = existing
      ? await regrant(existing, role, tx)
      : await userMembershipRepository.create({ userId: user.id, tenantId: platform.id, role }, tx)

    await record(
      {
        action: 'platform.member.granted',
        actor: 'system',
        access: 'system',
        tenantId: platform.id,
        targetId: membership.id,
        metadata: { userId: user.id, role, via: 'script' },
      },
      tx
    )
    return membership
  })
}
