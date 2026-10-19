/**
 * @file Concurrency and the platform last-owner guard: two platform owners
 * deleting each other (the second queues behind the first's locks, then
 * finds its own account gone and gets 401; no deadlock), an actor whose
 * account went inactive before the locks, and the last-active-platform-owner
 * guard as a pure function, since the route rules keep it unreachable,
 * a delete whose target came to own a tenant after its first ownership read,
 * and a delete racing a grant of ownership (tenant creation, an owner
 * invitation's accept, a role change to owner) in both orders: whichever
 * holds the target's user row first wins, the other waits, and no deadlock.
 * Seams via withMutatedMethod, no sleeps.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { PlatformUserRepository } from '@/repositories/platform-user.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql, type DbTransaction } from '@/services/database.service'
import {
  assertPlatformOwnerRemains,
  deactivateUser,
  deleteUser,
  signOutUser,
} from '@/services/platform-user.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { accept } from '@/services/tenant-invitation.service'
import { changeRole } from '@/services/tenant-membership.service'
import { createTenant } from '@/services/tenant.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backendPid, deferred, untilSignalled, waitForWaiter } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

const REASON = 'race test'
const DEADLOCK_TIMEOUT_MS = 10_000
const tenantRepository = new TenantRepository()
const invitationRepository = new TenantInvitationRepository()
const membershipRepository = new UserMembershipRepository()
const createdTenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('concurrent staff deletes', () => {
  it(
    'two platform owners deleting each other: the second waits on the first, then gets 401',
    async () => {
      const a = await createTrackedStaff('owner')
      const b = await createTrackedStaff('owner')
      // A third active owner, so the guard never decides the race: only the locks do.
      await createTrackedStaff('owner')

      // Pause the first delete inside its transaction, after the soft delete and before commit.
      const reached = deferred<number>()
      const release = deferred()
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realRevoke = TenantInvitationRepository.prototype.revokePendingByInviter
      let calls = 0
      /**
       * Pauses the first call after the real revoke until released; later calls run straight
       * through.
       */
      const pausingRevoke: typeof realRevoke = async function (
        this: TenantInvitationRepository,
        ...arguments_
      ) {
        calls += 1
        const revoked = await realRevoke.apply(this, arguments_)
        if (calls === 1) {
          reached.resolve(await backendPid(arguments_[1] as DbTransaction))
          await release.promise
        }
        return revoked
      }

      let outcomes: PromiseSettledResult<unknown>[] = []
      await withMutatedMethod(
        TenantInvitationRepository.prototype,
        'revokePendingByInviter',
        pausingRevoke,
        async () => {
          const aDeletesB = deleteUser({ userId: a.user.id }, b.user.id, REASON)
          const firstPid = await untilSignalled(reached.promise, aDeletesB, 'first delete')
          const bDeletesA = deleteUser({ userId: b.user.id }, a.user.id, REASON)
          // The second delete queues behind the first's platform owner locks.
          expect(await waitForWaiter(firstPid, bDeletesA)).toBe(true)
          release.resolve()
          outcomes = await Promise.allSettled([aDeletesB, bDeletesA])
        }
      )

      expect(outcomes[0]?.status).toBe('fulfilled')
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { statusCode: 401, message: 'Account no longer exists or is inactive' },
      })
      const deleted = await sql<{ id: string }[]>`
        select id from users where id = any(${[a.user.id, b.user.id]}) and deleted_at is not null`
      expect(deleted.map((row) => row.id)).toEqual([b.user.id])
    },
    DEADLOCK_TIMEOUT_MS
  )
})

describe('an actor whose account went inactive after the route gates', () => {
  it.each([
    ['deactivate', deactivateUser],
    ['sign out', signOutUser],
    ['delete', deleteUser],
  ] as const)('%s: 401 and nothing written', async (_verb, run) => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await createTrackedUser()
    await sql`update users set active = false where id = ${admin.id}`

    await expect(run({ userId: admin.id }, target.id, REASON)).rejects.toMatchObject({
      statusCode: 401,
      message: 'Account no longer exists or is inactive',
    })
    const [row] = await sql<{ active: boolean; deleted: boolean }[]>`
      select active, deleted_at is not null as deleted from users where id = ${target.id}`
    expect(row).toEqual({ active: true, deleted: false })
    const audit = await sql`select 1 from audit_logs where target_id = ${target.id}`
    expect(audit).toHaveLength(0)
  })
})

