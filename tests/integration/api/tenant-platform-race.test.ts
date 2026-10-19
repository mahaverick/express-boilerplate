/**
 * @file A staff user's platform role is re-read under lock inside the
 * service's transaction, not taken from request.principal. Same shape
 * as tenant-actor-race.test.ts, hooking the platform read
 * (findPlatformRole on the pool) instead of the membership read.
 */

import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql, type DbExecutor } from '@/services/database.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { hashToken, signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backdateInvitationSend } from '../../helpers/backdate'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * What happens to the staff user's platform membership right after resolveTenant reads it.
 */
type PlatformChange = 'demote-to-viewer' | 'remove'

/**
 * The platform role resolveTenant read, kept for the mutation proof.
 */
interface SeenRead {
  role?: MembershipRole
}

/**
 * Runs `run` with a hook that applies `change` to the staff user's platform
 * membership right after resolveTenant's pool read of their platform role,
 * so the request carries the stale role. `seen` receives the role resolveTenant
 * read. Fails the test if the hook never fired.
 */
async function withPlatformRoleChangedAfterResolve(
  staff: User,
  change: PlatformChange,
  seen: SeenRead,
  run: () => Promise<void>
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realFind = UserMembershipRepository.prototype.findPlatformRole
  const platform = await platformTenant()
  let hasChanged = false
  /**
   * Returns the real read's role, and on resolveTenant's own pool read applies `change` once.
   */
  const changingFind: typeof realFind = async function (
    this: UserMembershipRepository,
    userId: string,
    executor?: DbExecutor
  ) {
    const role = await realFind.call(this, userId, executor)
    const isResolveRead = executor === undefined && userId === staff.id
    if (!hasChanged && role && isResolveRead) {
      hasChanged = true
      seen.role = role
      const row = await userMembershipRepository.findByUserAndTenant(staff.id, platform.id)
      if (!row) throw new Error('setup: the staff user has a platform membership')
      if (change === 'remove') {
        await userMembershipRepository.delete(row.id)
      } else {
        await userMembershipRepository.updateRole(row.id, 'viewer')
      }
    }
    return role
  }

  await withMutatedMethod(UserMembershipRepository.prototype, 'findPlatformRole', changingFind, run)
  expect(hasChanged).toBe(true)
}

/**
 * Runs `run` with a hook that deletes the staff user's membership in `tenant`
 * right after resolveTenant's pool read of it, so the request passes the route
 * as a member while the service's locked re-read finds only their platform
 * role. Fails the test if the hook never fired.
 */
async function withMembershipRemovedAfterResolve(
  staff: User,
  tenant: Tenant,
  run: () => Promise<void>
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realFind = UserMembershipRepository.prototype.findByUserAndTenant
  let hasChanged = false
  /**
   * Returns the real read's row, and on resolveTenant's own pool read deletes the membership once.
   */
  const removingFind: typeof realFind = async function (
    this: UserMembershipRepository,
    userId: string,
    tenantId: string,
    executor?: DbExecutor
  ) {
    const row = await realFind.call(this, userId, tenantId, executor)
    const isResolveRead = executor === undefined && userId === staff.id && tenantId === tenant.id
    if (!hasChanged && row && isResolveRead) {
      hasChanged = true
      await userMembershipRepository.delete(row.id)
    }
    return row
  }

  await withMutatedMethod(
    UserMembershipRepository.prototype,
    'findByUserAndTenant',
    removingFind,
    run
  )
  expect(hasChanged).toBe(true)
}

/**
 * A pending viewer invitation sent by `inviter`, with its last send backdated
 * so a resend is not refused for being too soon; returns its id.
 */
