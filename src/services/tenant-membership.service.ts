/**
 * @file Membership changes that must keep a tenant owned. Each runs in one
 * transaction: lock the tenant's owners, then the actor's and target's
 * memberships, then (for staff) the actor's platform membership; authorize the
 * actor's current role against the target's (on the platform tenant, the staff
 * rule: an owner may act on another owner); check the last-owner rule (active
 * owners on the platform tenant); write; revoke the pending invitations the
 * member can no longer stand behind; audit.
 */
import type { AuditAccess } from '@/constants/audit.constants'
import {
  MEMBER_NOT_FOUND_CODE,
  MEMBER_NOT_FOUND_MESSAGE,
  MEMBERSHIP_ROLES,
  REASON_REQUIRED_CODE,
  REASON_REQUIRED_MESSAGE,
  type MembershipRole,
} from '@/constants/tenant.constants'
import type { TenantInvitation } from '@/database/models/tenant-invitation.model'
import type { UserMembership } from '@/database/models/user-membership.model'
import { HttpError } from '@/errors/http-error'
import {
  canActorGrantRole,
  canActorModifyTarget,
  canPlatformActorModifyTarget,
  isRoleAtLeast,
} from '@/policies/tenant.policy'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { record } from '@/services/audit.service'
import { db, type DbTransaction } from '@/services/database.service'
import {
  lockTenantAccess,
  platformAccessRole,
  resolveActorAccess,
  type ActorAccess,
} from '@/services/tenant-access.service'
import type { Actor, StaffReasonOption, TenantAccess } from '@/types/actor'
import type { RowLockMode } from '@/types/lock-mode'
import { hostnameDomain } from '@/utilities/email.utilities'

const tenantInvitationRepository = new TenantInvitationRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * The roles that a member holding `role` can no longer offer.
 * @param role - The member's role.
 * @returns Every role `canActorGrantRole` refuses to `role`.
 */
export function rolesUngrantableBy(role: MembershipRole): MembershipRole[] {
  return MEMBERSHIP_ROLES.filter((offered) => !canActorGrantRole(role, offered))
}

/**
 * Record one `invitation.revoked` per revoked invitation, in that
 * invitation's own tenant, under the actor of the change that cost the
 * sender their authority.
 * @param actor - The signed-in user whose change triggered the revoke, or `'system'` for a script.
 * @param access - How the actor reached the tenant they changed; `'system'` for a script.
 * @param revoked - The revoked rows.
 * @param options - The staff reason for the change, recorded on each entry too.
 * @param tx - The change's transaction.
 * @returns Resolves once every entry is written.
 */
async function auditRevokedInvitations(
  actor: Actor | 'system',
  access: AuditAccess,
  revoked: readonly TenantInvitation[],
  options: StaffReasonOption,
  tx: DbTransaction
): Promise<void> {
  for (const invitation of revoked) {
    await record(
      {
        action: 'invitation.revoked',
        actor,
        access,
        tenantId: invitation.tenantId,
        targetId: invitation.id,
        metadata: {
          role: invitation.role,
          // eslint-disable-next-line unicorn/no-null -- stored as JSON null in the audit metadata
          emailDomain: hostnameDomain(invitation.email) ?? null,
          ...(options.reason !== undefined && { reason: options.reason }),
        },
      },
      tx
    )
  }
}

/**
 * Revoke the pending invitations `inviterId` sent in this tenant, in the
 * caller's transaction, and record one `invitation.revoked` per invitation
 * under the actor of the change that cost the sender their authority.
 * @param actor - The signed-in user whose change triggers the revoke, or `'system'` for a script.
 * @param access - How the actor reached the tenant; `'system'` for a script.
 * @param tenantId - The tenant.
 * @param inviterId - The member whose invitations go.
 * @param roles - Only offers of these roles; every offer when absent.
 * @param options - The staff reason for the change, recorded on each entry too.
 * @param tx - The change's transaction.
 * @returns Resolves once every invitation is revoked and audited.
 */
export async function revokeInvitationsSentIn(
  actor: Actor | 'system',
  access: AuditAccess,
  tenantId: string,
  inviterId: string,
  roles: readonly MembershipRole[] | undefined,
  options: StaffReasonOption,
  tx: DbTransaction
): Promise<void> {
  const revoked = await tenantInvitationRepository.revokePendingByInviterInTenant(
    inviterId,
    tenantId,
    roles === undefined ? {} : { roles },
    tx
  )
  await auditRevokedInvitations(actor, access, revoked, options, tx)
}

