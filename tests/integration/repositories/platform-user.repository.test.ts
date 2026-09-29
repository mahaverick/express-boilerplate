/**
 * @file PlatformUserRepository: the staff user search (filters, both paging
 * directions, the ends), the detail reads, and the owner reads the
 * lifecycle actions use.
 * Every search is scoped by a per-test tag in `q`, so users from other files
 * in this worker never match.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Tenant } from '@/database/models/tenant.model'
import {
  PlatformUserRepository,
  type PlatformUserCursor,
} from '@/repositories/platform-user.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'

const repository = new PlatformUserRepository()
const tenantRepository = new TenantRepository()
const invitationRepository = new TenantInvitationRepository()
const createdTenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

function newTag(): string {
  return `u${randomUUID().slice(0, 8)}`
}

async function tenantOwnedBy(ownerId: string, name = `Acme ${randomUUID()}`): Promise<Tenant> {
  const tenant = await tenantRepository.create({ name, slug: `pu-${randomUUID()}`, ownerId })
  createdTenantIds.push(tenant.id)
  return tenant
}

async function archive(tenantId: string): Promise<void> {
  await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenantId}`
}

/**
 * Five users whose emails sort a..e under the tag.
 * @param tag - The per-test tag every email starts with.
 * @returns The five emails in sort order.
 */
async function fiveUsers(tag: string): Promise<string[]> {
  // Inserted out of order, so the result order comes from the query, not insertion.
  for (const letter of ['d', 'a', 'e', 'b', 'c']) {
    await createTrackedUser({ email: `${tag}-${letter}@example.test` })
  }
  return ['a', 'b', 'c', 'd', 'e'].map((letter) => `${tag}-${letter}@example.test`)
}

/**
 * The ids a search returns, in order.
 * @param options - The search options.
 * @returns The users' ids.
 */
async function ids(options: Parameters<PlatformUserRepository['search']>[0]): Promise<string[]> {
  const page = await repository.search(options)
  return page.users.map((user) => user.id)
}

