/**
 * @file Deactivate, reactivate, sign-out and delete, through the API: the
 * role and step-up gates, reasons, self and staff-on-staff refusals, the
 * last-owner guards, and that every live session ends at once.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  staleAuthTokenFor,
  TEST_PASSWORD,
} from '../../helpers/platform-users'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'

interface ApiEnvelope<TData> {
  success: boolean
  message: string
  code?: string
  data?: TData
}

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const createdTenantIds: string[] = []
const REASON = 'Ticket #4411: account compromise'

function action(token: string, userId: string, verb: string, body?: object): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform/users/${userId}/${verb}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body ?? { reason: REASON })
}

function remove(token: string, userId: string, body?: object): Promise<Response> {
  return request(app)
    .delete(`/api/v1/platform/users/${userId}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body ?? { reason: REASON })
}

/**
 * Sign `user` in through the real endpoint: a live session with a refresh cookie.
 * @param user - A user with TEST_PASSWORD.
 * @returns The access token and the refresh cookie pair.
 */
async function signIn(user: User): Promise<{ accessToken: string; refreshCookie: string }> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: TEST_PASSWORD })
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`)
  const accessToken = (response.body as ApiEnvelope<{ accessToken: string }>).data?.accessToken
  const cookieName = testRefreshCookie().name
  const line = (response.headers['set-cookie'] as unknown as string[]).find((cookie) =>
    cookie.startsWith(`${cookieName}=`)
  )
  if (!accessToken || !line) throw new Error('login returned no session')
  return { accessToken, refreshCookie: line.split(';', 1)[0] as string }
}

async function sessionStatuses(session: {
  accessToken: string
  refreshCookie: string
}): Promise<{ access: number; refresh: number }> {
  const profile = await request(app)
    .get('/api/v1/profile')
    .set('Authorization', `Bearer ${session.accessToken}`)
  const refresh = await request(app)
    .post('/api/v1/auth/refresh')
    .set('Cookie', session.refreshCookie)
  return { access: profile.status, refresh: refresh.status }
}

async function auditActions(targetId: string): Promise<{ action: string; metadata: unknown }[]> {
  return sql<{ action: string; metadata: unknown }[]>`
    select action, metadata from audit_logs where target_id = ${targetId} order by occurred_at, id
  `
}

/**
 * A pending invitation sent by `inviterId` into a fresh tenant where they are
 * an admin. Another user owns it, so the inviter is never its last owner.
 * @param inviterId - The inviting user (made admin of the tenant).
 * @returns The invitation's id.
 */
async function pendingInvitationFrom(inviterId: string): Promise<string> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: `Inviter ${randomUUID()}`,
    slug: `pu-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  await userMembershipRepository.create({ userId: inviterId, tenantId: tenant.id, role: 'admin' })
  const [row] = await sql<{ id: string }[]>`
    insert into tenant_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
    values (${tenant.id}, ${`invitee-${randomUUID()}@example.test`}, 'viewer',
      ${randomUUID().replaceAll('-', '').padEnd(64, '0')}, ${inviterId}, now() + interval '1 day')
    returning id
  `
  if (!row) throw new Error('no invitation inserted')
  return row.id
}

/**
 * Whether an invitation is revoked.
 * @param invitationId - The invitation.
 * @returns True when `revoked_at` is set.
 */
