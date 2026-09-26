// tests/integration/repositories/lock-modes.test.ts
//
// The row-lock strength each repository lock method takes. FOR NO KEY UPDATE
// lets a foreign-key insert through (it takes FOR KEY SHARE on the
// referenced row); FOR UPDATE makes it wait. Each test holds a lock in
// transaction A and runs the other side in transaction B on the pool's second
// connection; lock-probe.ts reports whether B queued behind A.
//
// Only `tenants` is referenced by foreign keys, so only its lock changes what
// an ordinary insert does. tenant_settings and user_memberships are probed
// with an explicit FOR KEY SHARE, the lock such an insert would take.
//
// The MUTATION_PROOF tests are DELIBERATELY red: each swaps a lock method for
// one that takes FOR UPDATE and keeps the real test's assertion.
//
//   MUTATION_PROOF=1 pnpm exec vitest run tests/integration/repositories/lock-modes.test.ts   # red
//   pnpm exec vitest run tests/integration/repositories/lock-modes.test.ts                    # green
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  tenantModel,
  tenantSettingsModel,
  type Tenant,
  type TenantSettings,
} from '@/database/models/tenant.model'
import { userMembershipModel, type UserMembership } from '@/database/models/user-membership.model'
import type { User } from '@/database/models/user.model'
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { db, sql, type DbExecutor, type DbTransaction } from '@/services/database.service'
import { changeRole, removeMember } from '@/services/tenant-membership.service'
import { updateTenant } from '@/services/tenant.service'
import type { RowLockMode } from '@/types/lock-mode'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backendPid, deferred, untilSignalled, waitForBlocked } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'

const tenantRepository = new TenantRepository()
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
 * @returns The user.
 */
