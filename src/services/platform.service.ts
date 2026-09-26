// src/services/platform.service.ts
//
// Platform staff are the members of the one tenant with is_platform set.
// This module reads a user's platform role, joins verified addresses on
// PLATFORM_EMAIL_DOMAINS as viewer, and grants roles for the bootstrap
// script. Auto-join never promotes or demotes an existing platform member.
import { PgTransaction } from 'drizzle-orm/pg-core'
import { getEnv } from '@/configs/env.config'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
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
 * last platform owner.
 * @param existing - The membership, locked in this transaction.
 * @param role - The new role.
 * @param tx - The transaction holding the owner lock.
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