describe('a delete whose target came to own a tenant after the first ownership read', () => {
  it('answers 409 and deletes nothing', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Late Owner Ltd',
      slug: `race-${randomUUID()}`,
      ownerId: target.id,
    })
    createdTenantIds.push(tenant.id)
    // The first read (before any lock) misses the tenant, as if it was created just after.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
    const realList = PlatformUserRepository.prototype.listOwnedTenants
    let calls = 0
    /**
     * Reports no owned tenants on the first call and the real list afterwards.
     */
    const lateList: typeof realList = async function (this: PlatformUserRepository, ...arguments_) {
      calls += 1
      return calls === 1 ? [] : realList.apply(this, arguments_)
    }

    await withMutatedMethod(PlatformUserRepository.prototype, 'listOwnedTenants', lateList, () =>
      expect(deleteUser({ userId: admin.id }, target.id, REASON)).rejects.toMatchObject({
        statusCode: 409,
        message: "This user's owned tenants changed meanwhile; try again",
      })
    )

    const [row] =
      await sql`select deleted_at is not null as deleted from users where id = ${target.id}`
    expect(row).toEqual({ deleted: false })
  })
})

/**
 * A seam's two signals: the paused transaction's backend pid, and its release.
 */
interface Pause {
  reached: ReturnType<typeof deferred<number>>
  release: ReturnType<typeof deferred<void>>
}

/**
 * A fresh pair of seam signals.
 * @returns An unreached, unreleased pause.
 */
function newPause(): Pause {
  return { reached: deferred<number>(), release: deferred() }
}

/**
 * Wrap a repository method so its first call runs for real, then reports its
 * transaction's backend pid and holds that transaction open until released.
 * Later calls run straight through.
 * @param real - The original method.
 * @param txIndex - The position of the transaction among its arguments.
 * @param pause - The signals to report on and wait for.
 * @returns The stand-in to install with `withMutatedMethod`.
 */
function pausingFirstCall<TThis, TArguments extends unknown[], TResult>(
  real: (this: TThis, ...arguments_: TArguments) => Promise<TResult>,
  txIndex: number,
  pause: Pause
): (this: TThis, ...arguments_: TArguments) => Promise<TResult> {
  let calls = 0
  return async function (this: TThis, ...arguments_: TArguments): Promise<TResult> {
    calls += 1
    const result = await real.apply(this, arguments_)
    if (calls === 1) {
      pause.reached.resolve(await backendPid(arguments_[txIndex] as DbTransaction))
      await pause.release.promise
    }
    return result
  }
}

/**
 * What one race produced.
 */
interface RaceResult {
  /**
   * Whether the second call was seen queued behind the paused first one.
   */
  wasQueued: boolean
  /**
   * The settled first and second calls.
   */
  outcomes: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]
}

/**
 * Start `first`, wait for it to pause at its seam, start `second`, and watch
 * whether `second` queues behind it; then release and settle both. The
 * release runs whatever the watch found, so no transaction outlives the test.
 * @param first - The call holding its transaction open at the seam.
 * @param pause - The seam's signals.
 * @param second - The call raced against it.
 * @returns Whether `second` queued, and both outcomes.
 * @throws {Error} When `first` settles before its seam, or the watch itself fails.
 */
async function race(
  first: () => Promise<unknown>,
  pause: Pause,
  second: () => Promise<unknown>
): Promise<RaceResult> {
  const firstRun = first()
  const pid = await untilSignalled(pause.reached.promise, firstRun, 'first call')
  const secondRun = second()
  const [watch] = await Promise.allSettled([waitForWaiter(pid, secondRun)])
  pause.release.resolve()
  const [firstOutcome, secondOutcome] = await Promise.allSettled([firstRun, secondRun])
  if (watch.status === 'rejected') {
    throw new Error('the lock watch failed', { cause: watch.reason })
  }
  return { wasQueued: watch.value, outcomes: [firstOutcome, secondOutcome] }
}

