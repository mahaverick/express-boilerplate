/**
 * @file Each onboarding trigger through the real services, with the
 * subscribers createApp() registers: tenant creation on both paths, the
 * first owner's accept (completing teammate_joined when others joined
 * while the tenant waited), a teammate's accept, a first member's accept
 * on a started tenant (which completes nothing), teammate invitations (and the
 * owner invitation and resend, which don't count), changed and no-op
 * settings saves, staff acting through platform access, and a throwing
 * subscriber that must not fail its request.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { OnboardingCompletionRepository } from '@/repositories/onboarding-completion.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { db, sql, withTransaction } from '@/services/database.service'
import {
  emitDomainEvent,
  resetDomainEventSubscribers,
  subscribeDomainEvent,
} from '@/services/domain-events.service'
import { registerOnboardingSubscribers } from '@/services/onboarding.service'
import { createTenant as createTenantAsStaff } from '@/services/platform-tenant.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { accept, createOwnerInvitation, invite, resend } from '@/services/tenant-invitation.service'
import { createTenant, updateSettings } from '@/services/tenant.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backdateInvitationSend } from '../../helpers/backdate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

const completionRepository = new OnboardingCompletionRepository()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const slugs: string[] = []

beforeAll(() => {
  // Building the app is what registers the subscribers; nothing else here does.
  resetDomainEventSubscribers()
  createApp()
})

afterEach(async () => {
  resetDomainEventSubscribers()
  registerOnboardingSubscribers()
  await truncateAuditLogs()
  if (slugs.length > 0) await sql`delete from tenants where slug = any(${slugs})`
  slugs.length = 0
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A slug unique to one call, tracked for cleanup.
 * @returns The slug.
 */
function trackedSlug(): string {
  const slug = `trigger-${randomUUID()}`
  slugs.push(slug)
  return slug
}

/**
 * A tenant created through the customer service, and its owner.
 * @returns Both.
 */
async function customerTenant(): Promise<{ owner: User; tenant: Tenant }> {
  const owner = await createTrackedUser()
  const tenant = await createTenant(
    { userId: owner.id },
    { name: 'Trigger Co', slug: trackedSlug() }
  )
  return { owner, tenant }
}

/**
 * The step keys completed in a tenant, sorted.
 * @param tenantId - The tenant.
 * @returns The keys.
 */
async function completedKeys(tenantId: string): Promise<string[]> {
  const rows = await completionRepository.listForTenant(tenantId)
  return rows.map((row) => row.stepKey).toSorted((a, b) => a.localeCompare(b))
}

/**
 * A pending invitation with a known raw token, written without `invite`.
 * @param tenantId - The tenant.
 * @param invitedBy - The inviter.
 * @param email - The invited address.
 * @param role - The offered role.
 * @returns The raw token and the invitation id.
 */
async function seedInvitation(
  tenantId: string,
  invitedBy: User,
  email: string,
  role: MembershipRole
): Promise<{ rawToken: string; invitationId: string }> {
  const rawToken = randomBytes(32).toString('base64url')
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId,
        email,
        role,
        tokenHash: hashToken(rawToken),
        invitedBy: invitedBy.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      tx
    )
  )
  return { rawToken, invitationId: invitation.id }
}

/**
 * A tenant staff created, its staff creator, and an owner invitation token for `ownerEmail`.
 * @returns The tenant id, the staff user and the raw owner token.
 */
async function staffTenant(): Promise<{
  tenantId: string
  staff: User
  ownerEmail: string
  ownerToken: string
}> {
  const { user: staff } = await createTrackedStaff('admin')
  const ownerEmail = `owner-${randomUUID()}@example.test`
  const { tenant } = await createTenantAsStaff(
    { userId: staff.id },
    { name: 'Staff Co', slug: trackedSlug(), ownerEmail }
  )
  // A second owner invitation to the same address supersedes the first and hands back its token.
  const dispatch = await withTransaction((tx) =>
    createOwnerInvitation({ userId: staff.id }, tenant.id, ownerEmail, 'Test setup', tx)
  )
  return { tenantId: tenant.id, staff, ownerEmail, ownerToken: dispatch.context.rawToken }
}

describe('tenant creation', () => {
  it('a customer-created tenant is tracked and started at creation, with nothing complete', async () => {
    const { tenant } = await customerTenant()

    const reread = await tenantRepository.findById(tenant.id)
    expect(reread?.onboardingTracked).toBe(true)
    expect(reread?.onboardingStartedAt).toEqual(tenant.createdAt)
    expect(await completedKeys(tenant.id)).toEqual([])
  })

  it('a staff-created tenant is tracked and waits for its owner', async () => {
    const { tenantId } = await staffTenant()

    const reread = await tenantRepository.findById(tenantId)
    expect(reread?.onboardingTracked).toBe(true)
    expect(reread?.onboardingStartedAt).toBeNull()
  })
})

