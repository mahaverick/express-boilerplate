/**
 * @file The customer onboarding API: any member and staff read; a member
 * ticks their own manual step; only an owner by membership dismisses and
 * restores; staff acting through platform access write nothing; each refusal
 * carries its code; dismissals are audited in the tenant; a settings save
 * ticks its step before the response returns.
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
import { sql } from '@/services/database.service'
import type { TenantOnboardingView } from '@/types/onboarding'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const tenantIds: string[] = []
// eslint-disable-next-line unicorn/no-null -- JSON null, as the API and the database return it
const NONE = null

afterEach(async () => {
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

/**
 * A tracked, started tenant and its owner.
 * @returns Both, and the owner's token.
 */
async function ownedTenant(): Promise<{ owner: User; ownerToken: string; tenant: Tenant }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Onboarding Co',
    slug: `onboarding-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  return { owner, ownerToken: tokenFor(owner), tenant }
}

/**
 * A new member of `tenant` with `role`, and their token.
 * @param tenant - The tenant.
 * @param role - Their role.
 * @returns Their token.
 */
async function memberToken(tenant: Tenant, role: MembershipRole): Promise<string> {
  const user = await createTrackedUser()
  await userMembershipRepository.create({ userId: user.id, tenantId: tenant.id, role })
  return tokenFor(user)
}

/**
 * `GET /tenants/:slug/onboarding`.
 * @param tenant - The tenant.
 * @param token - The caller's bearer token.
 * @returns The response.
 */
function readOnboarding(tenant: Tenant, token: string): Promise<Response> {
  return request(app)
    .get(`/api/v1/tenants/${tenant.slug}/onboarding`)
    .set('Authorization', `Bearer ${token}`)
}

/**
 * A POST under `/tenants/:slug/onboarding`, with no body.
 * @param tenant - The tenant.
 * @param path - The path after `/onboarding`.
 * @param token - The caller's bearer token.
 * @returns The response.
 */
function postOnboarding(tenant: Tenant, path: string, token: string): Promise<Response> {
  return request(app)
    .post(`/api/v1/tenants/${tenant.slug}/onboarding${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send()
}

/**
 * The view a response carries.
 * @param response - The response.
 * @returns Its `data`.
 */
function viewOf(response: Response): TenantOnboardingView {
  return (response.body as { data: TenantOnboardingView }).data
}

/**
 * One step of a view.
 * @param view - The view.
 * @param key - The step key.
 * @returns The step.
 */
function stepOf(view: TenantOnboardingView, key: string): TenantOnboardingView['steps'][number] {
  const found = view.steps.find((entry) => entry.key === key)
  if (!found) throw new Error(`no ${key} step`)
  return found
}

/**
 * The response's error code.
 * @param response - The response.
 * @returns Its `code`.
 */
function codeOf(response: Response): unknown {
  return (response.body as { code?: unknown }).code
}