/**
 * The target's owner memberships, to prove a refused grant left none.
 * @param userId - The target.
 * @returns How many owner rows they hold.
 */
async function ownerRowsOf(userId: string): Promise<number> {
  const rows =
    await sql`select 1 from user_memberships where user_id = ${userId} and role = 'owner'`
  return rows.length
}

/**
 * Whether the target is soft-deleted.
 * @param userId - The target.
 * @returns True once the delete committed.
 */
async function isDeleted(userId: string): Promise<boolean> {
  const [row] = await sql<{ deleted: boolean }[]>`
    select deleted_at is not null as deleted from users where id = ${userId}`
  return row?.deleted === true
}

/**
 * A tenant with no owner, tracked for cleanup.
 * @param name - Its display name.
 * @returns The tenant.
 */
async function ownerlessTenant(name: string): Promise<Tenant> {
  const tenant = await tenantRepository.createWithoutOwner({
    name,
    slug: `race-${randomUUID()}`,
  })
  createdTenantIds.push(tenant.id)
  return tenant
}

/**
 * A tenant owned by `ownerId`, tracked for cleanup.
 * @param name - Its display name.
 * @param ownerId - Its owner.
 * @returns The tenant.
 */
async function ownedTenant(name: string, ownerId: string): Promise<Tenant> {
  const tenant = await tenantRepository.create({ name, slug: `race-${randomUUID()}`, ownerId })
  createdTenantIds.push(tenant.id)
  return tenant
}

/**
 * One way a user becomes a tenant owner, set up for one race.
 */
interface OwnerGrant {
  /**
   * Makes the target an owner.
   */
  run: () => Promise<unknown>
  /**
   * Holds the grant's transaction open after its owner write, until released.
   */
  pauseAfterWrite: (pause: Pause, run: () => Promise<void>) => Promise<void>
  /**
   * What the grant answers once it finds the target deleted.
   */
  refusal: { statusCode: number; message: string }
}

const AUTHENTICATION_REQUIRED = { statusCode: 401, message: 'Authentication required' }

/**
 * `createTenant` by the target: they own the new tenant from its first write.
 * @param target - The user who becomes the owner.
 * @returns The grant.
 */
function viaCreateTenant(target: User): OwnerGrant {
  return {
    run: async () => {
      const tenant = await createTenant(
        { userId: target.id },
        { name: 'Raced Tenant', slug: `race-${randomUUID()}` }
      )
      createdTenantIds.push(tenant.id)
      return tenant
    },
    pauseAfterWrite: (pause, run) =>
      withMutatedMethod(
        TenantRepository.prototype,
        'create',
        // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
        pausingFirstCall(TenantRepository.prototype.create, 1, pause),
        run
      ),
    refusal: AUTHENTICATION_REQUIRED,
  }
}

/**
 * The target accepting an owner invitation to an ownerless tenant.
 * @param target - The invitee.
 * @param invitedBy - The sender: staff, or the target themself (the invitation the delete revokes).
 * @returns The grant.
 */
async function viaOwnerInvitation(target: User, invitedBy: string): Promise<OwnerGrant> {
  const tenant = await ownerlessTenant('Invited Owner Ltd')
  const rawToken = randomUUID()
  await invitationRepository.createPending({
    tenantId: tenant.id,
    email: target.email,
    role: 'owner',
    tokenHash: hashToken(rawToken),
    invitedBy,
    expiresAt: new Date(Date.now() + 60_000),
  })
  return {
    run: () => accept(rawToken, target.id),
    pauseAfterWrite: (pause, run) =>
      withMutatedMethod(
        TenantInvitationRepository.prototype,
        'claimForAccept',
        // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
        pausingFirstCall(TenantInvitationRepository.prototype.claimForAccept, 2, pause),
        run
      ),
    refusal: AUTHENTICATION_REQUIRED,
  }
}

/**
 * A tenant's owner promoting the target from admin to owner. The target also
 * co-owns another tenant, so the delete holds that tenant's owner rows while
 * the two race.
 * @param target - The member promoted.
 * @returns The grant.
 */