describe('accepting an invitation', () => {
  it("the first owner's accept on a staff-created tenant starts the clock and completes nothing", async () => {
    const { tenantId, ownerEmail, ownerToken } = await staffTenant()
    const owner = await createTrackedUser({ email: ownerEmail })

    await accept(ownerToken, owner.id)

    const reread = await tenantRepository.findById(tenantId)
    expect(reread?.onboardingStartedAt).toBeInstanceOf(Date)
    expect(await completedKeys(tenantId)).toEqual([])
  })

  it("the first owner's accept completes teammate_joined when a member joined while the tenant waited", async () => {
    const { tenantId, staff, ownerEmail, ownerToken } = await staffTenant()
    const early = await createTrackedUser()
    const { rawToken } = await seedInvitation(tenantId, staff, early.email, 'viewer')
    await accept(rawToken, early.id)
    expect(await completedKeys(tenantId)).toEqual([])
    const owner = await createTrackedUser({ email: ownerEmail })

    await accept(ownerToken, owner.id)

    const reread = await tenantRepository.findById(tenantId)
    expect(reread?.onboardingStartedAt).toBeInstanceOf(Date)
    expect(await completedKeys(tenantId)).toEqual(['teammate_joined'])
  })

  it("a first member's accept on a started tenant completes nothing", async () => {
    const { owner, tenant } = await customerTenant()

    // Fabricated: no real accept is a started tenant's first member, so only this pins the guard.
    await emitDomainEvent(
      {
        type: 'invitation_accepted',
        tenantId: tenant.id,
        userId: owner.id,
        role: 'viewer',
        wasFirstMember: true,
        at: new Date(),
      },
      { access: 'member' }
    )

    expect(await completedKeys(tenant.id)).toEqual([])
  })

  it('a teammate joining a started tenant completes teammate_joined', async () => {
    const { owner, tenant } = await customerTenant()
    const teammate = await createTrackedUser()
    const { rawToken } = await seedInvitation(tenant.id, owner, teammate.email, 'editor')

    await accept(rawToken, teammate.id)

    expect(await completedKeys(tenant.id)).toEqual(['teammate_joined'])
  })

  it('a second owner joining a staff-created tenant after the first completes teammate_joined', async () => {
    const { tenantId, ownerEmail, ownerToken } = await staffTenant()
    const owner = await createTrackedUser({ email: ownerEmail })
    await accept(ownerToken, owner.id)
    const second = await createTrackedUser()
    const { rawToken } = await seedInvitation(tenantId, owner, second.email, 'owner')

    await accept(rawToken, second.id)

    expect(await completedKeys(tenantId)).toEqual(['teammate_joined'])
  })

  it('a repeat accept by the same user emits nothing new', async () => {
    const { owner, tenant } = await customerTenant()
    const teammate = await createTrackedUser()
    const { rawToken } = await seedInvitation(tenant.id, owner, teammate.email, 'viewer')
    await accept(rawToken, teammate.id)
    await sql`delete from onboarding_completions where tenant_id = ${tenant.id}`

    await accept(rawToken, teammate.id)

    expect(await completedKeys(tenant.id)).toEqual([])
  })
})

describe('inviting', () => {
  it.each(['editor', 'owner'] as const)(
    "an owner's %s invitation completes invite_teammate",
    async (role) => {
      const { owner, tenant } = await customerTenant()

      await invite({ userId: owner.id }, tenant.id, `invitee-${randomUUID()}@example.test`, role)

      expect(await completedKeys(tenant.id)).toEqual(['invite_teammate'])
    }
  )

  it('neither the staff owner invitation nor a resend completes invite_teammate', async () => {
    const { owner, tenant } = await customerTenant()
    const { user: staff } = await createTrackedStaff('admin')
    await withTransaction((tx) =>
      createOwnerInvitation(
        { userId: staff.id },
        tenant.id,
        `co-owner-${randomUUID()}@example.test`,
        'Customer asked',
        tx
      )
    )
    const { invitationId } = await seedInvitation(
      tenant.id,
      owner,
      `pending-${randomUUID()}@example.test`,
      'viewer'
    )

    await backdateInvitationSend(invitationId)
    await resend({ userId: owner.id }, tenant.id, invitationId)

    expect(await completedKeys(tenant.id)).toEqual([])
  })
})

describe('saving settings', () => {
  it('a no-op save completes nothing; a changed save completes configure_settings', async () => {
    const { owner, tenant } = await customerTenant()

    await updateSettings({ userId: owner.id }, tenant.id, { timezone: 'UTC', locale: 'en' })
    expect(await completedKeys(tenant.id)).toEqual([])

    await updateSettings({ userId: owner.id }, tenant.id, { timezone: 'Europe/Paris' })
    expect(await completedKeys(tenant.id)).toEqual(['configure_settings'])
  })
})

describe('staff acting through platform access', () => {
  it('a settings save and an invitation by a staff admin complete nothing', async () => {
    const { tenant } = await customerTenant()
    const { user: staff } = await createTrackedStaff('admin')

    await updateSettings({ userId: staff.id }, tenant.id, { timezone: 'Asia/Tokyo' })
    await invite({ userId: staff.id }, tenant.id, `invitee-${randomUUID()}@example.test`, 'viewer')

    expect(await completedKeys(tenant.id)).toEqual([])
  })
})

describe('a throwing subscriber', () => {
  it('fails neither the save nor the onboarding subscriber after it', async () => {
    resetDomainEventSubscribers()
    subscribeDomainEvent('tenant_settings_updated', () => {
      throw new Error('subscriber failure')
    })
    registerOnboardingSubscribers()
    const { owner, tenant } = await customerTenant()

    const settings = await updateSettings({ userId: owner.id }, tenant.id, { locale: 'fr' })

    expect(settings.locale).toBe('fr')
    expect(await completedKeys(tenant.id)).toEqual(['configure_settings'])
  })
})
