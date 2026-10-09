/**
 * @file The platform tenant's member routes, which are how staff roles
 * change: owner-on-owner, the active-owner guard and step-up apply there
 * and nowhere else.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  recentAuthTokenFor,
  staleAuthTokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const createdTenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

/**
 * Change a member's role.
 * @param token - The caller's bearer token.
 * @param slug - The tenant.
 * @param userId - The member.
 * @param role - The new role.
 * @returns The response.
 */
function changeRole(token: string, slug: string, userId: string, role: string): Promise<Response> {
  return request(app)
    .patch(`/api/v1/tenants/${slug}/members/${userId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ role })
}

/**
 * Remove a member.
 * @param token - The caller's bearer token.
 * @param slug - The tenant.
 * @param userId - The member.
 * @returns The response.
 */
function removeMember(token: string, slug: string, userId: string): Promise<Response> {
  return request(app)
    .delete(`/api/v1/tenants/${slug}/members/${userId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({})
}

/**
 * Invite someone.
 * @param token - The caller's bearer token.
 * @param slug - The tenant.
 * @param role - The offered role.
 * @returns The response.
 */
function invite(token: string, slug: string, role: string): Promise<Response> {
  return request(app)
    .post(`/api/v1/tenants/${slug}/invitations`)
    .set('Authorization', `Bearer ${token}`)
    .send({ email: `invitee-${randomUUID()}@example.test`, role })
}

describe('the platform tenant member routes', () => {
  it('let an owner demote and remove another owner', async () => {
    const owner = await createTrackedStaff('owner')
    const other = await createTrackedStaff('owner')
    const third = await createTrackedStaff('owner')

    const response = await changeRole(owner.token, 'platform', other.user.id, 'admin')
    expect(response.status).toBe(200)
    const response2 = await removeMember(owner.token, 'platform', third.user.id)
    expect(response2.status).toBe(200)
  })

  it('answer 404 member_not_found for a role change or removal of a user who is not staff', async () => {
    const owner = await createTrackedStaff('owner')
    const outsider = await createTrackedUser()

    for (const response of [
      await changeRole(owner.token, 'platform', outsider.id, 'admin'),
      await removeMember(owner.token, 'platform', outsider.id),
    ]) {
      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({
        message: 'Member not found',
        code: 'member_not_found',
      })
    }
  })

  it('refuse to leave the platform without an active owner', async () => {
    const owner = await createTrackedStaff('owner')
    const inactiveOwner = await createTrackedStaff('owner', { active: false })
    // Other suites in this worker's database may have left active platform owners; park them.
    const parked = await sql<{ id: string }[]>`
      update users set active = false
      where active and id <> ${owner.user.id} and id in (
        select m.user_id from user_memberships m join tenants t on t.id = m.tenant_id
        where t.is_platform and m.role = 'owner')
      returning id`

    try {
      // Two owner rows, but only the actor can sign in.
      const response = await changeRole(owner.token, 'platform', owner.user.id, 'admin')

      expect(response.status).toBe(409)
      const roles = await sql<{ user_id: string; role: string }[]>`
        select m.user_id, m.role from user_memberships m join tenants t on t.id = m.tenant_id
        where t.is_platform and m.user_id = any(${[owner.user.id, inactiveOwner.user.id]})`
      expect(
        roles
          .map((row) => ({ userId: row.user_id, role: row.role }))
          .toSorted((a, b) => a.userId.localeCompare(b.userId))
      ).toEqual(
        [
          { userId: owner.user.id, role: 'owner' },
          { userId: inactiveOwner.user.id, role: 'owner' },
        ].toSorted((a, b) => a.userId.localeCompare(b.userId))
      )
    } finally {
      await sql`update users set active = true where id = any(${parked.map((row) => row.id)})`
    }
  })

  it('require a recent sign-in for a role change, a removal, every invitation and a resend', async () => {
    const owner = await createTrackedStaff('owner')
    const other = await createTrackedStaff('admin')
    const stale = staleAuthTokenFor(owner.user)
    const response2 = await invite(recentAuthTokenFor(owner.user), 'platform', 'admin')
    expect(response2.status).toBe(202)
    // The invite answers only a message, so read the new invitation's id back.
    const [pending] = await sql<{ id: string }[]>`
      select i.id from tenant_invitations i join tenants t on t.id = i.tenant_id
      where t.is_platform and i.accepted_at is null and i.revoked_at is null
      order by i.created_at desc, i.id desc limit 1`
    const pendingId = pending?.id ?? ''

    const responses = [
      await changeRole(stale, 'platform', other.user.id, 'viewer'),
      await removeMember(stale, 'platform', other.user.id),
      await invite(stale, 'platform', 'admin'),
      await invite(stale, 'platform', 'owner'),
      // Every platform role reads every user, tenant and address, so a viewer invitation mints staff too.
      await invite(stale, 'platform', 'viewer'),
      await invite(stale, 'platform', 'manager'),
      // A resend re-issues whatever role was offered, so it always needs step-up on the platform tenant.
      await request(app)
        .post(`/api/v1/tenants/platform/invitations/${pendingId}/resend`)
        .set('Authorization', `Bearer ${stale}`)
        .send({}),
    ]
    for (const response of responses) {
      expect(response.status).toBe(401)
      expect((response.body as { code?: string }).code).toBe(REAUTH_REQUIRED_CODE)
    }
    const response4 = await invite(recentAuthTokenFor(owner.user), 'platform', 'admin')
    expect(response4.status).toBe(202)
  })

  it('refuses a staff admin with a stale sign-in inviting a platform viewer 401, and admits a fresh one 202', async () => {
    const admin = await createTrackedStaff('admin')

    const stale = await invite(staleAuthTokenFor(admin.user), 'platform', 'viewer')
    expect(stale.status).toBe(401)
    expect((stale.body as { code?: string }).code).toBe(REAUTH_REQUIRED_CODE)

    const fresh = await invite(recentAuthTokenFor(admin.user), 'platform', 'viewer')
    expect(fresh.status).toBe(202)
  })

  it('lets a staff owner with a stale sign-in revoke a pending invitation, since it only removes a grant', async () => {
    const owner = await createTrackedStaff('owner')
    const created = await invite(recentAuthTokenFor(owner.user), 'platform', 'viewer')
    expect(created.status).toBe(202)
    const [pending] = await sql<{ id: string }[]>`
      select i.id from tenant_invitations i join tenants t on t.id = i.tenant_id
      where t.is_platform and i.accepted_at is null and i.revoked_at is null
      order by i.created_at desc, i.id desc limit 1`

    const revoked = await request(app)
      .delete(`/api/v1/tenants/platform/invitations/${pending?.id ?? ''}`)
      .set('Authorization', `Bearer ${staleAuthTokenFor(owner.user)}`)
    expect(revoked.status).toBe(200)
  })

  it('leave customer tenants as they were: no step-up, and an owner still cannot demote another owner', async () => {
    const customer = await createTrackedUser()
    const coOwner = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Customer Co',
      slug: `cust-${randomUUID()}`,
      ownerId: customer.id,
    })
    createdTenantIds.push(tenant.id)
    await userMembershipRepository.create({
      userId: coOwner.id,
      tenantId: tenant.id,
      role: 'owner',
    })
    const stale = staleAuthTokenFor(customer)

    const response = await changeRole(stale, tenant.slug, coOwner.id, 'admin')
    expect(response.status).toBe(403)
    const response2 = await invite(stale, tenant.slug, 'admin')
    expect(response2.status).toBe(202)
  })
})
