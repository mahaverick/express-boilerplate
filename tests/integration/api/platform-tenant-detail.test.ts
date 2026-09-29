/**
 * @file GET /api/v1/platform/tenants/:id: one customer tenant in any
 * lifecycle state, for the Apex detail page.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

interface DetailBody {
  id: string
  name: string
  slug: string
  description: string | null
  website: string | null
  logo: string | null
  lifecycleState: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  settings: { timezone: string; locale: string }
  memberCount: number
  owners: {
    userId: string
    email: string
    firstName: string | null
    lastName: string | null
    active: boolean
  }[]
  pendingInvitationCount: number
  pendingOwnerInvitation: { id: string; email: string; expiresAt: string } | null
}

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

function detailOf(response: Response): DetailBody {
  const data = (response.body as { data?: DetailBody }).data
  if (!data) throw new Error(`no data (status ${response.status})`)
  return data
}

function get(token: string, id: string): Promise<Response> {
  return request(app).get(`/api/v1/platform/tenants/${id}`).set('Authorization', `Bearer ${token}`)
}

describe('GET /api/v1/platform/tenants/:id', () => {
  const tenantIds: string[] = []
  const userIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
    if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
    tenantIds.length = 0
    userIds.length = 0
  })

  async function createUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({
      email: `detail-${randomUUID()}@example.test`,
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
    userIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID(), new Date()) }
  }

  async function staffToken(role: MembershipRole = 'viewer'): Promise<string> {
    const { user, token } = await createUser()
    await makeStaff(user.id, role)
    return token
  }

  async function createTenant(): Promise<{ tenant: Tenant; owner: User }> {
    const { user: owner } = await createUser()
    const tenant = await tenantRepository.create({
      name: `Detail ${randomUUID().slice(0, 8)}`,
      slug: `detail-${randomUUID()}`,
      website: 'https://example.test',
      ownerId: owner.id,
    })
    tenantIds.push(tenant.id)
    return { tenant, owner }
  }

  it('returns the contract fields, settings, live owners and counts', async () => {
    const { tenant, owner } = await createTenant()
    const { user: gone } = await createUser()
    await userMembershipRepository.create({ userId: gone.id, tenantId: tenant.id, role: 'owner' })
    await sql`update users set deleted_at = now() where id = ${gone.id}`
    await sql`insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
      values (${tenant.id}, ${'owner-next@example.test'}, 'owner', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day'),
             (${tenant.id}, ${'viewer@example.test'}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day'),
             (${tenant.id}, ${'expired@example.test'}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() - interval '1 day')`

    const response = await get(await staffToken(), tenant.id)

    expect(response.status).toBe(200)
    const body = detailOf(response)
    expect(body).toMatchObject({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      website: 'https://example.test',
      lifecycleState: 'active',
      // eslint-disable-next-line unicorn/no-null -- JSON null: a live tenant
      deletedAt: null,
      settings: { timezone: 'UTC', locale: 'en' },
      memberCount: 1,
      pendingInvitationCount: 2,
    })
    expect(body.owners).toEqual([
      {
        userId: owner.id,
        email: owner.email,
        firstName: 'Ada',
        lastName: 'Lovelace',
        active: true,
      },
    ])
    expect(body.pendingOwnerInvitation).toMatchObject({ email: 'owner-next@example.test' })
  })

  it('lists a deactivated owner with active: false, so staff can see the tenant has no owner who can sign in', async () => {
    const { tenant, owner } = await createTenant()
    await sql`update users set active = false where id = ${owner.id}`

    const body = detailOf(await get(await staffToken(), tenant.id))

    expect(body.owners).toEqual([expect.objectContaining({ userId: owner.id, active: false })])
  })

  it('returns a suspended tenant and an archived (soft-deleted) one', async () => {
    const { tenant: suspended } = await createTenant()
    const { tenant: archived } = await createTenant()
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${suspended.id}`
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${archived.id}`
    const token = await staffToken()

    expect(detailOf(await get(token, suspended.id)).lifecycleState).toBe('suspended')
    const archivedBody = detailOf(await get(token, archived.id))
    expect(archivedBody.lifecycleState).toBe('archived')
    expect(archivedBody.deletedAt).not.toBeNull()
  })

  it('answers 404 for the platform tenant, an unknown id and a malformed id', async () => {
    const token = await staffToken()
    const platform = await platformTenant()

    const response = await get(token, platform.id)
    expect(response.status).toBe(404)
    const response2 = await get(token, randomUUID())
    expect(response2.status).toBe(404)
    const response3 = await get(token, 'not-a-uuid')
    expect(response3.status).toBe(404)
  })

  it('answers 404 to a non-staff user', async () => {
    const { tenant } = await createTenant()
    const { token } = await createUser()

    const response = await get(token, tenant.id)
    expect(response.status).toBe(404)
  })
})
