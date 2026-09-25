// tests/integration/services/tenant.service.test.ts
//
// The tenant service against the real per-worker Postgres. Deleting a
// tenant cascades to its settings and memberships, so afterEach deletes
// tenants, then the users this file created.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { createTenant, getTenant, updateSettings, updateTenant } from '@/services/tenant.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'

const tenantSettingsRepository = new TenantSettingsRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const createdTenantIds: string[] = []
const createdUserIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (createdUserIds.length === 0) return
  await sql`delete from users where id = any(${createdUserIds})`
  createdUserIds.length = 0
})

/**
 * A fresh user, tracked for cleanup.
 * @returns The user's id.
 */
async function createUser(): Promise<string> {
  const user = await userRepository.create({ email: `tenant-service-${randomUUID()}@example.test` })
  createdUserIds.push(user.id)
  return user.id
}

/**
 * A slug unique to one call.
 * @returns The slug.
 */
function uniqueSlug(): string {
  return `tenant-${randomUUID()}`
}

/**
 * A repository `update` stand-in that fails the test if it is ever called.
 * @returns Never; always rejects.
 */
function refuseWrite(): Promise<never> {
  return Promise.reject(new Error('update must not run'))
}

describe('createTenant', () => {
  it('writes the tenant, its settings row and the actor as owner', async () => {
    const userId = await createUser()

    const tenant = await createTenant({ userId }, { name: 'Acme', slug: uniqueSlug() })
    createdTenantIds.push(tenant.id)

    expect(await tenantSettingsRepository.findByTenantId(tenant.id)).toBeDefined()
    const membership = await userMembershipRepository.findByUserAndTenant(userId, tenant.id)
    expect(membership?.role).toBe('owner')
  })

  it('answers 409 for a taken slug and leaves no second tenant', async () => {
    const userId = await createUser()
    const slug = uniqueSlug()
    const first = await createTenant({ userId }, { name: 'First', slug })
    createdTenantIds.push(first.id)

    const second = createTenant({ userId }, { name: 'Second', slug })

    await expect(second).rejects.toBeInstanceOf(HttpError)
    await expect(second).rejects.toMatchObject({ statusCode: 409 })
    const rows = await sql`select id from tenants where slug = ${slug}`
    expect(rows).toHaveLength(1)
  })
})

describe('getTenant', () => {
  it('answers 404 for an id with no tenant', async () => {
    await expect(getTenant(randomUUID())).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('updateTenant and updateSettings with no recognised field', () => {
  it('skip the write and return the current rows', async () => {
    const userId = await createUser()
    const tenant = await createTenant({ userId }, { name: 'Acme', slug: uniqueSlug() })
    createdTenantIds.push(tenant.id)

    await withMutatedMethod(TenantRepository.prototype, 'update', refuseWrite, async () => {
      await expect(updateTenant({ userId }, tenant.id, {})).resolves.toMatchObject({
        id: tenant.id,
      })
    })
    await withMutatedMethod(TenantSettingsRepository.prototype, 'update', refuseWrite, async () => {
      await expect(updateSettings({ userId }, tenant.id, {})).resolves.toMatchObject({
        tenantId: tenant.id,
      })
    })
  })
})

describe('updateTenant and updateSettings re-read the actor under lock', () => {
  it('refuse a member below admin before any write', async () => {
    const ownerId = await createUser()
    const editorId = await createUser()
    const tenant = await createTenant({ userId: ownerId }, { name: 'Acme', slug: uniqueSlug() })
    createdTenantIds.push(tenant.id)
    await userMembershipRepository.create({ userId: editorId, tenantId: tenant.id, role: 'editor' })

    await withMutatedMethod(TenantRepository.prototype, 'update', refuseWrite, async () => {
      await expect(
        updateTenant({ userId: editorId }, tenant.id, { name: 'Nope' })
      ).rejects.toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })
    await withMutatedMethod(TenantSettingsRepository.prototype, 'update', refuseWrite, async () => {
      await expect(
        updateSettings({ userId: editorId }, tenant.id, { locale: 'fr' })
      ).rejects.toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })
  })

  it('answer 404 Tenant not found to a caller with no access', async () => {
    const ownerId = await createUser()
    const outsiderId = await createUser()
    const tenant = await createTenant({ userId: ownerId }, { name: 'Acme', slug: uniqueSlug() })
    createdTenantIds.push(tenant.id)

    await expect(
      updateTenant({ userId: outsiderId }, tenant.id, { name: 'Nope' })
    ).rejects.toMatchObject({ statusCode: 404, message: 'Tenant not found' })
  })
})
