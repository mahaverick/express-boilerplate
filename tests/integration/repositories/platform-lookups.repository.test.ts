// tests/integration/repositories/platform-lookups.repository.test.ts
//
// TenantRepository.findPlatformTenant and UserMembershipRepository's
// findPlatformRole/lockPlatformRole against the seeded platform tenant. Platform memberships made here go with their user in afterEach
// (user_memberships.user_id cascades); the platform tenant is never deleted.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Tenant } from '@/database/models/tenant.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const createdTenantIds: string[] = []
const createdUserIds: string[] = []

afterEach(async () => {
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
  const user = await userRepository.create({
    email: `platform-lookup-${randomUUID()}@example.test`,
  })
  createdUserIds.push(user.id)
  return user.id
}

/**
 * The seeded platform tenant, failing the test when it is missing.
 * @returns The platform tenant.
 */
async function platformTenant(): Promise<Tenant> {
  const tenant = await tenantRepository.findPlatformTenant()
  if (!tenant) throw new Error('migration 0016 did not seed the platform tenant')
  return tenant
}

describe('TenantRepository.findPlatformTenant', () => {
  it('returns the seeded platform tenant', async () => {
    const tenant = await platformTenant()

    expect(tenant).toMatchObject({ slug: 'platform', isPlatform: true, lifecycleState: 'active' })
  })

  it('never returns a customer tenant', async () => {
    const owner = await createUser()
    const customer = await tenantRepository.create({
      name: 'Customer',
      slug: `customer-${randomUUID()}`,
      ownerId: owner,
    })
    createdTenantIds.push(customer.id)

    const platform = await platformTenant()
    expect(platform.id).not.toBe(customer.id)
    expect(customer.isPlatform).toBe(false)
  })
})

describe('UserMembershipRepository.findPlatformRole', () => {
  it('returns the user’s platform role', async () => {
    const userId = await createUser()
    const tenant = await platformTenant()
    await userMembershipRepository.create({ userId, tenantId: tenant.id, role: 'admin' })

    expect(await userMembershipRepository.findPlatformRole(userId)).toBe('admin')
  })

  it('returns null for a user whose memberships are all in customer tenants', async () => {
    const userId = await createUser()
    const customer = await tenantRepository.create({
      name: 'Customer',
      slug: `customer-${randomUUID()}`,
      ownerId: userId,
    })
    createdTenantIds.push(customer.id)

    expect(await userMembershipRepository.findPlatformRole(userId)).toBeNull()
  })

  it('sees a revocation on the next call (no cache)', async () => {
    const userId = await createUser()
    const tenant = await platformTenant()
    const membership = await userMembershipRepository.create({
      userId,
      tenantId: tenant.id,
      role: 'viewer',
    })
    expect(await userMembershipRepository.findPlatformRole(userId)).toBe('viewer')

    await userMembershipRepository.delete(membership.id)

    expect(await userMembershipRepository.findPlatformRole(userId)).toBeNull()
  })
})

describe('UserMembershipRepository.lockPlatformRole', () => {
  it('holds the platform membership FOR SHARE until the transaction ends', async () => {
    const userId = await createUser()
    const tenant = await platformTenant()
    const membership = await userMembershipRepository.create({
      userId,
      tenantId: tenant.id,
      role: 'editor',
    })

    await db.transaction(async (tx) => {
      expect(await userMembershipRepository.lockPlatformRole(userId, tx)).toBe('editor')
      // A writer on the pool's other connection cannot take the row now.
      await expect(
        sql`select id from user_memberships where id = ${membership.id} for update nowait`
      ).rejects.toMatchObject({ code: '55P03' })
    })

    await expect(
      sql`select id from user_memberships where id = ${membership.id} for update nowait`
    ).resolves.toHaveLength(1)
  })

  it('returns null for a non-staff user', async () => {
    const userId = await createUser()

    await db.transaction(async (tx) => {
      expect(await userMembershipRepository.lockPlatformRole(userId, tx)).toBeNull()
    })
  })
})