describe('PlatformUserRepository.search', () => {
  it('orders by lower(email), ignoring case', async () => {
    const tag = newTag()
    await createTrackedUser({ email: `${tag}-B@example.test` })
    await createTrackedUser({ email: `${tag}-a@example.test` })

    const page = await repository.search({ limit: 10, direction: 'next', q: tag })

    expect(page.users.map((user) => user.email)).toEqual([
      `${tag}-a@example.test`,
      `${tag}-B@example.test`,
    ])
  })

  it('pages forward and back, with no prevCursor on the first page and no nextCursor on the last', async () => {
    const tag = newTag()
    const emails = await fiveUsers(tag)

    const first = await repository.search({ limit: 2, direction: 'next', q: tag })
    expect(first.users.map((user) => user.email)).toEqual(emails.slice(0, 2))
    expect(first.prevCursor).toBeUndefined()
    expect(first.nextCursor).toBeDefined()

    const second = await repository.search({
      limit: 2,
      direction: 'next',
      q: tag,
      cursor: first.nextCursor,
    })
    expect(second.users.map((user) => user.email)).toEqual(emails.slice(2, 4))
    expect(second.prevCursor).toBeDefined()

    const third = await repository.search({
      limit: 2,
      direction: 'next',
      q: tag,
      cursor: second.nextCursor,
    })
    expect(third.users.map((user) => user.email)).toEqual(emails.slice(4))
    expect(third.nextCursor).toBeUndefined()

    const backToSecond = await repository.search({
      limit: 2,
      direction: 'prev',
      q: tag,
      cursor: third.prevCursor,
    })
    expect(backToSecond.users.map((user) => user.email)).toEqual(emails.slice(2, 4))
    expect(backToSecond.prevCursor).toBeDefined()
    expect(backToSecond.nextCursor).toBeDefined()

    const backToFirst = await repository.search({
      limit: 2,
      direction: 'prev',
      q: tag,
      cursor: backToSecond.prevCursor,
    })
    expect(backToFirst.users.map((user) => user.email)).toEqual(emails.slice(0, 2))
    expect(backToFirst.prevCursor).toBeUndefined()
    expect(backToFirst.nextCursor).toBeDefined()
  })

  it('answers an empty page past the end with the cursor as prevCursor, so the client can step back', async () => {
    const tag = newTag()
    await fiveUsers(tag)
    const beyond: PlatformUserCursor = { sortEmail: `${tag}-z@example.test`, id: randomUUID() }

    const page = await repository.search({ limit: 2, direction: 'next', q: tag, cursor: beyond })

    expect(page.users).toEqual([])
    expect(page.nextCursor).toBeUndefined()
    expect(page.prevCursor).toEqual(beyond)
  })

  it('matches q case-insensitively against email, first and last name, and literally for % and _', async () => {
    const tag = newTag()
    await createTrackedUser({ email: `${tag}-plain@example.test`, firstName: 'Ada' })
    await createTrackedUser({ email: `zz-${randomUUID()}@example.test`, firstName: `${tag}Grace` })
    await createTrackedUser({ email: `zz-${randomUUID()}@example.test`, lastName: `${tag}Hopper` })
    await createTrackedUser({ email: `${tag}_under@example.test` })

    const byTag = await repository.search({ limit: 10, direction: 'next', q: tag.toUpperCase() })
    expect(byTag.users).toHaveLength(4)

    const literal = await repository.search({ limit: 10, direction: 'next', q: `${tag}_` })
    expect(literal.users.map((user) => user.email)).toEqual([`${tag}_under@example.test`])

    const percent = await repository.search({ limit: 10, direction: 'next', q: `${tag}%` })
    expect(percent.users).toEqual([])
  })

  it('answers an empty prev page below every row with the cursor as nextCursor and no prevCursor', async () => {
    const tag = newTag()
    await fiveUsers(tag)
    const below: PlatformUserCursor = { sortEmail: `${tag}-0@example.test`, id: randomUUID() }

    const page = await repository.search({ limit: 2, direction: 'prev', q: tag, cursor: below })

    expect(page.users).toEqual([])
    expect(page.nextCursor).toEqual(below)
    expect(page.prevCursor).toBeUndefined()
  })

  it('breaks a lower(email) tie by id, in both directions', async () => {
    const tag = newTag()
    const shared = `${tag}-tie@example.test`
    const first = await createTrackedUser({ email: `${tag}-x1@example.test` })
    const second = await createTrackedUser({ email: `${tag}-x2@example.test` })
    // The unique index covers live rows only, so soft-deleted rows may share an address.
    await sql`update users set email = ${shared}, deleted_at = now() where id = any(${[first.id, second.id]})`
    const expected = [first.id, second.id].toSorted((a, b) => a.localeCompare(b))

    expect(await ids({ limit: 10, direction: 'next', q: tag, status: 'deleted' })).toEqual(expected)

    const page = await repository.search({ limit: 1, direction: 'next', q: tag, status: 'deleted' })
    expect(page.users.map((user) => user.id)).toEqual(expected.slice(0, 1))
    const following = await repository.search({
      limit: 1,
      direction: 'next',
      q: tag,
      status: 'deleted',
      cursor: page.nextCursor,
    })
    expect(following.users.map((user) => user.id)).toEqual(expected.slice(1))
    const back = await repository.search({
      limit: 1,
      direction: 'prev',
      q: tag,
      status: 'deleted',
      cursor: following.prevCursor,
    })
    expect(back.users.map((user) => user.id)).toEqual(expected.slice(0, 1))
  })

  it('combines filters: status with staff, verified with q, and a filter under a prev cursor', async () => {
    const tag = newTag()
    const activeStaff = await createTrackedUser({ email: `${tag}-a@example.test` })
    await makeStaff(activeStaff.id, 'viewer')
    const inactiveStaff = await createTrackedUser({ email: `${tag}-b@example.test`, active: false })
    await makeStaff(inactiveStaff.id, 'viewer')
    await createTrackedUser({ email: `${tag}-c@example.test` })
    const unverified = await createTrackedUser({ email: `${tag}-d@example.test`, verified: false })
    const unverifiedStaff = await createTrackedUser({
      email: `${tag}-e@example.test`,
      verified: false,
    })
    await makeStaff(unverifiedStaff.id, 'viewer')

    expect(
      await ids({ limit: 10, direction: 'next', q: tag, status: 'active', staff: true })
    ).toEqual([activeStaff.id, unverifiedStaff.id])
    expect(await ids({ limit: 10, direction: 'next', q: `${tag}-d`, verified: false })).toEqual([
      unverified.id,
    ])
    expect(await ids({ limit: 10, direction: 'next', q: `${tag}-a`, verified: false })).toEqual([])

    const behindE: PlatformUserCursor = {
      sortEmail: `${tag}-e@example.test`,
      id: unverifiedStaff.id,
    }
    expect(
      await ids({ limit: 10, direction: 'prev', q: tag, verified: false, cursor: behindE })
    ).toEqual([unverified.id])
  })

  it('filters by status, verified and staff', async () => {
    const tag = newTag()
    const inactive = await createTrackedUser({
      email: `${tag}-inactive@example.test`,
      active: false,
    })
    const unverified = await createTrackedUser({
      email: `${tag}-unverified@example.test`,
      verified: false,
    })
    const staff = await createTrackedUser({ email: `${tag}-staff@example.test` })
    await makeStaff(staff.id, 'viewer')

    expect(await ids({ limit: 10, direction: 'next', q: tag, status: 'inactive' })).toEqual([
      inactive.id,
    ])
    expect(await ids({ limit: 10, direction: 'next', q: tag, status: 'active' })).not.toContain(
      inactive.id
    )
    expect(await ids({ limit: 10, direction: 'next', q: tag, verified: false })).toEqual([
      unverified.id,
    ])
    expect(await ids({ limit: 10, direction: 'next', q: tag, staff: true })).toEqual([staff.id])
    expect(await ids({ limit: 10, direction: 'next', q: tag, staff: false })).not.toContain(
      staff.id
    )
  })

  it('excludes a soft-deleted user unless status is deleted, which lists only them', async () => {
    const tag = newTag()
    const live = await createTrackedUser({ email: `${tag}-live@example.test` })
    const gone = await createTrackedUser({ email: `${tag}-gone@example.test` })
    await sql`update users set deleted_at = now() where id = ${gone.id}`

    const byDefault = await repository.search({ limit: 10, direction: 'next', q: tag })
    const deleted = await repository.search({
      limit: 10,
      direction: 'next',
      q: tag,
      status: 'deleted',
    })

    expect(byDefault.users.map((user) => user.id)).toEqual([live.id])
    expect(deleted.users.map((user) => user.id)).toEqual([gone.id])
    expect(deleted.users[0]?.deletedAt).toBeInstanceOf(Date)
  })

  it('reports the platform role and counts live customer memberships only', async () => {
    const tag = newTag()
    const user = await createTrackedUser({ email: `${tag}-counted@example.test` })
    await makeStaff(user.id, 'admin')
    await tenantOwnedBy(user.id)
    const archived = await tenantOwnedBy(user.id)
    await archive(archived.id)

    const result = await repository.search({ limit: 10, direction: 'next', q: tag })
    const [row] = result.users

    expect(row).toMatchObject({ id: user.id, platformRole: 'admin', membershipCount: 1 })
  })
})

