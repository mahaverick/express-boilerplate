// tests/integration/api/platform-response-fields.test.ts
//
// The platform fields on existing responses: platformRole on the profile and
// the login user, isPlatform on the tenant list, and role, access and
// isPlatform on the tenant detail.
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
import { hashPassword } from '@/utilities/password.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
}

// The platform-role lookup getPlatformMembership calls.
const PLATFORM_LOOKUP_METHOD = 'findPlatformRole' as const

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

function dataOf<TData>(response: Response): TData {
  const data = (response.body as ApiEnvelope<TData>).data
  if (data === undefined) throw new Error(`no data (status ${response.status})`)
  return data
}

async function join(userId: string, tenant: Tenant, role: MembershipRole): Promise<void> {
  await userMembershipRepository.create({ userId, tenantId: tenant.id, role })
}

function readTenant(slug: string, token: string) {
  return request(app).get(`/api/v1/tenants/${slug}`).set('Authorization', `Bearer ${token}`)
}

describe('platform response fields', () => {
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
    const user = await userRepository.create({ email: `fields-${randomUUID()}@example.test` })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  async function createTenant(): Promise<Tenant> {
    const { user } = await createUser()
    const tenant = await tenantRepository.create({
      name: 'Fields Co',
      slug: `fields-${randomUUID()}`,
      ownerId: user.id,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  describe('GET and PATCH /api/v1/profile', () => {
    it('reports platformRole null for a user who is not staff', async () => {
      const { token } = await createUser()

      const profile = dataOf<{ platformRole: unknown }>(
        await request(app).get('/api/v1/profile').set('Authorization', `Bearer ${token}`)
      )

      expect(profile.platformRole).toBeNull()
    })

    it('reports the platform role on GET and on PATCH', async () => {
      const { user, token } = await createUser()
      await makeStaff(user.id, 'viewer')

      const read = dataOf<{ platformRole: unknown }>(
        await request(app).get('/api/v1/profile').set('Authorization', `Bearer ${token}`)
      )
      const updated = dataOf<{ platformRole: unknown }>(
        await request(app)
          .patch('/api/v1/profile')
          .set('Authorization', `Bearer ${token}`)
          .send({ firstName: 'Ada' })
      )

      expect(read.platformRole).toBe('viewer')
      expect(updated.platformRole).toBe('viewer')
    })
  })

  describe('POST /api/v1/auth/login', () => {
    const PASSWORD = 'correct horse battery staple'

    async function createVerifiedPasswordUser(): Promise<User> {
      const user = await userRepository.create({
        email: `fields-login-${randomUUID()}@example.test`,
        passwordHash: await hashPassword(PASSWORD),
      })
      createdUserIds.push(user.id)
      await sql`update users set email_verified_at = now() where id = ${user.id}`
      return user
    }

    function login(email: string): Promise<Response> {
      return request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })
    }

    it('returns the user with platformRole null for a user who is not staff', async () => {
      const user = await createVerifiedPasswordUser()

      const data = dataOf<{ user: { platformRole: unknown } }>(await login(user.email))

      expect(data.user.platformRole).toBeNull()
    })

    it('returns the platform role on the login user, so staff UI needs no reload', async () => {
      const user = await createVerifiedPasswordUser()
      await makeStaff(user.id, 'admin')

      const data = dataOf<{ user: { platformRole: unknown } }>(await login(user.email))

      expect(data.user.platformRole).toBe('admin')
    })

    it('still signs in, with platformRole null, when the platform read fails', async () => {
      const user = await createVerifiedPasswordUser()
      await makeStaff(user.id, 'admin')

      await withMutatedMethod(
        UserMembershipRepository.prototype,
        PLATFORM_LOOKUP_METHOD,
        () => Promise.reject(new Error('platform read failed')),
        async () => {
          const response = await login(user.email)

          expect(response.status).toBe(200)
          expect(dataOf<{ user: { platformRole: unknown } }>(response).user.platformRole).toBeNull()
        }
      )
    })
  })

  describe('GET /api/v1/tenants', () => {
    it('marks each row with isPlatform, true only for the platform tenant', async () => {
      const { user, token } = await createUser()
      const tenant = await createTenant()
      await join(user.id, tenant, 'editor')
      await makeStaff(user.id, 'viewer')
      const platform = await platformTenant()

      const rows = dataOf<Array<{ tenant: { id: string }; role: string; isPlatform: boolean }>>(
        await request(app).get('/api/v1/tenants').set('Authorization', `Bearer ${token}`)
      )

      const byId = new Map(rows.map((row) => [row.tenant.id, row]))
      expect(byId.get(tenant.id)).toMatchObject({ role: 'editor', isPlatform: false })
      expect(byId.get(platform.id)).toMatchObject({ role: 'viewer', isPlatform: true })
    })
  })

  describe('GET /api/v1/tenants/:slug', () => {
    it('reports a member with their membership role and access member', async () => {
      const { user, token } = await createUser()
      const tenant = await createTenant()
      await join(user.id, tenant, 'editor')

      const detail = dataOf<Record<string, unknown>>(await readTenant(tenant.slug, token))

      expect(detail).toMatchObject({
        id: tenant.id,
        slug: tenant.slug,
        role: 'editor',
        access: 'member',
        isPlatform: false,
      })
    })

    it('reports a non-member staff admin with their platform role and access platform', async () => {
      const { user, token } = await createUser()
      await makeStaff(user.id, 'admin')
      const tenant = await createTenant()

      const detail = dataOf<Record<string, unknown>>(await readTenant(tenant.slug, token))

      expect(detail).toMatchObject({ role: 'admin', access: 'platform', isPlatform: false })
    })

    it('reports a staff user who is a viewer member as a viewer: membership wins', async () => {
      const { user, token } = await createUser()
      await makeStaff(user.id, 'owner')
      const tenant = await createTenant()
      await join(user.id, tenant, 'viewer')

      const detail = dataOf<Record<string, unknown>>(await readTenant(tenant.slug, token))

      expect(detail).toMatchObject({ role: 'viewer', access: 'member' })
    })

    it('reports isPlatform true on the platform tenant to its members', async () => {
      const { user, token } = await createUser()
      await makeStaff(user.id, 'viewer')

      const detail = dataOf<Record<string, unknown>>(await readTenant('platform', token))

      expect(detail).toMatchObject({ isPlatform: true, access: 'member', role: 'viewer' })
    })
  })
})