async function isRevoked(invitationId: string): Promise<boolean> {
  const [row] = await sql<{ revoked: boolean }[]>`
    select revoked_at is not null as revoked from tenant_invitations where id = ${invitationId}
  `
  return row?.revoked === true
}

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('POST /api/v1/platform/users/:id/deactivate', () => {
  it('deactivates, ends every live session at once, revokes the invitations they sent and audits the reason', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ hasPassword: true })
    const session = await signIn(target)
    const sent = await pendingInvitationFrom(target.id)

    const response = await action(token, target.id, 'deactivate')

    expect(response.status).toBe(200)
    expect(await isRevoked(sent)).toBe(true)
    expect((response.body as ApiEnvelope<{ active: boolean }>).data?.active).toBe(false)
    expect(await sessionStatuses(session)).toEqual({ access: 401, refresh: 401 })
    expect(await auditActions(target.id)).toEqual([
      { action: 'user.deactivated', metadata: { reason: REASON } },
    ])
  })

  it('keeps old sessions dead after a reactivation', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ hasPassword: true })
    const session = await signIn(target)

    await action(token, target.id, 'deactivate')
    const reactivated = await action(token, target.id, 'reactivate')

    expect(reactivated.status).toBe(200)
    // The user is active again, so only the denylist can refuse the old token.
    expect(await sessionStatuses(session)).toEqual({ access: 401, refresh: 401 })
  })

  it('answers 401 REAUTH_REQUIRED on a stale step-up and changes nothing', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await createTrackedUser()

    const response = await action(staleAuthTokenFor(admin), target.id, 'deactivate')

    expect(response.status).toBe(401)
    expect((response.body as ApiEnvelope<unknown>).code).toBe(REAUTH_REQUIRED_CODE)
    const [row] = await sql`select active from users where id = ${target.id}`
    expect(row?.active).toBe(true)
  })

  it('answers 400 for a missing, blank or over-long reason', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser()

    const response = await action(token, target.id, 'deactivate', {})
    expect(response.status).toBe(400)
    const response2 = await action(token, target.id, 'deactivate', { reason: ' '.repeat(3) })
    expect(response2.status).toBe(400)
    const response3 = await action(token, target.id, 'deactivate', { reason: 'x'.repeat(501) })
    expect(response3.status).toBe(400)
  })

  it('answers 409 for self and an already inactive user, and lets one of two owners deactivate the other', async () => {
    const owner = await createTrackedStaff('owner')
    const otherOwner = await createTrackedStaff('owner')
    const inactive = await createTrackedUser({ active: false })

    const self = await action(owner.token, owner.user.id, 'deactivate')
    expect(self.status).toBe(409)
    expect((self.body as ApiEnvelope<unknown>).message).toBe(
      'You cannot deactivate your own account'
    )

    const again = await action(owner.token, inactive.id, 'deactivate')
    expect(again.status).toBe(409)
    expect((again.body as ApiEnvelope<unknown>).message).toBe('User is already inactive')

    // One active owner (the actor) remains; the last-owner guard is tested in platform-user-race.test.ts.
    const response = await action(owner.token, otherOwner.user.id, 'deactivate')
    expect(response.status).toBe(200)
  })

  it.each(['deactivate', 'reactivate', 'sign-out', 'delete'] as const)(
    '%s: a staff admin is refused a staff owner or another admin (403); an owner may act on another owner',
    async (verb) => {
      const admin = await createTrackedStaff('admin')
      const owner = await createTrackedStaff('owner')
      const otherAdmin = await createTrackedStaff('admin')
      const otherOwner = await createTrackedStaff('owner', {
        hasPassword: true,
        active: verb !== 'reactivate',
      })
      const send = (token: string, userId: string): Promise<Response> =>
        verb === 'delete' ? remove(token, userId) : action(token, userId, verb)

      const response = await send(admin.token, owner.user.id)
      expect(response.status).toBe(403)
      const response2 = await send(admin.token, otherAdmin.user.id)
      expect(response2.status).toBe(403)
      const response3 = await send(owner.token, otherOwner.user.id)
      expect(response3.status).toBe(200)
    }
  )

  it('refuses a platform viewer with 404', async () => {
    const { token } = await createTrackedStaff('viewer')
    const target = await createTrackedUser()

    const response = await action(token, target.id, 'deactivate')
    expect(response.status).toBe(404)
  })
})

describe('POST /api/v1/platform/users/:id/reactivate', () => {
  it('answers 409 for a user who is already active', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser()

    const response = await action(token, target.id, 'reactivate')

    expect(response.status).toBe(409)
    expect((response.body as ApiEnvelope<unknown>).message).toBe('User is already active')
  })
})

