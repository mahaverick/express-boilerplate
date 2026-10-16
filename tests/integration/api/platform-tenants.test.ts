/**
 * @file GET /api/v1/platform/tenants: staff search across every customer
 * tenant. Non-staff get the app's own 404, with no rate-limit headers.
 * Names carry a per-test tag, so rows from other files in this worker
 * never match.
 */

import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

/**
 * One tenant row of the staff search.
 */
interface PlatformTenantRowBody {
  id: string
  name: string
  slug: string
  lifecycleState: string
  memberCount: number
  createdAt: string
}

/**
 * One page of the staff tenant search, with its cursors.
 */
interface SearchPage {
  items: PlatformTenantRowBody[]
  page: {
    nextCursor: string | null
    prevCursor: string | null
    hasNext: boolean
    hasPrev: boolean
    limit: number
  }
}

/**
 * The response envelope, narrowed to the fields these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
  errors?: Record<string, string[]>
}

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * The search page in a response, failing the test when there is none.
 */
function pageOf(response: Response): SearchPage {
  const data = (response.body as ApiEnvelope<SearchPage>).data
  if (!data) throw new Error(`no data (status ${response.status})`)
  return data
}

/**
 * A response body without its per-request `requestId`, so two responses can be compared.
 */
function withoutRequestId(body: unknown): Record<string, unknown> {
  const copy = { ...(body as Record<string, unknown>) }
  delete copy.requestId
  return copy
}

/**
 * Runs the staff tenant search as the actor under test, with the filters a test sets.
 */
