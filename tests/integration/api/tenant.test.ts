// tests/integration/api/tenant.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts) — the same convention
// tests/integration/api/profile.test.ts and
// tests/integration/middlewares/tenant.middleware.test.ts already follow.
// Authenticated requests sign a token directly with `signAccessToken`
// rather than going through `POST /api/v1/auth/login`, and most fixtures
// (tenants, memberships) are built directly via the repositories rather
// than through this file's own `POST /tenants` endpoint —
// `tenant.middleware.test.ts`'s own header comment gives the identical
// reasoning: these tests are about what happens once a caller is already a
// member with a given role, not about tenant creation itself (which gets
// its own `describe` block below, exercised through the real endpoint).
// Members join only by invitation; tests/integration/api/invitation.test.ts
// covers those endpoints.
//
// RATE LIMITING here is "wiring, not thresholds" — `auth-refresh.test.ts`'s
// own header comment states the reasoning this file borrows verbatim:
// exhausting `createCreateTenantRateLimiter`'s real 20-per-hour budget
// would spend a budget every other
// integration file running in parallel shares. The 429 behaviour itself,
// including the user-keyed discriminator, is proven with small overrides in
// tests/unit/middlewares/rate-limit.middleware.test.ts.
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { TenantRepository, type CreateTenantInput } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import type { DbExecutor } from '@/services/database.service'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/utilities/token.utilities'
import { withMutatedMethod } from '../../helpers/mutate'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * The envelope every controller response is wrapped in
 * (response.utilities.ts), narrowed to the fields these tests read. Same
 * pattern as `tests/integration/api/profile.test.ts`'s own `ApiEnvelope`.
 */
interface ApiEnvelope<TData> {
  success: boolean
  message: string
  data?: TData
  errors?: Record<string, string[]>
}

/**
 * Cast a supertest response's body to a known envelope shape. supertest
 * types `.body` as `any`; every access after this point is a normal,
 * type-checked property access rather than an unsafe one.
 * @param response - The supertest response.
 * @returns The response body, typed.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `tenant-api-${randomUUID()}@example.test`
}

/**
 * A disposable slug, unique to one test run.
 * @returns A slug guaranteed unique to this call.
 */
function uniqueSlug(): string {
  return `tenant-${randomUUID()}`
}

/**
 * Add an existing user to a tenant with a given role, bypassing the API.
 * @param userId - The user to add.
 * @param tenantId - The tenant to add them to.
 * @param role - The role to grant.
 */
async function addMembership(
  userId: string,
  tenantId: string,
  role: MembershipRole
): Promise<void> {
  await userMembershipRepository.create({ userId, tenantId, role })
}

