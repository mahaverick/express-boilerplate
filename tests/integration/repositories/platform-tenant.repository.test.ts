/**
 * @file The staff list reads every tenant in this worker's database,
 * including other files' leftovers, so each test names its tenants with a
 * marker unique to the test and searches by it.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PlatformTenantRepository,
  type PlatformTenantRow,
} from '@/repositories/platform-tenant.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { platformTenantListSchema } from '@/validators/platform.validators'

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
 * A lowercase marker unique to one test, safe inside a slug, that the test puts in its tenants'
 * names and slugs and searches by.
 */
function marker(): string {
  return `m${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

/**
 * Creates a user, tracked for cleanup, and returns its id.
 */
async function createUser(): Promise<string> {
  const user = await userRepository.create({ email: `platform-repo-${randomUUID()}@example.test` })
  createdUserIds.push(user.id)
  return user.id
}

/**
 * Creates a tenant with this name and slug, owned by a user created for it, tracked for cleanup,
 * and returns its id.
 */
async function createTenant(name: string, slug: string): Promise<string> {
  const tenant = await tenantRepository.create({ name, slug, ownerId: await createUser() })
  createdTenantIds.push(tenant.id)
  return tenant.id
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
 * One page of the staff tenant list for these query params, parsed as the route parses them.
 */
async function listTenants(query: Record<string, string>) {
  const { params, filters } = platformTenantListSchema.parse(query)
  return platformTenantRepository.list(params, filters)
}

/**
 * Reads every page of a search for `search`, `limit` rows at a time, and returns the rows in page
 * order. It stops after 20 pages, so a cursor that never ends fails an assertion instead of
 * hanging the test.
 */
async function listEveryPage(search: string, limit: number): Promise<PlatformTenantRow[]> {
  const rows: PlatformTenantRow[] = []
  let cursor: string | null | undefined
  let pages = 0
  do {
    const page = await listTenants({
      search,
      limit: String(limit),
      ...(typeof cursor === 'string' && { cursor }),
    })
    rows.push(...page.items)
    cursor = page.page.nextCursor
    pages += 1
  } while (typeof cursor === 'string' && pages < 20)
  return rows
}

describe('PlatformTenantRepository.list', () => {
  it('never returns the platform tenant or a soft-deleted tenant', async () => {
    const tag = marker()
    await createTenant(`${tag} live`, `${tag}-live`)
    const deletedId = await createTenant(`${tag} gone`, `${tag}-gone`)
    await tenantRepository.softDelete(deletedId)

    const byTag = await listTenants({ search: tag, limit: '50' })
    const byPlatform = await listEveryPage('platform', 50)

    expect(byTag.items.map((tenant) => tenant.name)).toEqual([`${tag} live`])
    expect(byPlatform.map((tenant) => tenant.slug)).not.toContain('platform')
  })

  it('matches a case-insensitive substring of the name or the slug', async () => {
    const tag = marker()
    await createTenant(`Acme ${tag.toUpperCase()} Corp`, `${tag}-a`)
    await createTenant('Unrelated Name', `x-${tag}-slug`)

    const result = await listTenants({ search: tag.toUpperCase(), limit: '50' })

    const slugs = result.items.map((tenant) => tenant.slug)
    expect(slugs).toHaveLength(2)
    expect(slugs).toEqual(expect.arrayContaining([`${tag}-a`, `x-${tag}-slug`]))
  })

  it.each([
    ['%', '100% off', '100x off'],
    ['_', 'a_b', 'axb'],
    ['\\', String.raw`back\slash`, 'backslash'],
  ])('treats %s in search as a literal character', async (_character, literal, lookalike) => {
    const tag = marker()
    await createTenant(`${tag} ${literal}`, `${tag}-literal`)
    await createTenant(`${tag} ${lookalike}`, `${tag}-lookalike`)

    const result = await listTenants({ search: `${tag} ${literal}`, limit: '50' })

    expect(result.items.map((tenant) => tenant.slug)).toEqual([`${tag}-literal`])
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

    const everything = await listTenants({ search: tag, limit: '50' })
    const paged = await listEveryPage(tag, 1)

    expect(everything.items).toHaveLength(4)
    expect(everything.page.hasNext).toBe(false)
    expect(everything.items[0]?.name).toBe(`${tag} alpha`)
    expect(paged.map((tenant) => tenant.id)).toEqual(everything.items.map((tenant) => tenant.id))
    const tiedIds = everything.items.slice(1).map((tenant) => tenant.id)
    expect(tiedIds).toEqual(await sortedByDatabase(tiedIds))
  })

  it('stops at limit and reports more rows only while some remain', async () => {
    const tag = marker()
    for (let index = 0; index < 3; index += 1)
      await createTenant(`${tag} ${index}`, `${tag}-${index}`)

    const first = await listTenants({ search: tag, limit: '2' })
    const last = await listTenants({
      search: tag,
      limit: '2',
      cursor: required(first.page.nextCursor),
    })

    expect(first.items).toHaveLength(2)
    expect(first.page.hasNext).toBe(true)
    expect(last.items).toHaveLength(1)
    expect(last.page.hasNext).toBe(false)
  })

  it('returns the row shape with a live-member count', async () => {
    const tag = marker()
    const tenantId = await createTenant(`${tag} Counted`, `${tag}-counted`)
    const member = await createUser()
    const deletedMember = await createUser()
    await userMembershipRepository.create({ userId: member, tenantId, role: 'viewer' })
    await userMembershipRepository.create({ userId: deletedMember, tenantId, role: 'viewer' })
    await userRepository.softDelete(deletedMember)

    const { items } = await listTenants({ search: tag, limit: '50' })

    expect(items).toEqual([
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
})

/**
 * The ids in the order Postgres itself sorts them, which is the tiebreak the search uses, so the
 * test does not rely on JavaScript's string order matching it.
 */
async function sortedByDatabase(ids: string[]): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select unnest(${ids}::varchar[]) as id order by 1`
  return rows.map((row) => row.id)
}
