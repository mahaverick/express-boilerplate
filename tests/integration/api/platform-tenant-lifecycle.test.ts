/**
 * @file Staff suspend, reactivate and archive a customer tenant. Suspension
 * takes effect on the members' next request, because `resolveTenant` reads
 * the state every time.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()
const ELEVEN_MINUTES_MS = 11 * 60 * 1000

function act(
  token: string,
  tenantId: string,
  verb: 'suspend' | 'reactivate' | 'archive',
  reason = 'Support ticket 42'
): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform/tenants/${tenantId}/${verb}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason })
}

function memberGet(token: string, slug: string): Promise<Response> {
  return request(app).get(`/api/v1/tenants/${slug}`).set('Authorization', `Bearer ${token}`)
}

describe('tenant lifecycle', () => {
  const userIds: string[] = []
  const tenantIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
    if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
    tenantIds.length = 0
    userIds.length = 0
  })

  async function createUser(authenticatedAt = new Date()): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({
      email: `life-${randomUUID()}@example.test`,
      emailVerifiedAt: new Date(),
    })
    userIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID(), authenticatedAt) }
  }

  async function staff(
    role: MembershipRole,
    authenticatedAt = new Date()
  ): Promise<{ user: User; token: string }> {
    const created = await createUser(authenticatedAt)
    await makeStaff(created.user.id, role)
    return created
  }

  async function tenantWithMember(): Promise<{ tenant: Tenant; memberToken: string }> {
    const { user, token } = await createUser()
    const tenant = await tenantRepository.create({
      name: 'Life Co',
      slug: `life-${randomUUID()}`,
      ownerId: user.id,
    })
    tenantIds.push(tenant.id)
    return { tenant, memberToken: token }
  }

  it('suspend hides the tenant from its members at once; reactivate restores it', async () => {
    const { token } = await staff('admin')
    const { tenant, memberToken } = await tenantWithMember()
    const response = await memberGet(memberToken, tenant.slug)
    expect(response.status).toBe(200)

    const suspended = await act(token, tenant.id, 'suspend')
    expect(suspended.status).toBe(200)
    expect((suspended.body as { data: { lifecycleState: string } }).data.lifecycleState).toBe(
      'suspended'
    )
    const response2 = await memberGet(memberToken, tenant.slug)
    expect(response2.status).toBe(404)

    const reactivated = await act(token, tenant.id, 'reactivate')
    expect(reactivated.status).toBe(200)
    const response3 = await memberGet(memberToken, tenant.slug)
    expect(response3.status).toBe(200)
  })

  it('audits each transition with the reason and platform access', async () => {
    const { user: admin, token } = await staff('admin')
    const { tenant } = await tenantWithMember()

    await act(token, tenant.id, 'suspend', 'Chargeback')
    await act(token, tenant.id, 'reactivate', 'Resolved')

    const rows = await sql`select action, access, actor_user_id, target_id, metadata from audit_logs
      where tenant_id = ${tenant.id} and action like 'tenant.%' order by occurred_at, id`
    expect(rows).toEqual([
      {
        action: 'tenant.suspended',
        access: 'platform',
        actor_user_id: admin.id,
        target_id: tenant.id,
        metadata: { reason: 'Chargeback' },
      },
      {
        action: 'tenant.reactivated',
        access: 'platform',
        actor_user_id: admin.id,
        target_id: tenant.id,
        metadata: { reason: 'Resolved' },
      },
    ])
  })

  it('answers 409 with the current state for an invalid transition', async () => {
    const { token } = await staff('owner')
    const { tenant } = await tenantWithMember()

    const reactivateActive = await act(token, tenant.id, 'reactivate')
    expect(reactivateActive.status).toBe(409)
    expect((reactivateActive.body as { code?: string }).code).toBe('tenant_state_conflict')

    await act(token, tenant.id, 'suspend')
    const response = await act(token, tenant.id, 'suspend')
    expect(response.status).toBe(409)
  })

  it('archive is terminal, soft-deletes, revokes pending invitations, audits the reason and frees the slug', async () => {
    const { user: admin, token } = await staff('admin')
    const { tenant } = await tenantWithMember()
    await sql`insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
      values (${tenant.id}, ${'pending@example.test'}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day')`

    const archived = await act(token, tenant.id, 'archive')

    expect(archived.status).toBe(200)
    const body = (archived.body as { data: { lifecycleState: string; deletedAt: string | null } })
      .data
    expect(body.lifecycleState).toBe('archived')
    expect(body.deletedAt).not.toBeNull()
    const [pending] = await sql`select count(*)::int as n from tenant_invitations
      where tenant_id = ${tenant.id} and accepted_at is null and revoked_at is null`
    expect(pending?.n).toBe(0)
    const [audit] = await sql`select access, actor_user_id, metadata from audit_logs
      where tenant_id = ${tenant.id} and action = 'tenant.archived'`
    expect(audit).toEqual({
      access: 'platform',
      actor_user_id: admin.id,
      metadata: { reason: 'Support ticket 42' },
    })
    const response = await act(token, tenant.id, 'reactivate')
    expect(response.status).toBe(409)
    const response2 = await act(token, tenant.id, 'archive')
    expect(response2.status).toBe(409)

    const { user: other } = await createUser()
    const reused = await tenantRepository.create({
      name: 'Reuse',
      slug: tenant.slug,
      ownerId: other.id,
    })
    tenantIds.push(reused.id)
    expect(reused.slug).toBe(tenant.slug)
  })

  it('archives a suspended tenant', async () => {
    const { token } = await staff('owner')
    const { tenant } = await tenantWithMember()
    await act(token, tenant.id, 'suspend')

    const response = await act(token, tenant.id, 'archive')
    expect(response.status).toBe(200)
  })

  it('refuses the platform tenant with 409', async () => {
    const { token } = await staff('owner')
    const platform = await platformTenant()

    for (const verb of ['suspend', 'reactivate', 'archive'] as const) {
      const response = await act(token, platform.id, verb)
      expect(response.status).toBe(409)
    }
    const result = await platformTenant()
    expect(result.lifecycleState).toBe('active')
  })

  it('answers 404 for an unknown or malformed id', async () => {
    const { token } = await staff('owner')

    const response = await act(token, randomUUID(), 'suspend')
    expect(response.status).toBe(404)
    const response2 = await act(token, 'nope', 'suspend')
    expect(response2.status).toBe(404)
  })

  it('requires a reason', async () => {
    const { token } = await staff('admin')
    const { tenant } = await tenantWithMember()

    const response = await act(token, tenant.id, 'suspend', ' '.repeat(3))
    expect(response.status).toBe(400)
    const response2 = await act(token, tenant.id, 'suspend', 'x'.repeat(501))
    expect(response2.status).toBe(400)
  })

  it('refuses a platform viewer, and gates suspend and archive on a recent sign-in', async () => {
    const { token: viewerToken } = await staff('viewer')
    const { token: staleOwner } = await staff('owner', new Date(Date.now() - ELEVEN_MINUTES_MS))
    const { tenant } = await tenantWithMember()

    for (const verb of ['suspend', 'reactivate', 'archive'] as const) {
      const response = await act(viewerToken, tenant.id, verb)
      expect(response.status).toBe(404)
    }
    for (const verb of ['suspend', 'archive'] as const) {
      const stale = await act(staleOwner, tenant.id, verb)
      expect(stale.status).toBe(401)
      expect((stale.body as { code?: string }).code).toBe(REAUTH_REQUIRED_CODE)
    }
    // Reactivate carries no step-up.
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenant.id}`
    const response2 = await act(staleOwner, tenant.id, 'reactivate')
    expect(response2.status).toBe(200)
  })
})
