/**
 * @file GET /api/v1/platform/users and /platform/users/:id: the staff user
 * directory. Non-staff get the app's own 404 with no rate-limit headers.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

/**
 * One row of the directory listing, as the tests read it.
 */
interface UserRowBody {
  id: string
  email: string
  platformRole: string | null
  membershipCount: number
}

/**
 * One page of the directory listing with its paging cursors.
 */
interface UserPageBody {
  items: UserRowBody[]
  page: {
    nextCursor: string | null
    prevCursor: string | null
    hasNext: boolean
    hasPrev: boolean
    limit: number
  }
}

/**
 * The JSON envelope every API response is wrapped in.
 */
interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
  errors?: Record<string, string[]>
}

const app = createApp()
const tenantRepository = new TenantRepository()
const authProviderRepository = new AuthProviderRepository()
const createdTenantIds: string[] = []

/**
 * The envelope's `data`, failing the test with the status when the response carries none.
 */
function dataOf<TData>(response: Response): TData {
  const data = (response.body as ApiEnvelope<TData>).data
  if (!data) throw new Error(`no data (status ${response.status})`)
  return data
}

/**
 * A staff GET of the directory; `query` carries the filters and cursor.
 */
function list(token: string, query: Record<string, string> = {}): Promise<Response> {
  return request(app)
    .get('/api/v1/platform/users')
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

/**
 * A staff GET of one user's detail, resolving with the raw response so tests
 * can assert the 404s as well as the body.
 */
function detail(token: string, id: string): Promise<Response> {
  return request(app).get(`/api/v1/platform/users/${id}`).set('Authorization', `Bearer ${token}`)
}

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

describe('GET /api/v1/platform/users', () => {
  describe('access', () => {
    it('admits a platform viewer, behind the 60-a-minute limiter', async () => {
      const { token } = await createTrackedStaff('viewer')

      const response = await list(token)

      expect(response.status).toBe(200)
      expect(response.headers['ratelimit-limit']).toBe('60')
    })

    it("answers a non-staff user with the app's own 404 and no rate-limit headers", async () => {
      const outsider = await createTrackedUser()

      const response = await list(tokenFor(outsider))

      expect(response.status).toBe(404)
      expect(response.headers['ratelimit-limit']).toBeUndefined()
    })

    it('answers an anonymous caller 401', async () => {
      const response = await request(app).get('/api/v1/platform/users')

      expect(response.status).toBe(401)
    })
  })

  describe('query validation', () => {
    it('answers 400 for an unknown status and a non-boolean verified', async () => {
      const { token } = await createTrackedStaff('viewer')

      const response = await list(token, { status: 'archived' })
      expect(response.status).toBe(400)
      const response2 = await list(token, { verified: 'yes' })
      expect(response2.status).toBe(400)
    })
  })

  it('never returns a password hash', async () => {
    const { token } = await createTrackedStaff('viewer')
    const tag = `ph${randomUUID().slice(0, 8)}`
    await createTrackedUser({ email: `${tag}@example.test`, hasPassword: true })

    const response = await list(token, { search: tag })

    expect(JSON.stringify(response.body)).not.toContain('passwordHash')
    expect(JSON.stringify(response.body)).not.toContain('$2')
  })
})

describe('GET /api/v1/platform/users/:id', () => {
  it('returns the user with memberships, sign-in methods, password flag and pending invitations', async () => {
    const { token } = await createTrackedStaff('viewer')
    const user = await createTrackedUser({ firstName: 'Ada', hasPassword: true })
    await authProviderRepository.create({
      userId: user.id,
      provider: 'email',
      providerId: user.email.toLowerCase(),
    })
    const tenant = await tenantRepository.create({
      name: 'Analytical Engines',
      slug: `pu-${randomUUID()}`,
      ownerId: user.id,
    })
    createdTenantIds.push(tenant.id)

    const response = await detail(token, user.id)

    expect(response.status).toBe(200)
    expect(dataOf<Record<string, unknown>>(response)).toMatchObject({
      id: user.id,
      email: user.email,
      firstName: 'Ada',
      hasPassword: true,
      authProviders: ['email'],
      // eslint-disable-next-line unicorn/no-null -- JSON null: not staff
      platformRole: null,
      membershipCount: 1,
      memberships: [{ tenantId: tenant.id, tenantName: 'Analytical Engines', role: 'owner' }],
      pendingInvitations: [],
    })
    expect(JSON.stringify(response.body)).not.toContain('passwordHash')
  })

  it('answers 404 for a malformed id and an unknown id', async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await detail(token, 'not-a-uuid')
    expect(response.status).toBe(404)
    const response2 = await detail(token, randomUUID())
    expect(response2.status).toBe(404)
  })

  it('returns a soft-deleted user with deletedAt set, so an owner can purge it', async () => {
    const { token } = await createTrackedStaff('viewer')
    const gone = await createTrackedUser()
    await sql`update users set deleted_at = now() where id = ${gone.id}`
    // A pending invitation to the address, which may belong to someone else.
    const owner = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Invites Co',
      slug: `pu-${randomUUID()}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    await sql`
      insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
      values (${tenant.id}, ${gone.email}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day')`

    const response = await detail(token, gone.id)

    expect(response.status).toBe(200)
    expect(dataOf<{ deletedAt: string | null }>(response).deletedAt).toEqual(expect.any(String))
    expect(dataOf<{ pendingInvitations: unknown[] }>(response).pendingInvitations).toEqual([])
  })

  it('lists soft-deleted users under status=deleted only', async () => {
    const { token } = await createTrackedStaff('viewer')
    const tag = `del${randomUUID().slice(0, 8)}`
    const gone = await createTrackedUser({ email: `${tag}@example.test` })
    await sql`update users set deleted_at = now() where id = ${gone.id}`

    const byDefault = dataOf<UserPageBody>(await list(token, { search: tag }))
    const deleted = dataOf<UserPageBody>(await list(token, { search: tag, status: 'deleted' }))

    expect(byDefault.items).toEqual([])
    expect(deleted.items.map((user) => user.id)).toEqual([gone.id])
  })

  it("answers a non-staff user with the app's own 404", async () => {
    const outsider = await createTrackedUser()

    const response = await detail(tokenFor(outsider), outsider.id)

    expect(response.status).toBe(404)
    expect(response.headers['ratelimit-limit']).toBeUndefined()
  })
})
