/**
 * @file `reconcileOnboarding` re-derives the default automatic steps from
 * what the database still shows: `configure_settings` from a settings row
 * changed after the tenant was created, `invite_teammate` from a non-owner
 * invitation still on file or a second live member, and `teammate_joined`
 * from a second live member. It restores a deleted automatic completion,
 * leaves an existing one alone and skips tenants not tracked or awaiting
 * their owner.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { sql } from '@/services/database.service'
import { reconcileOnboarding } from '@/services/platform-onboarding.service'
import { hashToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  addCompletion,
  addMember,
  createOnboardingTenant,
  daysAgo,
  deleteOnboardingTenants,
} from '../../helpers/onboarding'
import { deleteTrackedUsers } from '../../helpers/platform-users'

const invitationRepository = new TenantInvitationRepository()
// eslint-disable-next-line unicorn/no-null -- awaiting the first owner: no start time
const NOT_STARTED = null

async function stepsOf(tenantId: string): Promise<{ step_key: string; source: string }[]> {
  return sql<{ step_key: string; source: string }[]>`
    select step_key, source from onboarding_completions
    where tenant_id = ${tenantId} order by step_key
  `
}

/**
 * Date the settings row's last change at the tenant's creation, as if
 * nobody had saved the settings since.
 * @param tenantId - The tenant.
 * @returns Resolves once the row is updated.
 */
async function leaveSettingsUntouched(tenantId: string): Promise<void> {
  await sql`
    update tenant_settings s set updated_at = t.created_at
    from tenants t where t.id = s.tenant_id and s.tenant_id = ${tenantId}
  `
}

async function changeSettings(tenantId: string): Promise<void> {
  await sql`update tenant_settings set timezone = 'Europe/Paris', updated_at = now() where tenant_id = ${tenantId}`
}

afterEach(async () => {
  await truncateAuditLogs()
  await deleteOnboardingTenants()
  await deleteTrackedUsers()
})

describe('reconcileOnboarding', () => {
  it('restores configure_settings from a settings change made after creation', async () => {
    const { tenant } = await createOnboardingTenant({
      startedAt: daysAgo(2),
      createdAt: daysAgo(2),
    })
    await changeSettings(tenant.id)

    await reconcileOnboarding()

    expect(await stepsOf(tenant.id)).toEqual([{ step_key: 'configure_settings', source: 'auto' }])
  })

  it('restores invite_teammate from a non-owner invitation still on file', async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    await leaveSettingsUntouched(tenant.id)
    await invitationRepository.createPending({
      tenantId: tenant.id,
      email: `teammate-${randomBytes(4).toString('hex')}@example.test`,
      role: 'editor',
      tokenHash: hashToken(randomBytes(32).toString('base64url')),
      invitedBy: owner.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    await reconcileOnboarding()

    expect(await stepsOf(tenant.id)).toEqual([{ step_key: 'invite_teammate', source: 'auto' }])
  })

  it('does not count an owner invitation', async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    await leaveSettingsUntouched(tenant.id)
    await invitationRepository.createPending({
      tenantId: tenant.id,
      email: `owner-${randomBytes(4).toString('hex')}@example.test`,
      role: 'owner',
      tokenHash: hashToken(randomBytes(32).toString('base64url')),
      invitedBy: owner.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    await reconcileOnboarding()

    expect(await stepsOf(tenant.id)).toEqual([])
  })

  it('restores invite_teammate and teammate_joined from a second live member', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    await leaveSettingsUntouched(tenant.id)
    await addMember(tenant, 'viewer')

    await reconcileOnboarding()

    expect(await stepsOf(tenant.id)).toEqual([
      { step_key: 'invite_teammate', source: 'auto' },
      { step_key: 'teammate_joined', source: 'auto' },
    ])
  })

  it('leaves an existing completion alone and reports only what it restored', async () => {
    const { tenant, owner } = await createOnboardingTenant({
      startedAt: daysAgo(2),
      createdAt: daysAgo(2),
    })
    await changeSettings(tenant.id)
    await addCompletion(tenant.id, 'configure_settings', {
      source: 'staff',
      completedBy: owner.id,
      reason: 'Done on the call',
    })

    const first = await reconcileOnboarding()
    const second = await reconcileOnboarding()

    expect(await stepsOf(tenant.id)).toEqual([{ step_key: 'configure_settings', source: 'staff' }])
    expect(first.failures).toBe(0)
    expect(second).toMatchObject({ stepsRestored: 0, failures: 0 })
  })

  it('skips an untracked tenant and one awaiting its owner', async () => {
    const { tenant: untracked } = await createOnboardingTenant({
      isTracked: false,
      createdAt: daysAgo(2),
    })
    const { tenant: awaiting } = await createOnboardingTenant({
      startedAt: NOT_STARTED,
      createdAt: daysAgo(2),
    })
    await changeSettings(untracked.id)
    await changeSettings(awaiting.id)

    await reconcileOnboarding()

    expect(await stepsOf(untracked.id)).toEqual([])
    expect(await stepsOf(awaiting.id)).toEqual([])
  })
})