function search(token: string, query: Record<string, string> = {}): Promise<Response> {
  return request(app)
    .get('/api/v1/platform/tenants')
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

/**
 * A short unique tag for tenant names, so a `q` search finds only this test's rows.
 */
function newTag(): string {
  return `t${randomUUID().slice(0, 8)}`
}

describe('GET /api/v1/platform/tenants', () => {
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
   * A fresh non-staff user with a bearer token, tracked for cleanup.
   */
  async function createUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: `platform-api-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID(), new Date()) }
  }

  /**
   * A token for a fresh staff user holding platform `role`.
   */
  async function createStaff(role: MembershipRole = 'viewer'): Promise<string> {
    const { user, token } = await createUser()
    await makeStaff(user.id, role)
    return token
  }

  /**
   * A tenant called `name`, owned by a fresh user and tracked for cleanup.
   */
  async function createNamedTenant(name: string): Promise<Tenant> {
    const { user } = await createUser()
    const tenant = await tenantRepository.create({
      name,
      slug: `plat-${randomUUID()}`,
      ownerId: user.id,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  /**
   * A live, a suspended and an archived tenant whose names start with `tag`.
   */
  async function seedStates(
    tag: string
  ): Promise<{ live: Tenant; suspended: Tenant; archived: Tenant }> {
    const live = await createNamedTenant(`${tag} Live`)
    const suspended = await createNamedTenant(`${tag} Suspended`)
    const archived = await createNamedTenant(`${tag} Archived`)
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${suspended.id}`
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${archived.id}`
    return { live, suspended, archived }
  }

  /**
   * Five tenants named `tag a` to `tag e`; returns the names in sorted order.
   */
  async function seedFive(tag: string): Promise<string[]> {
    // Created out of order, so the result proves the ordering, not insertion order.
    for (const suffix of ['c', 'a', 'e', 'b', 'd']) {
      await createNamedTenant(`${tag} ${suffix}`)
    }
    return ['a', 'b', 'c', 'd', 'e'].map((suffix) => `${tag} ${suffix}`)
  }

  describe('access', () => {
    it('admits a platform viewer, behind the 60-a-minute limiter', async () => {
      const response = await search(await createStaff('viewer'))

      expect(response.status).toBe(200)
      expect(response.headers['ratelimit-limit']).toBe('60')
    })

    it("answers a non-staff user with the app's own 404 and no rate-limit headers", async () => {
      const { token } = await createUser()

      const refused = await search(token)
      const unknown = await request(app)
        .get('/api/v1/definitely-not-a-route')
        .set('Authorization', `Bearer ${token}`)

      expect(refused.status).toBe(404)
      expect(withoutRequestId(refused.body)).toEqual(withoutRequestId(unknown.body))
      expect(refused.headers).not.toHaveProperty('ratelimit-limit')
    })

    it('answers 404 to a member of a customer tenant who is not staff', async () => {
      const tenant = await createNamedTenant(`${newTag()} Member Co`)
      const { user, token } = await createUser()
      await userMembershipRepository.create({ userId: user.id, tenantId: tenant.id, role: 'owner' })

      const refused = await search(token)

      expect(refused.status).toBe(404)
    })

    it('answers 401 without a token', async () => {
      const response = await request(app).get('/api/v1/platform/tenants')

      expect(response.status).toBe(401)
    })
  })

  describe('what it lists', () => {
    it('never lists the platform tenant', async () => {
      const token = await createStaff()
      const platform = await platformTenant()

      // Every page, so a crowd of other "platform" matches can't hide it.
      const seen: PlatformTenantRowBody[] = []
      let cursor: string | undefined
      do {
        const query: Record<string, string> = { search: platform.slug, limit: '50' }
        if (cursor !== undefined) query.cursor = cursor
        const page = pageOf(await search(token, query))
        seen.push(...page.items)
        cursor = page.page.nextCursor ?? undefined
      } while (cursor !== undefined)

      expect(seen.map((tenant) => tenant.id)).not.toContain(platform.id)
      expect(seen.map((tenant) => tenant.slug)).not.toContain(platform.slug)
    })

    it('leaves out soft-deleted tenants and keeps suspended ones, with their state', async () => {
      const tag = newTag()
      const live = await createNamedTenant(`${tag} Live`)
      const suspended = await createNamedTenant(`${tag} Suspended`)
      const deleted = await createNamedTenant(`${tag} Deleted`)
      await sql`update tenants set lifecycle_state = 'suspended' where id = ${suspended.id}`
      await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${deleted.id}`

      const page = pageOf(await search(await createStaff(), { search: tag }))

      const byId = new Map(page.items.map((tenant) => [tenant.id, tenant.lifecycleState]))
      expect(byId.get(live.id)).toBe('active')
      expect(byId.get(suspended.id)).toBe('suspended')
      expect(byId.has(deleted.id)).toBe(false)
    })

    it('returns the contract fields and counts live members only', async () => {
      const tenant = await createNamedTenant(`${newTag()} Counted`)
      const { user: member } = await createUser()
      const { user: gone } = await createUser()
      await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'viewer',
      })
      await userMembershipRepository.create({
        userId: gone.id,
        tenantId: tenant.id,
        role: 'viewer',
      })
      await sql`update users set deleted_at = now() where id = ${gone.id}`

      const page = pageOf(await search(await createStaff(), { search: tenant.slug }))

      expect(page.items).toEqual([
        {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          lifecycleState: 'active',
          memberCount: 2,
          createdAt: tenant.createdAt.toISOString(),
        },
      ])
    })
  })

  describe('search', () => {
    it('matches name case-insensitively and slug by substring', async () => {
      const tag = newTag()
      const tenant = await createNamedTenant(`${tag} Mixed CASE`)
      const token = await createStaff()

      const byName = pageOf(await search(token, { search: `${tag} mixed case` }))
      const bySlug = pageOf(await search(token, { search: tenant.slug.slice(5, 20) }))

      expect(byName.items.map((row) => row.id)).toEqual([tenant.id])
      expect(bySlug.items.map((row) => row.id)).toContain(tenant.id)
    })

    it('treats % as a literal character', async () => {
      const tag = newTag()
      const percent = await createNamedTenant(`${tag} 100% Co`)
      await createNamedTenant(`${tag} 1000 Co`)

      const page = pageOf(await search(await createStaff(), { search: `${tag} 100%` }))

      expect(page.items.map((row) => row.id)).toEqual([percent.id])
    })

    it('treats _ as a literal character', async () => {
      const tag = newTag()
      const underscore = await createNamedTenant(`${tag}_corp`)
      await createNamedTenant(`${tag}xcorp`)

      const page = pageOf(await search(await createStaff(), { search: `${tag}_corp` }))

      expect(page.items.map((row) => row.id)).toEqual([underscore.id])
    })

    it('treats a backslash as a literal character', async () => {
      const tag = newTag()
      const slashed = await createNamedTenant(String.raw`${tag} a\b`)
      await createNamedTenant(`${tag} ab`)

      const page = pageOf(await search(await createStaff(), { search: String.raw`${tag} a\b` }))

      expect(page.items.map((row) => row.id)).toEqual([slashed.id])
    })

    it('trims search before matching', async () => {
      const tag = newTag()
      const tenant = await createNamedTenant(`${tag} Trimmed`)

      const page = pageOf(await search(await createStaff(), { search: `   ${tag} trimmed  ` }))

      expect(page.items.map((row) => row.id)).toEqual([tenant.id])
    })

    it.each([
      ['whitespace only', ' '.repeat(3)],
      ['longer than 100 characters', 'x'.repeat(101)],
      ['carrying a NUL byte', 'a\0b'],
    ])('answers 400 for a search that is %s', async (_label, q) => {
      const response = await search(await createStaff(), { search: q })

      expect(response.status).toBe(400)
      expect((response.body as ApiEnvelope<unknown>).errors).toHaveProperty('search')
    })
  })

  describe('limit and cursor', () => {
    it.each([['0'], ['101'], ['1.5'], ['abc']])('answers 400 for limit=%s', async (limit) => {
      const response = await search(await createStaff(), { limit })

      expect(response.status).toBe(400)
      expect((response.body as ApiEnvelope<unknown>).errors).toHaveProperty('limit')
    })

    it('defaults to 20 rows, with a cursor for the rest', async () => {
      const tag = newTag()
      for (let index = 0; index < 21; index += 1) {
        await createNamedTenant(`${tag} Many ${String(index).padStart(2, '0')}`)
      }

      const page = pageOf(await search(await createStaff(), { search: tag }))

      expect(page.items).toHaveLength(20)
      expect(page.page.nextCursor).toEqual(expect.any(String))
    })

    it('pages tenants with equal names exactly once each, in the order one page gives', async () => {
      const tag = newTag()
      const created = [
        await createNamedTenant(`${tag} Same`),
        await createNamedTenant(`${tag} Same`),
        await createNamedTenant(`${tag} Same`),
      ]
      const token = await createStaff()

      const onePage = pageOf(await search(token, { search: tag, limit: '3' }))
      const walked: string[] = []
      let cursor: string | null | undefined
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const query: Record<string, string> = { search: tag, limit: '1' }
        if (typeof cursor === 'string') query.cursor = cursor
        const page = pageOf(await search(token, query))
        walked.push(...page.items.map((row) => row.id))
        cursor = page.page.nextCursor
      }

      expect(walked).toEqual(onePage.items.map((row) => row.id))
      expect(new Set(walked)).toEqual(new Set(created.map((tenant) => tenant.id)))
      expect(cursor).toBeNull()
    })

    // A 255-character name is the tenants.name column's limit; emoji are 4 UTF-8 bytes each, and a control character becomes 6 once JSON escapes it as \u00XX.
    it.each([
      ['emoji', '\u{1F600}'],
      ['control characters', '\u{1}'],
      ['CJK', '界'],
    ])('pages past a 255-character name made of %s', async (_label, character) => {
      const tag = newTag()
      const name = `${tag} ${character.repeat(255 - tag.length - 1)}`
      const created = [await createNamedTenant(name), await createNamedTenant(name)]
      const token = await createStaff()

      const first = pageOf(await search(token, { search: tag, limit: '1' }))
      if (first.page.nextCursor === null) throw new Error('expected a second page')
      const second = await search(token, {
        search: tag,
        limit: '1',
        cursor: first.page.nextCursor,
      })

      expect(second.status).toBe(200)
      const walked = [...first.items, ...pageOf(second).items].map((row) => row.id)
      expect(new Set(walked)).toEqual(new Set(created.map((tenant) => tenant.id)))
    })
  })

  describe('state filter', () => {
    it.each([
      [undefined, ['live', 'suspended']],
      ['active', ['live']],
      ['suspended', ['suspended']],
      ['archived', ['archived']],
      ['active,suspended,archived', ['archived', 'live', 'suspended']],
    ] as const)('state=%s lists %j', async (state, expected) => {
      const tag = newTag()
      const seeded = await seedStates(tag)
      const query: Record<string, string> = { search: tag }
      if (state !== undefined) query.state = state

      const page = pageOf(await search(await createStaff(), query))

      const names = Object.fromEntries(Object.entries(seeded).map(([key, t]) => [t.id, key]))
      const found = page.items.map((tenant) => names[tenant.id] ?? 'unexpected')
      expect(found.toSorted((a, b) => a.localeCompare(b))).toEqual([...expected])
    })

    it('rejects an unknown state with 400', async () => {
      const response = await search(await createStaff(), { state: 'deleted' })

      expect(response.status).toBe(400)
    })

    it('never lists the platform tenant under every state', async () => {
      const platform = await platformTenant()

      const page = pageOf(
        await search(await createStaff(), {
          search: platform.slug,
          state: 'active,suspended,archived',
          limit: '50',
        })
      )

      expect(page.items.map((tenant) => tenant.id)).not.toContain(platform.id)
    })
  })

  describe('paging in both directions', () => {
    it('rejects an unknown direction with 400', async () => {
      const response = await search(await createStaff(), { direction: 'up' })

      expect(response.status).toBe(400)
    })

    it('applies the state filter on every page, not only the first', async () => {
      const tag = newTag()
      await seedFive(tag)
      const suspended = await createNamedTenant(`${tag} bb`)
      await sql`update tenants set lifecycle_state = 'suspended' where id = ${suspended.id}`
      const token = await createStaff()

      const first = pageOf(await search(token, { search: tag, limit: '2', state: 'active' }))
      if (first.page.nextCursor === null) throw new Error('expected a second page')
      const second = pageOf(
        await search(token, {
          search: tag,
          limit: '2',
          state: 'active',
          cursor: first.page.nextCursor,
        })
      )

      expect([...first.items, ...second.items].map((t) => t.id)).not.toContain(suspended.id)
    })
  })
})
