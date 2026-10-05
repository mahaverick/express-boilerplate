/**
 * @file The evaluation context of one user, optionally in one tenant: the
 * distinct id, the tenant group and the `FLAG_TRAITS` values. Request code
 * reaches it through `flagContextFor` (flag-context.middleware.ts); workers
 * call `flagContextForUser`, which reads the same facts from the database.
 */
import { getEnv, type AppEnv } from '@/configs/env.config'
import type { MembershipRole } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import type { FlagContext } from '@/types/flags'

const DAY_MS = 86_400_000

const userRepository = new UserRepository()
const userMembershipRepository = new UserMembershipRepository()
const tenantRepository = new TenantRepository()

/**
 * The facts a context is built from.
 */
export interface FlagContextInput {
  userId: string
  /**
   * The tenant the flag is evaluated for, or null for none.
   */
  tenantId: string | null
  /**
   * The user's platform (staff) role, or null when they are not staff.
   */
  platformRole: MembershipRole | null
  /**
   * The user's membership role in `tenantId`, or null when there is no tenant or no membership.
   */
  tenantRole: MembershipRole | null
  userCreatedAt: Date
  /**
   * When `tenantId`'s tenant was created, or null when there is no tenant or it is unknown.
   */
  tenantCreatedAt: Date | null
  /**
   * The request's refresh session id, or null outside a request.
   */
  sessionId: string | null
  /**
   * The moment day counts are measured to; defaults to now.
   */
  now?: Date
  /**
   * The deployment; defaults to `APP_ENV`.
   */
  appEnv?: AppEnv
}

/**
 * Whole days from one moment to another, never negative.
 * @param from - The earlier moment.
 * @param to - The later moment.
 * @returns The whole days between them, at least 0.
 */
function wholeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS))
}

/**
 * Build an evaluation context from facts already read. Pure apart from
 * the `APP_ENV` default.
 * @param input - The user, tenant and their facts.
 * @returns The context: `tenant_role` is `none` without a tenant or a
 *   membership, and the tenant group and its traits are absent without a tenant.
 */
export function buildFlagContext(input: FlagContextInput): FlagContext {
  const now = input.now ?? new Date()
  const tenantRole = input.tenantId === null ? undefined : input.tenantRole
  const context: FlagContext = {
    distinctId: input.userId,
    groups: {},
    personProps: {
      platform_role: input.platformRole ?? 'none',
      tenant_role: tenantRole ?? 'none',
      app_env: input.appEnv ?? getEnv().APP_ENV,
      account_created_days: wholeDaysBetween(input.userCreatedAt, now),
    },
    groupProps: {},
    tenantId: input.tenantId,
    sessionId: input.sessionId,
  }
  if (input.tenantId !== null) {
    context.groups.tenant = input.tenantId
    context.groupProps.tenant =
      input.tenantCreatedAt === null
        ? {}
        : { tenant_created_days: wholeDaysBetween(input.tenantCreatedAt, now) }
  }
  return context
}

/**
 * Read a user's facts from the database and build their context.
 * @param userId - The user.
 * @param tenantId - The tenant to evaluate for, or null for none.
 * @param sessionId - The request's refresh session id, or null outside a request.
 * @returns The context. A tenant that cannot be read contributes its group
 *   key but no `tenant_created_days`.
 * @throws {HttpError} 404 `User not found` when the user does not exist or is deleted.
 */
export async function flagContextForUser(
  userId: string,
  tenantId: string | null,
  sessionId: string | null
): Promise<FlagContext> {
  const [user, platformRole, membership, tenant] = await Promise.all([
    userRepository.findById(userId),
    userMembershipRepository.findPlatformRole(userId),
    tenantId === null ? undefined : userMembershipRepository.findByUserAndTenant(userId, tenantId),
    tenantId === null ? undefined : tenantRepository.findById(tenantId),
  ])
  if (!user) throw new HttpError('User not found', 404)
  return buildFlagContext({
    userId,
    tenantId,
    platformRole,
    // eslint-disable-next-line unicorn/no-null -- the input's contract is null for no membership
    tenantRole: membership?.role ?? null,
    userCreatedAt: user.createdAt,
    // eslint-disable-next-line unicorn/no-null -- the input's contract is null for an unknown creation
    tenantCreatedAt: tenant?.createdAt ?? null,
    sessionId,
  })
}
