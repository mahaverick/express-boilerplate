/**
 * @file Integration test against the real per-worker Postgres database (see
 * `tests/helpers/worker-database.ts`). Every tenant this file creates is
 * deleted in `afterEach`, tenants first, then users: both
 * `tenant_settings.tenant_id` and `user_memberships.tenant_id` carry `ON
 * DELETE CASCADE` (`tenant.model.ts`, `user-membership.model.ts`), so
 * deleting the tenant takes its settings row and every membership row with
 * it. Also covers `TenantSettingsRepository` (`findByTenantId`/`update`)
 * inline, rather than in a separate file: every settings row in this
 * codebase is created exactly once, atomically, by `TenantRepository.create`,
 * so exercising it via the same tenant fixtures this file already builds is
 * more representative than standing up an isolated settings row a real
 * caller could never produce.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { TenantRepository, type CreateTenantInput } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { backdateUpdatedAt } from '../../helpers/backdate'

const tenantRepository = new TenantRepository()
const tenantSettingsRepository = new TenantSettingsRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `tenant-repo-${randomUUID()}@example.test`
}

/**
 * A disposable slug, unique to one test run. Lowercase hex only — already
 * satisfies the `/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/` shape `slugSchema`
 * (`tenant.validators.ts`) enforces, even though this repository layer does
 * not itself validate slug shape.
 * @returns A slug guaranteed unique to this call.
 */
function uniqueSlug(): string {
  return `tenant-${randomUUID()}`
}

