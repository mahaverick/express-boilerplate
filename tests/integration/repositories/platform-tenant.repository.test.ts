// tests/integration/repositories/platform-tenant.repository.test.ts
//
// The staff search reads every tenant in this worker's database, including
// other files' leftovers, so each test names its tenants with a marker unique
// to the test and searches by it.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PlatformTenantRepository,
  type PlatformTenantCursor,
  type PlatformTenantRow,
} from '@/repositories/platform-tenant.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'

const platformTenantRepository = new PlatformTenantRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const createdTenantIds: string[] = []
const createdUserIds: string[] = []

afterEach(async () => {
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (createdUserIds.length === 0) return
  await sql`delete from users where id = any(${createdUserIds})`
  createdUserIds.length = 0
})

/**
 * A lowercase marker unique to one test, safe inside a slug.
 * @returns The marker.
 */
function marker(): string {
  return `m${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

/**
 * A fresh user, tracked for cleanup.
 * @returns The user's id.
 */
async function createUser(): Promise<string> {
  const user = await userRepository.create({ email: `platform-repo-${randomUUID()}@example.test` })
  createdUserIds.push(user.id)
  return user.id
}

/**
 * A tenant with this name and slug, owned by a fresh user, tracked for cleanup.
 * @param name - The tenant's name.
 * @param slug - The tenant's slug.
 * @returns The tenant's id.
 */
async function createTenant(name: string, slug: string): Promise<string> {
  const tenant = await tenantRepository.create({ name, slug, ownerId: await createUser() })
  createdTenantIds.push(tenant.id)
  return tenant.id
}

/**
 * Every page of a search, following cursors.
 * @param q - The search text.
 * @param limit - The page size.
 * @returns The rows in page order.
 */
async function searchEveryPage(q: string, limit: number): Promise<PlatformTenantRow[]> {
  const rows: PlatformTenantRow[] = []
  let cursor: PlatformTenantCursor | undefined
  let pages = 0
  do {
    const page = await platformTenantRepository.searchAll({ q, limit, cursor })
    rows.push(...page.tenants)
    cursor = page.nextCursor
    pages += 1
  } while (cursor !== undefined && pages < 20)
  return rows
}

describe('PlatformTenantRepository.searchAll', () => {
  it('never returns the platform tenant or a soft-deleted tenant', async () => {
    const tag = marker()
    await createTenant(`${tag} live`, `${tag}-live`)
    const deletedId = await createTenant(`${tag} gone`, `${tag}-gone`)
    await tenantRepository.softDelete(deletedId)

    const byTag = await platformTenantRepository.searchAll({ q: tag, limit: 50 })
    const byPlatform = await searchEveryPage('platform', 50)

    expect(byTag.tenants.map((tenant) => tenant.name)).toEqual([`${tag} live`])
    expect(byPlatform.map((tenant) => tenant.slug)).not.toContain('platform')
  })

  it('matches a case-insensitive substring of the name or the slug', async () => {
    const tag = marker()
    await createTenant(`Acme ${tag.toUpperCase()} Corp`, `${tag}-a`)
    await createTenant('Unrelated Name', `x-${tag}-slug`)

    const result = await platformTenantRepository.searchAll({ q: tag.toUpperCase(), limit: 50 })

    const slugs = result.tenants.map((tenant) => tenant.slug)
    expect(slugs).toHaveLength(2)
    expect(slugs).toEqual(expect.arrayContaining([`${tag}-a`, `x-${tag}-slug`]))
  })

  it.each([
    ['%', '100% off', '100x off'],
    ['_', 'a_b', 'axb'],
    ['\\', String.raw`back\slash`, 'backslash'],
  ])('treats %s in q as a literal character', async (_character, literal, lookalike) => {
    const tag = marker()
    await createTenant(`${tag} ${literal}`, `${tag}-literal`)
    await createTenant(`${tag} ${lookalike}`, `${tag}-lookalike`)

    const result = await platformTenantRepository.searchAll({ q: `${tag} ${literal}`, limit: 50 })

    expect(result.tenants.map((tenant) => tenant.slug)).toEqual([`${tag}-literal`])
  })

  it('orders by lower(name) then id, and pages without duplicates when names tie', async () => {
    const tag = marker()
    for (const [index, name] of [
      `${tag} same`,
      `${tag} SAME`,
      `${tag} Same`,
      `${tag} alpha`,
    ].entries()) {
      await createTenant(name, `${tag}-${index}`)
    }

    const everything = await platformTenantRepository.searchAll({ q: tag, limit: 50 })
    const paged = await searchEveryPage(tag, 1)

    expect(everything.tenants).toHaveLength(4)
    expect(everything.nextCursor).toBeUndefined()
    expect(everything.tenants[0]?.name).toBe(`${tag} alpha`)
    expect(paged.map((tenant) => tenant.id)).toEqual(everything.tenants.map((tenant) => tenant.id))
    const tiedIds = everything.tenants.slice(1).map((tenant) => tenant.id)
    expect(tiedIds).toEqual(await sortedByDatabase(tiedIds))
  })

  it('stops at limit and hands back a cursor only when more rows remain', async () => {
    const tag = marker()
    for (let index = 0; index < 3; index += 1)
      await createTenant(`${tag} ${index}`, `${tag}-${index}`)

    const first = await platformTenantRepository.searchAll({ q: tag, limit: 2 })
    const last = await platformTenantRepository.searchAll({
      q: tag,
      limit: 2,
      cursor: first.nextCursor,
    })

    expect(first.tenants).toHaveLength(2)
    expect(first.nextCursor).toEqual({ sortName: `${tag} 1`, id: first.tenants[1]?.id })
    expect(last.tenants).toHaveLength(1)
    expect(last.nextCursor).toBeUndefined()
  })

  it('returns the row shape with a live-member count', async () => {
    const tag = marker()
    const tenantId = await createTenant(`${tag} Counted`, `${tag}-counted`)
    const member = await createUser()
    const deletedMember = await createUser()
    await userMembershipRepository.create({ userId: member, tenantId, role: 'viewer' })
    await userMembershipRepository.create({ userId: deletedMember, tenantId, role: 'viewer' })
    await userRepository.softDelete(deletedMember)

    const { tenants } = await platformTenantRepository.searchAll({ q: tag, limit: 50 })

    expect(tenants).toEqual([
      {
        id: tenantId,
        name: `${tag} Counted`,
        slug: `${tag}-counted`,
        lifecycleState: 'active',
        memberCount: 2,
        createdAt: expect.any(Date) as Date,
      },
    ])
  })

  it('lists every customer tenant when q is omitted', async () => {
    const tag = marker()
    const tenantId = await createTenant(`${tag} anywhere`, `${tag}-anywhere`)

    // Resume just before this test's names, so the first row is its own tenant.
    const page = await platformTenantRepository.searchAll({
      limit: 1,
      cursor: { sortName: tag, id: '' },
    })

    expect(page.tenants.map((tenant) => tenant.id)).toEqual([tenantId])
  })
})

/**
 * Ids in the order Postgres itself sorts them, the tiebreak the search uses.
 * @param ids - The ids.
 * @returns The same ids, database-ordered.
 */
async function sortedByDatabase(ids: string[]): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select unnest(${ids}::varchar[]) as id order by 1`
  return rows.map((row) => row.id)
}