describe('/api/v1/tenants', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    // Tenants first: `tenant_settings.tenant_id` and
    // `user_memberships.tenant_id` both carry `ON DELETE CASCADE`
    // (tenant.model.ts, user-membership.model.ts), so deleting the tenant
    // takes its settings row and every membership row with it — same
    // convention tenant.repository.test.ts uses.
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
   * A fresh, disposable user with a valid bearer token, tracked for
   * cleanup.
   * @returns The created row and a valid bearer token for it.
   */
  async function createAuthenticatedUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  /**
   * A fresh tenant via `TenantRepository.create`, tracked for cleanup.
   * @param ownerId - The user who becomes this tenant's owner.
   * @param overrides - Any `CreateTenantInput` fields to override.
   * @returns The created tenant row.
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
        envelopeOf<Array<{ tenant: Tenant; role: MembershipRole }>>(response).data ?? []
      expect(tenants).toHaveLength(2)
      const byTenantId = new Map(tenants.map((entry) => [entry.tenant.id, entry.role]))
      expect(byTenantId.get(owned.id)).toBe('owner')
      expect(byTenantId.get(joined.id)).toBe('viewer')
    })

    it('returns an empty list for a user with no memberships', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<unknown[]>(response).data).toEqual([])
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

    // A real race, not a hypothetical one — same reasoning as
    // profile.test.ts's own "deleted between requireAuth loading it and the
    // handler loading it again" test: `resolveTenant` (tenant.middleware.ts)
    // resolves the tenant via `findActiveBySlug`, a DIFFERENT method from
    // `getTenant`'s own `findById` call — so mutating `findById` alone
    // cannot make `resolveTenant` itself fail first, and needs no call
    // counter the way profile.test.ts's `findById` mutation does.
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

    // Mass-assignment: `slug` is not one of `updateTenantSchema`'s fields,
    // so it is silently stripped, exactly like `updateProfileSchema` strips
    // `email`/`id`/`passwordHash`/`active` (profile.test.ts's own version of
    // this test). Read back with raw SQL — an oracle independent of the
    // repository under test.
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

    // Same TOCTOU shape as the GET test above, for `updateTenant`'s own
    // second lookup — `tenantRepository.update`, taken here because the
    // request body carries a real change (`hasChanges` is true).
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
    it('lists members for any role, never leaking passwordHash', async () => {
      const { user, token } = await createAuthenticatedUser()
      const { user: viewerUser } = await createAuthenticatedUser()
      const tenant = await createTenant(user.id)
      await addMembership(viewerUser.id, tenant.id, 'viewer')

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/members`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      const members = envelopeOf<unknown[]>(response).data
      expect(members).toHaveLength(2)
      expect(JSON.stringify(response.body)).not.toMatch(/password/i)
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

      expect(response.status).toBe(404)
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

      expect(response.status).toBe(404)
    })

    // The SECOND "Member not found" — a real race, not the "target user was
    // never a member" 404 two tests above: `findByUserAndTenant` and every
    // permission/last-owner check already pass, and the membership row
    // vanishes only in the gap before `updateRole`'s own write. Mutating
    // `updateRole` (not `findByUserAndTenant`) is what isolates this branch
    // from the one above.
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

          expect(response.status).toBe(404)
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

    // Discovered consequence of the matrix as written, not a fix applied
    // here — see tenant.controller.ts's `removeMember` and this task's own
    // report. `actorRole === 'admin'` targeting an `'admin'` (itself) is
    // `'no'` in the plan's matrix with no self-exception carved out, unlike
    // the owner row's explicit "self-only".
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

      expect(response.status).toBe(404)
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

      expect(response.status).toBe(404)
    })

    // The SECOND "Member not found" — same race as updateMemberRole's own
    // version above: the permission and last-owner checks already pass, and
    // the row vanishes only in the gap before the delete itself.
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

          expect(response.status).toBe(404)
        }
      )
    })
  })

  describe('last-owner guard: atomic and blind to soft-deleted owners', () => {
    // Two owners demote themselves at once. countOwners is wrapped so the
    // first caller waits (up to 1s) for the second to have counted too.
    // - Pins: with the owner lock, the second transaction is blocked at
    //   lockOwners, so the first times out of the wait, commits, and the
    //   second then counts 1 and gets 409.
    // - Without the lock both usually count 2 and both succeed, leaving no
    //   owner; a start gap over 1s could still let that pass.
    // Pool note: test mode has max 2 connections. The two transactions hold
    // both, which works only because B waits inside its own connection and A
    // needs no third. A repository call inside the service that forgot the
    // executor would hang here until the test timeout.
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
      const waitingCountOwners: typeof realCountOwners = async function (
        this: UserMembershipRepository,
        tenantId: string,
        executor?: DbExecutor
      ) {
        // Forward the executor, or post-fix this would count outside the transaction.
        const count = await realCountOwners.call(this, tenantId, executor)
        arrivals += 1
        if (arrivals >= 2) releaseBarrier()
        await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 1000))])
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

    // An admin's DELETE is held just before it takes the owner lock, after
    // any earlier read of the target, while an owner promotes that target to
    // owner. The permission check must see the promotion and refuse.
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
      const heldLockOwners: typeof realLockOwners = async function (
        this: UserMembershipRepository,
        tenantId: string,
        executor?: DbExecutor
      ) {
        calls += 1
        // Only the first caller (the admin's DELETE) is held.
        if (calls === 1) {
          signalArrived()
          await heldReleased
        }
        return realLockOwners.call(this, tenantId, executor)
      }

      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'lockOwners',
        heldLockOwners,
        async () => {
          // Promise.resolve starts the request now (supertest is lazy until then'd).
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

    // Defensive, not reachable through any real gap in practice —
    // `TenantRepository.create` writes the settings row atomically alongside
    // the tenant itself (getSettings's own comment, tenant.controller.ts) —
    // but proven the same way as this file's other TOCTOU tests: mutate the
    // repository call directly, since `resolveTenant` never touches
    // `tenant_settings` at all and so cannot be tripped up by this.
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

    // Same shape as GET settings' own defensive test above, for
    // `updateSettings`'s own second lookup — `tenantSettingsRepository.update`,
    // taken here because the request body carries a real change.
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
})
