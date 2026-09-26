// tests/integration/services/tenant-membership.service.test.ts
//
// changeRole and removeMember called directly, against the real per-worker
// Postgres. The HTTP behaviour is covered by tests/integration/api/
// tenant.test.ts and tenant-actor-race.test.ts.
//
// Pool note: test mode has max 2 connections. The concurrent test's two
// transactions hold both; a query inside the service that skipped `tx`
// would hang here until the test timeout.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { changeRole, removeMember } from '@/services/tenant-membership.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * How a settled service call ended: 'fulfilled', an HttpError's status, or
 * a Postgres failure's SQLSTATE (40P01 for a deadlock).
 * @param result - The settled call.
 * @returns A comparable summary of the outcome.
 */
function outcomeOf(result: PromiseSettledResult<unknown>): string | number {
  if (result.status === 'fulfilled') return 'fulfilled'
  const reason: unknown = result.reason
  if (reason instanceof HttpError) return reason.statusCode
  const cause = (reason as { cause?: { code?: unknown } } | undefined)?.cause
  return typeof cause?.code === 'string' ? cause.code : String(reason)
}

describe('tenant-membership.service', () => {
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
   * @returns The created user.
   */
  async function createUser(): Promise<User> {
    const user = await userRepository.create({
      email: `membership-service-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    return user
  }

  /**
   * A tenant owned by `owner`, tracked for cleanup.
   * @param owner - The owner.
   * @returns The tenant.
   */
  async function createTenant(owner: User): Promise<Tenant> {
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  // Owner A promotes manager B to owner while B's call demotes A. Both
  // transactions are open and meet at lockOwners before either takes it.
  // - If A commits first, B is now an owner acting on another owner: 403.
  // - If B goes first, B is a manager below the owner bar: 403, then A wins.
  // Either way: A fulfilled, B 403, and no 40P01.
  it('settles two opposite role changes started together without a deadlock: one wins, one is refused', async () => {
    const ownerA = await createUser()
    const managerB = await createUser()
    const tenant = await createTenant(ownerA)
    await userMembershipRepository.create({
      userId: managerB.id,
      tenantId: tenant.id,
      role: 'manager',
    })

    // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
    const realLockOwners = UserMembershipRepository.prototype.lockOwners
    let arrivals = 0
    let releaseBarrier: () => void
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- tsconfig.json pins `lib: ["ES2023"]`; `Promise.withResolvers` is ES2024 and untyped under it.
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    const meetingLockOwners: typeof realLockOwners = async function (
      this: UserMembershipRepository,
      ...parameters: Parameters<typeof realLockOwners>
    ) {
      arrivals += 1
      if (arrivals >= 2) releaseBarrier()
      await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 1000))])
      return realLockOwners.apply(this, parameters)
    }

    let outcomes: (string | number)[] = []
    await withMutatedMethod(
      UserMembershipRepository.prototype,
      'lockOwners',
      meetingLockOwners,
      async () => {
        const settled = await Promise.allSettled([
          changeRole({ userId: ownerA.id }, tenant.id, managerB.id, 'owner'),
          changeRole({ userId: managerB.id }, tenant.id, ownerA.id, 'viewer'),
        ])
        outcomes = settled.map((result) => outcomeOf(result))
      }
    )

    expect(arrivals).toBe(2)
    expect(outcomes).toEqual(['fulfilled', 403])
    const a = await userMembershipRepository.findByUserAndTenant(ownerA.id, tenant.id)
    const b = await userMembershipRepository.findByUserAndTenant(managerB.id, tenant.id)
    expect([a?.role, b?.role]).toEqual(['owner', 'owner'])
  })

  it('answers 404 Tenant not found to an actor who is not a member, and leaves the target alone', async () => {
    const owner = await createUser()
    const outsider = await createUser()
    const target = await createUser()
    const tenant = await createTenant(owner)
    await userMembershipRepository.create({
      userId: target.id,
      tenantId: tenant.id,
      role: 'viewer',
    })

    await expect(
      changeRole({ userId: outsider.id }, tenant.id, target.id, 'editor')
    ).rejects.toMatchObject({ statusCode: 404, message: 'Tenant not found' })
    await expect(removeMember({ userId: outsider.id }, tenant.id, target.id)).rejects.toMatchObject(
      { statusCode: 404, message: 'Tenant not found' }
    )

    const membership = await userMembershipRepository.findByUserAndTenant(target.id, tenant.id)
    expect(membership?.role).toBe('viewer')
  })

  it('refuses a role change by an admin with requireRole’s message, before the matrix', async () => {
    const owner = await createUser()
    const admin = await createUser()
    const target = await createUser()
    const tenant = await createTenant(owner)
    await userMembershipRepository.create({ userId: admin.id, tenantId: tenant.id, role: 'admin' })
    await userMembershipRepository.create({
      userId: target.id,
      tenantId: tenant.id,
      role: 'viewer',
    })

    await expect(
      changeRole({ userId: admin.id }, tenant.id, target.id, 'editor')
    ).rejects.toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
  })

  it('keeps the matrix messages for an actor who clears the role bar', async () => {
    const owner = await createUser()
    const otherOwner = await createUser()
    const admin = await createUser()
    const tenant = await createTenant(owner)
    await userMembershipRepository.create({
      userId: otherOwner.id,
      tenantId: tenant.id,
      role: 'owner',
    })
    await userMembershipRepository.create({ userId: admin.id, tenantId: tenant.id, role: 'admin' })

    await expect(
      changeRole({ userId: owner.id }, tenant.id, otherOwner.id, 'admin')
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Insufficient permissions to change this member's role",
    })
    await expect(removeMember({ userId: admin.id }, tenant.id, owner.id)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Insufficient permissions to remove this member',
    })
  })
})
