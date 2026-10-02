/**
 * @file `reconcileOnboarding` restores only what members provably did,
 * dated when they did it: `configure_settings` from the earliest
 * member-access settings save, `invite_teammate` from the earliest
 * member-access teammate invitation, and `teammate_joined` from the second
 * member's join (its accept entry, else its membership row). Staff acting
 * through platform access are never credited, an entry from before the
 * clock started is not either, a restored old event leaves a stuck tenant
 * stuck, an existing completion is left alone, and tenants not tracked or
 * awaiting their owner are skipped.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { db, sql, withTransaction } from '@/services/database.service'
import {
  getTenantOnboardingDetail,
  reconcileOnboarding,
} from '@/services/platform-onboarding.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { accept, createOwnerInvitation, invite } from '@/services/tenant-invitation.service'
import { updateSettings } from '@/services/tenant.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  addCompletion,
  addMember,
  createOnboardingTenant,
  daysAgo,
  deleteOnboardingTenants,
} from '../../helpers/onboarding'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

const invitationRepository = new TenantInvitationRepository()
// eslint-disable-next-line unicorn/no-null -- awaiting the first owner: no start time
const NOT_STARTED = null

// This client hands timestamps back as UTC text, compared here as text at millisecond precision.
interface CompletionRow {
  step_key: string
  source: string
  completed_at: string
}

async function completionsOf(tenantId: string): Promise<CompletionRow[]> {
  return sql<CompletionRow[]>`
    select step_key, source, completed_at from onboarding_completions
    where tenant_id = ${tenantId} order by step_key
  `
}

async function stepsOf(tenantId: string): Promise<{ step_key: string; source: string }[]> {
  const rows = await completionsOf(tenantId)
  return rows.map(({ step_key, source }) => ({ step_key, source }))
}

/**
 * When the tenant's earliest audit entry of one action occurred.
 * @param tenantId - The tenant.
 * @param action - The audit action.
 * @returns Its time, as UTC text.
 */
async function entryTime(tenantId: string, action: string): Promise<string> {
  const [row] = await sql<{ occurred_at: string }[]>`
    select occurred_at from audit_logs
    where tenant_id = ${tenantId} and action = ${action}
    order by occurred_at limit 1
  `
  if (!row) throw new Error(`no ${action} entry`)
  return row.occurred_at
}

/**
 * Drop every completion in a tenant, as if each subscriber had failed after its request committed.
 * @param tenantId - The tenant.
 * @returns Resolves once the rows are gone.
 */
async function forgetCompletions(tenantId: string): Promise<void> {
  await sql`delete from onboarding_completions where tenant_id = ${tenantId}`
}

/**
 * A backdated member-access audit entry, written directly: the log is append-only, so a real
 * save cannot be moved into the past.
 * @param tenant - The tenant.
 * @param actor - The member who acted.
 * @param action - The audit action.
 * @param occurredAt - When it happened.
 * @returns Resolves once the row is in.
 */
async function addMemberEntry(
  tenant: Tenant,
  actor: User,
  action: 'tenant.settings_updated' | 'invitation.created',
  occurredAt: Date
): Promise<void> {
  await sql`
    insert into audit_logs (occurred_at, actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id)
    values (${occurredAt.toISOString()}::timestamptz, 'user', ${actor.id}, 'member', ${tenant.id},
      ${action}, ${action === 'invitation.created' ? 'invitation' : 'settings'}, ${tenant.id})
  `
}

/**
 * A pending invitation with a known raw token, written without `invite` (so no audit entry).
 * @param tenant - The tenant.
 * @param invitedBy - The inviter.
 * @param email - The invited address.
 * @param role - The offered role.
 * @returns The raw token.
 */
async function seedInvitation(
  tenant: Tenant,
  invitedBy: User,
  email: string,
  role: MembershipRole
): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url')
  await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email,
        role,
        tokenHash: hashToken(rawToken),
        invitedBy: invitedBy.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      tx
    )
  )
  return rawToken
}

