/**
 * @file The two UserMembershipRepository reads onboarding uses: the owners
 * whose member steps count (live and active only), and the raw membership
 * count an accept compares against one.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql } from '@/services/database.service'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const tenantIds: string[] = []

afterEach(async () => {
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

describe('listActiveOwnerIds', () => {
  it('lists live, active owners only', async () => {
    const owner = await createTrackedUser()
    const inactive = await createTrackedUser({ active: false })
    const deleted = await createTrackedUser()
    const editor = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Owners Co',
      slug: `owners-${randomUUID()}`,
      ownerId: owner.id,
    })
    tenantIds.push(tenant.id)
    for (const userId of [inactive.id, deleted.id]) {
      await userMembershipRepository.create({ userId, tenantId: tenant.id, role: 'owner' })
    }
    await userMembershipRepository.create({
      userId: editor.id,
      tenantId: tenant.id,
      role: 'editor',
    })
    await sql`update users set deleted_at = now() where id = ${deleted.id}`

    expect(await userMembershipRepository.listActiveOwnerIds(tenant.id)).toEqual([owner.id])
  })
})

describe('countMemberships', () => {
  it('counts every membership row of the tenant and none of another', async () => {
    const owner = await createTrackedUser()
    const teammate = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Count Co',
      slug: `count-${randomUUID()}`,
      ownerId: owner.id,
    })
    const empty = await tenantRepository.createWithoutOwner({
      name: 'Empty Co',
      slug: `empty-${randomUUID()}`,
    })
    tenantIds.push(tenant.id, empty.id)
    await userMembershipRepository.create({
      userId: teammate.id,
      tenantId: tenant.id,
      role: 'viewer',
    })

    expect(await userMembershipRepository.countMemberships(tenant.id)).toBe(2)
    expect(await userMembershipRepository.countMemberships(empty.id)).toBe(0)
  })
})
