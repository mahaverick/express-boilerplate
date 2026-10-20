/**
 * @file Tenant reads and writes behind the `/tenants` routes, other than membership
 * changes and invitations. Every read except `listForUser` assumes `resolveTenant`
 * has admitted the caller; the two updates re-read that access under lock, and
 * every write records its audit entry in the same transaction.
 */
import { isDeepStrictEqual } from 'node:util'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { NewTenant, Tenant, TenantSettings } from '@/database/models/tenant.model'
import { HttpError } from '@/errors/http-error'
import type { InvalidCursorError } from '@/errors/list-errors'
import { notFoundError } from '@/errors/not-found-errors'
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import {
  UserMembershipRepository,
  type MembershipWithUser,
} from '@/repositories/user-membership.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { lockActorRole, lockUserForOwnership } from '@/services/tenant-membership.service'
import type { Actor } from '@/types/actor'
import type { ListPage } from '@/utilities/list-page.utilities'
import type {
  CreateTenantInput,
  MemberListQuery,
  MyTenantListQuery,
  UpdateTenantInput,
  UpdateTenantSettingsInput,
} from '@/validators/tenant.validators'

const tenantRepository = new TenantRepository()
const tenantSettingsRepository = new TenantSettingsRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * The tenant columns a PATCH may write; a key left out leaves its column alone.
 */
type TenantUpdateValues = Partial<Pick<NewTenant, 'name' | 'description' | 'logo' | 'website'>>
/**
 * The settings columns a PATCH may write; a null `metadata` clears it.
 */
type SettingsUpdateValues = Partial<{
  timezone: string
  locale: string
  metadata: Record<string, unknown> | null
}>

/**
 * The tenant columns a validated PATCH body writes. `Object.hasOwn`, not
 * `!== undefined`: an omitted key leaves the column alone, an explicit
 * `null` (on the three nullable columns) clears it.
 * @param input - The validated body.
 * @returns Only the columns the caller supplied.
 */
function toTenantUpdateValues(input: UpdateTenantInput): TenantUpdateValues {
  const values: TenantUpdateValues = {}
  if (Object.hasOwn(input, 'name') && input.name !== undefined) values.name = input.name
  if (Object.hasOwn(input, 'description')) values.description = input.description
  if (Object.hasOwn(input, 'logo')) values.logo = input.logo
  if (Object.hasOwn(input, 'website')) values.website = input.website
  return values
}

/**
 * The settings columns a validated PATCH body writes, by the same presence
 * rule as `toTenantUpdateValues`.
 * @param input - The validated body.
 * @returns Only the columns the caller supplied.
 */
function toSettingsUpdateValues(input: UpdateTenantSettingsInput): SettingsUpdateValues {
  const values: SettingsUpdateValues = {}
  if (Object.hasOwn(input, 'timezone') && input.timezone !== undefined) {
    values.timezone = input.timezone
  }
  if (Object.hasOwn(input, 'locale') && input.locale !== undefined) {
    values.locale = input.locale
  }
  if (Object.hasOwn(input, 'metadata') && input.metadata !== undefined) {
    values.metadata = input.metadata
  }
  return values
}

/**
 * Whether a submitted value equals the stored one. `null` and `undefined`
 * both mean "no value"; objects (the jsonb `metadata` column) compare by
 * content, not identity.
 * @param submitted - The value the PATCH body carries.
 * @param stored - The value the row holds.
 * @returns True when writing `submitted` would leave the column as it is.
 */
function isSameValue(submitted: unknown, stored: unknown): boolean {
  return isDeepStrictEqual(submitted ?? undefined, stored ?? undefined)
}

/**
 * The columns whose submitted value differs from the current row, for the
 * write and its audit entry. The audit entry lists the names only, never the
 * values.
 * @param values - The columns the body supplied.
 * @param current - The row as read in this transaction.
 * @returns The differing columns' values, and their names sorted.
 */