/**
 * After a staff member's platform role is removed or lowered, revoke in
 * every customer tenant the pending invitations they sent that their
 * remaining authority there cannot grant, in the caller's transaction. Their
 * authority in a tenant is their membership role when they are a member
 * (membership wins, as in `lockTenantAccess`), otherwise the role their new
 * platform role gives through platform access, or none after a removal; with
 * none, every invitation there goes. Each revoke is audited in its own tenant
 * with `access: 'platform'`: the actor reaches those tenants through
 * platform authority, not membership; a script's revokes are audited as
 * `'system'` with `access: 'system'`.
 * @param actor - The signed-in user whose change triggers the revoke, or `'system'` for a script.
 * @param inviterId - The staff member whose invitations are checked.
 * @param newPlatformRole - Their platform role after the change; undefined after a removal.
 * @param tx - The change's transaction.
 * @returns Resolves once every invitation is revoked and audited.
 */
export async function revokeInvitationsBeyondAuthorityElsewhere(
  actor: Actor | 'system',
  inviterId: string,
  newPlatformRole: MembershipRole | undefined,
  tx: DbTransaction
): Promise<void> {
  const tenants = await tenantInvitationRepository.findCustomerTenantsWithPendingFrom(inviterId, tx)
  for (const { tenantId, memberRole } of tenants) {
    const authority =
      memberRole ??
      (newPlatformRole === undefined ? undefined : platformAccessRole(newPlatformRole))
    const revoked = await tenantInvitationRepository.revokePendingByInviterInTenant(
      inviterId,
      tenantId,
      authority === undefined ? {} : { roles: rolesUngrantableBy(authority) },
      tx
    )
    // No reason: these rows are a side effect of a platform-tenant write, whose caller is a member there.
    await auditRevokedInvitations(
      actor,
      actor === 'system' ? 'system' : 'platform',
      revoked,
      {},
      tx
    )
  }
}

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
 * Refuse a member or invitation write that reaches the tenant through
 * platform access without a staff reason. The route middleware admits a
 * caller who was a member when `resolveTenant` read them with no step-up and
 * no reason; if that membership went before the lock, the locked re-read
 * finds platform access, and the write must not go through on it. A reason
 * is present only when the middleware saw platform access and a recent
 * sign-in.
 * @param access - How the actor reached the tenant, as locked in this transaction.
 * @param options - The staff reason from the route, if any.
 * @throws {HttpError} 400 `REASON_REQUIRED` on platform access with no reason.
 */
