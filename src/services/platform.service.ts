/**
 * @file Platform staff are the members of the one tenant with `is_platform` set.
 * This module reads a user's platform role, joins verified addresses on
 * PLATFORM_EMAIL_DOMAINS as viewer (never changing an existing member's role),
 * and grants roles for the bootstrap script.
 */
import { PgTransaction } from 'drizzle-orm/pg-core'
import { getEnv } from '@/configs/env.config'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { isRoleAtLeast } from '@/policies/tenant.policy'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import {
  db,
  withTransaction,
  type DbExecutor,
  type DbTransaction,
} from '@/services/database.service'
import { logger } from '@/services/logger.service'
import {
  revokeInvitationsBeyondAuthorityElsewhere,
  revokeInvitationsSentIn,
  rolesUngrantableBy,
} from '@/services/tenant-membership.service'
import type { Actor } from '@/types/actor'
import { emailDomain } from '@/utilities/email.utilities'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * The user fields auto-join reads.
 */
export type AutoJoinCandidate = Pick<User, 'id' | 'email' | 'emailVerifiedAt'>

/**
 * The configured auto-join domains, trimmed and lowercased.
 * @param raw - `PLATFORM_EMAIL_DOMAINS` as validated, or undefined.
 * @returns The domains; empty when unset.
 */
export function parsePlatformEmailDomains(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0)
}

/**
 * Whether an address is on one of the auto-join domains. Exact match only:
 * a subdomain, or a domain that merely ends with a listed one, does not count.
 * @param email - The address.
 * @param domains - The lowercase auto-join domains.
 * @returns True when the address's domain is listed.
 */
export function isPlatformEmailDomain(email: string, domains: readonly string[]): boolean {
  const domain = emailDomain(email)
  return domain !== undefined && domains.includes(domain)
}

/**
 * The configured auto-join domains, read from the environment on each call.
 * @returns The domains; empty when PLATFORM_EMAIL_DOMAINS is unset.
 */
function configuredDomains(): string[] {
  return parsePlatformEmailDomains(getEnv().PLATFORM_EMAIL_DOMAINS)
}

/**
 * The user's role in the platform tenant, read now with no cache, so a
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
 * @throws {HttpError} 404 when the actor's platform role is now below `minimum`, as the route gate answers; 401 when the actor's account is now inactive or soft-deleted, as `requireAuth` answers.
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
 * Join a verified address on an auto-join domain to the platform tenant as
 * viewer, and audit the join. Does nothing to a user who already has a
 * platform membership, whatever its role.
 * @param user - The user.
 * @param tx - The transaction to write in.
 * @param domains - The auto-join domains; defaults to PLATFORM_EMAIL_DOMAINS.
 * @returns The new membership, or undefined when the user was not joined.
 * @throws {HttpError} 500 when the platform tenant is missing.
 */
export async function autoJoin(
  user: AutoJoinCandidate,
  tx: DbTransaction,
  domains: readonly string[] = configuredDomains()
): Promise<UserMembership | undefined> {
  const domain = emailDomain(user.email)
  if (domain === undefined || !domains.includes(domain)) return undefined
  if (user.emailVerifiedAt === null) return undefined

  const platform = await tenantRepository.findPlatformTenant(tx)
  if (!platform) throw new HttpError('The platform tenant is missing', 500)

  const created = await userMembershipRepository.insertIfAbsent(
    { userId: user.id, tenantId: platform.id, role: 'viewer' },
    tx
  )
  if (!created) return undefined

  await record(
    {
      action: 'platform.member.auto_joined',
      actor: 'system',
      access: 'system',
      tenantId: platform.id,
      targetId: created.id,
      metadata: { userId: user.id, emailDomain: domain },
    },
    tx
  )
  return created
}

/**
 * Run `autoJoin`, logging a failure at warn instead of throwing it. Inside a
 * caller's transaction it runs in a savepoint, so a failure leaves that
 * transaction usable. Safe to call twice for one user: the second call
 * finds the membership and does nothing.
 * @param user - The user.
 * @param executor - The caller's transaction, or the pool (default) for a transaction of its own.
 * @param domains - The auto-join domains; defaults to PLATFORM_EMAIL_DOMAINS.
 * @returns Resolves once the join is done, skipped or its failure logged.
 */
export async function autoJoinSafely(
  user: AutoJoinCandidate,
  executor: DbExecutor = db,
  domains: readonly string[] = configuredDomains()
): Promise<void> {
  if (!isPlatformEmailDomain(user.email, domains)) return
  const join = (tx: DbTransaction): Promise<UserMembership | undefined> =>
    autoJoin(user, tx, domains)
  try {
    await (executor instanceof PgTransaction ? executor.transaction(join) : db.transaction(join))
  } catch (error) {
    logger.warn('Platform auto-join failed', { error: redactedForLog(error), userId: user.id })
  }
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
 * @returns The membership as it now is.
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