function changedFields<TValues extends object>(
  values: TValues,
  current: object
): { changes: Partial<TValues>; changed: string[] } {
  const changes: Partial<TValues> = {}
  for (const key of Object.keys(values) as Array<keyof TValues & string>) {
    if (!isSameValue(values[key], (current as Record<string, unknown>)[key])) {
      changes[key] = values[key]
    }
  }
  const changed = Object.keys(changes).toSorted((a, b) => a.localeCompare(b))
  return { changes, changed }
}

/**
 * Create a tenant with its settings row and the actor as sole owner, and
 * audit it, in one transaction; then emit `tenant_created`. The actor's user
 * row is locked `FOR SHARE` first (`lockUserForOwnership`), so a concurrent
 * staff delete of the actor either sees the new tenant or wins and this
 * answers 401.
 * @param actor - The creating user, who becomes the owner.
 * @param input - The validated create body.
 * @returns The new tenant row.
 * @throws {HttpError} 409, when the slug is taken; 401 when the actor's account was deleted meanwhile.
 */
export async function createTenant(actor: Actor, input: CreateTenantInput): Promise<Tenant> {
  const created = await withTransaction(async (tx) => {
    await lockUserForOwnership(actor.userId, () => new HttpError('Sign in to continue.', 401), tx)
    const tenant = await tenantRepository.create({ ...input, ownerId: actor.userId }, tx)
    // The creator is the owner from this write on, so they act as a member.
    await record(
      {
        action: 'tenant.created',
        actor,
        access: 'member',
        tenantId: tenant.id,
        targetId: tenant.id,
        metadata: { name: tenant.name, slug: tenant.slug },
      },
      tx
    )
    return tenant
  })
  await emitDomainEvent(
    {
      type: 'tenant_created',
      tenantId: created.id,
      ownerId: actor.userId,
      at: created.createdAt,
    },
    { access: 'member' }
  )
  return created
}

/**
 * One page of the tenants the user belongs to, with their role and join time in each.
 * @param userId - The user.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listForUser(
  userId: string,
  query: MyTenantListQuery
): Promise<ListPage<{ tenant: Tenant; role: MembershipRole; joinedAt: Date }>> {
  return tenantRepository.listForUser(userId, query.params, { roles: query.filters.role })
}

/**
 * One tenant's row.
 * @param tenantId - The tenant.
 * @returns The tenant.
 * @throws {HttpError} 404, when the tenant is gone.
 */
export async function getTenant(tenantId: string): Promise<Tenant> {
  const tenant = await tenantRepository.findById(tenantId)
  if (!tenant) throw notFoundError('tenant')
  return tenant
}

/**
 * Update a tenant's name, description, logo or website, and audit it in the
 * same transaction. The actor's access is re-read under lock first, so a
 * demotion after `resolveTenant` still counts; the tenant row is locked
 * after it. Only the fields whose value differs from the row are written and
 * audited. When none differs, the write and the audit entry are skipped,
 * `updatedAt` stays as it was, and the current row is returned.
 * @param actor - The signed-in user making the change.
 * @param tenantId - The tenant.
 * @param input - The validated PATCH body.
 * @returns The tenant after the update.
 * @throws {HttpError} 404 `tenant_not_found` when the actor lost access or the tenant is gone; 403 (`requireRole`'s answer) when the actor is below admin.
 */
export async function updateTenant(
  actor: Actor,
  tenantId: string,
  input: UpdateTenantInput
): Promise<Tenant> {
  const values = toTenantUpdateValues(input)
  return withTransaction(async (tx) => {
    const { access } = await lockActorRole(actor, tenantId, 'admin', tx)
    const current = await tenantRepository.lockById(tenantId, tx)
    if (!current) throw notFoundError('tenant')
    const { changes, changed } = changedFields(values, current)
    if (changed.length === 0) return current
    const tenant = await tenantRepository.update(tenantId, changes, {}, tx)
    if (!tenant) throw notFoundError('tenant')
    await record(
      {
        action: 'tenant.updated',
        actor,
        access,
        tenantId,
        targetId: tenantId,
        metadata: { changed },
      },
      tx
    )
    return tenant
  })
}