export function assertStaffReasonGiven(access: TenantAccess, options: StaffReasonOption): void {
  if (access === 'platform' && options.reason === undefined) {
    throw new HttpError(REASON_REQUIRED_MESSAGE, 400, REASON_REQUIRED_CODE)
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
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access; 403 `Insufficient permissions` when their role is now below `minimum`; 404 `member_not_found` (message `Member not found`) when the target is not a member.
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
  if (!target) throw new HttpError(MEMBER_NOT_FOUND_MESSAGE, 404, MEMBER_NOT_FOUND_CODE)
  return { actorRole: locked.actor.role, access: locked.actor.access, target }
}

/**
 * Error code: the change would leave the tenant with no owner.
 */
export const LAST_OWNER_CODE = 'LAST_OWNER'

/**
 * Refuse a change that would take away the tenant's last live owner.
 * @param tenantId - The tenant.
 * @param executor - The transaction holding the owner lock.
 * @param message - The 409 message to use.
 * @param code - The 409's code, if it carries one.
 * @throws {HttpError} 409, when at most one live owner remains.
 */
async function assertAnotherOwnerRemains(
  tenantId: string,
  executor: DbTransaction,
  message: string,
  code?: string
): Promise<void> {
  const ownerCount = await userMembershipRepository.countOwners(tenantId, executor)
  if (ownerCount <= 1) throw new HttpError(message, 409, code)
}

/**
 * Options the membership writes take from the route, the staff reason included.
 */
export interface MembershipWriteOptions extends StaffReasonOption {
  /**
   * The tenant is the platform tenant (`request.principal.isPlatformTenant`):
   * its members are staff, so an owner may act on another owner and the
   * last-owner guard counts active owners only.
   */
  isPlatformTenant?: boolean
}

/**
 * The actor-to-target rule for this tenant: on the platform tenant,
 * `canPlatformActorModifyTarget` for another member and the customer rule for
 * oneself; `canActorModifyTarget` everywhere else.
 * @param options - Whether the tenant is the platform tenant.
 * @returns The rule to apply.
 */
function modifyRuleFor(options: MembershipWriteOptions): typeof canActorModifyTarget {
  if (options.isPlatformTenant !== true) return canActorModifyTarget
  // Leaving, or changing one's own role, keeps the customer rule; the platform rule never covers oneself.
  return (actorRole, targetRole, isSelf) =>
    isSelf
      ? canActorModifyTarget(actorRole, targetRole, true)
      : canPlatformActorModifyTarget(actorRole, targetRole, false)
}

/**
 * Refuse a change that would leave the platform tenant with no live, active
 * owner other than `targetUserId`.
 * @param tenantId - The platform tenant.
 * @param targetUserId - The owner being demoted or removed.
 * @param executor - The transaction holding the owner lock.
 * @param message - The 409 message to use.
 * @param code - The 409's code, if it carries one.
 * @throws {HttpError} 409 when no other active owner remains.
 */
async function assertAnotherActiveOwnerRemains(
  tenantId: string,
  targetUserId: string,
  executor: DbTransaction,
  message: string,
  code?: string
): Promise<void> {
  const others = await userMembershipRepository.countActiveOwners(tenantId, executor, targetUserId)
  if (others < 1) throw new HttpError(message, 409, code)
}

/**
 * Apply the last-owner rule to demoting or removing an owner: live owners on a
 * customer tenant, live and active owners other than the target on the
 * platform tenant.
 * @param tenantId - The tenant.
 * @param targetUserId - The owner being demoted or removed.
 * @param options - Whether the tenant is the platform tenant.
 * @param executor - The transaction holding the owner lock.
 * @param message - The 409 message to use.
 * @param code - The 409's code, if it carries one.
 * @throws {HttpError} 409 when the rule refuses.
 */
async function assertOwnerRemainsFor(
  tenantId: string,
  targetUserId: string,
  options: MembershipWriteOptions,
  executor: DbTransaction,
  message: string,
  code?: string
): Promise<void> {
  await (options.isPlatformTenant === true
    ? assertAnotherActiveOwnerRemains(tenantId, targetUserId, executor, message, code)
    : assertAnotherOwnerRemains(tenantId, executor, message, code))
}

/**
 * Change a member's role; demoting the last live owner is refused. The
 * actor's access is re-read under lock, so a demotion that lands after
 * `resolveTenant` still counts. Atomic against a concurrent role change or
 * removal of an owner. The member's pending invitations here that the new
 * role could not grant are revoked in the same transaction; on the platform
 * tenant, so are those they sent in customer tenants that their remaining
 * authority there (a membership, else the new platform role) cannot grant.
 * @param actor - The signed-in user making the change.
 * @param tenantId - The tenant.
 * @param targetUserId - The member whose role changes.
 * @param role - The new role.
 * @param options - Pass isPlatformTenant for the platform tenant: owner-on-owner and the active-owner guard; `reason` for a staff change.
 * @returns The updated membership.
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access; 403 when the actor is no longer an owner or the matrix refuses; 404 `member_not_found` (message `Member not found`) when the target is not a member; 409 when the target is the last live (on the platform tenant, active) owner and `role` is not owner; 400 `REASON_REQUIRED` when the actor now reaches the tenant through platform access and gave no reason.
 */
export async function changeRole(
  actor: Actor,
  tenantId: string,
  targetUserId: string,
  role: MembershipRole,
  options: MembershipWriteOptions = {}
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
    assertStaffReasonGiven(access, options)
    if (!modifyRuleFor(options)(actorRole, target.role, targetUserId === actor.userId)) {
      throw new HttpError("Insufficient permissions to change this member's role", 403)
    }
    if (role !== 'owner' && target.role === 'owner') {
      await assertOwnerRemainsFor(
        tenantId,
        targetUserId,
        options,
        tx,
        'Cannot change role: you are the last owner'
      )
    }
    const updated = await userMembershipRepository.updateRole(target.id, role, tx)
    if (!updated) throw new HttpError(MEMBER_NOT_FOUND_MESSAGE, 404, MEMBER_NOT_FOUND_CODE)
    // Offers the new role could not make itself stop admitting people.
    const ungrantable = rolesUngrantableBy(role)
    await revokeInvitationsSentIn(actor, access, tenantId, targetUserId, ungrantable, options, tx)
    if (options.isPlatformTenant === true) {
      await revokeInvitationsBeyondAuthorityElsewhere(actor, targetUserId, role, tx)
    }
    await record(
      {
        action: 'member.role_changed',
        actor,
        access,
        tenantId,
        targetId: updated.id,
        metadata: {
          userId: targetUserId,
          from: target.role,
          to: role,
          ...(options.reason !== undefined && { reason: options.reason }),
        },
      },
      tx
    )
    return updated
  })
}

