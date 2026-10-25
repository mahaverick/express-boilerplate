/**
 * @file `GET /tenants/:slug/entitlements` and the plan-gated
 * `GET /tenants/:slug/insights`, end to end against the real database.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { db, sql } from '@/services/database.service'
import { hashToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { putTenantOnPaid } from '../../helpers/billing'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const membershipRepository = new UserMembershipRepository()
const invitationRepository = new TenantInvitationRepository()

const DAY_MS = 24 * 60 * 60 * 1000
const tenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

/**
 * A Free workspace and its owner.
 * @returns The workspace and the owner.
 */
async function workspace(): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Insights Co',
    slug: `bill-ent-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  return { tenant, owner }
}

/**
 * GET a tenant path as `user`.
 * @param user - The caller.
 * @param path - The path after `/api/v1/tenants/`.
 * @returns The response.
 */
function getAs(user: User, path: string) {
  return request(app)
    .get(`/api/v1/tenants/${path}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
}

describe('GET /api/v1/tenants/:slug/entitlements', () => {
  it('answers a viewer with the Free entitlements and no sources', async () => {
    const { tenant } = await workspace()
    const viewer = await createTrackedUser()
    await membershipRepository.create({ userId: viewer.id, tenantId: tenant.id, role: 'viewer' })

    const response = await getAs(viewer, `${tenant.slug}/entitlements`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      success: true,
      data: {
        plan: { key: 'free', name: 'Free' },
        state: 'free',
        trialEndsAt: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        pastDue: null,
        features: { advanced_example: false },
        limits: { members: { limit: 3, used: 2, approaching: false } },
      },
    })
    expect((response.body as { data: object }).data).not.toHaveProperty('sources')
  })

  it('answers staff reading through platform access', async () => {
    const { tenant } = await workspace()
    const { user } = await createTrackedStaff('viewer')

    const response = await getAs(user, `${tenant.slug}/entitlements`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { plan: { key: 'free' } } })
  })

  it('answers a non-member the tenant 404', async () => {
    const { tenant } = await workspace()
    const stranger = await createTrackedUser()

    const response = await getAs(stranger, `${tenant.slug}/entitlements`)

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'tenant_not_found' })
  })
})

describe('GET /api/v1/tenants/:slug/insights', () => {
  it('refuses a Free workspace with 402 PLAN_FEATURE_REQUIRED and the feature key', async () => {
    const { tenant, owner } = await workspace()

    const response = await getAs(owner, `${tenant.slug}/insights`)

    expect(response.status).toBe(402)
    expect(response.body).toMatchObject({
      success: false,
      statusCode: 402,
      code: 'PLAN_FEATURE_REQUIRED',
      message: 'Workspace insights is included in Paid. Upgrade to use it.',
      details: { key: 'advanced_example' },
    })
  })

  it('answers a Paid workspace with the joins and invitations of the last 30 days', async () => {
    const { tenant, owner } = await workspace()
    await putTenantOnPaid(tenant.id)
    const old = await createTrackedUser()
    await membershipRepository.create({ userId: old.id, tenantId: tenant.id, role: 'viewer' })
    await sql`update user_memberships set created_at = now() - interval '40 days' where user_id = ${old.id}`
    for (const email of [`a-${randomUUID()}@example.test`, `b-${randomUUID()}@example.test`]) {
      await db.transaction((tx) =>
        invitationRepository.createPending(
          {
            tenantId: tenant.id,
            email,
            role: 'viewer',
            tokenHash: hashToken(randomBytes(32).toString('base64url')),
            invitedBy: owner.id,
            expiresAt: new Date(Date.now() + DAY_MS),
          },
          tx
        )
      )
    }
    await sql`update tenant_invitations set created_at = now() - interval '31 days' where id = (
      select id from tenant_invitations where tenant_id = ${tenant.id} order by created_at limit 1)`

    const response = await getAs(owner, `${tenant.slug}/insights`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      data: { membersJoinedLast30Days: 1, invitationsSentLast30Days: 1 },
    })
  })
})
