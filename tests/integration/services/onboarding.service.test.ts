/**
 * @file completeOnboardingStep and getTenantOnboarding against the real
 * per-worker Postgres: one completion per step, the refusals, untracked and
 * waiting tenants, a dismissed tenant still recording, and the customer's
 * view of tenant steps, their own member steps, and staff-only states.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { OnboardingCompletionRepository } from '@/repositories/onboarding-completion.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql } from '@/services/database.service'
import { completeOnboardingStep, getTenantOnboarding } from '@/services/onboarding.service'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'

const completionRepository = new OnboardingCompletionRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const tenantIds: string[] = []
// eslint-disable-next-line unicorn/no-null -- JSON null, as the API and the database return it
const NONE = null

afterEach(async () => {
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

/**
 * A customer-created tenant (tracked and started) and its owner.
 * @returns Both.
 */
async function startedTenant(): Promise<{ owner: User; tenant: Tenant }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Service Co',
    slug: `service-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  return { owner, tenant }
}

describe('completeOnboardingStep', () => {
  it('records a step once; a repeat returns undefined', async () => {
    const { tenant } = await startedTenant()
    const input = { tenantId: tenant.id, stepKey: 'invite_teammate', source: 'auto' } as const

    expect(await completeOnboardingStep(input)).toMatchObject({ stepKey: 'invite_teammate' })
    expect(await completeOnboardingStep(input)).toBeUndefined()
    expect(await completionRepository.listForTenant(tenant.id)).toHaveLength(1)
  })

  it('never stores who recorded an auto completion', async () => {
    const { owner, tenant } = await startedTenant()

    const row = await completeOnboardingStep({
      tenantId: tenant.id,
      stepKey: 'configure_settings',
      source: 'auto',
      completedBy: owner.id,
    })

    expect(row?.completedBy).toBeNull()
  })

  it.each([
    [
      'an unknown key',
      { stepKey: 'verify_email', source: 'auto' },
      { statusCode: 404, code: 'onboarding_step_not_found' },
    ],
    [
      'a member step with no member',
      { stepKey: 'read_getting_started', source: 'customer' },
      { statusCode: 409, code: 'member_step' },
    ],
    [
      'a tenant step with a member',
      { stepKey: 'configure_settings', source: 'customer', userId: 'set-below' },
      { statusCode: 409, code: 'scope_mismatch' },
    ],
    [
      'a staff completion with no reason',
      { stepKey: 'configure_settings', source: 'staff' },
      { statusCode: 400 },
    ],
  ] as const)('refuses %s', async (_label, input, expected) => {
    const { owner, tenant } = await startedTenant()
    const withUser = 'userId' in input ? { ...input, userId: owner.id } : input

    await expect(
      completeOnboardingStep({ tenantId: tenant.id, ...withUser })
    ).rejects.toMatchObject(expected)
    expect(await completionRepository.listForTenant(tenant.id)).toHaveLength(0)
  })

  it('refuses an untracked tenant and one waiting for its owner with 409 not_tracked', async () => {
    const { tenant } = await startedTenant()
    const waiting = await tenantRepository.createWithoutOwner({
      name: 'Waiting Co',
      slug: `waiting-${randomUUID()}`,
    })
    tenantIds.push(waiting.id)
    await sql`update tenants set onboarding_tracked = false where id = ${tenant.id}`

    for (const tenantId of [tenant.id, waiting.id]) {
      await expect(
        completeOnboardingStep({ tenantId, stepKey: 'invite_teammate', source: 'auto' })
      ).rejects.toMatchObject({ statusCode: 409, code: 'not_tracked' })
    }
  })

  it('still records in a dismissed tenant', async () => {
    const { owner, tenant } = await startedTenant()
    await tenantRepository.setOnboardingDismissed(tenant.id, owner.id, new Date())

    await expect(
      completeOnboardingStep({ tenantId: tenant.id, stepKey: 'invite_teammate', source: 'auto' })
    ).resolves.toBeDefined()
  })
})

describe('getTenantOnboarding', () => {
  it('shows tenant steps for everyone and member steps as the viewer’s own', async () => {
    const { owner, tenant } = await startedTenant()
    const teammate = await createTrackedUser()
    await userMembershipRepository.create({
      userId: teammate.id,
      tenantId: tenant.id,
      role: 'viewer',
    })
    await completeOnboardingStep({
      tenantId: tenant.id,
      stepKey: 'configure_settings',
      source: 'auto',
    })
    await completeOnboardingStep({
      tenantId: tenant.id,
      userId: owner.id,
      stepKey: 'read_getting_started',
      source: 'customer',
      completedBy: owner.id,
    })

    const asOwner = await getTenantOnboarding(tenant.id, { userId: owner.id })
    const asTeammate = await getTenantOnboarding(tenant.id, { userId: teammate.id })

    const asStaff = await getTenantOnboarding(tenant.id, { userId: NONE })

    const stepOf = (view: typeof asOwner, key: string) =>
      view.steps.find((entry) => entry.key === key)
    expect(asOwner.steps.map((entry) => entry.key)).toEqual([
      'configure_settings',
      'invite_teammate',
      'teammate_joined',
      'read_getting_started',
    ])
    expect(asOwner).toMatchObject({
      state: 'in_progress',
      requiredDone: 1,
      requiredTotal: 2,
      completedAt: NONE,
      dismissedAt: NONE,
    })
    for (const view of [asOwner, asTeammate, asStaff]) {
      expect(stepOf(view, 'configure_settings')).toMatchObject({
        source: 'auto',
        kind: 'auto',
        scope: 'tenant',
        required: true,
      })
      expect(stepOf(view, 'configure_settings')?.completedAt).toBeTypeOf('string')
    }
    expect(stepOf(asOwner, 'read_getting_started')).toMatchObject({
      source: 'customer',
      kind: 'manual',
      scope: 'member',
      required: false,
    })
    expect(stepOf(asTeammate, 'read_getting_started')).toMatchObject({
      source: NONE,
      completedAt: NONE,
    })
    expect(stepOf(asStaff, 'read_getting_started')).toMatchObject({
      source: NONE,
      completedAt: NONE,
    })
  })

  it('reports complete with the time of the last required step, and dismissed with its time', async () => {
    const { owner, tenant } = await startedTenant()
    await completeOnboardingStep({
      tenantId: tenant.id,
      stepKey: 'configure_settings',
      source: 'auto',
    })
    const at = new Date('2026-10-02T12:00:00.000Z')
    await tenantRepository.setOnboardingDismissed(tenant.id, owner.id, at)

    const dismissed = await getTenantOnboarding(tenant.id, { userId: owner.id })
    const last = await completeOnboardingStep({
      tenantId: tenant.id,
      stepKey: 'invite_teammate',
      source: 'auto',
    })
    const complete = await getTenantOnboarding(tenant.id, { userId: owner.id })

    expect(dismissed).toMatchObject({ state: 'dismissed', dismissedAt: at.toISOString() })
    expect(complete).toMatchObject({
      state: 'complete',
      completedAt: last?.completedAt.toISOString(),
    })
  })

  it('reports stuck to the customer as in_progress, and awaiting_owner and untracked as not_tracked', async () => {
    const { owner, tenant } = await startedTenant()
    const waiting = await tenantRepository.createWithoutOwner({
      name: 'Waiting Co',
      slug: `waiting-${randomUUID()}`,
    })
    tenantIds.push(waiting.id)
    const muchLater = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)

    const stuck = await getTenantOnboarding(tenant.id, { userId: owner.id }, muchLater)

    const awaiting = await getTenantOnboarding(waiting.id, { userId: NONE })
    await sql`update tenants set onboarding_tracked = false where id = ${tenant.id}`
    const untracked = await getTenantOnboarding(tenant.id, { userId: owner.id })

    expect(stuck.state).toBe('in_progress')
    expect(awaiting.state).toBe('not_tracked')
    expect(untracked.state).toBe('not_tracked')
  })

  it('answers 404 for a tenant that is gone', async () => {
    await expect(getTenantOnboarding(randomUUID(), { userId: NONE })).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
