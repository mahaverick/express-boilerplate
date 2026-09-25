// src/services/tenant.service.ts
//
// Tenant reads and writes behind the `/tenants` routes, other than
// membership changes (tenant-membership.service.ts) and invitations
// (tenant-invitation.service.ts). Every function below except `createTenant`
// and `listForUser` assumes `resolveTenant` has already confirmed the caller
// is a member of `tenantId`.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { NewTenant, Tenant, TenantSettings } from '@/database/models/tenant.model'
import { HttpError } from '@/errors/http-error'
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import {
  UserMembershipRepository,
  type MembershipWithUser,
} from '@/repositories/user-membership.repository'
import { withTransaction } from '@/services/database.service'
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
 * Create a tenant with its settings row and the actor as sole owner, in one
 * transaction.
 * @param actor - The creating user, who becomes the owner.
 * @param input - The validated create body.
 * @returns The new tenant row.
 * @throws {HttpError} 409, when the slug is taken.
 */
export async function createTenant(actor: Actor, input: CreateTenantInput): Promise<Tenant> {
  return withTransaction((tx) => tenantRepository.create({ ...input, ownerId: actor.userId }, tx))
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
 * Update a tenant's name, description, logo or website. A body with no
 * recognised field skips the write and returns the current row.
 * @param tenantId - The tenant.
 * @param input - The validated PATCH body.
 * @returns The tenant after the update.
 * @throws {HttpError} 404, when the tenant no longer exists.
 */
export async function updateTenant(tenantId: string, input: UpdateTenantInput): Promise<Tenant> {
  const values = toTenantUpdateValues(input)
  const hasChanges = Object.keys(values).length > 0
  const tenant = hasChanges
    ? await tenantRepository.update(tenantId, values)
    : await tenantRepository.findById(tenantId)
  if (!tenant) throw new HttpError('Tenant not found', 404)
  return tenant
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
 * Update a tenant's settings. A body with no recognised field skips the
 * write and returns the current row.
 * @param tenantId - The tenant.
 * @param input - The validated PATCH body.
 * @returns The settings after the update.
 * @throws {HttpError} 404, when no settings row exists.
 */
export async function updateSettings(
  tenantId: string,
  input: UpdateTenantSettingsInput
): Promise<TenantSettings> {
  const values = toSettingsUpdateValues(input)
  const hasChanges = Object.keys(values).length > 0
  const settings = hasChanges
    ? await tenantSettingsRepository.update(tenantId, values)
    : await tenantSettingsRepository.findByTenantId(tenantId)
  if (!settings) throw new HttpError('Tenant settings not found', 404)
  return settings
}
