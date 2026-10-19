/**
 * @file Platform staff are the members of the one tenant with `is_platform` set.
 * This module reads a user's platform role, re-checks it inside a staff
 * write, and grants roles for the bootstrap script. Staff join only by
 * invitation or that grant.
 */
import type { MembershipRole } from '@/constants/tenant.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { isRoleAtLeast } from '@/policies/tenant.policy'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { createLinkedAccount, isAddressTaken } from '@/services/account-claim.service'
import { record } from '@/services/audit.service'
import { withTransaction, type DbExecutor, type DbTransaction } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { denySessionsAfterCommit, revokeSessionRows } from '@/services/session.service'
import {
  revokeInvitationsBeyondAuthorityElsewhere,
  revokeInvitationsSentIn,
  rolesUngrantableBy,
} from '@/services/tenant-membership.service'
import { markEmailVerified } from '@/services/verification.service'
import type { Actor } from '@/types/actor'
import { hostnameDomain } from '@/utilities/email.utilities'

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
 * Give the account an address holds a role in the platform tenant, creating
 * or changing their membership, audited as a system grant. For the
 * bootstrap script: nobody can invite before the first platform owner
 * exists. An address with no live account gets a verified one
 * (`createLinkedAccount`, audited `user.created` by the system); an
 * unverified account is verified, its sessions revoked as a link's claim
 * revokes them. The operator naming the address vouches for its mailbox.
 * Everything commits together, and `email_verified` is emitted after the
 * commit when this call created or verified the account. A grant whose
 * insert loses a unique index to a concurrent write (the account's address,
 * or the membership) runs again once, against the row that won.
 * @param email - The address, in any case.
 * @param role - The platform role to hold.
 * @returns The membership after the change.
 * @throws {HttpError} 409 when the change would leave the platform tenant without an owner; 500 when the platform tenant is missing.
 */
export async function bootstrapGrant(email: string, role: MembershipRole): Promise<UserMembership> {
  try {
    return await grantOnce(email, role)
  } catch (error) {
    if (!isAddressTaken(error)) throw error
    return grantOnce(email, role)
  }
}

/**
 * One attempt of `bootstrapGrant`.
 * @param email - The address, in any case.
 * @param role - The platform role to hold.
 * @returns The membership after the change.
 * @throws {HttpError} 409 from `createLinkedAccount` when a concurrent create won the address, or from the last-owner check; 500 when the platform tenant is missing.
 */
async function grantOnce(email: string, role: MembershipRole): Promise<UserMembership> {
  const { membership, verifiedUserId, revokedSessionIds } = await withTransaction(async (tx) => {
    const found = await userRepository.findByEmail(email, {}, tx)
    const user = found ?? (await createForGrant(email, tx))
    const granted = await grantInTransaction(user.id, role, tx)
    // After the membership locks, so the user row is locked last, as lockStaffPair orders them.
    const { verifiedNow, sessionIds } = found
      ? await verifyForGrant(found, tx)
      : { verifiedNow: true, sessionIds: [] }
    return {
      membership: granted,
      // eslint-disable-next-line unicorn/no-null -- no account was created or verified
      verifiedUserId: verifiedNow ? user.id : null,
      revokedSessionIds: sessionIds,
    }
  })
  if (verifiedUserId !== null) {
    await denySessionsAfterCommit(verifiedUserId, revokedSessionIds)
    await emitDomainEvent({ type: 'email_verified', userId: verifiedUserId, at: new Date() })
  }
  return membership
}

/**
 * Create the verified account a grant names, audited `user.created` by the
 * system in the platform tenant.
 * @param email - The address.
 * @param tx - The grant's transaction.
 * @returns The new account.
 * @throws {HttpError} 409 when a live account holds the address; 500 when the platform tenant is missing.
 */
async function createForGrant(email: string, tx: DbTransaction): Promise<User> {
  const user = await createLinkedAccount(email, tx)
  const platform = await tenantRepository.findPlatformTenant(tx)
  if (!platform) throw new HttpError('The platform tenant is missing', 500)
  await record(
    {
      action: 'user.created',
      actor: 'system',
      access: 'system',
      tenantId: platform.id,
      targetId: user.id,
      // eslint-disable-next-line unicorn/no-null -- stored as JSON null in the audit metadata
      metadata: { emailDomain: hostnameDomain(user.email) ?? null },
    },
    tx
  )
  return user
}

/**
 * Verify an unverified account a grant names, under its row lock, and
 * revoke its sessions: a session from before the verification proved no
 * mailbox, so it gets no platform role.
 * @param found - The account the address holds.
 * @param tx - The grant's transaction.
 * @returns Whether this call verified it, and the revoked session ids.
 * @throws {HttpError} 500 when the account vanished or cannot be verified.
 */
async function verifyForGrant(
  found: User,
  tx: DbTransaction
): Promise<{ verifiedNow: boolean; sessionIds: string[] }> {
  if (found.emailVerifiedAt !== null) return { verifiedNow: false, sessionIds: [] }
  const locked = await userRepository.lockById(found.id, 'no key update', tx)
  if (!locked) throw new HttpError('Granted user not found', 500)
  if (locked.emailVerifiedAt !== null) return { verifiedNow: false, sessionIds: [] }
  const verified = await markEmailVerified(locked.id, tx)
  if (!verified) throw new HttpError('Granted user could not be verified', 500)
  return { verifiedNow: true, sessionIds: await revokeSessionRows(locked.id, {}, tx) }
}

/**
 * The grant's membership write and its audit entry, in the grant's
 * transaction.
 * @param userId - The account.
 * @param role - The platform role to hold.
 * @param tx - The grant's transaction.
 * @returns The membership after the change.
 * @throws {HttpError} 409 when the change would leave the platform tenant without an owner; 500 when the platform tenant is missing.
 */
async function grantInTransaction(
  userId: string,
  role: MembershipRole,
  tx: DbTransaction
): Promise<UserMembership> {
  const platform = await tenantRepository.findPlatformTenant(tx)
  if (!platform) throw new HttpError('The platform tenant is missing', 500)

  await userMembershipRepository.lockOwners(platform.id, 'no key update', tx)
  const [existing] = await userMembershipRepository.lockMemberships(
    platform.id,
    [userId],
    'no key update',
    tx
  )
  const membership = existing
    ? await regrant(existing, role, tx)
    : await userMembershipRepository.create({ userId, tenantId: platform.id, role }, tx)

  await record(
    {
      action: 'platform.member.granted',
      actor: 'system',
      access: 'system',
      tenantId: platform.id,
      targetId: membership.id,
      metadata: { userId, role, via: 'script' },
    },
    tx
  )
  return membership
}
