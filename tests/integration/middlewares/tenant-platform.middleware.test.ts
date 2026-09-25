// tests/integration/middlewares/tenant-platform.middleware.test.ts
//
// resolveTenant's platform branch through a real Express dispatch, on the
// probe harness tenant.middleware.test.ts uses: the principal each caller
// gets, the requireRole floors each platform role clears, and the platform
// tenant staying members-only. Staff are users with a membership in the
// seeded platform tenant.
//
// Staff visits write audit rows, which RESTRICT deleting their user and
// tenant, so afterEach clears audit_logs first.
import { randomUUID } from 'node:crypto'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MEMBERSHIP_ROLES, type MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import { errorHandler } from '@/middlewares/error.middleware'
import { requestContext } from '@/middlewares/request-context.middleware'
import { requestId } from '@/middlewares/request-id.middleware'
import { requireRole, resolveTenant } from '@/middlewares/tenant.middleware'
import { AuditLogRepository } from '@/repositories/audit-log.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { requestContextStore, type TenantContext } from '@/services/request-context.service'
import type { RequestPrincipal } from '@/types/actor'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

/**
 * What the probe route reports: the principal and the ALS tenant.
 */
interface ProbeBody {
  principal: RequestPrincipal | undefined
  contextTenant: TenantContext | undefined
}

/**
 * The requireRole floors each platform role clears, written out rather than
 * derived from isRoleAtLeast, so the test does not check the code against itself.
 */
const FLOORS_CLEARED: Record<MembershipRole, readonly MembershipRole[]> = {
  owner: ['owner', 'admin', 'manager', 'editor', 'viewer'],
  admin: ['admin', 'manager', 'editor', 'viewer'],
  manager: ['manager', 'editor', 'viewer'],
  editor: ['editor', 'viewer'],
  viewer: ['viewer'],
}

/**
 * A platform-role lookup that makes anyone staff admin.
 * @returns 'admin', whoever asks.
 */
const answersAdminForAnyone: UserMembershipRepository['findPlatformRole'] = () =>
  Promise.resolve('admin')

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * Sets `request.user` from a real user id, standing in for `requireAuth`.
 * @param userId - The user id to attach.
 * @returns An Express middleware.
 */
function stubAuthenticatedUser(userId: string) {
  return (thisRequest: Request, _response: Response, next: NextFunction): void => {
    thisRequest.user = {
      id: userId,
      email: 'stub@example.test',
      // eslint-disable-next-line unicorn/no-null -- AuthenticatedUser.firstName/lastName are `string | null`.
      firstName: null,
      // eslint-disable-next-line unicorn/no-null -- see comment above.
      lastName: null,
    }
    next()
  }
}

/**
 * Reports what the chain ahead of it attached.
 * @param thisRequest - The incoming request.
 * @param response - The response to write the probe body to.
 */
function probe(thisRequest: Request, response: Response): void {
  response.json({
    principal: thisRequest.principal,
    contextTenant: requestContextStore.getStore()?.tenant,
  } satisfies ProbeBody)
}

/**
 * A standalone app: requestId, requestContext, the stub user, resolveTenant,
 * optionally requireRole, then the probe, on `/tenants/:slug/probe`.
 * @param userId - The user `resolveTenant` sees.
 * @param roles - When given, `requireRole(...roles)` runs after `resolveTenant`.
 * @returns The app, not listening.
 */
function buildApp(userId: string, roles?: MembershipRole[]): Express {
  const app = express()
  app.use(requestId)
  app.use(requestContext)
  app.use(stubAuthenticatedUser(userId))
  const chain = roles ? [resolveTenant(), requireRole(...roles)] : [resolveTenant()]
  app.get('/tenants/:slug/probe', ...chain, probe)
  app.use(errorHandler)
  return app
}