/**
 * One row of `GET /tenants/:slug/members`. `user.active` is present on the
 * platform tenant only, where the last-owner rule reads it.
 */
export interface TenantMemberRow {
  /**
   * The membership row itself.
   */
  membership: MembershipWithUser['membership']
  /**
   * The member's safe user fields, with `active` on the platform tenant only.
   */
  user: Omit<MembershipWithUser['user'], 'active'> & { active?: boolean }
}

/**
 * One page of a tenant's members, each with safe user fields only.
 * `user.active` is returned on the platform tenant alone: its last-owner
 * rule counts active owners only, and staff already read every account's
 * status. A customer tenant's rule ignores it, so its members never learn
 * that a co-member's account was deactivated.
 * @param tenantId - The tenant.
 * @param isPlatformTenant - The tenant is the platform tenant (`request.principal.isPlatformTenant`).
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listMembers(
  tenantId: string,
  isPlatformTenant: boolean,
  query: MemberListQuery
): Promise<ListPage<TenantMemberRow>> {
  const page = await userMembershipRepository.listPageByTenant(tenantId, query.params, {
    roles: query.filters.role,
  })
  if (isPlatformTenant) return page
  return {
    ...page,
    items: page.items.map(({ membership, user: { active: _active, ...user } }) => ({
      membership,
      user,
    })),
  }
}

/**
 * A tenant's settings row.
 * @param tenantId - The tenant.
 * @returns The settings.
 * @throws {HttpError} 404, when no settings row exists.
 */
export async function getSettings(tenantId: string): Promise<TenantSettings> {
  const settings = await tenantSettingsRepository.findByTenantId(tenantId)
  if (!settings) throw notFoundError('tenantSettings')
  return settings
}

/**
 * Update a tenant's settings, and audit it in the same transaction. The
 * actor's access is re-read under lock first; the settings row is locked
 * after it. Only the fields whose value differs from the row are written and
 * audited. When none differs, the write and the audit entry are skipped,
 * `updatedAt` stays as it was, and the current row is returned. A real
 * change emits `tenant_settings_updated` after commit, with the access the
 * actor used.
 * @param actor - The signed-in user making the change.
 * @param tenantId - The tenant.
 * @param input - The validated PATCH body.
 * @returns The settings after the update.
 * @throws {HttpError} 404 `tenant_not_found` when the actor lost access; 403 (`requireRole`'s answer) when the actor is below admin; 404 when no settings row exists.
 */
export async function updateSettings(
  actor: Actor,
  tenantId: string,
  input: UpdateTenantSettingsInput
): Promise<TenantSettings> {
  const values = toSettingsUpdateValues(input)
  const outcome = await withTransaction(async (tx) => {
    const { access } = await lockActorRole(actor, tenantId, 'admin', tx)
    const current = await tenantSettingsRepository.lockByTenantId(tenantId, tx)
    if (!current) throw notFoundError('tenantSettings')
    const { changes, changed } = changedFields(values, current)
    if (changed.length === 0) return { settings: current, access, isChanged: false }
    const settings = await tenantSettingsRepository.update(tenantId, changes, tx)
    if (!settings) throw notFoundError('tenantSettings')
    await record(
      {
        action: 'tenant.settings_updated',
        actor,
        access,
        tenantId,
        targetId: tenantId,
        metadata: { changed },
      },
      tx
    )
    return { settings, access, isChanged: true }
  })
  if (outcome.isChanged) {
    await emitDomainEvent(
      {
        type: 'tenant_settings_updated',
        tenantId,
        actorId: actor.userId,
        at: outcome.settings.updatedAt,
      },
      { access: outcome.access }
    )
  }
  return outcome.settings
}