describe('PlatformUserRepository detail reads', () => {
  it('findRecord returns a live user, and a soft-deleted one only when asked', async () => {
    const user = await createTrackedUser()
    const live = await repository.findRecord(user.id)
    expect(live?.email).toBe(user.email)
    expect(live?.deletedAt).toBeNull()

    await sql`update users set deleted_at = now() where id = ${user.id}`
    expect(await repository.findRecord(user.id)).toBeUndefined()
    const result = await repository.findRecord(user.id, { includeDeleted: true })
    expect(result?.deletedAt).toBeInstanceOf(Date)
    expect(await repository.findRecord(randomUUID(), { includeDeleted: true })).toBeUndefined()
  })

  it('listMemberships includes archived tenants and never the platform tenant', async () => {
    const user = await createTrackedUser()
    await makeStaff(user.id, 'viewer')
    const live = await tenantOwnedBy(user.id, 'Alpha')
    const archived = await tenantOwnedBy(user.id, 'Beta')
    await archive(archived.id)

    const memberships = await repository.listMemberships(user.id)

    expect(memberships.map((membership) => membership.tenantId)).toEqual([live.id, archived.id])
    expect(memberships[1]).toMatchObject({ lifecycleState: 'archived', role: 'owner' })
  })

  it('listPendingInvitations returns only pending, unexpired invitations, matched case-insensitively', async () => {
    const owner = await createTrackedUser()
    const tenant = await tenantOwnedBy(owner.id)
    const email = `invitee-${randomUUID()}@example.test`
    const pending = await invitationRepository.createPending({
      tenantId: tenant.id,
      email,
      role: 'editor',
      tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      invitedBy: owner.id,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const otherTenant = await tenantOwnedBy(owner.id)
    await invitationRepository.createPending({
      tenantId: otherTenant.id,
      email,
      role: 'viewer',
      tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '1'),
      invitedBy: owner.id,
      expiresAt: new Date(Date.now() - 60_000),
    })

    const invitations = await repository.listPendingInvitations(email.toUpperCase())

    expect(invitations).toEqual([
      {
        id: pending.id,
        tenantId: tenant.id,
        tenantName: tenant.name,
        role: 'editor',
        expiresAt: pending.expiresAt,
      },
    ])
  })
})

describe('PlatformUserRepository owner reads', () => {
  it('listOwnedTenants lists live owned tenants, the platform tenant included, in tenant-id order', async () => {
    const user = await createTrackedUser()
    await makeStaff(user.id, 'owner')
    const first = await tenantOwnedBy(user.id)
    const archived = await tenantOwnedBy(user.id)
    await archive(archived.id)
    const platform = await platformTenant()

    const owned = await repository.listOwnedTenants(user.id)

    const expected = [first.id, platform.id].toSorted((a, b) => a.localeCompare(b))
    expect(owned.map((tenant) => tenant.tenantId)).toEqual(expected)
    expect(owned.find((tenant) => tenant.tenantId === platform.id)?.isPlatform).toBe(true)
  })
})
