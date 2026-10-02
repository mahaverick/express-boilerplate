/**
 * @file Onboarding fixtures for the staff onboarding tests: a customer
 * tenant with its onboarding columns set directly, completions inserted
 * directly with chosen timestamps, and members. Every tenant made here is
 * tracked; call `deleteOnboardingTenants` in an afterEach, after
 * `truncateAuditLogs` and before `deleteTrackedUsers` (completions cascade
 * with the tenant; the tenant's email messages have no foreign key, so
 * they are deleted here).
 */
import { randomUUID } from 'node:crypto'
import type { OnboardingSource } from '@/constants/onboarding.constants'
import type { MembershipRole, TenantLifecycleState } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql } from '@/services/database.service'
import { createTrackedUser } from './platform-users'

/**
 * SQL NULL for a raw insert or update: postgres-js refuses `undefined`.
 */
// eslint-disable-next-line unicorn/no-null -- the bound value must be NULL, not absent
const SQL_NULL = null

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const trackedTenantIds: string[] = []

/**
 * One day in milliseconds.
 */
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A Date `days` days before `from`.
 * @param days - How many days back.
 * @param from - The instant to count from; now by default.
 * @returns The Date.
 */
export function daysAgo(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - days * DAY_MS)
}

/**
 * How `createOnboardingTenant` sets the tenant's onboarding columns.
 * Defaults: tracked, started now, not dismissed, active, created when started.
 */
export interface OnboardingTenantOptions {
  isTracked?: boolean
  startedAt?: Date | null
  createdAt?: Date
  dismissedAt?: Date | null
  dismissedBy?: string | null
  lifecycleState?: TenantLifecycleState
  name?: string
}

/**
 * A tracked customer tenant owned by a new verified user, its onboarding
 * columns then set as asked. An archived tenant is soft-deleted too, as
 * `archiveTenant` leaves it.
 * @param options - The onboarding columns and lifecycle state.
 * @returns The tenant as it now is, and its owner.
 */
export async function createOnboardingTenant(
  options: OnboardingTenantOptions = {}
): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser({ firstName: 'Olive', lastName: 'Owner' })
  const created = await tenantRepository.create({
    name: options.name ?? `Onboard Co ${randomUUID().slice(0, 6)}`,
    slug: `ob-${randomUUID()}`,
    ownerId: owner.id,
  })
  trackedTenantIds.push(created.id)
  const startedAt = options.startedAt === undefined ? new Date() : options.startedAt
  const createdAt = options.createdAt ?? startedAt ?? new Date()
  const lifecycleState = options.lifecycleState ?? 'active'
  await sql`
    update tenants set
      onboarding_tracked = ${options.isTracked ?? true},
      onboarding_started_at = ${startedAt?.toISOString() ?? SQL_NULL}::timestamptz,
      onboarding_dismissed_at = ${options.dismissedAt?.toISOString() ?? SQL_NULL}::timestamptz,
      onboarding_dismissed_by = ${options.dismissedBy ?? SQL_NULL},
      created_at = ${createdAt.toISOString()}::timestamptz,
      lifecycle_state = ${lifecycleState},
      deleted_at = ${lifecycleState === 'archived' ? new Date().toISOString() : SQL_NULL}::timestamptz
    where id = ${created.id}
  `
  const tenant = await tenantRepository.findByIdIncludingDeleted(created.id)
  if (!tenant) throw new Error('createOnboardingTenant: the tenant vanished')
  return { tenant, owner }
}

/**
 * A new verified user who is a member of `tenant` with `role`.
 * @param tenant - The tenant.
 * @param role - The membership role.
 * @param options - Whether the account can still sign in.
 * @param options.isActive - False for a deactivated account.
 * @returns The user.
 */
export async function addMember(
  tenant: Tenant,
  role: MembershipRole,
  options: { isActive?: boolean } = {}
): Promise<User> {
  const user = await createTrackedUser({ active: options.isActive ?? true })
  await userMembershipRepository.create({ userId: user.id, tenantId: tenant.id, role })
  return user
}

/**
 * How `addCompletion` writes its row. Defaults: a tenant row (no user),
 * source `auto`, completed now.
 */
export interface CompletionOptions {
  userId?: string | null
  source?: OnboardingSource
  completedBy?: string | null
  reason?: string | null
  completedAt?: Date
}

/**
 * Insert one completion directly, bypassing `completeOnboardingStep`, so a
 * test can choose its time and write a key outside the registry. A `staff`
 * row needs a reason (the table's CHECK).
 * @param tenantId - The tenant.
 * @param stepKey - The step key, in the registry or not.
 * @param options - The row's other columns.
 * @returns Resolves once the row is in.
 */
export async function addCompletion(
  tenantId: string,
  stepKey: string,
  options: CompletionOptions = {}
): Promise<void> {
  const completedAt = options.completedAt ?? new Date()
  await sql`
    insert into onboarding_completions
      (id, tenant_id, user_id, step_key, source, completed_by, reason, completed_at)
    values (
      ${randomUUID()}, ${tenantId}, ${options.userId ?? SQL_NULL}, ${stepKey},
      ${options.source ?? 'auto'}, ${options.completedBy ?? SQL_NULL}, ${options.reason ?? SQL_NULL},
      ${completedAt.toISOString()}::timestamptz
    )
  `
}

/**
 * Hard-delete every tracked tenant (completions and memberships cascade)
 * and the email messages that name it.
 * @returns Resolves once the rows are gone.
 */
export async function deleteOnboardingTenants(): Promise<void> {
  if (trackedTenantIds.length === 0) return
  await sql`delete from email_messages where tenant_id = any(${trackedTenantIds})`
  await sql`delete from tenants where id = any(${trackedTenantIds})`
  trackedTenantIds.length = 0
}
