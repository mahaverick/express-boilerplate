// tests/integration/services/database-transactions.test.ts
//
// Real-Postgres proof that withTransaction's reuse is not just the same
// TYPE of object but the same LIVE transaction: a write made through a
// nested withTransaction call, and a write made by a repository through a
// passed-through executor, both roll back when the OUTER code throws
// after they resolved — proving no savepoint was opened and no
// repository silently used its own connection instead of the given one.
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'
import { TenantRepository, type CreateTenantInput } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, withTransaction } from '@/services/database.service'

const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()

function uniqueEmail(): string {
  return `tx-${randomUUID()}@example.test`
}

function uniqueSlug(): string {
  return `tx-${randomUUID()}`
}

describe('withTransaction and repository executors, against real Postgres', () => {
  const createdUserIds: string[] = []
  const createdTenantIds: string[] = []

  afterEach(async () => {
    if (createdTenantIds.length > 0) {
      await db.delete(tenantModel).where(inArray(tenantModel.id, createdTenantIds))
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) {
      return
    }

    await db.delete(userModel).where(inArray(userModel.id, createdUserIds))
    createdUserIds.length = 0
  })

  it('a nested withTransaction call reuses the outer transaction: its write rolls back with the outer throw', async () => {
    const email = uniqueEmail()

    await expect(
      withTransaction(async (outerTx) => {
        await withTransaction(async (innerTx) => {
          expect(innerTx).toBe(outerTx) // no savepoint: same object, not a new one
          await innerTx.insert(userModel).values({ email, firstName: 'A', lastName: 'B' })
        }, outerTx)
        throw new Error('force rollback')
      })
    ).rejects.toThrow('force rollback')

    expect(await userRepository.findByEmail(email)).toBeUndefined()
  })

  it('a nested withTransaction call commits with the outer when it does not throw', async () => {
    const email = uniqueEmail()

    await withTransaction(async (outerTx) => {
      await withTransaction(async (innerTx) => {
        await innerTx.insert(userModel).values({ email, firstName: 'A', lastName: 'B' })
      }, outerTx)
    })

    const found = await userRepository.findByEmail(email)
    expect(found).toBeDefined()
    if (found) createdUserIds.push(found.id)
  })

  it('opens its own transaction when no executor is given: a write inside rolls back on throw', async () => {
    const email = uniqueEmail()

    await expect(
      withTransaction(async (tx) => {
        await tx.insert(userModel).values({ email, firstName: 'A', lastName: 'B' })
        throw new Error('force rollback')
      })
    ).rejects.toThrow('force rollback')

    expect(await userRepository.findByEmail(email)).toBeUndefined()
  })

  it('UserRepository.create writes through a passed tx, and rolls back when the caller throws after it resolves', async () => {
    // { email } alone, no other columns — reuses the exact shape
    // tenant.repository.test.ts:77's own createUser() helper already
    // relies on (`userRepository.create({ email: uniqueEmail() })`
    // bare), so this is a proven-working NewUser shape, not a new
    // assumption about the users table's NOT NULL columns.
    const email = uniqueEmail()

    await expect(
      withTransaction(async (tx) => {
        await userRepository.create({ email }, tx)
        throw new Error('force rollback')
      })
    ).rejects.toThrow('force rollback')

    expect(await userRepository.findByEmail(email)).toBeUndefined()
  })

  it('UserMembershipRepository.create writes through a passed tx, and rolls back when the caller throws after it resolves', async () => {
    const ownerId = await withTransaction(async (tx) => {
      const [user] = await tx
        .insert(userModel)
        .values({ email: uniqueEmail(), firstName: 'A', lastName: 'B' })
        .returning()
      if (!user) throw new Error('setup: insert returned no row')
      return user.id
    })
    createdUserIds.push(ownerId)
    const tenant = await tenantRepository.create({ name: 'Acme', slug: uniqueSlug(), ownerId })
    createdTenantIds.push(tenant.id)
    const secondOwnerId = await withTransaction(async (tx) => {
      const [user] = await tx
        .insert(userModel)
        .values({ email: uniqueEmail(), firstName: 'C', lastName: 'D' })
        .returning()
      if (!user) throw new Error('setup: insert returned no row')
      return user.id
    })
    createdUserIds.push(secondOwnerId)

    await expect(
      withTransaction(async (tx) => {
        await userMembershipRepository.create(
          { userId: secondOwnerId, tenantId: tenant.id, role: 'viewer' },
          tx
        )
        throw new Error('force rollback')
      })
    ).rejects.toThrow('force rollback')

    expect(
      await userMembershipRepository.findByUserAndTenant(secondOwnerId, tenant.id)
    ).toBeUndefined()
  })

  it('TenantRepository.create writes through a passed tx, and rolls back when the caller throws after it resolves', async () => {
    const ownerId = await withTransaction(async (tx) => {
      const [user] = await tx
        .insert(userModel)
        .values({ email: uniqueEmail(), firstName: 'A', lastName: 'B' })
        .returning()
      if (!user) throw new Error('setup: insert returned no row')
      return user.id
    })
    createdUserIds.push(ownerId)
    const slug = uniqueSlug()
    const input: CreateTenantInput = { name: 'Acme', slug, ownerId }

    await expect(
      withTransaction(async (tx) => {
        await tenantRepository.create(input, tx)
        throw new Error('force rollback')
      })
    ).rejects.toThrow('force rollback')

    // The tenant row itself never committed...
    expect(await tenantRepository.findBySlug(slug)).toBeUndefined()
    // ...and neither did its owner membership. `ownerId` never got a
    // tenant id back (the insert that would have produced one rolled
    // back), so this checks by user rather than by (user, tenant): a
    // fresh user created only for this test must end up a member of
    // nothing at all if the membership insert really rolled back with
    // the rest of the transaction.
    expect(await userMembershipRepository.listByUser(ownerId)).toEqual([])
  })
})
