/**
 * @file `/api/v1/tenants` against the real per-worker Postgres database
 * (tests/helpers/worker-database.ts). Requests sign a token with
 * `signAccessToken` instead of logging in, and most fixtures (tenants,
 * memberships) are built through the repositories instead of `POST /tenants`:
 * these tests cover what a caller with a given role can do once a member, and
 * tenant creation has its own `describe` block below. Members join only by
 * invitation; tests/integration/api/invitation.test.ts covers those endpoints.
 */

import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { NOT_FOUND } from '@/errors/not-found-errors'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { TenantRepository, type CreateTenantInput } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import type { DbExecutor } from '@/services/database.service'
import { sql } from '@/services/database.service'
import { hashToken, signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'
import { settle } from '../../helpers/timing'

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * One row of `GET /tenants/:slug/members`, as these tests read it.
 */
interface MemberRow {
  membership: { role: MembershipRole }
  user: Record<string, unknown>
}

/**
 * The envelope `response.utilities.ts` wraps every controller response in,
 * narrowed to the fields these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  message: string
  code?: string
  data?: TData
  errors?: Record<string, string[]>
}

/**
 * Casts a response body, which supertest types as `any`, to the envelope, so
 * every later property access is type-checked.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * Asserts the member routes' unknown-member answer: 404 with the message and
 * the `member_not_found` code a client branches on.
 */
function expectMemberNotFound(response: Response): void {
  expect(response.status).toBe(404)
  expect(envelopeOf(response)).toMatchObject({
    message: NOT_FOUND.member.message,
    code: 'member_not_found',
  })
}

/**
 * Asserts the unknown-tenant answer a caller without access gets: 404
 * `tenant_not_found`, never `member_not_found`, so a client never reads it
 * as a vanished member.
 */
function expectTenantNotFound(response: Response): void {
  expect(response.status).toBe(404)
  expect(envelopeOf(response)).toMatchObject({
    message: NOT_FOUND.tenant.message,
    code: 'tenant_not_found',
  })
}

/**
 * A disposable email unique to this call, so it cannot collide with rows other
 * tests in this worker's database hold.
 */
function uniqueEmail(): string {
  return `tenant-api-${randomUUID()}@example.test`
}

/**
 * A throwaway tenant slug unique to this call.
 */
function uniqueSlug(): string {
  return `tenant-${randomUUID()}`
}

/**
 * Adds an existing user to a tenant with the given role, bypassing the API.
 */
async function addMembership(
  userId: string,
  tenantId: string,
  role: MembershipRole
): Promise<void> {
  await userMembershipRepository.create({ userId, tenantId, role })
}

/**
 * `DELETE /tenants/:slug/membership` as the bearer of `token`, or with no
 * Authorization header when `token` is omitted.
 */
async function leave(slug: string, token?: string): Promise<Response> {
  const pending = request(app).delete(`/api/v1/tenants/${slug}/membership`)
  if (token !== undefined) pending.set('Authorization', `Bearer ${token}`)
  return pending.send({})
}

/**
 * A pending invitation sent by `inviterId`, written straight to the table; returns its id.
 */
async function pendingFrom(tenantId: string, inviterId: string): Promise<string> {
  const invitation = await new TenantInvitationRepository().createPending({
    tenantId,
    email: uniqueEmail(),
    role: 'viewer',
    tokenHash: hashToken(randomUUID()),
    invitedBy: inviterId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return invitation.id
}

/**
 * An object nested `levels` deep: `{ a: { a: … {} } }`, for the metadata depth cap.
 */
function nested(levels: number): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let cursor = root
  for (let depth = 1; depth < levels; depth += 1) {
    const next: Record<string, unknown> = {}
    cursor.a = next
    cursor = next
  }
  return root
}

describe('/api/v1/tenants', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    // Tenants first: tenant_settings.tenant_id and user_memberships.tenant_id cascade, so deleting the tenant takes its settings and membership rows with it.
    if (createdTenantIds.length > 0) {
      await sql`delete from tenants where id = any(${createdTenantIds})`
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) {
      return
    }

    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user with a valid bearer token, tracked for cleanup.
   */
  async function createAuthenticatedUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  /**
   * A fresh tenant via `TenantRepository.create`, tracked for cleanup.
   */
  async function createTenant(
    ownerId: string,
    overrides: Partial<CreateTenantInput> = {}
  ): Promise<Tenant> {
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: uniqueSlug(),
      ownerId,
      ...overrides,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  /**
   * PATCHes the settings of a fresh tenant as its owner and returns the response status.
   */
  async function patchSettings(body: unknown): Promise<number> {
    const { user, token } = await createAuthenticatedUser()
    const tenant = await createTenant(user.id)
    const response = await request(app)
      .patch(`/api/v1/tenants/${tenant.slug}/settings`)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object)
    return response.status
  }

  describe('POST /api/v1/tenants', () => {
    it('creates a tenant and makes the caller its owner', async () => {
      const { user, token } = await createAuthenticatedUser()
      const slug = uniqueSlug()

      const response = await request(app)
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Acme Inc', slug, description: 'A test tenant' })

      expect(response.status).toBe(201)
      const tenant = envelopeOf<Tenant>(response).data
      expect(tenant).toMatchObject({ name: 'Acme Inc', slug, description: 'A test tenant' })
      if (tenant) createdTenantIds.push(tenant.id)

      const membership = await userMembershipRepository.findByUserAndTenant(
        user.id,
        tenant?.id ?? ''
      )
      expect(membership?.role).toBe('owner')
    })

    it('rejects a request with no token', async () => {
      const response = await request(app)
        .post('/api/v1/tenants')
        .send({ name: 'Acme Inc', slug: uniqueSlug() })

      expect(response.status).toBe(401)
    })

    it.each([
      ['too short', 'ab'],
      ['uppercase', 'MyOrg123'],
      ['leading hyphen', '-myorg'],
      ['trailing hyphen', 'myorg-'],
      ['spaces', 'my org'],
    ])('rejects an invalid slug shape (%s)', async (_label, slug) => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Acme Inc', slug })

      expect(response.status).toBe(400)
    })

    it('rejects a reserved slug', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Acme Inc', slug: 'admin' })

      expect(response.status).toBe(400)
    })

    it('rejects a duplicate slug with 409', async () => {
      const { user: firstOwner } = await createAuthenticatedUser()
      const { token: secondToken } = await createAuthenticatedUser()
      const slug = uniqueSlug()
      await createTenant(firstOwner.id, { slug })

      const response = await request(app)
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${secondToken}`)
        .send({ name: 'Someone Else Inc', slug })

      expect(response.status).toBe(409)
    })

    /**
     * Wiring, not thresholds: the 429 behaviour, including the user-keyed
     * discriminator, is proven with small overrides in
     * tests/unit/middlewares/rate-limit.middleware.test.ts, so this does not
     * exhaust the real 20-per-hour `RATE_LIMITS.createTenant` budget.
     */
    it('runs a limiter — proven by the RateLimit-* headers on an ordinary response', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'A', slug: 'ab' }) // fails slug validation, never creates a row

      expect(response.status).toBe(400)
      expect(response.headers).toHaveProperty('ratelimit-limit')
      expect(response.headers).not.toHaveProperty('x-ratelimit-limit')
    })
  })

  describe('GET /api/v1/tenants', () => {
    it("lists the caller's tenants with their role in each", async () => {
      const { user, token } = await createAuthenticatedUser()
      const owned = await createTenant(user.id)
      const { user: otherOwner } = await createAuthenticatedUser()
      const joined = await createTenant(otherOwner.id)
      await addMembership(user.id, joined.id, 'viewer')

      const response = await request(app)
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      const tenants =
        envelopeOf<{ items: Array<{ tenant: Tenant; role: MembershipRole }> }>(response).data
          ?.items ?? []
      expect(tenants).toHaveLength(2)
      const byTenantId = new Map(tenants.map((entry) => [entry.tenant.id, entry.role]))
      expect(byTenantId.get(owned.id)).toBe('owner')
      expect(byTenantId.get(joined.id)).toBe('viewer')
    })

    it('returns an empty page for a user with no memberships', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<{ items: unknown[] }>(response).data?.items).toEqual([])
    })

    it('rejects a request with no token', async () => {
      const response = await request(app).get('/api/v1/tenants')
      expect(response.status).toBe(401)
    })
  })

  describe('GET /api/v1/tenants/:slug', () => {
    it('returns tenant details for a member', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<Tenant>(response).data).toMatchObject({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      })
    })

    it('404s for a non-member (Ruling G, not 403)', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { token: outsiderToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${outsiderToken}`)

      expect(response.status).toBe(404)
    })

    it('404s for a nonexistent slug', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .get(`/api/v1/tenants/${uniqueSlug()}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(404)
    })

    // resolveTenant loads the tenant with findActiveBySlug and the handler with findById, so mutating findById alone cannot fail resolveTenant first.
    it('404s when the tenant is deleted between resolveTenant loading it and the handler loading it again', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)

      await withMutatedMethod(
        TenantRepository.prototype,
        'findById',
        () => Promise.resolve(undefined),
        async () => {
          const response = await request(app)
            .get(`/api/v1/tenants/${tenant.slug}`)
            .set('Authorization', `Bearer ${token}`)

          expect(response.status).toBe(404)
        }
      )
    })
  })

  describe('PATCH /api/v1/tenants/:slug', () => {
    it('lets an owner update name/description/logo/website', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Renamed Inc',
          description: 'A brand new description',
          logo: 'https://example.test/new-logo.png',
          website: 'https://example.test',
        })

      expect(response.status).toBe(200)
      expect(envelopeOf<Tenant>(response).data).toMatchObject({
        name: 'Renamed Inc',
        description: 'A brand new description',
        logo: 'https://example.test/new-logo.png',
        website: 'https://example.test',
      })
    })

    it('lets an admin update the tenant', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { user: adminUser, token: adminToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(adminUser.id, tenant.id, 'admin')

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Renamed By Admin' })

      expect(response.status).toBe(200)
    })

    it('treats an explicit null as clearing a nullable field', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id, { description: 'Will be cleared' })

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${token}`)
        // eslint-disable-next-line unicorn/no-null -- exercising the explicit-null-clears-the-field contract itself
        .send({ description: null })

      expect(response.status).toBe(200)
      expect(envelopeOf<Tenant>(response).data?.description).toBeNull()
    })

    it.each<MembershipRole>(['manager', 'editor', 'viewer'])(
      'rejects a %s with 403',
      async (role) => {
        const { user: ownerUser } = await createAuthenticatedUser()
        const { user: memberUser, token: memberToken } = await createAuthenticatedUser()
        const tenant = await createTenant(ownerUser.id)
        await addMembership(memberUser.id, tenant.id, role)

        const response = await request(app)
          .patch(`/api/v1/tenants/${tenant.slug}`)
          .set('Authorization', `Bearer ${memberToken}`)
          .send({ name: 'Should not apply' })

        expect(response.status).toBe(403)
      }
    )

    it('404s for a non-member', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { token: outsiderToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ name: 'Nope' })

      expect(response.status).toBe(404)
    })

    // Mass assignment: slug is not one of updateTenantSchema's fields, so it is stripped; the row is read back with raw SQL, independent of the repository under test.
    it('ignores slug even when supplied, and the stored row proves it', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      const attemptedSlug = uniqueSlug()

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed', slug: attemptedSlug })

      expect(response.status).toBe(200)
      expect(envelopeOf<Tenant>(response).data?.slug).toBe(tenant.slug)

      const [row] = await sql`select slug from tenants where id = ${tenant.id}`
      expect(row).toEqual({ slug: tenant.slug })
    })

    // The write path of the race above: updateTenant calls tenantRepository.update only when the body changes a field, and the new name does.
    it('404s when the tenant is deleted between resolveTenant loading it and the update itself', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)

      await withMutatedMethod(
        TenantRepository.prototype,
        'update',
        () => Promise.resolve(undefined),
        async () => {
          const response = await request(app)
            .patch(`/api/v1/tenants/${tenant.slug}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'Renamed' })

          expect(response.status).toBe(404)
        }
      )
    })
  })

  describe('GET /api/v1/tenants/:slug/members', () => {
    it('lists members for any role, never leaking a private column', async () => {
      const { user, token } = await createAuthenticatedUser()
      const { user: viewerUser } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      await addMembership(viewerUser.id, tenant.id, 'viewer')

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/members`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      const members = envelopeOf<{ items: unknown[] }>(response).data?.items
      expect(members).toHaveLength(2)
      expect(JSON.stringify(response.body)).not.toMatch(/emailVerifiedAt|lastLoggedInAt/)
    })

    it('omits active on a customer tenant, even for a deactivated member', async () => {
      const { user: ownerUser, token } = await createAuthenticatedUser()
      const { user: deactivatedUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(deactivatedUser.id, tenant.id, 'owner')
      await userRepository.update(deactivatedUser.id, { active: false })

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/members`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      const members = envelopeOf<{ items: MemberRow[] }>(response).data?.items ?? []
      const activeRow = members.find((member) => member.user.id === ownerUser.id)
      const inactiveRow = members.find((member) => member.user.id === deactivatedUser.id)
      expect(activeRow?.user).toStrictEqual({
        id: ownerUser.id,
        email: ownerUser.email,
        firstName: ownerUser.firstName,
        lastName: ownerUser.lastName,
      })
      expect(inactiveRow?.membership.role).toBe('owner')
      expect(inactiveRow?.user).toStrictEqual({
        id: deactivatedUser.id,
        email: deactivatedUser.email,
        firstName: deactivatedUser.firstName,
        lastName: deactivatedUser.lastName,
      })

      // Staff reading through platform access get the customer shape too: the tenant decides the shape, not the caller.
      const { user: staffUser, token: staffToken } = await createAuthenticatedUser()
      await makeStaff(staffUser.id, 'viewer')
      const staffResponse = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/members`)
        .set('Authorization', `Bearer ${staffToken}`)
      expect(staffResponse.status).toBe(200)
      const staffRows = envelopeOf<{ items: MemberRow[] }>(staffResponse).data?.items ?? []
      expect(staffRows).toHaveLength(2)
      for (const member of staffRows) {
        const memberRow = members.find((row) => row.user.id === member.user.id)
        expect(member.user).toStrictEqual(memberRow?.user)
      }
    })

    it('says whether each member is active on the platform tenant, the flag its last-owner rule reads', async () => {
      const { user: staffUser, token } = await createAuthenticatedUser()
      const { user: deactivatedStaff } = await createAuthenticatedUser()
      await makeStaff(staffUser.id, 'viewer')
      await makeStaff(deactivatedStaff.id, 'owner')
      await userRepository.update(deactivatedStaff.id, { active: false })
      const platform = await platformTenant()

      const response = await request(app)
        .get(`/api/v1/tenants/${platform.slug}/members`)
        .query({ limit: '100' })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      const members = envelopeOf<{ items: MemberRow[] }>(response).data?.items ?? []
      const activeRow = members.find((member) => member.user.id === staffUser.id)
      const inactiveRow = members.find((member) => member.user.id === deactivatedStaff.id)
      expect(activeRow?.user).toStrictEqual({
        id: staffUser.id,
        email: staffUser.email,
        firstName: staffUser.firstName,
        lastName: staffUser.lastName,
        active: true,
      })
      expect(inactiveRow?.membership.role).toBe('owner')
      expect(inactiveRow?.user.active).toBe(false)
    })

    it('404s for a non-member', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { token: outsiderToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/members`)
        .set('Authorization', `Bearer ${outsiderToken}`)

      expect(response.status).toBe(404)
    })
  })

  describe('POST /api/v1/tenants/:slug/members (removed)', () => {
    it('is gone: an owner gets 404 and nobody is added', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: targetUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .post(`/api/v1/tenants/${tenant.slug}/members`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: targetUser.email, role: 'editor' })

      expect(response.status).toBe(404)
      const membership = await userMembershipRepository.findByUserAndTenant(
        targetUser.id,
        tenant.id
      )
      expect(membership).toBeUndefined()
    })
  })

  describe('PATCH /api/v1/tenants/:slug/members/:userId (role matrix)', () => {
    it.each<MembershipRole>(['admin', 'manager', 'editor', 'viewer'])(
      'blocks a %s actor with 403 (router-level requireRole(owner) only)',
      async (actorRole) => {
        const { user: ownerUser } = await createAuthenticatedUser()
        const { user: actorUser, token: actorToken } = await createAuthenticatedUser()
        const { user: targetUser } = await createAuthenticatedUser()
        const tenant = await createTenant(ownerUser.id)
        await addMembership(actorUser.id, tenant.id, actorRole)
        await addMembership(targetUser.id, tenant.id, 'viewer')

        const response = await request(app)
          .patch(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
          .set('Authorization', `Bearer ${actorToken}`)
          .send({ role: 'editor' })

        expect(response.status).toBe(403)
      }
    )

    it.each<MembershipRole>(['admin', 'manager', 'editor', 'viewer'])(
      'lets an owner change a %s member to any non-owner role',
      async (targetRole) => {
        const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
        const { user: targetUser } = await createAuthenticatedUser()
        const tenant = await createTenant(ownerUser.id)
        await addMembership(targetUser.id, tenant.id, targetRole)

        const response = await request(app)
          .patch(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ role: 'manager' })

        expect(response.status).toBe(200)
        expect(envelopeOf<{ role: MembershipRole }>(response).data?.role).toBe('manager')
      }
    )

    it('blocks an owner from changing ANOTHER owner (not self)', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: otherOwnerUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(otherOwnerUser.id, tenant.id, 'owner')

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${otherOwnerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' })

      expect(response.status).toBe(403)
    })

    it('lets an owner promote an existing member to owner (ownership transfer)', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: adminUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(adminUser.id, tenant.id, 'admin')

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${adminUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'owner' })

      expect(response.status).toBe(200)
      expect(envelopeOf<{ role: MembershipRole }>(response).data?.role).toBe('owner')
    })

    it('lets the sole owner re-submit role owner on themselves (no-op), even though they are the last owner', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'owner' })

      expect(response.status).toBe(200)
    })

    it('blocks the sole owner from demoting themselves (last-owner guard)', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' })

      expect(response.status).toBe(409)
      const membership = await userMembershipRepository.findByUserAndTenant(ownerUser.id, tenant.id)
      expect(membership?.role).toBe('owner')
    })

    it('lets an owner demote themselves when another owner exists', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: secondOwnerUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(secondOwnerUser.id, tenant.id, 'owner')

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' })

      expect(response.status).toBe(200)
      expect(envelopeOf<{ role: MembershipRole }>(response).data?.role).toBe('admin')
    })

    it('404s for a target user who is not a member of this tenant', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: outsiderUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${outsiderUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' })

      expectMemberNotFound(response)
    })

    it('404s for a non-member actor', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { token: outsiderToken } = await createAuthenticatedUser()
      const { user: targetUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(targetUser.id, tenant.id, 'viewer')

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ role: 'admin' })

      expectTenantNotFound(response)
    })

    // Not the never-a-member 404: the permission and last-owner checks pass, and the row vanishes only before updateRole's own write.
    it('404s when the membership is deleted between the permission check and the role update itself', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: targetUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(targetUser.id, tenant.id, 'viewer')

      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'updateRole',
        () => Promise.resolve(undefined),
        async () => {
          const response = await request(app)
            .patch(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ role: 'manager' })

          expectMemberNotFound(response)
        }
      )
    })
  })

  describe('DELETE /api/v1/tenants/:slug/members/:userId (role matrix)', () => {
    it.each<MembershipRole>(['manager', 'editor', 'viewer'])(
      'blocks a %s actor with 403 (router-level requireRole(owner, admin) only)',
      async (actorRole) => {
        const { user: ownerUser } = await createAuthenticatedUser()
        const { user: actorUser, token: actorToken } = await createAuthenticatedUser()
        const { user: targetUser } = await createAuthenticatedUser()
        const tenant = await createTenant(ownerUser.id)
        await addMembership(actorUser.id, tenant.id, actorRole)
        await addMembership(targetUser.id, tenant.id, 'viewer')

        const response = await request(app)
          .delete(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
          .set('Authorization', `Bearer ${actorToken}`)

        expect(response.status).toBe(403)
      }
    )

    it.each<MembershipRole>(['admin', 'manager', 'editor', 'viewer'])(
      'lets an owner remove a %s member',
      async (targetRole) => {
        const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
        const { user: targetUser } = await createAuthenticatedUser()
        const tenant = await createTenant(ownerUser.id)
        await addMembership(targetUser.id, tenant.id, targetRole)

        const response = await request(app)
          .delete(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
          .set('Authorization', `Bearer ${ownerToken}`)

        expect(response.status).toBe(200)
        const membership = await userMembershipRepository.findByUserAndTenant(
          targetUser.id,
          tenant.id
        )
        expect(membership).toBeUndefined()
      }
    )

    it('answers the no-content envelope, with data: null', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: targetUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(targetUser.id, tenant.id, 'viewer')

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(response.body).toEqual({
        success: true,
        message: 'Member removed.',
        statusCode: 200,
        // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
        data: null,
      })
    })

    it('blocks an owner from removing ANOTHER owner (not self)', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: otherOwnerUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(otherOwnerUser.id, tenant.id, 'owner')

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${otherOwnerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(response.status).toBe(403)
    })

    it('blocks the sole owner from removing themselves (last-owner guard)', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(response.status).toBe(409)
    })

    it('lets an owner remove themselves when another owner exists', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: secondOwnerUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(secondOwnerUser.id, tenant.id, 'owner')

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(response.status).toBe(200)
    })

    it.each<MembershipRole>(['manager', 'editor', 'viewer'])(
      'lets an admin remove a %s member',
      async (targetRole) => {
        const { user: ownerUser } = await createAuthenticatedUser()
        const { user: adminUser, token: adminToken } = await createAuthenticatedUser()
        const { user: targetUser } = await createAuthenticatedUser()
        const tenant = await createTenant(ownerUser.id)
        await addMembership(adminUser.id, tenant.id, 'admin')
        await addMembership(targetUser.id, tenant.id, targetRole)

        const response = await request(app)
          .delete(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
          .set('Authorization', `Bearer ${adminToken}`)

        expect(response.status).toBe(200)
      }
    )

    it('blocks an admin from removing another admin', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { user: adminUser, token: adminToken } = await createAuthenticatedUser()
      const { user: otherAdminUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(adminUser.id, tenant.id, 'admin')
      await addMembership(otherAdminUser.id, tenant.id, 'admin')

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${otherAdminUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(response.status).toBe(403)
    })

    // The matrix has no self-exception for an admin acting on an admin, unlike the owner row's "self-only".
    it('blocks an admin from removing THEMSELVES (matrix: admin actor, admin target = no)', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { user: adminUser, token: adminToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(adminUser.id, tenant.id, 'admin')

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${adminUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(response.status).toBe(403)
    })

    it('blocks an admin from removing the owner', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { user: adminUser, token: adminToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(adminUser.id, tenant.id, 'admin')

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${ownerUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(response.status).toBe(403)
    })

    it('404s for a target user who is not a member of this tenant', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: outsiderUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${outsiderUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expectMemberNotFound(response)
    })

    it('404s for a non-member actor', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { token: outsiderToken } = await createAuthenticatedUser()
      const { user: targetUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(targetUser.id, tenant.id, 'viewer')

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
        .set('Authorization', `Bearer ${outsiderToken}`)

      expectTenantNotFound(response)
    })

    // The same race as the role update above: the permission and last-owner checks pass, and the row vanishes only before the delete itself.
    it('404s when the membership is deleted between the permission check and the delete itself', async () => {
      const { user: ownerUser, token: ownerToken } = await createAuthenticatedUser()
      const { user: targetUser } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)
      await addMembership(targetUser.id, tenant.id, 'viewer')

      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'delete',
        () => Promise.resolve(false),
        async () => {
          const response = await request(app)
            .delete(`/api/v1/tenants/${tenant.slug}/members/${targetUser.id}`)
            .set('Authorization', `Bearer ${ownerToken}`)

          expectMemberNotFound(response)
        }
      )
    })
  })

  describe('last-owner guard: atomic and blind to soft-deleted owners', () => {
    /**
     * Two owners demote themselves at once. `countOwners` is wrapped so the
     * first caller waits, for at most 1 s, until the second has counted too.
     * With the owner lock the second transaction blocks at `lockOwners`, so
     * the first times out of the wait and commits, and the second then counts
     * 1 and gets 409. Without the lock both usually count 2 and both succeed,
     * leaving no owner.
     *
     * The test pool has 2 connections (`DB_POOL_MAX` in .env.test) and the two
     * transactions hold both, so a repository call in the service that
     * forgot the executor would need a third and hang until the test timeout.
     */
    it('lets exactly one of two concurrent self-demotions through, leaving one owner', async () => {
      const { user: ownerA, token: tokenA } = await createAuthenticatedUser()
      const { user: ownerB, token: tokenB } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerA.id)
      await addMembership(ownerB.id, tenant.id, 'owner')

      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realCountOwners = UserMembershipRepository.prototype.countOwners
      let arrivals = 0
      let releaseBarrier: () => void
      // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- tsconfig.json pins `lib: ["ES2023"]`; `Promise.withResolvers` is ES2024 and untyped under it.
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve
      })
      /**
       * Counts with the caller's executor, then holds the caller until the
       * other owner has counted or 1 s passes.
       */
      const waitingCountOwners: typeof realCountOwners = async function (
        this: UserMembershipRepository,
        tenantId: string,
        executor?: DbExecutor
      ) {
        // Forward the executor, or the count would run outside the transaction and bypass the lock.
        const count = await realCountOwners.call(this, tenantId, executor)
        arrivals += 1
        if (arrivals >= 2) releaseBarrier()
        await Promise.race([
          barrier,
          settle(1000, 'with the owner lock the second caller blocks before it arrives'),
        ])
        return count
      }

      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'countOwners',
        waitingCountOwners,
        async () => {
          const responses = await Promise.all([
            request(app)
              .patch(`/api/v1/tenants/${tenant.slug}/members/${ownerA.id}`)
              .set('Authorization', `Bearer ${tokenA}`)
              .send({ role: 'admin' }),
            request(app)
              .patch(`/api/v1/tenants/${tenant.slug}/members/${ownerB.id}`)
              .set('Authorization', `Bearer ${tokenB}`)
              .send({ role: 'admin' }),
          ])

          expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
            200, 409,
          ])
        }
      )

      expect(await userMembershipRepository.countOwners(tenant.id)).toBe(1)
    })

    it('does not count a soft-deleted owner, so the only live owner cannot demote themselves', async () => {
      const { user: liveOwner, token } = await createAuthenticatedUser()
      const { user: deletedOwner } = await createAuthenticatedUser()
      const tenant = await createTenant(liveOwner.id)
      await addMembership(deletedOwner.id, tenant.id, 'owner')
      await userRepository.softDelete(deletedOwner.id)

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${liveOwner.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' })

      expect(response.status).toBe(409)
      const membership = await userMembershipRepository.findByUserAndTenant(liveOwner.id, tenant.id)
      expect(membership?.role).toBe('owner')
    })

    it('does not count a soft-deleted owner, so the only live owner cannot remove themselves', async () => {
      const { user: liveOwner, token } = await createAuthenticatedUser()
      const { user: deletedOwner } = await createAuthenticatedUser()
      const tenant = await createTenant(liveOwner.id)
      await addMembership(deletedOwner.id, tenant.id, 'owner')
      await userRepository.softDelete(deletedOwner.id)

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${liveOwner.id}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(409)
      expect(
        await userMembershipRepository.findByUserAndTenant(liveOwner.id, tenant.id)
      ).toBeDefined()
    })

    // An admin's DELETE is held just before it takes the owner lock while an owner promotes the target; the permission check under the lock must see the promotion and refuse.
    it("re-checks the admin's permission under the lock, so a target promoted to owner mid-request is not removed", async () => {
      const { user: owner, token: ownerToken } = await createAuthenticatedUser()
      const { user: admin, token: adminToken } = await createAuthenticatedUser()
      const { user: target } = await createAuthenticatedUser()
      const tenant = await createTenant(owner.id)
      await addMembership(admin.id, tenant.id, 'admin')
      await addMembership(target.id, tenant.id, 'manager')

      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realLockOwners = UserMembershipRepository.prototype.lockOwners
      let signalArrived: () => void
      // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- tsconfig.json pins `lib: ["ES2023"]`; `Promise.withResolvers` is ES2024 and untyped under it.
      const arrived = new Promise<void>((resolve) => {
        signalArrived = resolve
      })
      let releaseHeld: () => void
      // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- see the disable above.
      const heldReleased = new Promise<void>((resolve) => {
        releaseHeld = resolve
      })
      let calls = 0
      /**
       * Holds the first caller before it takes the owner lock until the test releases it.
       */
      const heldLockOwners: typeof realLockOwners = async function (
        this: UserMembershipRepository,
        ...parameters: Parameters<typeof realLockOwners>
      ) {
        calls += 1
        // Only the first caller (the admin's DELETE) is held.
        if (calls === 1) {
          signalArrived()
          await heldReleased
        }
        return realLockOwners.apply(this, parameters)
      }

      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'lockOwners',
        heldLockOwners,
        async () => {
          // Promise.resolve starts the request: supertest sends only once something calls its `then`.
          const deleting = Promise.resolve(
            request(app)
              .delete(`/api/v1/tenants/${tenant.slug}/members/${target.id}`)
              .set('Authorization', `Bearer ${adminToken}`)
          )
          await arrived

          const promotion = await request(app)
            .patch(`/api/v1/tenants/${tenant.slug}/members/${target.id}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ role: 'owner' })
          expect(promotion.status).toBe(200)

          releaseHeld()
          const removal = await deleting
          expect(removal.status).toBe(403)
        }
      )

      const membership = await userMembershipRepository.findByUserAndTenant(target.id, tenant.id)
      expect(membership?.role).toBe('owner')
    })
  })

  describe('DELETE /api/v1/tenants/:slug/membership (leave)', () => {
    it.each<MembershipRole>(['admin', 'manager', 'editor', 'viewer'])(
      'lets the %s leave: the membership goes and member.left is recorded',
      async (role) => {
        const { user: owner } = await createAuthenticatedUser()
        const tenant = await createTenant(owner.id)
        const { user, token } = await createAuthenticatedUser()
        await addMembership(user.id, tenant.id, role)

        const response = await leave(tenant.slug, token)

        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({
          success: true,
          message: 'You left the tenant.',
          // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
          data: null,
        })
        expect(
          await userMembershipRepository.findByUserAndTenant(user.id, tenant.id)
        ).toBeUndefined()
        const rows = await sql<{ actor_user_id: string; access: string; metadata: unknown }[]>`
          select actor_user_id, access, metadata from audit_logs
          where tenant_id = ${tenant.id} and action = 'member.left'`
        expect(rows).toEqual([{ actor_user_id: user.id, access: 'member', metadata: { role } }])
      }
    )

    it('revokes the leaver’s pending invitations there, one invitation.revoked entry each', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const tenant = await createTenant(owner.id)
      const { user: admin, token } = await createAuthenticatedUser()
      await addMembership(admin.id, tenant.id, 'admin')
      const first = await pendingFrom(tenant.id, admin.id)
      const second = await pendingFrom(tenant.id, admin.id)
      const ownersOwn = await pendingFrom(tenant.id, owner.id)

      const response = await leave(tenant.slug, token)

      expect(response.status).toBe(200)
      const pending = await sql<{ id: string }[]>`
        select id from tenant_invitations
        where tenant_id = ${tenant.id} and revoked_at is null and accepted_at is null`
      expect(pending.map((row) => row.id)).toEqual([ownersOwn])
      const revoked = await sql<{ target_id: string; actor_user_id: string }[]>`
        select target_id, actor_user_id from audit_logs
        where tenant_id = ${tenant.id} and action = 'invitation.revoked' order by target_id`
      expect(revoked).toEqual(
        [first, second]
          .toSorted((a, b) => a.localeCompare(b))
          .map((target_id) => ({ target_id, actor_user_id: admin.id }))
      )
    })

    it('refuses the last owner 409 LAST_OWNER, and they stay', async () => {
      const { user: owner, token } = await createAuthenticatedUser()
      const tenant = await createTenant(owner.id)

      const response = await leave(tenant.slug, token)

      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({ code: 'LAST_OWNER' })
      const kept = await userMembershipRepository.findByUserAndTenant(owner.id, tenant.id)
      expect(kept?.role).toBe('owner')
    })

    it('lets an owner leave while another owner remains', async () => {
      const { user: owner, token } = await createAuthenticatedUser()
      const tenant = await createTenant(owner.id)
      const { user: coOwner } = await createAuthenticatedUser()
      await addMembership(coOwner.id, tenant.id, 'owner')

      const response = await leave(tenant.slug, token)

      expect(response.status).toBe(200)
      expect(
        await userMembershipRepository.findByUserAndTenant(owner.id, tenant.id)
      ).toBeUndefined()
    })

    it('answers 404 tenant_not_found when the membership vanishes before the delete itself', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const tenant = await createTenant(owner.id)
      const { user, token } = await createAuthenticatedUser()
      await addMembership(user.id, tenant.id, 'viewer')

      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'delete',
        () => Promise.resolve(false),
        async () => {
          expectTenantNotFound(await leave(tenant.slug, token))
        }
      )
    })

    it('answers 401 without a bearer token', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const tenant = await createTenant(owner.id)

      const response = await leave(tenant.slug)

      expect(response.status).toBe(401)
    })

    it('answers 404 to a caller who is not a member, as for an unknown tenant', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const tenant = await createTenant(owner.id)
      const { token } = await createAuthenticatedUser()

      const response = await leave(tenant.slug, token)

      expectTenantNotFound(response)
    })

    it('answers 404 to staff who reach the tenant only through their platform role', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const tenant = await createTenant(owner.id)
      const { user: staff, token } = await createAuthenticatedUser()
      await makeStaff(staff.id, 'owner')

      const response = await leave(tenant.slug, token)

      expectTenantNotFound(response)
      expect(await sql`select id from audit_logs where action = 'member.left'`).toHaveLength(0)
    })

    it('leaves only the named tenant: a membership in another tenant stays', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const tenant = await createTenant(owner.id)
      const other = await createTenant(owner.id)
      const { user, token } = await createAuthenticatedUser()
      await addMembership(user.id, tenant.id, 'viewer')
      await addMembership(user.id, other.id, 'viewer')

      const response = await leave(tenant.slug, token)

      expect(response.status).toBe(200)
      expect(await userMembershipRepository.findByUserAndTenant(user.id, other.id)).toBeDefined()
    })

    it('needs a recent sign-in to leave the platform tenant, as a self-removal there does', async () => {
      const platform = await platformTenant()
      const { user: staff, token } = await createAuthenticatedUser()
      await makeStaff(staff.id, 'viewer')

      const stale = await leave(platform.slug, token)
      const fresh = await leave(platform.slug, signAccessToken(staff, randomUUID(), new Date()))

      expect(stale.status).toBe(401)
      expect(stale.body).toMatchObject({ code: 'REAUTH_REQUIRED' })
      expect(fresh.status).toBe(200)
    })
  })

  describe('GET /api/v1/tenants/:slug/settings', () => {
    it('returns default settings for any member', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      const settings = envelopeOf<{
        tenantId: string
        timezone: string
        locale: string
        metadata: unknown
      }>(response).data
      expect(settings).toMatchObject({ tenantId: tenant.id, timezone: 'UTC', locale: 'en' })
      expect(settings?.metadata).toBeNull()
    })

    it('404s for a non-member', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { token: outsiderToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${outsiderToken}`)

      expect(response.status).toBe(404)
    })

    // Defensive: TenantRepository.create writes the settings row in the same transaction as the tenant, so no real gap exists; the repository call is mutated directly.
    it('404s when the settings row is unexpectedly missing', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)

      await withMutatedMethod(
        TenantSettingsRepository.prototype,
        'findByTenantId',
        () => Promise.resolve(undefined),
        async () => {
          const response = await request(app)
            .get(`/api/v1/tenants/${tenant.slug}/settings`)
            .set('Authorization', `Bearer ${token}`)

          expect(response.status).toBe(404)
        }
      )
    })
  })

  describe('PATCH /api/v1/tenants/:slug/settings', () => {
    it('lets an owner update timezone, locale, and metadata', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        .send({ timezone: 'America/New_York', locale: 'en-US', metadata: { theme: 'dark' } })

      expect(response.status).toBe(200)
      expect(
        envelopeOf<{ timezone: string; locale: string; metadata: unknown }>(response).data
      ).toMatchObject({
        timezone: 'America/New_York',
        locale: 'en-US',
        metadata: { theme: 'dark' },
      })
    })

    it('treats an explicit null as clearing metadata', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        .send({ metadata: { theme: 'dark' } })

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        // eslint-disable-next-line unicorn/no-null -- exercising the explicit-null-clears-the-field contract itself
        .send({ metadata: null })

      expect(response.status).toBe(200)
      expect(envelopeOf<{ metadata: unknown }>(response).data?.metadata).toBeNull()
    })

    it.each<MembershipRole>(['manager', 'editor', 'viewer'])(
      'rejects a %s with 403',
      async (role) => {
        const { user: ownerUser } = await createAuthenticatedUser()
        const { user: memberUser, token: memberToken } = await createAuthenticatedUser()
        const tenant = await createTenant(ownerUser.id)
        await addMembership(memberUser.id, tenant.id, role)

        const response = await request(app)
          .patch(`/api/v1/tenants/${tenant.slug}/settings`)
          .set('Authorization', `Bearer ${memberToken}`)
          .send({ locale: 'fr' })

        expect(response.status).toBe(403)
      }
    )

    it('404s for a non-member', async () => {
      const { user: ownerUser } = await createAuthenticatedUser()
      const { token: outsiderToken } = await createAuthenticatedUser()
      const tenant = await createTenant(ownerUser.id)

      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ locale: 'fr' })

      expect(response.status).toBe(404)
    })

    // The write path of the defensive case above: updateSettings calls tenantSettingsRepository.update only when the body changes a field, and the new locale does.
    it('404s when the settings row is unexpectedly missing at update time', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)

      await withMutatedMethod(
        TenantSettingsRepository.prototype,
        'update',
        () => Promise.resolve(undefined),
        async () => {
          const response = await request(app)
            .patch(`/api/v1/tenants/${tenant.slug}/settings`)
            .set('Authorization', `Bearer ${token}`)
            .send({ locale: 'fr' })

          expect(response.status).toBe(404)
        }
      )
    })
  })

  describe('NUL in unvalidated input answers 4xx, not 500', () => {
    it('a :slug with NUL answers 404 to any signed-in user', async () => {
      const { token } = await createAuthenticatedUser()
      const response = await request(app)
        .get('/api/v1/tenants/a%00b')
        .set('Authorization', `Bearer ${token}`)
      expect(response.status).toBe(404)
    })

    it.each([
      ['DELETE', '/api/v1/tenants/a%00b/membership'],
      ['PATCH', '/api/v1/tenants/a%00b/members/0198f8a0-0000-7000-8000-000000000000'],
    ] as const)('%s %s answers 404', async (method, path) => {
      const { token } = await createAuthenticatedUser()
      const response = await request(app)
        [method.toLowerCase() as 'delete' | 'patch'](path)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'viewer' })
      expect(response.status).toBe(404)
    })

    it('a member :userId with NUL answers 404', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/a%00b`)
        .set('Authorization', `Bearer ${token}`)
      expectMemberNotFound(response)
    })

    it.each([
      ['timezone', { timezone: 'UTC\u{0}x' }],
      ['locale', { locale: 'en\u{0}' }],
      ['metadata value', { metadata: { a: 'x\u{0}y' } }],
      ['metadata key', { metadata: { 'a\u{0}': 1 } }],
    ])('settings %s with NUL answers 400', async (_label, body) => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
      expect(response.status).toBe(400)
    })

    it('a nested metadata string with NUL answers 400', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        .send({ metadata: { a: [{ b: 'x\u{0}' }] } })
      expect(response.status).toBe(400)
    })
  })

  describe('PATCH /api/v1/tenants/:slug/members/:userId with a malformed id', () => {
    it('answers 404 for a member id that is not a uuid', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/not-a-uuid`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'viewer' })
      expectMemberNotFound(response)
    })
  })

  describe('timezone and locale refuse control and bidi characters', () => {
    it.each([
      ['timezone bidi override', { timezone: 'Etc/\u{202E}gnp' }],
      ['timezone newline', { timezone: 'UTC\nX' }],
      ['locale bell', { locale: 'en\u{7}' }],
      ['timezone that names no zone', { timezone: 'Not/AZone' }],
      ['timezone with a colon offset (shape check)', { timezone: '+05:30' }],
      ['locale with an underscore', { locale: 'en_US' }],
      ['locale that is not a language tag', { locale: 'x-private' }],
    ])('%s', async (_label, body) => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
      expect(response.status).toBe(400)
    })

    it.each([
      { timezone: 'UTC', locale: 'en' },
      { timezone: 'Etc/GMT+5', locale: 'zh-Hant-TW' },
      { timezone: 'America/Argentina/Buenos_Aires', locale: 'pt-BR' },
    ])('accepts a real zone and language tag %j', async (body) => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
      expect(response.status).toBe(200)
    })
  })

  describe('metadata is bounded', () => {
    it('refuses 900 KB of metadata', async () => {
      expect(await patchSettings({ metadata: { blob: 'x'.repeat(900_000) } })).toBe(400)
    })

    it('refuses metadata nested 1,000 deep', async () => {
      expect(await patchSettings({ metadata: nested(1000) })).toBe(400)
    })

    it('refuses metadata nested 100,000 deep with a 400, not a 500', async () => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      // Raw JSON: JSON.stringify overflows the stack on a value this deep.
      const levels = 100_000
      const body = `{"metadata":${'{"a":'.repeat(levels - 1)}{}${'}'.repeat(levels - 1)}}`
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(body)
      expect(response.status).toBe(400)
      const { errors } = response.body as { errors: Record<string, string[]> }
      expect(errors.metadata).toEqual(['Metadata must be nested at most 10 levels deep.'])
    })

    it('accepts metadata at the size and depth caps, and refuses one past each', async () => {
      // 16 384 serialized characters: {"blob":"…"} is 11 characters of frame.
      expect(await patchSettings({ metadata: { blob: 'x'.repeat(16_384 - 11) } })).toBe(200)
      expect(await patchSettings({ metadata: { blob: 'x'.repeat(16_384 - 10) } })).toBe(400)
      expect(await patchSettings({ metadata: nested(10) })).toBe(200)
      expect(await patchSettings({ metadata: nested(11) })).toBe(400)
    })
  })

  describe('logo and website must be http(s) URLs', () => {
    it.each([
      ['website javascript:', { website: 'javascript:alert(document.domain)' }],
      ['logo javascript:', { logo: 'javascript:alert(1)' }],
      ['logo data:', { logo: 'data:text/html,<script>alert(1)</script>' }],
      ['website not a URL', { website: 'call us maybe' }],
      ['website userinfo host swap', { website: 'https://bank.example@evil.example/' }],
      ['website credentials', { website: 'https://user:pw@host.example/' }],
      ['website backslash before @', { website: String.raw`https://evil.example\@good.example/` }],
      ['logo backslash in path', { logo: String.raw`https://good.example/a\b` }],
    ])('PATCH refuses %s', async (_label, body) => {
      const { user, token } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
      expect(response.status).toBe(400)
    })

    it('POST refuses a javascript: website and still accepts an https one', async () => {
      const { token } = await createAuthenticatedUser()
      const refused = await request(app)
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Acme', slug: uniqueSlug(), website: 'javascript:alert(1)' })
      const leaked = envelopeOf<{ id: string }>(refused).data
      if (leaked) createdTenantIds.push(leaked.id)
      expect(refused.status).toBe(400)
      expect(envelopeOf(refused).errors?.website).toEqual([
        'Website must be a web address that starts with http:// or https://.',
      ])

      const slug = uniqueSlug()
      const accepted = await request(app)
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Acme',
          slug,
          website: ' https://acme.example/ ',
          logo: 'http://localhost:3000/logo.png',
        })
      expect(accepted.status).toBe(201)
      const created = envelopeOf<{ id: string; website: string }>(accepted).data
      if (created) createdTenantIds.push(created.id)
      expect(created?.website).toBe('https://acme.example/')
    })

    it('POST still accepts an @ in the path or query', async () => {
      const { token } = await createAuthenticatedUser()
      const response = await request(app)
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Acme', slug: uniqueSlug(), website: 'https://example.com/u/@name?x=a@b' })
      const created = envelopeOf<{ id: string; website: string }>(response).data
      if (created) createdTenantIds.push(created.id)
      expect(response.status).toBe(201)
      expect(created?.website).toBe('https://example.com/u/@name?x=a@b')
    })
  })
})
