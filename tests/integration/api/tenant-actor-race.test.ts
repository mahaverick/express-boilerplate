// tests/integration/api/tenant-actor-race.test.ts
//
// The actor's own role is re-read under lock inside the service's
// transaction, not taken from request.principal. Each test changes the
// actor's membership straight after resolveTenant has read it, so
// requireRole still sees the old owner role; the write must be refused
// and must change nothing.
//
// The hook wraps UserMembershipRepository.findByUserAndTenant and fires
// once, on resolveTenant's pool read of the actor. Reads inside a
// transaction (the executor argument is set) pass through untouched.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { TenantInvitation } from '@/database/models/tenant-invitation.model'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql, type DbExecutor } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { hashToken, signAccessToken } from '@/services/session.service'
import { withMutatedMethod } from '../../helpers/mutate'
import { request } from '../../helpers/request'

const app = createApp()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const HOUR_MS = 60 * 60 * 1000

afterAll(async () => {
  // Clear anything a regression lets these requests enqueue.
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A disposable email, unique to one call.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `actor-race-${randomUUID()}@example.test`
}

/**
 * What happens to the actor's membership right after resolveTenant reads it.
 */
type ActorChange = 'demote-to-viewer' | 'remove'

/**
 * Run `run` while resolveTenant's read of the actor's membership in
 * `tenant` returns the row as read, then applies `change` to it. The
 * request therefore carries the stale role.
 * @param actor - The acting user.
 * @param tenant - The tenant the request names.
 * @param change - What to do to the actor's membership.
 * @param run - The request(s) to make while the hook is installed.
 */
async function withActorChangedAfterResolve(
  actor: User,
  tenant: Tenant,
  change: ActorChange,
  run: () => Promise<void>
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realFind = UserMembershipRepository.prototype.findByUserAndTenant
  let hasChanged = false
  const changingFind: typeof realFind = async function (
    this: UserMembershipRepository,
    userId: string,
    tenantId: string,
    executor?: DbExecutor
  ) {
    const row = await realFind.call(this, userId, tenantId, executor)
    const isResolveRead = executor === undefined && userId === actor.id && tenantId === tenant.id
    if (!hasChanged && row && isResolveRead) {
      hasChanged = true
      if (change === 'remove') {
        await userMembershipRepository.delete(row.id)
      } else {
        await userMembershipRepository.updateRole(row.id, 'viewer')
      }
    }
    return row
  }

  await withMutatedMethod(
    UserMembershipRepository.prototype,
    'findByUserAndTenant',
    changingFind,
    run
  )
  expect(hasChanged).toBe(true)
}

/**
 * A pending invitation in `tenant`, written directly.
 * @param tenant - The tenant.
 * @param invitedBy - The inviter.
 * @returns The stored row.
 */
async function seedInvitation(tenant: Tenant, invitedBy: User): Promise<TenantInvitation> {
  return db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email: uniqueEmail(),
        role: 'viewer',
        tokenHash: hashToken(randomBytes(32).toString('base64url')),
        invitedBy: invitedBy.id,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
      tx
    )
  )
}

/**
 * The stored token hash and revocation time of one invitation.
 * @param invitationId - The invitation.
 * @returns Its row's `tokenHash` and `revokedAt`.
 */
async function invitationState(
  invitationId: string
): Promise<{ tokenHash: string; revokedAt: Date | null } | undefined> {
  const [row] = await sql<{ tokenHash: string; revokedAt: Date | null }[]>`
    select token_hash as "tokenHash", revoked_at as "revokedAt"
    from tenant_invitations where id = ${invitationId}
  `
  return row
}