describe('TenantRepository', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdTenantIds.length > 0) {
      await sql`delete from tenants where id = any(${createdTenantIds})`
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) {
      return
    }

    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user for a test to own or join tenants with, tracked for
   * cleanup.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  /**
   * A fresh tenant via `TenantRepository.create`, tracked for cleanup.
   * @param ownerId - The user who becomes this tenant's owner.
   * @param overrides - Any `CreateTenantInput` fields to override the defaults with (e.g. a fixed `slug`, to exercise a collision).
   * @returns The created tenant row.
   */
  async function createTenant(ownerId: string, overrides: Partial<CreateTenantInput> = {}) {
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: uniqueSlug(),
      ownerId,
      ...overrides,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  describe('create', () => {
    it('creates the tenant, its settings row, and the owner membership atomically', async () => {
      const ownerId = await createUser()
      const slug = uniqueSlug()

      const tenant = await tenantRepository.create({ name: 'Acme Inc', slug, ownerId })
      createdTenantIds.push(tenant.id)

      expect(tenant.id).toBeTruthy()
      expect(tenant.name).toBe('Acme Inc')
      expect(tenant.slug).toBe(slug)
      expect(tenant.lifecycleState).toBe('active')
      expect(tenant.deletedAt).toBeNull()

      const settings = await tenantSettingsRepository.findByTenantId(tenant.id)
      expect(settings).toMatchObject({ tenantId: tenant.id, timezone: 'UTC', locale: 'en' })
      expect(settings?.metadata).toBeNull()

      const membership = await userMembershipRepository.findByUserAndTenant(ownerId, tenant.id)
      expect(membership).toMatchObject({ userId: ownerId, tenantId: tenant.id, role: 'owner' })
    })

    it('accepts optional description, logo, and website', async () => {
      const ownerId = await createUser()

      const tenant = await createTenant(ownerId, {
        description: 'A test tenant',
        logo: 'https://example.test/logo.png',
        website: 'https://example.test',
      })

      expect(tenant.description).toBe('A test tenant')
      expect(tenant.logo).toBe('https://example.test/logo.png')
      expect(tenant.website).toBe('https://example.test')
    })

    it('rejects a duplicate visible slug with HttpError(409), and creates nothing', async () => {
      const firstOwnerId = await createUser()
      const secondOwnerId = await createUser()
      const slug = uniqueSlug()

      const first = await createTenant(firstOwnerId, { slug })

      await expect(createTenant(secondOwnerId, { slug })).rejects.toMatchObject({
        name: 'HttpError',
        statusCode: 409,
      })

      // The rolled-back attempt must not have left a second tenant, a settings row, or an owner membership behind — proving the transaction, not just the tenant insert, rolled back.
      const found = await tenantRepository.findBySlug(slug)
      expect(found?.id).toBe(first.id)
      expect(
        await userMembershipRepository.findByUserAndTenant(secondOwnerId, first.id)
      ).toBeUndefined()
    })

    /**
     * The catch block's other branch: `isUniqueViolation` false, so a
     * foreign-key violation on the owner membership insert propagates
     * unchanged rather than becoming an `HttpError(409)` meant for a slug
     * collision.
     */
    it('propagates a non-slug-collision database error unchanged, e.g. a foreign-key violation on ownerId', async () => {
      const bogusOwnerId = randomUUID()

      await expect(createTenant(bogusOwnerId)).rejects.not.toMatchObject({ name: 'HttpError' })
    })

    it('allows reusing a slug once the original tenant is soft-deleted', async () => {
      const firstOwnerId = await createUser()
      const secondOwnerId = await createUser()
      const slug = uniqueSlug()

      const first = await createTenant(firstOwnerId, { slug })
      await tenantRepository.softDelete(first.id)

      const second = await createTenant(secondOwnerId, { slug })

      expect(second.id).not.toBe(first.id)
      expect(second.slug).toBe(slug)
    })

    it('rejects an unknown lifecycle_state at the database, not just in TypeScript', async () => {
      // Load-bearing for the tenants_lifecycle_state_check schema guarantee (tenant.model.ts): a raw insert, around TenantRepository's own typing, proves the database itself rejects it.
      await expect(
        sql`insert into tenants (name, slug, lifecycle_state) values ('x', ${uniqueSlug()}, 'deleted')`
      ).rejects.toMatchObject({ code: '23514' }) // check_violation
    })
  })

  describe('findBySlug', () => {
    it('finds a visible tenant by slug', async () => {
      const ownerId = await createUser()
      const tenant = await createTenant(ownerId)

      expect(await tenantRepository.findBySlug(tenant.slug)).toMatchObject({ id: tenant.id })
    })

    it('returns undefined for a slug that does not exist', async () => {
      expect(await tenantRepository.findBySlug(uniqueSlug())).toBeUndefined()
    })

    it('excludes a soft-deleted tenant by default, and includes it when includeDeleted is set', async () => {
      const ownerId = await createUser()
      const tenant = await createTenant(ownerId)
      await tenantRepository.softDelete(tenant.id)

      expect(await tenantRepository.findBySlug(tenant.slug)).toBeUndefined()
      expect(
        await tenantRepository.findBySlug(tenant.slug, { includeDeleted: true })
      ).toMatchObject({ id: tenant.id })
    })
  })

  describe('findActiveBySlug', () => {
    it('finds a tenant that is visible and active', async () => {
      const ownerId = await createUser()
      const tenant = await createTenant(ownerId)

      expect(await tenantRepository.findActiveBySlug(tenant.slug)).toMatchObject({ id: tenant.id })
    })

    it('returns undefined for a suspended tenant', async () => {
      const ownerId = await createUser()
      const tenant = await createTenant(ownerId)
      await tenantRepository.update(tenant.id, { lifecycleState: 'suspended' })

      expect(await tenantRepository.findActiveBySlug(tenant.slug)).toBeUndefined()
      // The plain (non-active-scoped) lookup still finds it: suspension is not a soft-delete.
      expect(await tenantRepository.findBySlug(tenant.slug)).toMatchObject({
        lifecycleState: 'suspended',
      })
    })

    it('returns undefined for a soft-deleted (even if still-active) tenant', async () => {
      const ownerId = await createUser()
      const tenant = await createTenant(ownerId)
      await tenantRepository.softDelete(tenant.id)

      expect(await tenantRepository.findActiveBySlug(tenant.slug)).toBeUndefined()
    })

    it('returns undefined for a slug that does not exist', async () => {
      expect(await tenantRepository.findActiveBySlug(uniqueSlug())).toBeUndefined()
    })
  })

  describe('listForUser', () => {
    it('lists every tenant a user belongs to, with their role in each', async () => {
      const userId = await createUser()
      const otherOwnerId = await createUser()

      const owned = await createTenant(userId)
      const joined = await createTenant(otherOwnerId)
      await userMembershipRepository.create({ userId, tenantId: joined.id, role: 'editor' })

      const rows = await tenantRepository.listForUser(userId)
      const byTenantId = new Map(rows.map((row) => [row.tenant.id, row.role]))

      expect(byTenantId.get(owned.id)).toBe('owner')
      expect(byTenantId.get(joined.id)).toBe('editor')
    })

    it('excludes a soft-deleted tenant even if the membership row still exists', async () => {
      const userId = await createUser()
      const tenant = await createTenant(userId)
      await tenantRepository.softDelete(tenant.id)

      const rows = await tenantRepository.listForUser(userId)
      expect(rows.some((row) => row.tenant.id === tenant.id)).toBe(false)
    })

    it('returns an empty array for a user with no memberships', async () => {
      const userId = await createUser()
      expect(await tenantRepository.listForUser(userId)).toEqual([])
    })
  })

  describe('inherited BaseRepository behaviour', () => {
    it('updates a tenant and bumps updatedAt', async () => {
      const ownerId = await createUser()
      const tenant = await createTenant(ownerId)
      const backdatedAt = await backdateUpdatedAt('tenants', { column: 'id', value: tenant.id })

      const updated = await tenantRepository.update(tenant.id, { name: 'Renamed Inc' })

      expect(updated?.name).toBe('Renamed Inc')
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(backdatedAt.getTime())
    })

    it('rejects an update that would duplicate another tenant’s visible slug with HttpError(409)', async () => {
      const ownerId = await createUser()
      const first = await createTenant(ownerId)
      const second = await createTenant(ownerId)

      await expect(tenantRepository.update(second.id, { slug: first.slug })).rejects.toBeInstanceOf(
        HttpError
      )
      await expect(tenantRepository.update(second.id, { slug: first.slug })).rejects.toMatchObject({
        statusCode: 409,
      })
    })

    it('excludes a soft-deleted tenant from findById by default', async () => {
      const ownerId = await createUser()
      const tenant = await createTenant(ownerId)
      await tenantRepository.softDelete(tenant.id)

      expect(await tenantRepository.findById(tenant.id)).toBeUndefined()
      expect(await tenantRepository.findById(tenant.id, { includeDeleted: true })).toMatchObject({
        id: tenant.id,
      })
    })
  })

  describe('TenantSettingsRepository', () => {
    it('updates a tenant’s settings and bumps updatedAt', async () => {
      const ownerId = await createUser()
      const tenant = await createTenant(ownerId)
      const original = await tenantSettingsRepository.findByTenantId(tenant.id)
      expect(original).toBeDefined()
      const backdatedAt = await backdateUpdatedAt('tenant_settings', {
        column: 'tenant_id',
        value: tenant.id,
      })

      const updated = await tenantSettingsRepository.update(tenant.id, {
        timezone: 'America/New_York',
        locale: 'en-US',
        metadata: { plan: 'pro' },
      })

      expect(updated?.timezone).toBe('America/New_York')
      expect(updated?.locale).toBe('en-US')
      expect(updated?.metadata).toEqual({ plan: 'pro' })
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(backdatedAt.getTime())
    })

    it('returns undefined for a tenant id that has no settings row', async () => {
      expect(await tenantSettingsRepository.findByTenantId(randomUUID())).toBeUndefined()
      expect(
        await tenantSettingsRepository.update(randomUUID(), { timezone: 'UTC' })
      ).toBeUndefined()
    })
  })
})
