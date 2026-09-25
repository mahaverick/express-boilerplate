// tests/integration/api/platform-tenants.test.ts
//
// GET /api/v1/platform/tenants: staff search across every customer tenant.
// Non-staff get the app's own 404, with no rate-limit headers. Names carry a
// per-test tag, so rows from other files in this worker never match.
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

interface PlatformTenantRowBody {
  id: string
  name: string
  slug: string
  lifecycleState: string
  memberCount: number
  createdAt: string
}

interface SearchPage {
  tenants: PlatformTenantRowBody[]
  nextCursor: string | null
}

interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
  errors?: Record<string, string[]>
}

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

function pageOf(response: Response): SearchPage {
  const data = (response.body as ApiEnvelope<SearchPage>).data
  if (!data) throw new Error(`no data (status ${response.status})`)
  return data
}

function withoutRequestId(body: unknown): Record<string, unknown> {
  const copy = { ...(body as Record<string, unknown>) }
  delete copy.requestId
  return copy
}

function search(token: string, query: Record<string, string> = {}): Promise<Response> {
  return request(app)
    .get('/api/v1/platform/tenants')
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

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

  async function createUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: `platform-api-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  async function createStaff(role: MembershipRole = 'viewer'): Promise<string> {
    const { user, token } = await createUser()
    await makeStaff(user.id, role)
    return token
  }

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

  describe('access', () => {
    // First, so that before the route exists the first red line is this 404-for-200.
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

      const page = pageOf(await search(token, { q: 'platform', limit: '50' }))

      expect(page.tenants.map((tenant) => tenant.id)).not.toContain(platform.id)
      expect(page.tenants.map((tenant) => tenant.slug)).not.toContain('platform')
    })

    it('leaves out soft-deleted tenants and keeps suspended ones, with their state', async () => {
      const tag = newTag()
      const live = await createNamedTenant(`${tag} Live`)
      const suspended = await createNamedTenant(`${tag} Suspended`)
      const deleted = await createNamedTenant(`${tag} Deleted`)
      await sql`update tenants set lifecycle_state = 'suspended' where id = ${suspended.id}`
      await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${deleted.id}`

      const page = pageOf(await search(await createStaff(), { q: tag }))

      const byId = new Map(page.tenants.map((tenant) => [tenant.id, tenant.lifecycleState]))
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

      const page = pageOf(await search(await createStaff(), { q: tenant.slug }))

      expect(page.tenants).toEqual([
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

  describe('q', () => {
    it('matches name case-insensitively and slug by substring', async () => {
      const tag = newTag()
      const tenant = await createNamedTenant(`${tag} Mixed CASE`)
      const token = await createStaff()

      const byName = pageOf(await search(token, { q: `${tag} mixed case` }))
      const bySlug = pageOf(await search(token, { q: tenant.slug.slice(5, 20) }))

      expect(byName.tenants.map((row) => row.id)).toEqual([tenant.id])
      expect(bySlug.tenants.map((row) => row.id)).toContain(tenant.id)
    })

    it('treats % as a literal character', async () => {
      const tag = newTag()
      const percent = await createNamedTenant(`${tag} 100% Co`)
      await createNamedTenant(`${tag} 1000 Co`)

      const page = pageOf(await search(await createStaff(), { q: `${tag} 100%` }))

      expect(page.tenants.map((row) => row.id)).toEqual([percent.id])
    })

    it('treats _ as a literal character', async () => {
      const tag = newTag()
      const underscore = await createNamedTenant(`${tag}_corp`)
      await createNamedTenant(`${tag}xcorp`)

      const page = pageOf(await search(await createStaff(), { q: `${tag}_corp` }))

      expect(page.tenants.map((row) => row.id)).toEqual([underscore.id])
    })

    it('treats a backslash as a literal character', async () => {
      const tag = newTag()
      const slashed = await createNamedTenant(String.raw`${tag} a\b`)
      await createNamedTenant(`${tag} ab`)

      const page = pageOf(await search(await createStaff(), { q: String.raw`${tag} a\b` }))

      expect(page.tenants.map((row) => row.id)).toEqual([slashed.id])
    })

    it('trims q before matching', async () => {
      const tag = newTag()
      const tenant = await createNamedTenant(`${tag} Trimmed`)

      const page = pageOf(await search(await createStaff(), { q: `   ${tag} trimmed  ` }))

      expect(page.tenants.map((row) => row.id)).toEqual([tenant.id])
    })

    it.each([
      ['whitespace only', ' '.repeat(3)],
      ['longer than 100 characters', 'x'.repeat(101)],
    ])('answers 400 for a q that is %s', async (_label, q) => {
      const response = await search(await createStaff(), { q })

      expect(response.status).toBe(400)
      expect((response.body as ApiEnvelope<unknown>).errors).toHaveProperty('q')
    })
  })

  describe('limit and cursor', () => {
    it.each([['0'], ['51'], ['1.5'], ['abc']])('answers 400 for limit=%s', async (limit) => {
      const response = await search(await createStaff(), { limit })

      expect(response.status).toBe(400)
      expect((response.body as ApiEnvelope<unknown>).errors).toHaveProperty('limit')
    })

    it('defaults to 20 rows, with a cursor for the rest', async () => {
      const tag = newTag()
      for (let index = 0; index < 21; index += 1) {
        await createNamedTenant(`${tag} Many ${String(index).padStart(2, '0')}`)
      }

      const page = pageOf(await search(await createStaff(), { q: tag }))

      expect(page.tenants).toHaveLength(20)
      expect(page.nextCursor).toEqual(expect.any(String))
    })

    it('pages tenants with equal names exactly once each, in the order one page gives', async () => {
      const tag = newTag()
      const created = [
        await createNamedTenant(`${tag} Same`),
        await createNamedTenant(`${tag} Same`),
        await createNamedTenant(`${tag} Same`),
      ]
      const token = await createStaff()

      const onePage = pageOf(await search(token, { q: tag, limit: '3' }))
      const walked: string[] = []
      let cursor: string | null | undefined
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const query: Record<string, string> = { q: tag, limit: '1' }
        if (typeof cursor === 'string') query.cursor = cursor
        const page = pageOf(await search(token, query))
        walked.push(...page.tenants.map((row) => row.id))
        cursor = page.nextCursor
      }

      expect(walked).toEqual(onePage.tenants.map((row) => row.id))
      expect(new Set(walked)).toEqual(new Set(created.map((tenant) => tenant.id)))
      expect(cursor).toBeNull()
    })

    it.each([
      ['not base64 JSON', '!!!'],
      ['the wrong shape', Buffer.from('{"sortName":1,"id":"x"}').toString('base64url')],
    ])('answers 400 for a cursor that is %s', async (_label, cursorValue) => {
      const response = await search(await createStaff(), { cursor: cursorValue })

      expect(response.status).toBe(400)
      expect((response.body as ApiEnvelope<unknown>).errors).toHaveProperty('cursor')
    })
  })
})
