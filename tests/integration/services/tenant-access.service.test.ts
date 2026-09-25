// tests/integration/services/tenant-access.service.test.ts
//
// resolveActorAccess against the real per-worker Postgres, and the lock
// order it adds: owners, then memberships, then the platform membership FOR
// SHARE. The lock test runs a staff write in a customer tenant while that
// staff member's demotion in the platform tenant is still uncommitted. Only
// the staff write locks rows in two tenants.
//
// The last test is DELIBERATELY red under MUTATION_PROOF=1. It swaps the
// FOR SHARE read for a plain read in the same transaction and keeps the
// real test's assertions:
//
//   MUTATION_PROOF=1 pnpm exec vitest run tests/integration/services/tenant-access.service.test.ts   # red
//   pnpm exec vitest run tests/integration/services/tenant-access.service.test.ts                    # green
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
import { db, sql } from '@/services/database.service'
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

/**
 * A promise with its resolver exposed.
 * @returns The promise and its resolve function.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle: (() => void) | undefined
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- tsconfig.json pins `lib: ["ES2023"]`; `Promise.withResolvers` is ES2024 and untyped under it.
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: () => settle?.() }
}

/**
 * Wait for `promise`, or give up after `ms`.
 * @param promise - What to wait for.
 * @param ms - The longest wait.
 */
async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))])
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
    /**
     * What the staff write's locked platform read ran and saw, in order
     * with the demotion's commit.
     */
    interface DemotionRace {
      outcomes: (string | number)[]
      events: string[]
    }

    /**
     * Staff admin S removes manager M from tenant T while platform owner P's
     * demotion of S to viewer holds S's platform row FOR UPDATE, uncommitted.
     * P's transaction waits (inside `updateRole`) until S has called
     * `lockPlatformRole` and that call has either returned or had time to
     * block, then commits.
     * @param platformRead - The read S's transaction makes in place of `lockPlatformRole`.
     * @returns The two outcomes (S, then P) and the order of S's read against P's commit.
     */
    async function raceStaffRemovalAgainstDemotion(
      platformRead: UserMembershipRepository['lockPlatformRole']
    ): Promise<DemotionRace & { staff: User; tenant: Tenant; manager: User }> {
      const platform = await platformTenant()
      const owner = await createUser()
      const tenant = await createTenant(owner)
      const manager = await createUser()
      await addMember(tenant, manager, 'manager')
      const staff = await createUser()
      await addMember(platform, staff, 'admin')
      const platformOwner = await createUser()
      await addMember(platform, platformOwner, 'owner')

      const events: string[] = []
      const demotionHolds = deferred()
      const staffReadCalled = deferred()
      const staffReadReturned = deferred()

      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realUpdateRole = UserMembershipRepository.prototype.updateRole
      const holdingUpdateRole: typeof realUpdateRole = async function (
        this: UserMembershipRepository,
        ...parameters: Parameters<typeof realUpdateRole>
      ) {
        const updated = await realUpdateRole.apply(this, parameters)
        demotionHolds.resolve()
        await withTimeout(staffReadCalled.promise, 5000)
        await withTimeout(staffReadReturned.promise, 500)
        events.push('demotion committing')
        return updated
      }
      const recordingRead: typeof platformRead = async function (
        this: UserMembershipRepository,
        userId,
        tx
      ) {
        staffReadCalled.resolve()
        const role = await platformRead.call(this, userId, tx)
        events.push(`staff read ${String(role)}`)
        staffReadReturned.resolve()
        return role
      }

      let outcomes: (string | number)[] = []
      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'updateRole',
        holdingUpdateRole,
        async () => {
          await withMutatedMethod(
            UserMembershipRepository.prototype,
            'lockPlatformRole',
            recordingRead,
            async () => {
              const demotion = changeRole(
                { userId: platformOwner.id },
                platform.id,
                staff.id,
                'viewer'
              )
              await withTimeout(demotionHolds.promise, 5000)
              const removal = removeMember({ userId: staff.id }, tenant.id, manager.id)
              const settled = await Promise.allSettled([removal, demotion])
              outcomes = settled.map((result) => outcomeOf(result))
            }
          )
        }
      )
      return { outcomes, events, staff, tenant, manager }
    }

    /**
     * Assert the staff write waited for the demotion and was refused on it.
     * @param race - The race's result.
     */
    async function expectRefusedOnTheDemotedRole(
      race: Awaited<ReturnType<typeof raceStaffRemovalAgainstDemotion>>
    ): Promise<void> {
      expect(race.outcomes).toEqual([403, 'fulfilled'])
      expect(race.events).toEqual(['demotion committing', 'staff read viewer'])
      expect(await userMembershipRepository.findPlatformRole(race.staff.id)).toBe('viewer')
      const kept = await userMembershipRepository.findByUserAndTenant(
        race.manager.id,
        race.tenant.id
      )
      expect(kept?.role).toBe('manager')
    }

    // No lock cycle is possible by construction: the only lock that reaches
    // a second tenant is this FOR SHARE on one platform row, and no
    // platform-tenant transaction locks rows in a customer tenant.
    it('serialises a staff write behind a concurrent demotion (the FOR SHARE lock)', async () => {
      const race = await raceStaffRemovalAgainstDemotion(
        // eslint-disable-next-line @typescript-eslint/unbound-method -- called with `this` bound by recordingRead
        UserMembershipRepository.prototype.lockPlatformRole
      )
      await expectRefusedOnTheDemotedRole(race)
    })

    // DELIBERATELY red under MUTATION_PROOF=1: the same assertions, with an
    // unlocked read of the platform role in the same transaction.
    it.runIf(process.env.MUTATION_PROOF === '1')(
      'reproduces the lock test against an unlocked platform read',
      async () => {
        const race = await raceStaffRemovalAgainstDemotion(function (
          this: UserMembershipRepository,
          userId,
          tx
        ) {
          return this.findPlatformRole(userId, tx)
        })
        await expectRefusedOnTheDemotedRole(race)
      }
    )
  })
})