async function viaChangeRole(target: User): Promise<OwnerGrant> {
  const owner = await createTrackedUser()
  const tenant = await ownedTenant('Promoting Ltd', owner.id)
  await membershipRepository.insertIfAbsent({
    userId: target.id,
    tenantId: tenant.id,
    role: 'admin',
  })
  const coOwned = await ownedTenant('Co-owned Ltd', owner.id)
  await membershipRepository.insertIfAbsent({
    userId: target.id,
    tenantId: coOwned.id,
    role: 'owner',
  })
  return {
    run: () => changeRole({ userId: owner.id }, tenant.id, target.id, 'owner'),
    pauseAfterWrite: (pause, run) =>
      withMutatedMethod(
        UserMembershipRepository.prototype,
        'updateRole',
        // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
        pausingFirstCall(UserMembershipRepository.prototype.updateRole, 2, pause),
        run
      ),
    refusal: { statusCode: 404, message: 'Member not found' },
  }
}

describe('a delete racing a grant of ownership', () => {
  const grants: Array<[string, (target: User, staffId: string) => Promise<OwnerGrant>]> = [
    ['createTenant', (target) => Promise.resolve(viaCreateTenant(target))],
    [
      'accept of an owner invitation from staff',
      (target, staffId) => viaOwnerInvitation(target, staffId),
    ],
    [
      'accept of an owner invitation the target sent',
      (target) => viaOwnerInvitation(target, target.id),
    ],
    ['changeRole to owner', (target) => viaChangeRole(target)],
  ]

  it.each(grants)(
    '%s first: the delete waits, then answers 409 and deletes nothing',
    async (_grant, setUp) => {
      const { user: admin } = await createTrackedStaff('admin')
      const target = await createTrackedUser()
      const grant = await setUp(target, admin.id)
      const pause = newPause()

      let result: RaceResult | undefined
      await grant.pauseAfterWrite(pause, async () => {
        result = await race(grant.run, pause, () =>
          deleteUser({ userId: admin.id }, target.id, REASON)
        )
      })

      // The delete queues behind the grant's lock on the target's user row.
      expect(result?.wasQueued).toBe(true)
      expect(result?.outcomes[0].status).toBe('fulfilled')
      expect(result?.outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: {
          statusCode: 409,
          message: "This user's owned tenants changed meanwhile; try again",
        },
      })
      expect(await isDeleted(target.id)).toBe(false)
    },
    DEADLOCK_TIMEOUT_MS
  )

  it.each(grants)(
    '%s second: the grant waits, then finds the user deleted and grants nothing',
    async (_grant, setUp) => {
      const { user: admin } = await createTrackedStaff('admin')
      const target = await createTrackedUser()
      const grant = await setUp(target, admin.id)
      const ownersBefore = await ownerRowsOf(target.id)
      const pause = newPause()

      let result: RaceResult | undefined
      await withMutatedMethod(
        TenantInvitationRepository.prototype,
        'revokePendingByInviter',
        // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
        pausingFirstCall(TenantInvitationRepository.prototype.revokePendingByInviter, 1, pause),
        async () => {
          result = await race(
            () => deleteUser({ userId: admin.id }, target.id, REASON),
            pause,
            grant.run
          )
        }
      )

      // The grant queues behind the delete's lock on the target's user row.
      expect(result?.wasQueued).toBe(true)
      expect(result?.outcomes[0].status).toBe('fulfilled')
      expect(result?.outcomes[1]).toMatchObject({ status: 'rejected', reason: grant.refusal })
      expect(await isDeleted(target.id)).toBe(true)
      expect(await ownerRowsOf(target.id)).toBe(ownersBefore)
    },
    DEADLOCK_TIMEOUT_MS
  )
})

/**
 * The platform tenant's id.
 * @returns The id of the one `is_platform` tenant.
 */