async function createUser(): Promise<User> {
  const user = await userRepository.create({ email: `lock-modes-${randomUUID()}@example.test` })
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

/**
 * Hold `lock` in transaction A while `other` runs in transaction B, and
 * report whether B queued behind A. A stays open until the probe answers.
 * @param lock - Takes the lock under test in A.
 * @param other - The statement that may conflict, run in B.
 * @returns True when B waited on A's lock.
 */
async function wasBlockedBehind(
  lock: (tx: DbTransaction) => Promise<unknown>,
  other: (tx: DbTransaction) => Promise<unknown>
): Promise<boolean> {
  // A holder object: TypeScript does not see assignments made inside the callback.
  const state: { running?: Promise<void>; wasBlocked?: boolean } = {}
  try {
    await db.transaction(async (txA) => {
      await lock(txA)
      const pid = deferred<number>()
      const running = db.transaction(async (txB) => {
        pid.resolve(await backendPid(txB))
        await other(txB)
      })
      state.running = running
      state.wasBlocked = await waitForBlocked(
        await untilSignalled(pid.promise, running, 'B'),
        running
      )
    })
  } finally {
    await Promise.allSettled([state.running])
  }
  await state.running
  if (state.wasBlocked === undefined) throw new Error('the probe never ran')
  return state.wasBlocked
}

/**
 * An audit entry for `tenant`: its insert checks the tenant foreign key.
 * @param tenant - The tenant.
 * @param actor - The acting user.
 * @param tx - The transaction to insert in.
 * @returns The insert.
 */
function auditInsert(tenant: Tenant, actor: User, tx: DbTransaction): Promise<unknown> {
  return record(
    {
      action: 'tenant.updated',
      actor: { userId: actor.id },
      access: 'member',
      tenantId: tenant.id,
      targetId: tenant.id,
      metadata: { changed: ['name'] },
    },
    tx
  )
}

/**
 * A `TenantRepository.lockById` stand-in that takes FOR UPDATE.
 * @param id - The tenant's id.
 * @param executor - The transaction to hold the lock in.
 * @returns The locked tenant, or undefined.
 */
async function lockTenantForUpdate(
  id: string,
  executor: DbTransaction
): Promise<Tenant | undefined> {
  const [row] = await executor
    .select()
    .from(tenantModel)
    .where(and(eq(tenantModel.id, id), isNull(tenantModel.deletedAt)))
    .limit(1)
    .for('update')
  return row
}

/**
 * A `TenantSettingsRepository.lockByTenantId` stand-in that takes FOR UPDATE.
 * @param tenantId - The tenant whose settings to lock.
 * @param executor - The transaction to hold the lock in.
 * @returns The locked row, or undefined.
 */
async function lockSettingsForUpdate(
  tenantId: string,
  executor: DbTransaction
): Promise<TenantSettings | undefined> {
  const [row] = await executor
    .select()
    .from(tenantSettingsModel)
    .where(eq(tenantSettingsModel.tenantId, tenantId))
    .for('update')
  return row
}

/**
 * A `UserMembershipRepository.lockOwners` stand-in that takes FOR UPDATE whatever the mode.
 * @param tenantId - The tenant whose owners to lock.
 * @param _mode - Ignored.
 * @param executor - The transaction to hold the lock in.
 * @returns The locked owner memberships.
 */
async function lockOwnersForUpdate(
  tenantId: string,
  _mode?: RowLockMode,
  executor: DbExecutor = db
): Promise<UserMembership[]> {
  return executor
    .select()
    .from(userMembershipModel)
    .where(and(eq(userMembershipModel.tenantId, tenantId), eq(userMembershipModel.role, 'owner')))
    .orderBy(userMembershipModel.id)
    .for('update')
}

/**
 * A `UserMembershipRepository.lockMemberships` stand-in that takes FOR UPDATE whatever the
 * mode.
 * @param tenantId - The tenant.
 * @param userIds - The users whose memberships to lock.
 * @param _mode - Ignored.
 * @param executor - The transaction to hold the locks in.
 * @returns The locked memberships.
 */
async function lockMembershipsForUpdate(
  tenantId: string,
  userIds: readonly string[],
  _mode?: RowLockMode,
  executor: DbExecutor = db
): Promise<UserMembership[]> {
  return executor
    .select()
    .from(userMembershipModel)
    .where(
      and(eq(userMembershipModel.tenantId, tenantId), inArray(userMembershipModel.userId, userIds))
    )
    .orderBy(userMembershipModel.userId)
    .for('update')
}

/**
 * FOR KEY SHARE on one settings row, the lock a referencing insert would take.
 * @param tenantId - The settings row's key.
 * @param tx - The transaction to take it in.
 * @returns The select.
 */
function keyShareSettings(tenantId: string, tx: DbTransaction): Promise<unknown> {
  return tx
    .select({ tenantId: tenantSettingsModel.tenantId })
    .from(tenantSettingsModel)
    .where(eq(tenantSettingsModel.tenantId, tenantId))
    .for('key share')
}

/**
 * FOR KEY SHARE on one membership row.
 * @param membershipId - The membership's id.
 * @param tx - The transaction to take it in.
 * @returns The select.
 */
function keyShareMembership(membershipId: string, tx: DbTransaction): Promise<unknown> {
  return tx
    .select({ id: userMembershipModel.id })
    .from(userMembershipModel)
    .where(eq(userMembershipModel.id, membershipId))
    .for('key share')
}

describe('TenantRepository.lockById', () => {
  it('lets an audit insert for the tenant finish while the tenant row is locked', async () => {
    const owner = await createUser()
    const tenant = await createTenant(owner)

    const wasBlocked = await wasBlockedBehind(
      (tx) => tenantRepository.lockById(tenant.id, tx),
      (tx) => auditInsert(tenant, owner, tx)
    )

    expect(wasBlocked).toBe(false)
  })

  it('lets a membership insert (an invitation accept) finish while the tenant row is locked', async () => {
    const owner = await createUser()
    const invitee = await createUser()
    const tenant = await createTenant(owner)

    const wasBlocked = await wasBlockedBehind(
      (tx) => tenantRepository.lockById(tenant.id, tx),
      (tx) =>
        userMembershipRepository.createIfAbsent(
          { userId: invitee.id, tenantId: tenant.id, role: 'viewer' },
          tx
        )
    )

    expect(wasBlocked).toBe(false)
  })

  // Always on: the probe does see a wait, so the tests above cannot pass vacuously.
  it('sees the same audit insert wait behind FOR UPDATE', async () => {
    const owner = await createUser()
    const tenant = await createTenant(owner)

    const wasBlocked = await wasBlockedBehind(
      (tx) => lockTenantForUpdate(tenant.id, tx),
      (tx) => auditInsert(tenant, owner, tx)
    )

    expect(wasBlocked).toBe(true)
  })

  // DELIBERATELY red under MUTATION_PROOF=1.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the audit-insert test against a lockById that takes FOR UPDATE',
    async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner)
      await withMutatedMethod(
        TenantRepository.prototype,
        'lockById',
        lockTenantForUpdate,
        async () => {
          const wasBlocked = await wasBlockedBehind(
            (tx) => tenantRepository.lockById(tenant.id, tx),
            (tx) => auditInsert(tenant, owner, tx)
          )
          expect(wasBlocked).toBe(false)
        }
      )
    }
  )
})

