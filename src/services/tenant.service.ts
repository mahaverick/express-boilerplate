// src/services/tenant.service.ts
//
// Tenant reads and writes behind the `/tenants` routes, other than
// membership changes (tenant-membership.service.ts) and invitations
// (tenant-invitation.service.ts). Every read below except `listForUser`
// assumes `resolveTenant` has already admitted the caller to `tenantId`; the
// two updates re-read that access under lock. Every write records its audit
// entry in the same transaction.
import { isDeepStrictEqual } from 'node:util'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { NewTenant, Tenant, TenantSettings } from '@/database/models/tenant.model'
import { HttpError } from '@/errors/http-error'
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import {
  UserMembershipRepository,
  type MembershipWithUser,
} from '@/repositories/user-membership.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
import { lockActorRole } from '@/services/tenant-membership.service'
import type { Actor } from '@/types/actor'
import type {
  CreateTenantInput,
  UpdateTenantInput,
  UpdateTenantSettingsInput,
} from '@/validators/tenant.validators'

const tenantRepository = new TenantRepository()
const tenantSettingsRepository = new TenantSettingsRepository()
const userMembershipRepository = new UserMembershipRepository()

type TenantUpdateValues = Partial<Pick<NewTenant, 'name' | 'description' | 'logo' | 'website'>>
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
 * @param stored - The value the row holds now.
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
 * @param current - The row as it is now.
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
 * audit it, in one transaction.
 * @param actor - The creating user, who becomes the owner.
 * @param input - The validated create body.
 * @returns The new tenant row.
 * @throws {HttpError} 409, when the slug is taken.
 */
export async function createTenant(actor: Actor, input: CreateTenantInput): Promise<Tenant> {
  return withTransaction(async (tx) => {
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
}

/**
 * Every tenant the user belongs to, with their role in each.
 * @param userId - The user.
 * @returns One entry per visible tenant.
 */
export async function listForUser(
  userId: string
): Promise<Array<{ tenant: Tenant; role: MembershipRole }>> {
  return tenantRepository.listForUser(userId)
}

/**
 * One tenant's row.
 * @param tenantId - The tenant.
 * @returns The tenant.
 * @throws {HttpError} 404, when the tenant no longer exists.
 */
export async function getTenant(tenantId: string): Promise<Tenant> {
  const tenant = await tenantRepository.findById(tenantId)
  if (!tenant) throw new HttpError('Tenant not found', 404)
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
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access or the tenant is gone; 403 `Insufficient permissions` when the actor is now below admin.
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
    if (!current) throw new HttpError('Tenant not found', 404)
    const { changes, changed } = changedFields(values, current)
    if (changed.length === 0) return current
    const tenant = await tenantRepository.update(tenantId, changes, {}, tx)
    if (!tenant) throw new HttpError('Tenant not found', 404)
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
 * A tenant's members, each with safe user fields only.
 * @param tenantId - The tenant.
 * @returns One entry per live member.
 */
export async function listMembers(tenantId: string): Promise<MembershipWithUser[]> {
  return userMembershipRepository.listByTenant(tenantId)
}

/**
 * A tenant's settings row.
 * @param tenantId - The tenant.
 * @returns The settings.
 * @throws {HttpError} 404, when no settings row exists.
 */
export async function getSettings(tenantId: string): Promise<TenantSettings> {
  const settings = await tenantSettingsRepository.findByTenantId(tenantId)
  if (!settings) throw new HttpError('Tenant settings not found', 404)
  return settings
}

/**
 * Update a tenant's settings, and audit it in the same transaction. The
 * actor's access is re-read under lock first; the settings row is locked
 * after it. Only the fields whose value differs from the row are written and
 * audited. When none differs, the write and the audit entry are skipped,
 * `updatedAt` stays as it was, and the current row is returned.
 * @param actor - The signed-in user making the change.
 * @param tenantId - The tenant.
 * @param input - The validated PATCH body.
 * @returns The settings after the update.
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access; 403 `Insufficient permissions` when the actor is now below admin; 404 when no settings row exists.
 */
export async function updateSettings(
  actor: Actor,
  tenantId: string,
  input: UpdateTenantSettingsInput
): Promise<TenantSettings> {
  const values = toSettingsUpdateValues(input)
  return withTransaction(async (tx) => {
    const { access } = await lockActorRole(actor, tenantId, 'admin', tx)
    const current = await tenantSettingsRepository.lockByTenantId(tenantId, tx)
    if (!current) throw new HttpError('Tenant settings not found', 404)
    const { changes, changed } = changedFields(values, current)
    if (changed.length === 0) return current
    const settings = await tenantSettingsRepository.update(tenantId, changes, tx)
    if (!settings) throw new HttpError('Tenant settings not found', 404)
    // The settings row's key is the tenant id.
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
    return settings
  })
}