afterEach(async () => {
  await truncateAuditLogs()
  await deleteOnboardingTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('reconcileOnboarding: what members did', () => {
  it("restores configure_settings from a member's settings save, dated by its audit entry", async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    await updateSettings({ userId: owner.id }, tenant.id, { timezone: 'Europe/Paris' })
    await forgetCompletions(tenant.id)

    await reconcileOnboarding()

    const savedAt = await entryTime(tenant.id, 'tenant.settings_updated')
    expect(await completionsOf(tenant.id)).toEqual([
      { step_key: 'configure_settings', source: 'auto', completed_at: savedAt },
    ])
  })

  it.each(['editor', 'owner'] as const)(
    "restores invite_teammate from a member's %s invitation, dated by its audit entry",
    async (role) => {
      const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(2) })
      await invite({ userId: owner.id }, tenant.id, `invitee-${randomUUID()}@example.test`, role)
      await forgetCompletions(tenant.id)

      await reconcileOnboarding()

      const invitedAt = await entryTime(tenant.id, 'invitation.created')
      expect(await completionsOf(tenant.id)).toEqual([
        { step_key: 'invite_teammate', source: 'auto', completed_at: invitedAt },
      ])
    }
  )

  it("restores teammate_joined, and only it, from a teammate's accept, dated by its audit entry", async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    const teammate = await createTrackedUser()
    const rawToken = await seedInvitation(tenant, owner, teammate.email, 'editor')
    await accept(rawToken, teammate.id)
    await forgetCompletions(tenant.id)

    await reconcileOnboarding()

    const joinedAt = await entryTime(tenant.id, 'invitation.accepted')
    expect(await completionsOf(tenant.id)).toEqual([
      { step_key: 'teammate_joined', source: 'auto', completed_at: joinedAt },
    ])
  })

  it("falls back to the second membership's created_at when no accept entry is on file", async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    const teammate = await addMember(tenant, 'viewer')
    // Microseconds truncated to the completion's milliseconds, as the JS Date it passes through does.
    const [membership] = await sql<{ created_at: string }[]>`
      select date_trunc('milliseconds', created_at)::timestamptz(3) as created_at
      from user_memberships where tenant_id = ${tenant.id} and user_id = ${teammate.id}
    `

    await reconcileOnboarding()

    expect(await completionsOf(tenant.id)).toEqual([
      { step_key: 'teammate_joined', source: 'auto', completed_at: membership?.created_at },
    ])
  })
})

describe('reconcileOnboarding: what it never credits', () => {
  it('credits neither a settings save nor an invitation by staff through platform access', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    const { user: staff } = await createTrackedStaff('admin')
    await updateSettings({ userId: staff.id }, tenant.id, { timezone: 'Asia/Tokyo' })
    await invite({ userId: staff.id }, tenant.id, `invitee-${randomUUID()}@example.test`, 'viewer')

    await reconcileOnboarding()

    expect(await stepsOf(tenant.id)).toEqual([])
  })

  it('does not count the staff owner invitation', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(2) })
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

    await reconcileOnboarding()

    expect(await stepsOf(tenant.id)).toEqual([])
  })

  it('does not count a member entry from before the clock started', async () => {
    const { tenant, owner } = await createOnboardingTenant({
      startedAt: daysAgo(2),
      createdAt: daysAgo(5),
    })
    await addMemberEntry(tenant, owner, 'tenant.settings_updated', daysAgo(3))
    await addMemberEntry(tenant, owner, 'invitation.created', daysAgo(3))

    await reconcileOnboarding()

    expect(await stepsOf(tenant.id)).toEqual([])
  })
})

describe('reconcileOnboarding: progress and idempotence', () => {
  it('leaves a stuck tenant stuck when the restored event is old, its last progress at that event', async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(20) })
    const savedAt = daysAgo(10)
    await addMemberEntry(tenant, owner, 'tenant.settings_updated', savedAt)

    await reconcileOnboarding()

    const detail = await getTenantOnboardingDetail(tenant.id)
    expect(await stepsOf(tenant.id)).toEqual([{ step_key: 'configure_settings', source: 'auto' }])
    expect(detail.state).toBe('stuck')
    expect(detail.lastProgressAt).toEqual(savedAt)
  })

  it('leaves an existing completion alone and reports only what it restored', async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    await updateSettings({ userId: owner.id }, tenant.id, { timezone: 'Europe/Paris' })
    await forgetCompletions(tenant.id)
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
    const { tenant: untracked, owner: untrackedOwner } = await createOnboardingTenant({
      isTracked: false,
      createdAt: daysAgo(2),
    })
    const { tenant: awaiting, owner: awaitingOwner } = await createOnboardingTenant({
      startedAt: NOT_STARTED,
      createdAt: daysAgo(2),
    })
    await addMemberEntry(untracked, untrackedOwner, 'tenant.settings_updated', daysAgo(1))
    await addMemberEntry(awaiting, awaitingOwner, 'tenant.settings_updated', daysAgo(1))

    await reconcileOnboarding()

    expect(await stepsOf(untracked.id)).toEqual([])
    expect(await stepsOf(awaiting.id)).toEqual([])
  })
})