describe('TenantSettingsRepository.lockByTenantId', () => {
  it('does not block FOR KEY SHARE on the settings row', async () => {
    const tenant = await createTenant(await createUser())

    const wasBlocked = await wasBlockedBehind(
      (tx) => tenantSettingsRepository.lockByTenantId(tenant.id, tx),
      (tx) => keyShareSettings(tenant.id, tx)
    )

    expect(wasBlocked).toBe(false)
  })

  // DELIBERATELY red under MUTATION_PROOF=1.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the settings test against a lockByTenantId that takes FOR UPDATE',
    async () => {
      const tenant = await createTenant(await createUser())
      await withMutatedMethod(
        TenantSettingsRepository.prototype,
        'lockByTenantId',
        lockSettingsForUpdate,
        async () => {
          const wasBlocked = await wasBlockedBehind(
            (tx) => tenantSettingsRepository.lockByTenantId(tenant.id, tx),
            (tx) => keyShareSettings(tenant.id, tx)
          )
          expect(wasBlocked).toBe(false)
        }
      )
    }
  )
})

describe('UserMembershipRepository lock modes', () => {
  it.each([
    { mode: undefined, expected: false },
    { mode: 'no key update' as const, expected: false },
    { mode: 'update' as const, expected: true },
  ])('lockOwners with mode $mode blocks FOR KEY SHARE: $expected', async ({ mode, expected }) => {
    const owner = await createUser()
    const tenant = await createTenant(owner)
    const ownerRow = await userMembershipRepository.findByUserAndTenant(owner.id, tenant.id)
    if (!ownerRow) throw new Error('setup: the owner has a membership')

    const wasBlocked = await wasBlockedBehind(
      (tx) => userMembershipRepository.lockOwners(tenant.id, mode, tx),
      (tx) => keyShareMembership(ownerRow.id, tx)
    )

    expect(wasBlocked).toBe(expected)
  })

  // DELIBERATELY red under MUTATION_PROOF=1.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    "reproduces lockOwners' 'no key update' row against a lockOwners that takes FOR UPDATE",
    async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner)
      const ownerRow = await userMembershipRepository.findByUserAndTenant(owner.id, tenant.id)
      if (!ownerRow) throw new Error('setup: the owner has a membership')
      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'lockOwners',
        lockOwnersForUpdate,
        async () => {
          const wasBlocked = await wasBlockedBehind(
            (tx) => userMembershipRepository.lockOwners(tenant.id, 'no key update', tx),
            (tx) => keyShareMembership(ownerRow.id, tx)
          )
          expect(wasBlocked).toBe(false)
        }
      )
    }
  )

  it.each([
    { mode: undefined, expected: false },
    { mode: 'no key update' as const, expected: false },
    { mode: 'update' as const, expected: true },
  ])(
    'lockMemberships with mode $mode blocks FOR KEY SHARE: $expected',
    async ({ mode, expected }) => {
      const owner = await createUser()
      const member = await createUser()
      const tenant = await createTenant(owner)
      const membership = await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      const wasBlocked = await wasBlockedBehind(
        (tx) => userMembershipRepository.lockMemberships(tenant.id, [member.id], mode, tx),
        (tx) => keyShareMembership(membership.id, tx)
      )

      expect(wasBlocked).toBe(expected)
    }
  )

  // DELIBERATELY red under MUTATION_PROOF=1.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    "reproduces lockMemberships' 'no key update' row against a lockMemberships that takes FOR UPDATE",
    async () => {
      const owner = await createUser()
      const member = await createUser()
      const tenant = await createTenant(owner)
      const membership = await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'viewer',
      })
      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'lockMemberships',
        lockMembershipsForUpdate,
        async () => {
          const wasBlocked = await wasBlockedBehind(
            (tx) =>
              userMembershipRepository.lockMemberships(tenant.id, [member.id], 'no key update', tx),
            (tx) => keyShareMembership(membership.id, tx)
          )
          expect(wasBlocked).toBe(false)
        }
      )
    }
  )
})

