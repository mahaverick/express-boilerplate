// tests/integration/api/platform-access.test.ts
//
// Staff over the real API: what a platform role lets a user read and change
// in a tenant they do not belong to, how membership overrides it, and the
// platform tenant staying closed. Staff are users with a membership in the
// seeded platform tenant.
//
// Staff visits write audit rows, which RESTRICT deleting their user and
// tenant, so afterEach clears audit_logs first.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { PlatformTenantRepository } from '@/repositories/platform-tenant.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A disposable email, unique to one call.
 * @returns The address.
 */
function uniqueEmail(): string {
  return `platform-access-${randomUUID()}@example.test`
}

/**
 * The `data` of an enveloped response.
 * @param body - The response body.
 * @returns Its `data`.
 */
function dataOf<TData>(body: unknown): TData {
  return (body as { data: TData }).data
}

describe('platform access over the API', () => {
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
   * A fresh user with a bearer token, tracked for cleanup.
   * @returns The user and a token.
   */
  async function createAuthenticatedUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  /**
   * A tenant owned by a fresh user, tracked for cleanup.
   * @param fields - Optional name and slug.
   * @param fields.name - The tenant name; defaults to "Acme Inc".
   * @param fields.slug - The slug; defaults to a unique one.
   * @returns The owner, their token and the tenant.
   */
  async function ownedTenant(
    fields: { name?: string; slug?: string } = {}
  ): Promise<{ owner: User; ownerToken: string; tenant: Tenant }> {
    const { user: owner, token: ownerToken } = await createAuthenticatedUser()
    const tenant = await tenantRepository.create({
      name: fields.name ?? 'Acme Inc',
      slug: fields.slug ?? `tenant-${randomUUID()}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    return { owner, ownerToken, tenant }
  }

  /**
   * A fresh staff user with `role`, and a token.
   * @param role - The platform role.
   * @returns The user and a token.
   */
  async function staffUser(role: MembershipRole): Promise<{ user: User; token: string }> {
    const staff = await createAuthenticatedUser()
    await makeStaff(staff.user.id, role)
    return staff
  }

  describe('reads and the role bar', () => {
    it('answers 404 to a user who is neither a member nor staff, on reads and writes alike', async () => {
      const { tenant } = await ownedTenant()
      const { token } = await createAuthenticatedUser()

      const read = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${token}`)
      const write = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Nope' })

      expect(read.status).toBe(404)
      expect(write.status).toBe(404)
      expect(read.body).toMatchObject({ statusCode: 404, message: 'Tenant not found' })
    })

    it.each(['viewer', 'editor', 'manager'] as const)(
      'lets a staff %s read the tenant, its members and settings, but change nothing',
      async (role) => {
        const { tenant } = await ownedTenant()
        const { token } = await staffUser(role)
        const auth = `Bearer ${token}`

        const detail = await request(app)
          .get(`/api/v1/tenants/${tenant.slug}`)
          .set('Authorization', auth)
        const members = await request(app)
          .get(`/api/v1/tenants/${tenant.slug}/members`)
          .set('Authorization', auth)
        const settings = await request(app)
          .get(`/api/v1/tenants/${tenant.slug}/settings`)
          .set('Authorization', auth)
        const rename = await request(app)
          .patch(`/api/v1/tenants/${tenant.slug}`)
          .set('Authorization', auth)
          .send({ name: 'Renamed by staff' })
        const relocale = await request(app)
          .patch(`/api/v1/tenants/${tenant.slug}/settings`)
          .set('Authorization', auth)
          .send({ locale: 'fr' })
        const invitations = await request(app)
          .get(`/api/v1/tenants/${tenant.slug}/invitations`)
          .set('Authorization', auth)

        expect(detail.status).toBe(200)
        expect(dataOf<{ id: string }>(detail.body).id).toBe(tenant.id)
        expect(members.status).toBe(200)
        expect(settings.status).toBe(200)
        expect(rename.status).toBe(403)
        expect(rename.body).toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
        expect(relocale.status).toBe(403)
        expect(invitations.status).toBe(403)
        const [row] = await sql`select name from tenants where id = ${tenant.id}`
        expect(row).toEqual({ name: 'Acme Inc' })
      }
    )

    it('lets a staff admin change the tenant and its settings', async () => {
      const { tenant } = await ownedTenant()
      const { token } = await staffUser('admin')

      const rename = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed by staff' })
      const relocale = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        .send({ locale: 'fr' })

      expect(rename.status).toBe(200)
      expect(relocale.status).toBe(200)
      const [row] = await sql`select name from tenants where id = ${tenant.id}`
      expect(row).toEqual({ name: 'Renamed by staff' })
      const [settingsRow] =
        await sql`select locale from tenant_settings where tenant_id = ${tenant.id}`
      expect(settingsRow).toEqual({ locale: 'fr' })
    })

    it('treats a staff admin who is a viewer member of the tenant as a viewer', async () => {
      const { tenant } = await ownedTenant()
      const { user, token } = await staffUser('admin')
      await userMembershipRepository.create({
        userId: user.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed by staff' })

      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })
  })

  describe('the platform tenant', () => {
    it('answers 404 on /tenants/platform to a user who owns a different tenant', async () => {
      const { ownerToken } = await ownedTenant()
      const platform = await platformTenant()

      const response = await request(app)
        .get(`/api/v1/tenants/${platform.slug}`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ statusCode: 404, message: 'Tenant not found' })
    })

    it('opens /tenants/platform to a platform member', async () => {
      const { token } = await staffUser('viewer')
      const platform = await platformTenant()

      const response = await request(app)
        .get(`/api/v1/tenants/${platform.slug}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(dataOf<{ id: string }>(response.body).id).toBe(platform.id)
    })

    it('never lists the platform tenant in the all-tenants search', async () => {
      const { tenant: lookalike } = await ownedTenant({
        name: 'Platform Partners',
        slug: `platform-${randomUUID()}`,
      })
      const platform = await platformTenant()

      const result = await new PlatformTenantRepository().searchAll({ q: 'platform', limit: 50 })
      const serialised = JSON.stringify(result)

      // The search works (the look-alike is found) and skips the platform tenant.
      expect(serialised).toContain(lookalike.id)
      expect(serialised).not.toContain(platform.id)
    })
  })
})
