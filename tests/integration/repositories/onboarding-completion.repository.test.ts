/**
 * @file OnboardingCompletionRepository against the real per-worker Postgres:
 * a repeat completion is a no-op for tenant and member steps alike, and the
 * reads return a tenant's rows and one member's rows.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { OnboardingCompletionRepository } from '@/repositories/onboarding-completion.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'

const repository = new OnboardingCompletionRepository()
const tenantRepository = new TenantRepository()
const tenantIds: string[] = []

afterEach(async () => {
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

/**
 * An owner and the tenant they own, tracked for cleanup.
 * @returns Both.
 */
async function ownedTenant(): Promise<{ owner: User; tenant: Tenant }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Completion Co',
    slug: `completion-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  return { owner, tenant }
}

describe('OnboardingCompletionRepository.insertIfNew', () => {
  it('records a tenant step once; the repeat returns undefined and writes nothing', async () => {
    const { tenant } = await ownedTenant()

    const first = await repository.insertIfNew({
      tenantId: tenant.id,
      stepKey: 'configure_settings',
      source: 'auto',
    })
    const repeat = await repository.insertIfNew({
      tenantId: tenant.id,
      stepKey: 'configure_settings',
      source: 'auto',
    })

    // eslint-disable-next-line unicorn/no-null -- a tenant step's row has no member
    expect(first).toMatchObject({ tenantId: tenant.id, userId: null, source: 'auto' })
    expect(repeat).toBeUndefined()
    expect(await repository.listForTenant(tenant.id)).toHaveLength(1)
  })

  it('records a member step once per member', async () => {
    const { owner, tenant } = await ownedTenant()
    const teammate = await createTrackedUser()
    const row = {
      tenantId: tenant.id,
      stepKey: 'read_getting_started',
      source: 'customer' as const,
    }

    expect(
      await repository.insertIfNew({ ...row, userId: owner.id, completedBy: owner.id })
    ).toBeDefined()
    expect(
      await repository.insertIfNew({ ...row, userId: teammate.id, completedBy: teammate.id })
    ).toBeDefined()
    expect(
      await repository.insertIfNew({ ...row, userId: owner.id, completedBy: owner.id })
    ).toBeUndefined()
  })
})

describe('OnboardingCompletionRepository reads', () => {
  it("lists a tenant's rows, and one member's own rows only", async () => {
    const { owner, tenant } = await ownedTenant()
    const teammate = await createTrackedUser()
    const other = await ownedTenant()
    await repository.insertIfNew({
      tenantId: tenant.id,
      stepKey: 'invite_teammate',
      source: 'auto',
    })
    for (const userId of [owner.id, teammate.id]) {
      await repository.insertIfNew({
        tenantId: tenant.id,
        userId,
        stepKey: 'read_getting_started',
        source: 'customer',
        completedBy: userId,
      })
    }
    await repository.insertIfNew({
      tenantId: other.tenant.id,
      stepKey: 'invite_teammate',
      source: 'auto',
    })

    const all = await repository.listForTenant(tenant.id)
    const own = await repository.listForTenantAndUser(tenant.id, owner.id)

    expect(all).toHaveLength(3)
    expect(all.every((row) => row.tenantId === tenant.id)).toBe(true)
    expect(own.map((row) => [row.userId, row.stepKey])).toEqual([
      [owner.id, 'read_getting_started'],
    ])
  })
})
