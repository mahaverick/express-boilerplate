// tests/integration/api/tenant-platform-race.test.ts
//
// A staff user's platform role is re-read under lock inside the service's
// transaction, not taken from request.principal. Each test changes the
// staff user's platform membership straight after resolveTenant has read
// it, so requireRole still sees the old role; the write must be refused
// and must change nothing. Same shape as tenant-actor-race.test.ts, hooking
// the platform read (findPlatformRole on the pool) instead of the
// membership read.
//
// The last test is DELIBERATELY red under MUTATION_PROOF=1. It also makes
// the service's locked re-read return the row resolveTenant saw, which is
// what a service trusting that earlier read would do, and keeps the real
// test's assertions:
//
//   MUTATION_PROOF=1 pnpm exec vitest run tests/integration/api/tenant-platform-race.test.ts   # red
//   pnpm exec vitest run tests/integration/api/tenant-platform-race.test.ts                    # green
//
// Staff visits write audit rows, so afterEach clears audit_logs first.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql, type DbExecutor } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
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
 * Run `run` while resolveTenant's pool read of the staff user's platform
 * role returns the role as read, then applies `change` to their platform
 * membership. The request therefore carries the stale platform role.
 * @param staff - The staff user.
 * @param change - What to do to their platform membership.
 * @param seen - Receives the role resolveTenant read.
 * @param run - The request(s) to make while the hook is installed.
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
 * A locked re-read that returns the role resolveTenant saw: a service that
 * trusted the earlier read.
 * @param seen - The role resolveTenant read.
 * @returns A stand-in for lockPlatformRole.
 */
function trustingEarlierRead(seen: SeenRead): UserMembershipRepository['lockPlatformRole'] {
  // eslint-disable-next-line unicorn/no-null -- the platform-role contract is `MembershipRole | null`.
  return () => Promise.resolve(seen.role ?? null)
}

/**
 * The tenant's stored name.
 * @param tenant - The tenant.
 * @returns Its name column.
 */
async function storedName(tenant: Tenant): Promise<string | undefined> {
  const [row] = await sql<{ name: string }[]>`select name from tenants where id = ${tenant.id}`
  return row?.name
}

/**
 * PATCH the tenant's name as the bearer of `token`.
 * @param tenant - The tenant.
 * @param token - The caller's token.
 * @returns The response status and body.
 */
async function rename(tenant: Tenant, token: string): Promise<{ status: number; body: unknown }> {
  const response = await request(app)
    .patch(`/api/v1/tenants/${tenant.slug}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Renamed on a stale role' })
  return { status: response.status, body: response.body as unknown }
}

describe('the staff role is re-read under lock (platform role changed after resolveTenant)', () => {
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
   * @returns The user and token.
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
   * @returns The tenant.
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
   * A fresh staff user with `role`, and a token.
   * @param role - The platform role.
   * @returns The user and token.
   */
  async function staffUser(role: MembershipRole): Promise<{ user: User; token: string }> {
    const staff = await createAuthenticatedUser()
    await makeStaff(staff.user.id, role)
    return staff
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
    const { user: staff, token } = await staffUser('owner')

    await withPlatformRoleChangedAfterResolve(staff, 'demote-to-viewer', {}, async () => {
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'editor' })
      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })

    const membership = await userMembershipRepository.findByUserAndTenant(target.id, tenant.id)
    expect(membership?.role).toBe('viewer')
  })

  // Always on: the locked re-read is the only thing refusing the stale role.
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

  // DELIBERATELY red under MUTATION_PROOF=1: the first test's own assertions,
  // against a service that trusts resolveTenant's read.
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
