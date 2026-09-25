// tests/integration/services/tenant-access.service.test.ts
//
// resolveActorAccess against the real per-worker Postgres, and the lock
// order it adds: owners, then memberships, then the platform membership FOR
// SHARE. The deadlock test races a staff write in a customer tenant against
// that staff member's demotion in the platform tenant, the one pair of
// transactions that lock rows in two tenants.
//
// Pool note: test mode has max 2 connections, and the race holds both. A
// query inside a service that skipped `tx` would hang here.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql, type DbExecutor } from '@/services/database.service'
import { resolveActorAccess } from '@/services/tenant-access.service'
import { changeRole, removeMember } from '@/services/tenant-membership.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { platformTenant } from '../../helpers/platform-staff'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * How a settled call ended: 'fulfilled', an HttpError's status, or a
 * Postgres failure's SQLSTATE (40P01 for a deadlock).
 * @param result - The settled call.
 * @returns A comparable summary.
 */
function outcomeOf(result: PromiseSettledResult<unknown>): string | number {
  if (result.status === 'fulfilled') return 'fulfilled'
  const reason: unknown = result.reason
  if (reason instanceof HttpError) return reason.statusCode
  const cause = (reason as { cause?: { code?: unknown } } | undefined)?.cause
  return typeof cause?.code === 'string' ? cause.code : String(reason)
}

/**
 * Add `user` to `tenant` with `role`.
 * @param tenant - The tenant (the platform tenant makes them staff).
 * @param user - The user.
 * @param role - The role.
 */
async function addMember(tenant: Tenant, user: User, role: MembershipRole): Promise<void> {
  await userMembershipRepository.create({ userId: user.id, tenantId: tenant.id, role })
}

describe('tenant-access.service', () => {
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
   * @returns The user.
   */
  async function createUser(): Promise<User> {
    const user = await userRepository.create({
      email: `tenant-access-${randomUUID()}@example.test`,
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

  describe('resolveActorAccess', () => {
    it('reports a member as "member", with their own role', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner)

      await expect(
        db.transaction((tx) => resolveActorAccess({ userId: owner.id }, tenant.id, tx))
      ).resolves.toEqual({ role: 'owner', access: 'member' })
    })

    it('falls back to the platform role for staff with no membership', async () => {
      const tenant = await createTenant(await createUser())
      const staff = await createUser()
      await addMember(await platformTenant(), staff, 'manager')

      await expect(
        db.transaction((tx) => resolveActorAccess({ userId: staff.id }, tenant.id, tx))
      ).resolves.toEqual({ role: 'manager', access: 'platform' })
    })

    it('lets membership win for staff who are members', async () => {
      const tenant = await createTenant(await createUser())
      const staff = await createUser()
      await addMember(await platformTenant(), staff, 'owner')
      await addMember(tenant, staff, 'viewer')

      await expect(
        db.transaction((tx) => resolveActorAccess({ userId: staff.id }, tenant.id, tx))
      ).resolves.toEqual({ role: 'viewer', access: 'member' })
    })

    it('answers 404 Tenant not found to a caller who is neither a member nor staff', async () => {
      const tenant = await createTenant(await createUser())
      const outsider = await createUser()

      await expect(
        db.transaction((tx) => resolveActorAccess({ userId: outsider.id }, tenant.id, tx))
      ).rejects.toMatchObject({ statusCode: 404, message: 'Tenant not found' })
    })

    it('keeps the platform tenant members-only: its non-members have no platform role', async () => {
      const outsider = await createUser()
      const platform = await platformTenant()

      await expect(
        db.transaction((tx) => resolveActorAccess({ userId: outsider.id }, platform.id, tx))
      ).rejects.toMatchObject({ statusCode: 404, message: 'Tenant not found' })
    })
  })

  describe('the platform-membership lock', () => {
    // Staff admin S removes manager M from tenant T (T owners, T memberships,
    // then S's platform row FOR SHARE) while platform owner P demotes S (P
    // owners, P memberships incl. S's row FOR UPDATE). Both meet at lockOwners.
    // - If P locks S's row first, S's share lock waits, sees viewer: 403.
    // - If S's share lock comes first, P's demotion waits for S to commit.
    // Either way no cycle, so never 40P01.
    it('settles a staff removal racing that staff member’s demotion without a deadlock', async () => {
      const platform = await platformTenant()

      for (let round = 0; round < 3; round += 1) {
        const owner = await createUser()
        const tenant = await createTenant(owner)
        const manager = await createUser()
        await addMember(tenant, manager, 'manager')
        const staff = await createUser()
        await addMember(platform, staff, 'admin')
        const platformOwner = await createUser()
        await addMember(platform, platformOwner, 'owner')

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
          tenantId: string,
          executor?: DbExecutor
        ) {
          arrivals += 1
          if (arrivals >= 2) releaseBarrier()
          await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 1000))])
          return realLockOwners.call(this, tenantId, executor)
        }

        let outcomes: (string | number)[] = []
        await withMutatedMethod(
          UserMembershipRepository.prototype,
          'lockOwners',
          meetingLockOwners,
          async () => {
            const settled = await Promise.allSettled([
              removeMember({ userId: staff.id }, tenant.id, manager.id),
              changeRole({ userId: platformOwner.id }, platform.id, staff.id, 'viewer'),
            ])
            outcomes = settled.map((result) => outcomeOf(result))
          }
        )

        expect(arrivals).toBe(2)
        expect(outcomes).not.toContain('40P01')
        expect([
          ['fulfilled', 'fulfilled'],
          [403, 'fulfilled'],
        ]).toContainEqual(outcomes)
        expect(await userMembershipRepository.findPlatformRole(staff.id)).toBe('viewer')
        const managerMembership = await userMembershipRepository.findByUserAndTenant(
          manager.id,
          tenant.id
        )
        expect(managerMembership === undefined).toBe(outcomes[0] === 'fulfilled')
      }
    })
  })
})