describe('resolveTenant platform access (integration)', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await truncateAuditLogs()
    if (createdTenantIds.length > 0) {
      await sql`delete from tenants where id = any(${createdTenantIds})`
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) return
    // Cascades to their platform memberships.
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user, tracked for cleanup.
   * @returns The user's id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({
      email: `tenant-platform-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    return user.id
  }

  /**
   * A fresh tenant owned by `ownerId`, tracked for cleanup.
   * @param ownerId - Its owner.
   * @returns The tenant.
   */
  async function createTenant(ownerId: string): Promise<Tenant> {
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  it('gives a member access "member" with their own role and no platform role', async () => {
    const ownerId = await createUser()
    const tenant = await createTenant(ownerId)

    const response = await request(buildApp(ownerId)).get(`/tenants/${tenant.slug}/probe`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      principal: {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        isPlatformTenant: false,
        role: 'owner',
        memberRole: 'owner',
        // eslint-disable-next-line unicorn/no-null -- a member's principal carries no platform role
        platformRole: null,
        access: 'member',
      },
      contextTenant: { tenantId: tenant.id, tenantSlug: tenant.slug, role: 'owner' },
    })
  })

  it('gives staff with no membership their platform role as the effective role, access "platform"', async () => {
    const tenant = await createTenant(await createUser())
    const staffId = await createUser()
    await makeStaff(staffId, 'editor')

    const response = await request(buildApp(staffId)).get(`/tenants/${tenant.slug}/probe`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      principal: {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        isPlatformTenant: false,
        role: 'editor',
        // eslint-disable-next-line unicorn/no-null -- staff reach this tenant with no membership
        memberRole: null,
        platformRole: 'editor',
        access: 'platform',
      },
      contextTenant: { tenantId: tenant.id, tenantSlug: tenant.slug, role: 'editor' },
    })
  })

  it('lets membership win: a staff admin who is a viewer member is a viewer there', async () => {
    const tenant = await createTenant(await createUser())
    const staffId = await createUser()
    await makeStaff(staffId, 'admin')
    await userMembershipRepository.create({ userId: staffId, tenantId: tenant.id, role: 'viewer' })

    const response = await request(buildApp(staffId)).get(`/tenants/${tenant.slug}/probe`)
    const body = response.body as ProbeBody

    expect(body.principal).toMatchObject({
      role: 'viewer',
      memberRole: 'viewer',
      // eslint-disable-next-line unicorn/no-null -- membership wins, so no platform role is used
      platformRole: null,
      access: 'member',
    })
    const adminOnly = await request(buildApp(staffId, ['admin'])).get(
      `/tenants/${tenant.slug}/probe`
    )
    expect(adminOnly.status).toBe(403)
  })

  it.each(MEMBERSHIP_ROLES)(
    'lets a staff %s clear exactly the requireRole floors at or below that role',
    async (staffRole) => {
      const tenant = await createTenant(await createUser())
      const staffId = await createUser()
      await makeStaff(staffId, staffRole)

      for (const floor of MEMBERSHIP_ROLES) {
        const response = await request(buildApp(staffId, [floor])).get(
          `/tenants/${tenant.slug}/probe`
        )
        const expected = FLOORS_CLEARED[staffRole].includes(floor) ? 200 : 403
        expect({ floor, status: response.status }).toEqual({ floor, status: expected })
      }
    }
  )

  it('records the staff visit as tenant.accessed_by_platform', async () => {
    const tenant = await createTenant(await createUser())
    const staffId = await createUser()
    await makeStaff(staffId, 'viewer')

    await request(buildApp(staffId)).get(`/tenants/${tenant.slug}/probe`)

    const rows = await sql`
      select action, actor_kind as "actorKind", actor_user_id as "actorUserId", access, metadata
      from audit_logs where tenant_id = ${tenant.id}
    `
    expect(rows).toEqual([
      {
        action: 'tenant.accessed_by_platform',
        actorKind: 'user',
        actorUserId: staffId,
        access: 'platform',
        metadata: { platformRole: 'viewer' },
      },
    ])
  })

  it('still admits staff when the visit cannot be audited, and logs a warning', async () => {
    const tenant = await createTenant(await createUser())
    const staffId = await createUser()
    await makeStaff(staffId, 'viewer')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await withMutatedMethod(
      AuditLogRepository.prototype,
      'insert',
      () => Promise.reject(new Error('audit insert failed')),
      async () => {
        const response = await request(buildApp(staffId)).get(`/tenants/${tenant.slug}/probe`)
        expect(response.status).toBe(200)
        expect((response.body as ProbeBody).principal?.access).toBe('platform')
      }
    )

    expect(warn).toHaveBeenCalledWith(
      'Platform access audit failed',
      expect.objectContaining({ tenantId: tenant.id })
    )
  })

  it('answers 404 to a user who is neither a member nor staff', async () => {
    const tenant = await createTenant(await createUser())
    const outsiderId = await createUser()

    const response = await request(buildApp(outsiderId)).get(`/tenants/${tenant.slug}/probe`)

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ statusCode: 404, message: 'Tenant not found' })
  })

  describe('the platform tenant', () => {
    it('answers 404 to a user who is not its member, even one who owns another tenant', async () => {
      const ownerId = await createUser()
      await createTenant(ownerId)
      const platform = await platformTenant()

      const response = await request(buildApp(ownerId)).get(`/tenants/${platform.slug}/probe`)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ statusCode: 404, message: 'Tenant not found' })
    })

    it('stays members-only even if the platform lookup answered "admin" for anyone', async () => {
      const outsiderId = await createUser()
      const tenant = await createTenant(await createUser())
      const platform = await platformTenant()
      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'findPlatformRole',
        answersAdminForAnyone,
        async () => {
          const app = buildApp(outsiderId)
          const customer = await request(app).get(`/tenants/${tenant.slug}/probe`)
          const platformProbe = await request(app).get(`/tenants/${platform.slug}/probe`)
          // The mutation is live: a customer tenant opens on it.
          expect(customer.status).toBe(200)
          expect(platformProbe.status).toBe(404)
        }
      )
    })

    it('opens to a platform member, as a member', async () => {
      const staffId = await createUser()
      await makeStaff(staffId, 'viewer')
      const platform = await platformTenant()

      const response = await request(buildApp(staffId)).get(`/tenants/${platform.slug}/probe`)

      expect(response.status).toBe(200)
      expect((response.body as ProbeBody).principal).toMatchObject({
        isPlatformTenant: true,
        role: 'viewer',
        access: 'member',
      })
    })
  })
})
