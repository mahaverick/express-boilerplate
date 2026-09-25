// tests/integration/repositories/user-membership.repository.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts). Every tenant this file creates is
// deleted in afterEach, tenants first — `user_memberships.tenant_id`
// carries `ON DELETE CASCADE` (user-membership.model.ts), same convention
// tenant.repository.test.ts's own header comment describes. Users are
// deleted second: `user_memberships.user_id` also cascades, so deleting a
// user takes any membership row still pointing at it (including one whose
// tenant this file never tracked, which does not happen here, but the
// ordering is deliberate regardless — same "delete the parent, trust the
// cascade" convention as auth-provider.repository.test.ts).
//
// Every tenant here is created via `TenantRepository.create` — the only
// way a tenant (and therefore any membership pointing at it) can exist in
// this codebase — never a raw insert, so these fixtures are exactly what a
// real caller would produce: a tenant with an owner membership already in
// place, onto which this file adds further memberships directly via
// `UserMembershipRepository.create`.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `membership-repo-${randomUUID()}@example.test`
}

describe('UserMembershipRepository', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdTenantIds.length > 0) {
      await sql`delete from tenants where id = any(${createdTenantIds})`
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) {
      return
    }

    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user, tracked for cleanup.
   * @param overrides - Any `NewUser` fields to override the default email with.
   * @returns The created user row.
   */
  async function createUser(overrides: Partial<{ firstName: string; lastName: string }> = {}) {
    const user = await userRepository.create({ email: uniqueEmail(), ...overrides })
    createdUserIds.push(user.id)
    return user
  }

  /**
   * A fresh tenant owned by `ownerId`, tracked for cleanup — already
   * carries one `'owner'` membership for `ownerId`, via
   * `TenantRepository.create`.
   * @param ownerId - The user who becomes this tenant's owner.
   * @returns The created tenant row.
   */
  async function createTenant(ownerId: string) {
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  describe('findByUserAndTenant', () => {
    it('finds an existing membership', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)

      const found = await userMembershipRepository.findByUserAndTenant(owner.id, tenant.id)
      expect(found).toMatchObject({ userId: owner.id, tenantId: tenant.id, role: 'owner' })
    })

    it('returns undefined when the user has no membership in the tenant', async () => {
      const owner = await createUser()
      const outsider = await createUser()
      const tenant = await createTenant(owner.id)

      expect(
        await userMembershipRepository.findByUserAndTenant(outsider.id, tenant.id)
      ).toBeUndefined()
    })
  })

  describe('create', () => {
    it('adds a member with an explicit role', async () => {
      const owner = await createUser()
      const member = await createUser()
      const tenant = await createTenant(owner.id)

      const membership = await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'editor',
      })

      expect(membership.role).toBe('editor')
      expect(membership.userId).toBe(member.id)
      expect(membership.tenantId).toBe(tenant.id)
    })

    it('defaults role to viewer when none is given', async () => {
      const owner = await createUser()
      const member = await createUser()
      const tenant = await createTenant(owner.id)

      const membership = await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
      })

      expect(membership.role).toBe('viewer')
    })

    it('rejects a duplicate (userId, tenantId) pair with HttpError(409)', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)

      // owner already has a membership row, created by TenantRepository
      // .create — this is the collision.
      await expect(
        userMembershipRepository.create({ userId: owner.id, tenantId: tenant.id, role: 'admin' })
      ).rejects.toMatchObject({ name: 'HttpError', statusCode: 409 })
    })

    // The catch block's OTHER branch: `isUniqueViolation` false, so the
    // original error propagates unchanged rather than becoming an
    // HttpError(409) meant for a (userId, tenantId) collision specifically.
    // A foreign-key violation on `userId` (naming no real user) is a real,
    // different failure — mirrors tenant.repository.test.ts's and
    // auth-provider.repository.test.ts's identical case for their own
    // `create`.
    it('propagates a non-collision database error unchanged, e.g. a foreign-key violation on userId', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)

      await expect(
        userMembershipRepository.create({
          userId: randomUUID(),
          tenantId: tenant.id,
          role: 'viewer',
        })
      ).rejects.not.toMatchObject({ name: 'HttpError' })
    })

    it('rejects an unknown role at the database, not just in TypeScript', async () => {
      // Load-bearing for this task's own schema guarantee
      // (`user_memberships_role_check`, user-membership.model.ts) — same
      // standard auth-provider.repository.test.ts's identical check holds
      // itself to.
      const owner = await createUser()
      const member = await createUser()
      const tenant = await createTenant(owner.id)

      await expect(
        sql`insert into user_memberships (user_id, tenant_id, role) values (${member.id}, ${tenant.id}, 'superadmin')`
      ).rejects.toMatchObject({ code: '23514' }) // check_violation
    })
  })

  describe('listByTenant', () => {
    it('lists every member with their safe user info, never passwordHash', async () => {
      const owner = await createUser({ firstName: 'Ada', lastName: 'Lovelace' })
      const tenant = await createTenant(owner.id)
      const member = await createUser({ firstName: 'Alan', lastName: 'Turing' })
      await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      const rows = await userMembershipRepository.listByTenant(tenant.id)
      expect(rows).toHaveLength(2)

      const ownerRow = rows.find((row) => row.user.id === owner.id)
      expect(ownerRow).toMatchObject({
        membership: { role: 'owner' },
        user: { id: owner.id, email: owner.email, firstName: 'Ada', lastName: 'Lovelace' },
      })
      expect(ownerRow?.user).not.toHaveProperty('passwordHash')

      const memberRow = rows.find((row) => row.user.id === member.id)
      expect(memberRow?.membership.role).toBe('viewer')
    })

    it('excludes a member whose own user account is soft-deleted', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)
      const member = await createUser()
      await userMembershipRepository.create({ userId: member.id, tenantId: tenant.id })

      await userRepository.softDelete(member.id)

      const rows = await userMembershipRepository.listByTenant(tenant.id)
      expect(rows.some((row) => row.user.id === member.id)).toBe(false)
      // The membership row itself is untouched by the user's soft-delete —
      // only the projection excludes it.
      const [rawMembership] =
        await sql`select * from user_memberships where user_id = ${member.id} and tenant_id = ${tenant.id}`
      expect(rawMembership).toBeDefined()
    })

    it('returns only the owner for a freshly created tenant', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)
      const rows = await userMembershipRepository.listByTenant(tenant.id)
      expect(rows).toHaveLength(1) // just the owner
    })
  })

  describe('listByUser', () => {
    it('lists every tenant a user belongs to, with the membership and tenant rows', async () => {
      const owner = await createUser()
      const outsideOwner = await createUser()
      const owned = await createTenant(owner.id)
      const joined = await createTenant(outsideOwner.id)
      await userMembershipRepository.create({
        userId: owner.id,
        tenantId: joined.id,
        role: 'manager',
      })

      const rows = await userMembershipRepository.listByUser(owner.id)
      const byTenantId = new Map(rows.map((row) => [row.tenant.id, row.membership.role]))

      expect(byTenantId.get(owned.id)).toBe('owner')
      expect(byTenantId.get(joined.id)).toBe('manager')
    })

    it('excludes a soft-deleted tenant', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)
      await tenantRepository.softDelete(tenant.id)

      const rows = await userMembershipRepository.listByUser(owner.id)
      expect(rows.some((row) => row.tenant.id === tenant.id)).toBe(false)
    })
  })

  describe('updateRole', () => {
    it('changes a membership’s role and bumps updatedAt', async () => {
      const owner = await createUser()
      const member = await createUser()
      const tenant = await createTenant(owner.id)
      const membership = await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      const updated = await userMembershipRepository.updateRole(membership.id, 'manager')

      expect(updated?.role).toBe('manager')
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(membership.updatedAt.getTime())
    })

    it('returns undefined for a membership id that does not exist', async () => {
      expect(await userMembershipRepository.updateRole(randomUUID(), 'admin')).toBeUndefined()
    })
  })

  describe('delete', () => {
    it('hard-deletes a membership and returns true', async () => {
      const owner = await createUser()
      const member = await createUser()
      const tenant = await createTenant(owner.id)
      const membership = await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
      })

      expect(await userMembershipRepository.delete(membership.id)).toBe(true)
      expect(
        await userMembershipRepository.findByUserAndTenant(member.id, tenant.id)
      ).toBeUndefined()

      const [row] = await sql`select * from user_memberships where id = ${membership.id}`
      expect(row).toBeUndefined()
    })

    it('returns false for a membership id that does not exist', async () => {
      expect(await userMembershipRepository.delete(randomUUID())).toBe(false)
    })
  })

  describe('countOwners', () => {
    it('counts the single owner a freshly created tenant has', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)

      expect(await userMembershipRepository.countOwners(tenant.id)).toBe(1)
    })

    it('reflects an added second owner and a removed one', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)
      const secondOwner = await createUser()

      const secondMembership = await userMembershipRepository.create({
        userId: secondOwner.id,
        tenantId: tenant.id,
        role: 'owner',
      })
      expect(await userMembershipRepository.countOwners(tenant.id)).toBe(2)

      await userMembershipRepository.delete(secondMembership.id)
      expect(await userMembershipRepository.countOwners(tenant.id)).toBe(1)
    })

    it('does not count non-owner roles', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)
      const member = await createUser()
      await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'admin',
      })

      expect(await userMembershipRepository.countOwners(tenant.id)).toBe(1)
    })
  })

  describe('lockMemberships', () => {
    it('returns only the listed members of this tenant, in user_id order', async () => {
      const owner = await createUser()
      const first = await createUser()
      const second = await createUser()
      const outsider = await createUser()
      const tenant = await createTenant(owner.id)
      await userMembershipRepository.create({
        userId: second.id,
        tenantId: tenant.id,
        role: 'editor',
      })
      await userMembershipRepository.create({
        userId: first.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      const locked = await db.transaction((tx) =>
        userMembershipRepository.lockMemberships(
          tenant.id,
          [second.id, outsider.id, first.id, first.id],
          tx
        )
      )

      expect(locked.map((membership) => membership.userId)).toEqual(
        [first.id, second.id].toSorted((a, b) => a.localeCompare(b))
      )
    })

    it('returns nothing for an empty list', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)

      const locked = await db.transaction((tx) =>
        userMembershipRepository.lockMemberships(tenant.id, [], tx)
      )

      expect(locked).toEqual([])
    })

    it('holds a row lock until the transaction ends', async () => {
      const owner = await createUser()
      const member = await createUser()
      const tenant = await createTenant(owner.id)
      const membership = await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      // Pool note: test mode has max 2 connections; the transaction holds one, the probe uses the other.
      await db.transaction(async (tx) => {
        await userMembershipRepository.lockMemberships(tenant.id, [member.id], tx)
        await expect(
          sql`select id from user_memberships where id = ${membership.id} for update nowait`
        ).rejects.toMatchObject({ code: '55P03' })
      })

      const [row] = await sql<{ id: string }[]>`
        select id from user_memberships where id = ${membership.id} for update nowait
      `
      expect(row?.id).toBe(membership.id)
    })
  })

  it('deletes a tenant’s membership rows automatically via ON DELETE CASCADE', async () => {
    const owner = await createUser()
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId: owner.id,
    })
    const membership = await userMembershipRepository.findByUserAndTenant(owner.id, tenant.id)
    expect(membership).toBeDefined()
    if (!membership) throw new Error('unreachable: asserted above')

    await sql`delete from tenants where id = ${tenant.id}`
    // The tenant row is gone without ever being tracked in createdTenantIds
    // above — afterEach has nothing to clean up here, deliberately, since
    // this test's own point is that the cascade already did it.

    const [remaining] = await sql`select * from user_memberships where id = ${membership.id}`
    expect(remaining).toBeUndefined()
  })

  it('deletes a user’s membership rows automatically via ON DELETE CASCADE', async () => {
    const owner = await createUser()
    const tenant = await createTenant(owner.id)
    const member = await createUser()
    const membership = await userMembershipRepository.create({
      userId: member.id,
      tenantId: tenant.id,
    })

    await sql`delete from users where id = ${member.id}`
    // member's row is gone without ever being tracked in createdUserIds
    // above — same deliberate omission as the cascade test above.

    const [remaining] = await sql`select * from user_memberships where id = ${membership.id}`
    expect(remaining).toBeUndefined()
  })

  describe('createIfAbsent', () => {
    it('inserts a membership when none exists', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)
      const user = await createUser()

      const membership = await userMembershipRepository.createIfAbsent({
        userId: user.id,
        tenantId: tenant.id,
        role: 'editor',
      })

      expect(membership).toMatchObject({ userId: user.id, tenantId: tenant.id, role: 'editor' })
    })

    it('keeps an existing membership and its role', async () => {
      const owner = await createUser()
      const tenant = await createTenant(owner.id)
      const user = await createUser()
      const existing = await userMembershipRepository.create({
        userId: user.id,
        tenantId: tenant.id,
        role: 'manager',
      })

      const membership = await userMembershipRepository.createIfAbsent({
        userId: user.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      expect(membership.id).toBe(existing.id)
      expect(membership.role).toBe('manager')
    })
  })
})