describe('POST /api/v1/platform/users/:id/sign-out', () => {
  it('ends every session of an active user and audits it', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ hasPassword: true })
    const first = await signIn(target)
    const second = await signIn(target)

    const response = await action(token, target.id, 'sign-out')

    expect(response.status).toBe(200)
    // The user is still active: the 401s come from revocation and the denylist.
    expect(await sessionStatuses(first)).toEqual({ access: 401, refresh: 401 })
    expect(await sessionStatuses(second)).toEqual({ access: 401, refresh: 401 })
    expect(await auditActions(target.id)).toEqual([
      { action: 'user.signed_out', metadata: { reason: REASON } },
    ])
  })

  it('refuses to sign the actor out of their own account (409)', async () => {
    const { user, token } = await createTrackedStaff('admin')

    const response = await action(token, user.id, 'sign-out')

    expect(response.status).toBe(409)
    expect((response.body as ApiEnvelope<unknown>).message).toBe(
      'Sign out from your profile instead'
    )
  })
})

describe('DELETE /api/v1/platform/users/:id', () => {
  it('soft-deletes, ends every session, frees the address fully and audits the reason', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ hasPassword: true })
    const session = await signIn(target)
    await sql`
      insert into auth_providers (user_id, provider, provider_id)
      values (${target.id}, 'google', ${randomUUID()})
    `
    const sent = await pendingInvitationFrom(target.id)

    const response = await remove(token, target.id)

    expect(response.status).toBe(200)
    const [row] = await sql`select deleted_at from users where id = ${target.id}`
    expect(row?.deleted_at).not.toBeNull()
    const google = await sql`
      select 1 from auth_providers where user_id = ${target.id} and provider = 'google'
    `
    expect(google).toHaveLength(0)
    expect(await isRevoked(sent)).toBe(true)
    expect(await sessionStatuses(session)).toEqual({ access: 401, refresh: 401 })
    expect(await auditActions(target.id)).toEqual([
      { action: 'user.deleted', metadata: { reason: REASON } },
    ])
  })

  it('refuses a platform viewer with 404 (soft delete is an admin action)', async () => {
    const { token } = await createTrackedStaff('viewer')
    const target = await createTrackedUser()

    const response = await remove(token, target.id)
    expect(response.status).toBe(404)
  })

  it('refuses the last owner of a customer tenant with 409 naming it, and allows it once a second owner exists', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Lonely Owner Ltd',
      slug: `pu-${randomUUID()}`,
      ownerId: target.id,
    })
    createdTenantIds.push(tenant.id)

    const refused = await remove(token, target.id)
    expect(refused.status).toBe(409)
    expect((refused.body as ApiEnvelope<unknown>).message).toBe(
      'Cannot delete the last owner of: Lonely Owner Ltd'
    )

    const coOwner = await createTrackedUser()
    await userMembershipRepository.create({
      userId: coOwner.id,
      tenantId: tenant.id,
      role: 'owner',
    })
    const response = await remove(token, target.id)
    expect(response.status).toBe(200)
  })

  it('refuses to delete oneself (409)', async () => {
    const owner = await createTrackedStaff('owner')

    const self = await remove(owner.token, owner.user.id)

    expect(self.status).toBe(409)
    expect((self.body as ApiEnvelope<unknown>).message).toBe('You cannot delete your own account')
  })

  it('answers 401 REAUTH_REQUIRED on a stale step-up', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await createTrackedUser()

    const response = await remove(staleAuthTokenFor(admin), target.id)

    expect(response.status).toBe(401)
    expect((response.body as ApiEnvelope<unknown>).code).toBe(REAUTH_REQUIRED_CODE)
  })

  it('answers 404 once the user is gone', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser()

    const response = await remove(token, target.id)
    expect(response.status).toBe(200)
    const response2 = await remove(token, target.id)
    expect(response2.status).toBe(404)
  })
})