/**
 * Run `run` while recording the mode lockOwners and lockMemberships are called with.
 * @param run - The service call to observe.
 * @returns One `method:mode` entry per call, in call order.
 */
async function recordModes(run: () => Promise<unknown>): Promise<string[]> {
  const calls: string[] = []
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realOwners = UserMembershipRepository.prototype.lockOwners
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realMemberships = UserMembershipRepository.prototype.lockMemberships
  const owners: typeof realOwners = function (this: UserMembershipRepository, ...parameters) {
    calls.push(`lockOwners:${parameters[1] ?? 'default'}`)
    return realOwners.apply(this, parameters)
  }
  const memberships: typeof realMemberships = function (
    this: UserMembershipRepository,
    ...parameters
  ) {
    calls.push(`lockMemberships:${parameters[2] ?? 'default'}`)
    return realMemberships.apply(this, parameters)
  }
  await withMutatedMethod(UserMembershipRepository.prototype, 'lockOwners', owners, async () => {
    await withMutatedMethod(
      UserMembershipRepository.prototype,
      'lockMemberships',
      memberships,
      async () => {
        await run()
      }
    )
  })
  return calls
}

describe('the mode each call site passes', () => {
  it('takes FOR UPDATE when removing a member, whose row the transaction deletes', async () => {
    const owner = await createUser()
    const member = await createUser()
    const tenant = await createTenant(owner)
    await userMembershipRepository.create({
      userId: member.id,
      tenantId: tenant.id,
      role: 'viewer',
    })

    const calls = await recordModes(() => removeMember({ userId: owner.id }, tenant.id, member.id))

    expect(calls).toEqual(['lockOwners:update', 'lockMemberships:update'])
  })

  it('takes FOR NO KEY UPDATE for a role change and a tenant update', async () => {
    const owner = await createUser()
    const member = await createUser()
    const tenant = await createTenant(owner)
    await userMembershipRepository.create({
      userId: member.id,
      tenantId: tenant.id,
      role: 'viewer',
    })

    const calls = await recordModes(async () => {
      await changeRole({ userId: owner.id }, tenant.id, member.id, 'editor')
      await updateTenant({ userId: owner.id }, tenant.id, { name: 'Renamed' })
    })

    expect(calls).toEqual([
      'lockOwners:no key update',
      'lockMemberships:no key update',
      'lockOwners:no key update',
      'lockMemberships:no key update',
    ])
  })
})