describe('the actor role is re-read under lock (actor changed after resolveTenant)', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdTenantIds.length > 0) {
      await sql`delete from tenants where id = any(${createdTenantIds})`
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user with a valid bearer token, tracked for cleanup.
   * @returns The user and a bearer token for it.
   */
  async function createAuthenticatedUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  /**
   * A tenant owned by a fresh actor, tracked for cleanup.
   * @returns The owner-actor, their token and the tenant.
   */
  async function ownedTenant(): Promise<{ actor: User; token: string; tenant: Tenant }> {
    const { user: actor, token } = await createAuthenticatedUser()
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId: actor.id,
    })
    createdTenantIds.push(tenant.id)
    return { actor, token, tenant }
  }

  /**
   * A fresh user added to `tenant` with `role`, bypassing the API.
   * @param tenant - The tenant.
   * @param role - The role to grant.
   * @returns The new member.
   */
  async function addMember(tenant: Tenant, role: MembershipRole): Promise<User> {
    const { user } = await createAuthenticatedUser()
    await userMembershipRepository.create({ userId: user.id, tenantId: tenant.id, role })
    return user
  }

  it('refuses a role change by an owner demoted to viewer, and the target keeps their role', async () => {
    const { actor, token, tenant } = await ownedTenant()
    const target = await addMember(tenant, 'viewer')

    await withActorChangedAfterResolve(actor, tenant, 'demote-to-viewer', async () => {
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

  it('answers 404 Tenant not found to an owner removed after resolveTenant, and changes nothing', async () => {
    const { actor, token, tenant } = await ownedTenant()
    const target = await addMember(tenant, 'viewer')

    await withActorChangedAfterResolve(actor, tenant, 'remove', async () => {
      const response = await request(app)
        .patch(`/api/v1/tenants/${tenant.slug}/members/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'editor' })

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ statusCode: 404, message: 'Tenant not found' })
    })

    const membership = await userMembershipRepository.findByUserAndTenant(target.id, tenant.id)
    expect(membership?.role).toBe('viewer')
  })

  it('refuses a removal by an owner demoted to viewer, and the target stays a member', async () => {
    const { actor, token, tenant } = await ownedTenant()
    const target = await addMember(tenant, 'viewer')

    await withActorChangedAfterResolve(actor, tenant, 'demote-to-viewer', async () => {
      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/members/${target.id}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })

    expect(await userMembershipRepository.findByUserAndTenant(target.id, tenant.id)).toBeDefined()
  })

  it('refuses an invite by an owner demoted to viewer, and records no invitation', async () => {
    const { actor, token, tenant } = await ownedTenant()

    await withActorChangedAfterResolve(actor, tenant, 'demote-to-viewer', async () => {
      const response = await request(app)
        .post(`/api/v1/tenants/${tenant.slug}/invitations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ email: uniqueEmail(), role: 'viewer' })

      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })

    const rows = await sql`select id from tenant_invitations where tenant_id = ${tenant.id}`
    expect(rows).toHaveLength(0)
  })

  it('refuses a resend by an owner demoted to viewer, and the old link survives', async () => {
    const { actor, token, tenant } = await ownedTenant()
    const invitation = await seedInvitation(tenant, actor)

    await withActorChangedAfterResolve(actor, tenant, 'demote-to-viewer', async () => {
      const response = await request(app)
        .post(`/api/v1/tenants/${tenant.slug}/invitations/${invitation.id}/resend`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })

    expect(await invitationState(invitation.id)).toEqual({
      tokenHash: invitation.tokenHash,
      // eslint-disable-next-line unicorn/no-null -- the column is SQL NULL while pending
      revokedAt: null,
    })
  })

  it('refuses a revoke by an owner demoted to viewer, and the invitation stays pending', async () => {
    const { actor, token, tenant } = await ownedTenant()
    const invitation = await seedInvitation(tenant, actor)

    await withActorChangedAfterResolve(actor, tenant, 'demote-to-viewer', async () => {
      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/invitations/${invitation.id}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ statusCode: 403, message: 'Insufficient permissions' })
    })

    const state = await invitationState(invitation.id)
    expect(state?.revokedAt).toBeNull()
  })
})