describe('GET /tenants/:slug/onboarding', () => {
  it('serves every member the registry in order with tenant progress', async () => {
    const { tenant } = await ownedTenant()
    const viewerToken = await memberToken(tenant, 'viewer')

    const response = await readOnboarding(tenant, viewerToken)

    expect(response.status).toBe(200)
    expect(viewOf(response)).toMatchObject({
      state: 'in_progress',
      requiredDone: 0,
      requiredTotal: 2,
      completedAt: NONE,
      dismissedAt: NONE,
    })
    expect(viewOf(response).steps.map((entry) => [entry.key, entry.kind, entry.required])).toEqual([
      ['configure_settings', 'auto', true],
      ['invite_teammate', 'auto', true],
      ['teammate_joined', 'auto', false],
      ['read_getting_started', 'manual', false],
    ])
  })

  it('lets staff read through platform access, with no member step of their own', async () => {
    const { ownerToken, tenant } = await ownedTenant()
    await postOnboarding(tenant, '/steps/read_getting_started/complete', ownerToken)
    const { token: staffToken } = await createTrackedStaff('viewer')

    const response = await readOnboarding(tenant, staffToken)

    expect(response.status).toBe(200)
    expect(stepOf(viewOf(response), 'read_getting_started')).toMatchObject({
      completedAt: NONE,
      source: NONE,
    })
  })

  it('answers 404 to a non-member', async () => {
    const { tenant } = await ownedTenant()
    const outsider = await createTrackedUser()

    const response = await readOnboarding(tenant, tokenFor(outsider))

    expect(response.status).toBe(404)
  })

  it('ticks configure_settings by the time a settings save has answered', async () => {
    const { ownerToken, tenant } = await ownedTenant()

    const saved = await request(app)
      .patch(`/api/v1/tenants/${tenant.slug}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ timezone: 'Europe/Paris' })
    const response = await readOnboarding(tenant, ownerToken)

    expect(saved.status).toBe(200)
    expect(stepOf(viewOf(response), 'configure_settings').source).toBe('auto')
    expect(viewOf(response).requiredDone).toBe(1)
  })
})

describe('POST /tenants/:slug/onboarding/steps/:key/complete', () => {
  it('completes the manual member step for the caller only, and a repeat changes nothing', async () => {
    const { ownerToken, tenant } = await ownedTenant()
    const viewerToken = await memberToken(tenant, 'viewer')

    const ticked = await postOnboarding(tenant, '/steps/read_getting_started/complete', viewerToken)
    const repeat = await postOnboarding(tenant, '/steps/read_getting_started/complete', viewerToken)
    const asOwner = await readOnboarding(tenant, ownerToken)

    expect(ticked.status).toBe(200)
    expect(stepOf(viewOf(ticked), 'read_getting_started')).toMatchObject({ source: 'customer' })
    expect(repeat.status).toBe(200)
    expect(stepOf(viewOf(asOwner), 'read_getting_started').completedAt).toBeNull()
    expect(
      await sql`select 1 from onboarding_completions where tenant_id = ${tenant.id}`
    ).toHaveLength(1)
  })

  it.each([
    ['an auto step', 'configure_settings', 409, 'not_manual'],
    ['an unknown step', 'verify_email', 404, 'onboarding_step_not_found'],
  ])('refuses %s', async (_label, key, status, code) => {
    const { ownerToken, tenant } = await ownedTenant()

    const response = await postOnboarding(tenant, `/steps/${key}/complete`, ownerToken)

    expect(response.status).toBe(status)
    expect(codeOf(response)).toBe(code)
  })

  it('answers 400 to a malformed step key', async () => {
    const { ownerToken, tenant } = await ownedTenant()

    const response = await postOnboarding(tenant, '/steps/Not-A-Key/complete', ownerToken)

    expect(response.status).toBe(400)
  })

  it('answers 409 not_tracked on an untracked tenant', async () => {
    const { ownerToken, tenant } = await ownedTenant()
    await sql`update tenants set onboarding_tracked = false where id = ${tenant.id}`

    const response = await postOnboarding(
      tenant,
      '/steps/read_getting_started/complete',
      ownerToken
    )

    expect(response.status).toBe(409)
    expect(codeOf(response)).toBe('not_tracked')
  })

  it('still records in a dismissed tenant', async () => {
    const { ownerToken, tenant } = await ownedTenant()
    await postOnboarding(tenant, '/dismiss', ownerToken)

    const response = await postOnboarding(
      tenant,
      '/steps/read_getting_started/complete',
      ownerToken
    )

    expect(response.status).toBe(200)
    expect(stepOf(viewOf(response), 'read_getting_started').source).toBe('customer')
  })

  it('answers 404 to a staff owner acting through platform access, and writes nothing', async () => {
    const { tenant } = await ownedTenant()
    const { token: staffToken } = await createTrackedStaff('owner')

    const response = await postOnboarding(
      tenant,
      '/steps/read_getting_started/complete',
      staffToken
    )

    expect(response.status).toBe(404)
    expect(
      await sql`select 1 from onboarding_completions where tenant_id = ${tenant.id}`
    ).toHaveLength(0)
  })
})

describe('POST /tenants/:slug/onboarding/dismiss and /undismiss', () => {
  it('dismisses and restores for an owner, auditing each in the tenant as a member', async () => {
    const { owner, ownerToken, tenant } = await ownedTenant()

    const dismissed = await postOnboarding(tenant, '/dismiss', ownerToken)
    const again = await postOnboarding(tenant, '/dismiss', ownerToken)
    const restored = await postOnboarding(tenant, '/undismiss', ownerToken)
    const restoredAgain = await postOnboarding(tenant, '/undismiss', ownerToken)

    expect(dismissed.status).toBe(200)
    expect(viewOf(dismissed).state).toBe('dismissed')
    expect(viewOf(dismissed).dismissedAt).toBeTypeOf('string')
    expect([again.status, codeOf(again)]).toEqual([409, 'dismiss_state'])
    expect(restored.status).toBe(200)
    expect(viewOf(restored)).toMatchObject({ state: 'in_progress', dismissedAt: NONE })
    expect([restoredAgain.status, codeOf(restoredAgain)]).toEqual([409, 'dismiss_state'])
    const entries = await sql`
      select action, access, actor_user_id, target_type, target_id, metadata from audit_logs
      where tenant_id = ${tenant.id} and action like 'onboarding.%' order by occurred_at, id`
    expect(entries).toEqual(
      ['onboarding.dismissed', 'onboarding.undismissed'].map((action) => ({
        action,
        access: 'member',
        actor_user_id: owner.id,
        target_type: 'tenant',
        target_id: tenant.id,
        metadata: {},
      }))
    )
  })

  it('answers 403 to an admin member', async () => {
    const { tenant } = await ownedTenant()
    const adminToken = await memberToken(tenant, 'admin')

    const response = await postOnboarding(tenant, '/dismiss', adminToken)

    expect(response.status).toBe(403)
  })

  it.each(['owner', 'viewer'] as const)(
    'answers 404 to a staff %s acting through platform access',
    async (role) => {
      const { tenant } = await ownedTenant()
      const { token: staffToken } = await createTrackedStaff(role)

      const dismiss = await postOnboarding(tenant, '/dismiss', staffToken)
      const undismiss = await postOnboarding(tenant, '/undismiss', staffToken)

      expect([dismiss.status, undismiss.status]).toEqual([404, 404])
    }
  )

  it('answers 409 not_tracked on an untracked tenant', async () => {
    const { ownerToken, tenant } = await ownedTenant()
    await sql`update tenants set onboarding_tracked = false where id = ${tenant.id}`

    const response = await postOnboarding(tenant, '/dismiss', ownerToken)

    expect([response.status, codeOf(response)]).toEqual([409, 'not_tracked'])
  })
})
