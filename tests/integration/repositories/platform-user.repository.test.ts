/**
 * @file PlatformUserRepository: the staff user list (filters, order and the
 * id tiebreak; the shared paging contract is in list-contract.test.ts), the
 * detail reads, and the owner reads the lifecycle actions use.
 * Every list is scoped by a per-test tag in `search`, so users from other files
 * in this worker never match.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { Tenant } from '@/database/models/tenant.model'
import { PlatformUserRepository } from '@/repositories/platform-user.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { platformUserListSchema } from '@/validators/platform.validators'
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

/**
 * A short random tag for one test's emails, so a search by it matches only that test's users.
 */
function newTag(): string {
  return `u${randomUUID().slice(0, 8)}`
}

/**
 * Creates a tenant owned by `ownerId`, tracked for cleanup.
 */
async function tenantOwnedBy(ownerId: string, name = `Acme ${randomUUID()}`): Promise<Tenant> {
  const tenant = await tenantRepository.create({ name, slug: `pu-${randomUUID()}`, ownerId })
  createdTenantIds.push(tenant.id)
  return tenant
}

/**
 * Marks a tenant archived and soft-deleted, a state that `listMemberships` lists and that the
 * membership count leaves out.
 */
async function archive(tenantId: string): Promise<void> {
  await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenantId}`
}

/**
 * A cursor a page must have handed back.
 * @param cursor - The page's `nextCursor` or `prevCursor`.
 * @returns The cursor.
 * @throws {Error} When the page has none.
 */
function required(cursor: string | null): string {
  if (cursor === null) throw new Error('expected the page to hand back a cursor')
  return cursor
}

/**
 * One page of the staff user list for these query params, parsed as the route parses them.
 */
async function listUsers(query: Record<string, string>) {
  const { params, filters } = platformUserListSchema.parse(query)
  return repository.list(params, filters)
}

/**
 * Runs `listUsers` and keeps only the ids of the users it found, in order, for filter assertions.
 */
async function ids(query: Record<string, string>): Promise<string[]> {
  const page = await listUsers(query)
  return page.items.map((user) => user.id)
}

describe('PlatformUserRepository.list', () => {
  it('orders by lower(email), ignoring case', async () => {
    const tag = newTag()
    await createTrackedUser({ email: `${tag}-B@example.test` })
    await createTrackedUser({ email: `${tag}-a@example.test` })

    const page = await listUsers({ search: tag })

    expect(page.items.map((user) => user.email)).toEqual([
      `${tag}-a@example.test`,
      `${tag}-B@example.test`,
    ])
  })

  it('matches search case-insensitively against email, first and last name, and literally for % and _', async () => {
    const tag = newTag()
    await createTrackedUser({ email: `${tag}-plain@example.test`, firstName: 'Ada' })
    await createTrackedUser({ email: `zz-${randomUUID()}@example.test`, firstName: `${tag}Grace` })
    await createTrackedUser({ email: `zz-${randomUUID()}@example.test`, lastName: `${tag}Hopper` })
    await createTrackedUser({ email: `${tag}_under@example.test` })

    const byTag = await listUsers({ search: tag.toUpperCase() })
    expect(byTag.items).toHaveLength(4)

    const literal = await listUsers({ search: `${tag}_` })
    expect(literal.items.map((user) => user.email)).toEqual([`${tag}_under@example.test`])

    const percent = await listUsers({ search: `${tag}%` })
    expect(percent.items).toEqual([])
  })

  it('breaks a lower(email) tie by id, in both directions', async () => {
    const tag = newTag()
    const shared = `${tag}-tie@example.test`
    const first = await createTrackedUser({ email: `${tag}-x1@example.test` })
    const second = await createTrackedUser({ email: `${tag}-x2@example.test` })
    // The unique index covers live rows only, so soft-deleted rows may share an address.
    await sql`update users set email = ${shared}, deleted_at = now() where id = any(${[first.id, second.id]})`
    const expected = [first.id, second.id].toSorted((a, b) => a.localeCompare(b))

    expect(await ids({ search: tag, status: 'deleted' })).toEqual(expected)

    const page = await listUsers({ search: tag, status: 'deleted', limit: '1' })
    expect(page.items.map((user) => user.id)).toEqual(expected.slice(0, 1))
    const following = await listUsers({
      search: tag,
      status: 'deleted',
      limit: '1',
      cursor: required(page.page.nextCursor),
    })
    expect(following.items.map((user) => user.id)).toEqual(expected.slice(1))
    const back = await listUsers({
      search: tag,
      status: 'deleted',
      limit: '1',
      direction: 'prev',
      cursor: required(following.page.prevCursor),
    })
    expect(back.items.map((user) => user.id)).toEqual(expected.slice(0, 1))
  })

  it('combines filters: status with staff, and verified with search', async () => {
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

    expect(await ids({ search: tag, status: 'active', staff: 'true' })).toEqual([
      activeStaff.id,
      unverifiedStaff.id,
    ])
    expect(await ids({ search: `${tag}-d`, verified: 'false' })).toEqual([unverified.id])
    expect(await ids({ search: `${tag}-a`, verified: 'false' })).toEqual([])
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

    expect(await ids({ search: tag, status: 'inactive' })).toEqual([inactive.id])
    expect(await ids({ search: tag, status: 'active' })).not.toContain(inactive.id)
    expect(await ids({ search: tag, verified: 'false' })).toEqual([unverified.id])
    expect(await ids({ search: tag, staff: 'true' })).toEqual([staff.id])
    expect(await ids({ search: tag, staff: 'false' })).not.toContain(staff.id)
  })

  it('filters by whether the user has signed in, apart from verified', async () => {
    const tag = newTag()
    const signedIn = await createTrackedUser({ email: `${tag}-signed@example.test` })
    await sql`update users set last_logged_in_at = now() where id = ${signedIn.id}`
    // Verified, never signed in: the case `verified` and `signedIn` tell apart.
    const verifiedOnly = await createTrackedUser({ email: `${tag}-verified@example.test` })
    const neither = await createTrackedUser({
      email: `${tag}-neither@example.test`,
      verified: false,
    })

    expect(await ids({ search: tag, signedIn: 'true' })).toEqual([signedIn.id])
    expect(await ids({ search: tag, signedIn: 'false' })).toEqual([neither.id, verifiedOnly.id])
    expect(await ids({ search: tag, verified: 'true' })).toEqual([signedIn.id, verifiedOnly.id])
    expect(await ids({ search: tag })).toHaveLength(3)
  })

  it('combines signedIn with verified, staff, status and search', async () => {
    const tag = newTag()
    const staffSignedIn = await createTrackedUser({ email: `${tag}-a@example.test` })
    await makeStaff(staffSignedIn.id, 'viewer')
    const inactiveSignedIn = await createTrackedUser({
      email: `${tag}-b@example.test`,
      active: false,
    })
    await sql`update users set last_logged_in_at = now() where id = any(${[staffSignedIn.id, inactiveSignedIn.id]})`
    const verifiedStaffNever = await createTrackedUser({ email: `${tag}-c@example.test` })
    await makeStaff(verifiedStaffNever.id, 'viewer')
    const unverifiedNever = await createTrackedUser({
      email: `${tag}-d@example.test`,
      verified: false,
    })

    expect(await ids({ search: tag, signedIn: 'true', staff: 'true' })).toEqual([staffSignedIn.id])
    expect(await ids({ search: tag, signedIn: 'false', staff: 'true' })).toEqual([
      verifiedStaffNever.id,
    ])
    expect(await ids({ search: tag, signedIn: 'false', verified: 'true' })).toEqual([
      verifiedStaffNever.id,
    ])
    expect(await ids({ search: tag, signedIn: 'false', verified: 'false' })).toEqual([
      unverifiedNever.id,
    ])
    expect(await ids({ search: tag, signedIn: 'true', status: 'inactive' })).toEqual([
      inactiveSignedIn.id,
    ])
    expect(await ids({ search: `${tag}-c`, signedIn: 'true' })).toEqual([])
  })

  it('excludes a soft-deleted user unless status is deleted, which lists only them', async () => {
    const tag = newTag()
    const live = await createTrackedUser({ email: `${tag}-live@example.test` })
    const gone = await createTrackedUser({ email: `${tag}-gone@example.test` })
    await sql`update users set deleted_at = now() where id = ${gone.id}`

    const byDefault = await listUsers({ search: tag })
    const deleted = await listUsers({ search: tag, status: 'deleted' })

    expect(byDefault.items.map((user) => user.id)).toEqual([live.id])
    expect(deleted.items.map((user) => user.id)).toEqual([gone.id])
    expect(deleted.items[0]?.deletedAt).toBeInstanceOf(Date)
  })

  it('reports the platform role and counts live customer memberships only', async () => {
    const tag = newTag()
    const user = await createTrackedUser({ email: `${tag}-counted@example.test` })
    await makeStaff(user.id, 'admin')
    await tenantOwnedBy(user.id)
    const archived = await tenantOwnedBy(user.id)
    await archive(archived.id)

    const result = await listUsers({ search: tag })
    const [row] = result.items

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
        tenantSlug: tenant.slug,
        role: 'editor',
        expiresAt: pending.expiresAt,
        lastSentAt: pending.lastSentAt,
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
