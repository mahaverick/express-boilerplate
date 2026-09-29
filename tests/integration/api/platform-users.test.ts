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

interface UserRowBody {
  id: string
  email: string
  platformRole: string | null
  membershipCount: number
}

interface UserPageBody {
  users: UserRowBody[]
  nextCursor: string | null
  prevCursor: string | null
}

interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
  errors?: Record<string, string[]>
}

const app = createApp()
const tenantRepository = new TenantRepository()
const authProviderRepository = new AuthProviderRepository()
const createdTenantIds: string[] = []

function dataOf<TData>(response: Response): TData {
  const data = (response.body as ApiEnvelope<TData>).data
  if (!data) throw new Error(`no data (status ${response.status})`)
  return data
}

function list(token: string, query: Record<string, string> = {}): Promise<Response> {
  return request(app)
    .get('/api/v1/platform/users')
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

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

  describe('paging', () => {
    it('answers prevCursor null on the first page and walks forward and back by cursor', async () => {
      const { token } = await createTrackedStaff('viewer')
      const tag = `api${randomUUID().slice(0, 8)}`
      for (const letter of ['c', 'a', 'b']) {
        await createTrackedUser({ email: `${tag}-${letter}@example.test` })
      }

      const first = dataOf<UserPageBody>(await list(token, { q: tag, limit: '2' }))
      expect(first.users.map((user) => user.email)).toEqual([
        `${tag}-a@example.test`,
        `${tag}-b@example.test`,
      ])
      expect(first.prevCursor).toBeNull()
      expect(first.nextCursor).toEqual(expect.any(String))

      const second = dataOf<UserPageBody>(
        await list(token, { q: tag, limit: '2', cursor: first.nextCursor as string })
      )
      expect(second.users.map((user) => user.email)).toEqual([`${tag}-c@example.test`])
      expect(second.nextCursor).toBeNull()

      const back = dataOf<UserPageBody>(
        await list(token, {
          q: tag,
          limit: '2',
          direction: 'prev',
          cursor: second.prevCursor as string,
        })
      )
      expect(back.users.map((user) => user.email)).toEqual([
        `${tag}-a@example.test`,
        `${tag}-b@example.test`,
      ])
      expect(back.prevCursor).toBeNull()
    })

    it('answers 400 for direction=prev without a cursor, and for a forged cursor', async () => {
      const { token } = await createTrackedStaff('viewer')

      const noCursor = await list(token, { direction: 'prev' })
      expect(noCursor.status).toBe(400)
      expect((noCursor.body as ApiEnvelope<unknown>).errors?.cursor).toEqual([
        'cursor is required when direction is prev.',
      ])

      const forged = await list(token, { cursor: 'not-a-cursor' })
      expect(forged.status).toBe(400)
    })

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

    const response = await list(token, { q: tag })

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

    const response = await detail(token, gone.id)

    expect(response.status).toBe(200)
    expect(dataOf<{ deletedAt: string | null }>(response).deletedAt).toEqual(expect.any(String))
  })

  it('lists soft-deleted users under status=deleted only', async () => {
    const { token } = await createTrackedStaff('viewer')
    const tag = `del${randomUUID().slice(0, 8)}`
    const gone = await createTrackedUser({ email: `${tag}@example.test` })
    await sql`update users set deleted_at = now() where id = ${gone.id}`

    const byDefault = dataOf<UserPageBody>(await list(token, { q: tag }))
    const deleted = dataOf<UserPageBody>(await list(token, { q: tag, status: 'deleted' }))

    expect(byDefault.users).toEqual([])
    expect(deleted.users.map((user) => user.id)).toEqual([gone.id])
  })

  it("answers a non-staff user with the app's own 404", async () => {
    const outsider = await createTrackedUser()

    const response = await detail(tokenFor(outsider), outsider.id)

    expect(response.status).toBe(404)
    expect(response.headers['ratelimit-limit']).toBeUndefined()
  })
})