/**
 * Remove a member; removing the last live owner is refused. The actor's
 * access is re-read under lock. Atomic against a concurrent role change or
 * removal of an owner. The member's pending invitations in this tenant are
 * revoked in the same transaction, including ones the remover could not
 * revoke directly; on the platform tenant, so are those they sent in
 * customer tenants that a membership there cannot grant.
 * @param actor - The signed-in user removing the member.
 * @param tenantId - The tenant.
 * @param targetUserId - The member to remove.
 * @param options - Pass isPlatformTenant for the platform tenant: owner-on-owner and the active-owner guard; `reason` for a staff removal.
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access; 403 when the actor is now below admin or the matrix refuses; 404 `member_not_found` (message `Member not found`) when the target is not a member; 409 when the target is the last live (on the platform tenant, active) owner; 400 `REASON_REQUIRED` when the actor now reaches the tenant through platform access and gave no reason.
 */
export async function removeMember(
  actor: Actor,
  tenantId: string,
  targetUserId: string,
  options: MembershipWriteOptions = {}
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
    assertStaffReasonGiven(access, options)
    if (!modifyRuleFor(options)(actorRole, target.role, targetUserId === actor.userId)) {
      throw new HttpError('Insufficient permissions to remove this member', 403)
    }
    if (target.role === 'owner') {
      await assertOwnerRemainsFor(
        tenantId,
        targetUserId,
        options,
        tx,
        'Cannot remove the last owner'
      )
    }
    const wasDeleted = await userMembershipRepository.delete(target.id, tx)
    if (!wasDeleted) throw new HttpError(MEMBER_NOT_FOUND_MESSAGE, 404, MEMBER_NOT_FOUND_CODE)
    await revokeInvitationsSentIn(actor, access, tenantId, targetUserId, undefined, options, tx)
    if (options.isPlatformTenant === true) {
      await revokeInvitationsBeyondAuthorityElsewhere(actor, targetUserId, undefined, tx)
    }
    await record(
      {
        action: 'member.removed',
        actor,
        access,
        tenantId,
        targetId: target.id,
        metadata: {
          userId: targetUserId,
          role: target.role,
          self: targetUserId === actor.userId,
          ...(options.reason !== undefined && { reason: options.reason }),
        },
      },
      tx
    )
  })
}

/**
 * Leave a tenant: the caller removes their own membership. Any role may
 * leave except the tenant's last live owner (on the platform tenant, its last
 * active owner). Only a member can leave: the membership is re-read under
 * lock, and a caller with none (staff reaching the tenant through their
 * platform role, or a member removed since `resolveTenant`) has nothing to
 * leave. The leaver's pending invitations there are revoked in the same
 * transaction; on the platform tenant, so are those they sent in customer
 * tenants that a membership there cannot grant, as for a removal.
 * @param actor - The signed-in member leaving.
 * @param tenantId - The tenant.
 * @param options - Pass isPlatformTenant for the platform tenant: the active-owner guard and the customer-tenant revoke.
 * @throws {HttpError} 404 `Tenant not found` when the caller is not a member; 409 `LAST_OWNER` when they are its last owner.
 */
export async function leaveTenant(
  actor: Actor,
  tenantId: string,
  options: MembershipWriteOptions = {}
): Promise<void> {
  await db.transaction(async (tx) => {
    // FOR UPDATE: this transaction deletes the leaver's membership row.
    await userMembershipRepository.lockOwners(tenantId, 'update', tx)
    const [own] = await userMembershipRepository.lockMemberships(
      tenantId,
      [actor.userId],
      'update',
      tx
    )
    if (!own) throw new HttpError('Tenant not found', 404)
    if (own.role === 'owner') {
      await assertOwnerRemainsFor(
        tenantId,
        actor.userId,
        options,
        tx,
        'You are the last owner: make someone else an owner before you leave.',
        LAST_OWNER_CODE
      )
    }
    const wasDeleted = await userMembershipRepository.delete(own.id, tx)
    if (!wasDeleted) throw new HttpError('Tenant not found', 404)
    await revokeInvitationsSentIn(actor, 'member', tenantId, actor.userId, undefined, {}, tx)
    if (options.isPlatformTenant === true) {
      await revokeInvitationsBeyondAuthorityElsewhere(actor, actor.userId, undefined, tx)
    }
    await record(
      {
        action: 'member.left',
        actor,
        access: 'member',
        tenantId,
        targetId: own.id,
        metadata: { role: own.role },
      },
      tx
    )
  })
}