async function pendingInvitation(tenant: Tenant, inviter: User): Promise<string> {
  const invitation = await new TenantInvitationRepository().createPending({
    tenantId: tenant.id,
    email: `platform-race-${randomUUID()}@example.test`,
    role: 'viewer',
    tokenHash: hashToken(randomUUID()),
    invitedBy: inviter.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  await backdateInvitationSend(invitation.id)
  return invitation.id
}

/**
 * A stand-in for `lockPlatformRole` that returns the role resolveTenant saw,
 * as a service trusting the earlier read would.
 */
function trustingEarlierRead(seen: SeenRead): UserMembershipRepository['lockPlatformRole'] {
  // eslint-disable-next-line unicorn/no-null -- the platform-role contract is `MembershipRole | null`.
  return () => Promise.resolve(seen.role ?? null)
}

/**
 * The tenant's stored name, read with raw SQL.
 */
async function storedName(tenant: Tenant): Promise<string | undefined> {
  const [row] = await sql<{ name: string }[]>`select name from tenants where id = ${tenant.id}`
  return row?.name
}

/**
 * PATCHes the tenant's name as the bearer of `token`, returning only the status and body.
 */
async function rename(tenant: Tenant, token: string): Promise<{ status: number; body: unknown }> {
  const response = await request(app)
    .patch(`/api/v1/tenants/${tenant.slug}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Renamed on a stale role' })
  return { status: response.status, body: response.body as unknown }
}

// Each test changes the staff user's platform membership right after resolveTenant read it, so requireRole still sees the old role; the write must be refused and change nothing.
describe('the staff role is re-read under lock (platform role changed after resolveTenant)', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    // Staff visits write audit rows, whose foreign keys restrict deleting the tenants and users.
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
   */
  async function createAuthenticatedUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({
      email: `platform-race-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  /**
   * A tenant owned by a fresh user, tracked for cleanup.
   */
  async function ownedTenant(): Promise<Tenant> {
    const { user: owner } = await createAuthenticatedUser()
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  /**
   * A fresh staff user with the given platform role, and a token.
   */
  async function staffUser(role: MembershipRole): Promise<{ user: User; token: string }> {
    const staff = await createAuthenticatedUser()
    await makeStaff(staff.user.id, role)
    return staff
  }

  /**
   * A fresh manager of `tenant`; returns their user id.
   */
  async function manager(tenant: Tenant): Promise<string> {
    const { user } = await createAuthenticatedUser()
    await userMembershipRepository.create({ userId: user.id, tenantId: tenant.id, role: 'manager' })
    return user.id
  }

  it('refuses a tenant update by a staff admin demoted to viewer, and the name stays', async () => {
    const tenant = await ownedTenant()
    const { user: staff, token } = await staffUser('admin')

    await withPlatformRoleChangedAfterResolve(staff, 'demote-to-viewer', {}, async () => {
      const response = await rename(tenant, token)
      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })

    expect(await storedName(tenant)).toBe('Acme Inc')
  })

  it('answers 404 Tenant not found to a staff admin removed from the platform, and the name stays', async () => {
    const tenant = await ownedTenant()
    const { user: staff, token } = await staffUser('admin')

    await withPlatformRoleChangedAfterResolve(staff, 'remove', {}, async () => {
      const response = await rename(tenant, token)
      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ statusCode: 404, message: 'Tenant not found' })
      expect(response.body).not.toHaveProperty('code')
    })

    expect(await storedName(tenant)).toBe('Acme Inc')
  })

  it('refuses a settings update by a demoted staff admin, and the locale stays', async () => {
    const tenant = await ownedTenant()
    const { user: staff, token } = await staffUser('admin')

    await withPlatformRoleChangedAfterResolve(staff, 'demote-to-viewer', {}, async () => {
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/settings`)
        .set('Authorization', `Bearer ${token}`)
        .send({ locale: 'fr' })
      expect(response.status).toBe(403)
    })

    const [row] = await sql`select locale from tenant_settings where tenant_id = ${tenant.id}`
    expect(row).toEqual({ locale: 'en' })
  })

  it('refuses a role change by a demoted staff owner, and the target keeps their role', async () => {
    const tenant = await ownedTenant()
    const { user: target } = await createAuthenticatedUser()
    await userMembershipRepository.create({
      userId: target.id,
      tenantId: tenant.id,
      role: 'viewer',
    })
    const { user: staff } = await staffUser('owner')
    // A staff member's role change on a customer tenant needs a recent sign-in and a reason.
    const recentToken = signAccessToken(staff, randomUUID(), new Date())

    await withPlatformRoleChangedAfterResolve(staff, 'demote-to-viewer', {}, async () => {
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${target.id}`)
        .set('Authorization', `Bearer ${recentToken}`)
        .send({ role: 'editor', reason: 'Customer asked us to, ticket 4411' })
      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })

    const membership = await userMembershipRepository.findByUserAndTenant(target.id, tenant.id)
    expect(membership?.role).toBe('viewer')
  })

  // Runs every time, unlike the MUTATION_PROOF case below: with the locked re-read trusting the earlier read the stale role gets through, so that re-read is what refuses it.
  it('lets the stale role through only while the locked re-read trusts the earlier read', async () => {
    const trustedTenant = await ownedTenant()
    const trusted = await staffUser('admin')
    const seen: SeenRead = {}

    await withPlatformRoleChangedAfterResolve(trusted.user, 'demote-to-viewer', seen, async () => {
      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'lockPlatformRole',
        trustingEarlierRead(seen),
        async () => {
          const response = await rename(trustedTenant, trusted.token)
          expect(response.status).toBe(200)
        }
      )
    })
    expect(await storedName(trustedTenant)).toBe('Renamed on a stale role')

    // Restored: the same race is refused again.
    const tenant = await ownedTenant()
    const { user: staff, token } = await staffUser('admin')
    await withPlatformRoleChangedAfterResolve(staff, 'demote-to-viewer', {}, async () => {
      const response = await rename(tenant, token)
      expect(response.status).toBe(403)
    })
    expect(await storedName(tenant)).toBe('Acme Inc')
  })

  describe('a staff member whose membership goes after resolveTenant', () => {
    /**
     * One member or invitation write, sent with no reason.
     */
    interface MemberWrite {
      name: string
      action: string
      send: (tenant: Tenant, token: string, staff: User) => Promise<Response>
    }

    const writes: MemberWrite[] = [
      {
        name: 'PATCH /members/:userId',
        action: 'member.role_changed',
        send: async (tenant, token) =>
          request(app)
            .patch(`/api/v1/tenants/${tenant.slug}/members/${await manager(tenant)}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'editor' }),
      },
      {
        name: 'DELETE /members/:userId',
        action: 'member.removed',
        send: async (tenant, token) =>
          request(app)
            .delete(`/api/v1/tenants/${tenant.slug}/members/${await manager(tenant)}`)
            .set('Authorization', `Bearer ${token}`)
            .send({}),
      },
      {
        name: 'POST /invitations',
        action: 'invitation.created',
        send: async (tenant, token) =>
          request(app)
            .post(`/api/v1/tenants/${tenant.slug}/invitations`)
            .set('Authorization', `Bearer ${token}`)
            .send({ email: `platform-race-${randomUUID()}@example.test`, role: 'viewer' }),
      },
      {
        name: 'POST /invitations/:id/resend',
        action: 'invitation.resent',
        send: async (tenant, token, staff) =>
          request(app)
            .post(
              `/api/v1/tenants/${tenant.slug}/invitations/${await pendingInvitation(tenant, staff)}/resend`
            )
            .set('Authorization', `Bearer ${token}`)
            .send({}),
      },
      {
        name: 'DELETE /invitations/:id',
        action: 'invitation.revoked',
        send: async (tenant, token, staff) =>
          request(app)
            .delete(
              `/api/v1/tenants/${tenant.slug}/invitations/${await pendingInvitation(tenant, staff)}`
            )
            .set('Authorization', `Bearer ${token}`)
            .send({}),
      },
    ]

    it.each(writes)(
      '$name: refuses 400 REASON_REQUIRED once only platform access is left, and writes nothing',
      async (write) => {
        const tenant = await ownedTenant()
        const { user: staff, token } = await staffUser('owner')
        await userMembershipRepository.create({
          userId: staff.id,
          tenantId: tenant.id,
          role: 'owner',
        })

        await withMembershipRemovedAfterResolve(staff, tenant, async () => {
          const response = await write.send(tenant, token, staff)
          expect(response.status).toBe(400)
          expect(response.body).toMatchObject({ code: 'REASON_REQUIRED' })
        })

        const rows = await sql`
          select 1 from audit_logs
          where tenant_id = ${tenant.id} and action = ${write.action} and actor_user_id = ${staff.id}`
        expect(rows).toHaveLength(0)
      }
    )

    it('DELETE /membership: answers 404 Tenant not found once only platform access is left, and records no member.left', async () => {
      const tenant = await ownedTenant()
      const { user: staff, token } = await staffUser('owner')
      await userMembershipRepository.create({
        userId: staff.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      await withMembershipRemovedAfterResolve(staff, tenant, async () => {
        const response = await request(app)
          .delete(`/api/v1/tenants/${tenant.slug}/membership`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
        expect(response.status).toBe(404)
        expect(response.body).toMatchObject({ statusCode: 404, message: 'Tenant not found' })
        expect(response.body).not.toHaveProperty('code')
      })

      const rows = await sql`
        select 1 from audit_logs where tenant_id = ${tenant.id} and action = 'member.left'`
      expect(rows).toHaveLength(0)
    })
  })

  /**
   * Red under MUTATION_PROOF=1 by design: the service's locked re-read
   * returns the role resolveTenant saw, as a service trusting that earlier
   * read would, while the first test's assertions stand.
   *
   *   MUTATION_PROOF=1 pnpm exec vitest run tests/integration/api/tenant-platform-race.test.ts   # red
   *   pnpm exec vitest run tests/integration/api/tenant-platform-race.test.ts                    # green
   */
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the stale-role test against a service that trusts the earlier read',
    async () => {
      const tenant = await ownedTenant()
      const { user: staff, token } = await staffUser('admin')
      const seen: SeenRead = {}

      await withPlatformRoleChangedAfterResolve(staff, 'demote-to-viewer', seen, async () => {
        await withMutatedMethod(
          UserMembershipRepository.prototype,
          'lockPlatformRole',
          trustingEarlierRead(seen),
          async () => {
            const response = await rename(tenant, token)
            expect(response.status).toBe(403)
            expect(response.body).toMatchObject({
              statusCode: 403,
              message: 'Insufficient permissions',
            })
          }
        )
      })

      expect(await storedName(tenant)).toBe('Acme Inc')
    }
  )
})