async function platformTenantId(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from tenants where is_platform`
  if (!row) throw new Error('no platform tenant')
  return row.id
}

/**
 * The target's platform role and whether they are soft-deleted.
 * @param userId - The target.
 * @returns Their state after a race.
 */
async function staffState(userId: string): Promise<{ deleted: boolean; role: string | null }> {
  const [row] = await sql<{ deleted: boolean; role: string | null }[]>`
    select u.deleted_at is not null as deleted, m.role
    from users u
    left join user_memberships m
      on m.user_id = u.id and m.tenant_id = (select id from tenants where is_platform)
    where u.id = ${userId}`
  if (!row) throw new Error('no such user')
  return row
}

describe('a delete racing a platform invitation accept', () => {
  it.each(['owner', 'admin'] as const)(
    'an admin delete queued behind the accept of a platform %s invitation sees the new role and answers 403',
    async (role) => {
      const { user: owner } = await createTrackedStaff('owner')
      const { user: admin } = await createTrackedStaff('admin')
      const target = await createTrackedUser()
      const rawToken = randomUUID()
      await invitationRepository.createPending({
        tenantId: await platformTenantId(),
        email: target.email,
        role,
        tokenHash: hashToken(rawToken),
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      const pause = newPause()

      let result: RaceResult | undefined
      await withMutatedMethod(
        TenantInvitationRepository.prototype,
        'claimForAccept',
        // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
        pausingFirstCall(TenantInvitationRepository.prototype.claimForAccept, 2, pause),
        async () => {
          result = await race(
            () => accept(rawToken, target.id),
            pause,
            () => deleteUser({ userId: admin.id }, target.id, REASON)
          )
        }
      )

      // The delete queues behind the accept's lock on the target's user row.
      expect(result?.wasQueued).toBe(true)
      expect(result?.outcomes[0].status).toBe('fulfilled')
      // An admin acting on a platform admin or owner is refused, as when the accept ran first.
      expect(result?.outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: {
          statusCode: 403,
          message: "Your platform role can't act on this staff member. Ask a platform owner.",
        },
      })
      expect(await staffState(target.id)).toEqual({ deleted: false, role })
    },
    DEADLOCK_TIMEOUT_MS
  )
})

describe('a role change to platform owner racing a delete of the target', () => {
  it(
    'queues on the platform owner rows the delete holds, then answers 404 with no deadlock',
    async () => {
      const { user: platformOwner } = await createTrackedStaff('owner')
      const { user: admin } = await createTrackedStaff('admin')
      // A viewer who owns no customer tenant, so the delete's first owner-row lock is the platform's.
      const { user: target } = await createTrackedStaff('viewer')
      const platformId = await platformTenantId()
      const pause = newPause()

      let result: RaceResult | undefined
      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'lockOwners',
        // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
        pausingFirstCall(UserMembershipRepository.prototype.lockOwners, 2, pause),
        async () => {
          result = await race(
            () => deleteUser({ userId: admin.id }, target.id, REASON),
            pause,
            () =>
              changeRole({ userId: platformOwner.id }, platformId, target.id, 'owner', {
                isPlatformTenant: true,
              })
          )
        }
      )

      // It waits on the platform owner rows holding nothing; a user-row lock taken first would deadlock (40P01).
      expect(result?.wasQueued).toBe(true)
      expect(result?.outcomes[0].status).toBe('fulfilled')
      expect(result?.outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { statusCode: 404, message: 'Member not found' },
      })
      expect(await staffState(target.id)).toEqual({ deleted: true, role: 'viewer' })
    },
    DEADLOCK_TIMEOUT_MS
  )
})

describe('assertPlatformOwnerRemains', () => {
  it('refuses when the target is the last active platform owner, and allows a spare owner or a non-owner', () => {
    // The second argument counts the OTHER active platform owners.
    expect(() => assertPlatformOwnerRemains('owner', 0, 'deactivate')).toThrow(
      'Make another staff member a platform owner before you deactivate this one.'
    )
    expect(() => assertPlatformOwnerRemains('owner', 0, 'delete')).toThrow(
      'Make another staff member a platform owner before you delete this one.'
    )
    expect(() => assertPlatformOwnerRemains('owner', 1, 'delete')).not.toThrow()
    expect(() => assertPlatformOwnerRemains('admin', 0, 'delete')).not.toThrow()
    // eslint-disable-next-line unicorn/no-null -- a non-staff target
    expect(() => assertPlatformOwnerRemains(null, 0, 'delete')).not.toThrow()
  })
})
