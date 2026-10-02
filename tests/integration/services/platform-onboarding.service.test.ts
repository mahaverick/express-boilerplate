/**
 * @file The staff tenant tab (`getTenantOnboardingDetail`) against the real
 * registry and `ONBOARDING_STUCK_AFTER_DAYS` (7 in the test environment):
 * every step with its completion and who made it, a member step's
 * per-member status, the reminder history and availability, any lifecycle
 * state, and parity with `deriveOnboardingState` and the customer read,
 * which derive the same progress in TypeScript.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import type { OnboardingState } from '@/constants/onboarding.constants'
import type { Tenant } from '@/database/models/tenant.model'
import { OnboardingCompletionRepository } from '@/repositories/onboarding-completion.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql } from '@/services/database.service'
import { deriveOnboardingState, getTenantOnboarding } from '@/services/onboarding.service'
import {
  countStuckTenants,
  getTenantOnboardingDetail,
  REMINDER_INTERVAL_MS,
} from '@/services/platform-onboarding.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  addCompletion,
  addMember,
  createOnboardingTenant,
  DAY_MS,
  daysAgo,
  deleteOnboardingTenants,
} from '../../helpers/onboarding'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

// eslint-disable-next-line unicorn/no-null -- JSON null, as the API returns it
const NONE = null

const tenantRepository = new TenantRepository()
const completionRepository = new OnboardingCompletionRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * An `onboarding.reminder_sent` entry's metadata.
 */
type ReminderMetadata = {
  reason: string
  recipientCount: number
  emailDomains: string[]
  messageIds: string[]
}

/**
 * The metadata a reminder entry carries unless a test passes its own.
 */
const DEFAULT_REMINDER_METADATA: ReminderMetadata = {
  reason: 'Nudge after the call',
  recipientCount: 1,
  emailDomains: ['example.test'],
  messageIds: ['00000000-0000-7000-8000-00000000000a'],
}

/**
 * Insert one `onboarding.reminder_sent` entry at a chosen time (an insert
 * may name `occurred_at`; only UPDATE and DELETE are refused).
 * @param tenantId - The tenant it is filed in.
 * @param actorId - The staff member.
 * @param occurredAt - When it was sent.
 * @param metadata - Its metadata.
 * @returns The entry's id.
 */
async function addReminderEntry(
  tenantId: string,
  actorId: string,
  occurredAt: Date,
  metadata: ReminderMetadata = DEFAULT_REMINDER_METADATA
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id, metadata, occurred_at)
    values ('user', ${actorId}, 'platform', ${tenantId}, 'onboarding.reminder_sent', 'tenant', ${tenantId},
      ${JSON.stringify(metadata)}::jsonb, ${occurredAt.toISOString()}::timestamptz)
    returning id
  `
  if (!row) throw new Error('addReminderEntry: insert returned no row')
  return row.id
}

afterEach(async () => {
  await truncateAuditLogs()
  await deleteOnboardingTenants()
  await deleteTrackedUsers()
})

describe('getTenantOnboardingDetail', () => {
  it('answers 404 for an unknown tenant and for the platform tenant', async () => {
    const platform = await platformTenant()

    await expect(getTenantOnboardingDetail(randomUUID())).rejects.toMatchObject({
      statusCode: 404,
    })
    await expect(getTenantOnboardingDetail(platform.id)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('lists every registry step in order with its completion, staff completions with name and reason', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(3) })
    const { user: staff } = await createTrackedStaff('admin', {
      firstName: 'Sam',
      lastName: 'Staff',
    })
    await addCompletion(tenant.id, 'configure_settings', {
      source: 'staff',
      completedBy: staff.id,
      reason: 'Set up on the onboarding call',
      completedAt: daysAgo(2),
    })

    const detail = await getTenantOnboardingDetail(tenant.id)

    expect(detail.steps.map((step) => step.key)).toEqual([
      'configure_settings',
      'invite_teammate',
      'teammate_joined',
      'read_getting_started',
    ])
    expect(detail.steps[0]).toMatchObject({
      scope: 'tenant',
      kind: 'auto',
      required: true,
      source: 'staff',
      completedBy: { id: staff.id, name: 'Sam Staff' },
      reason: 'Set up on the onboarding call',
      members: NONE,
      canMarkComplete: false,
    })
    expect(detail.steps[1]).toMatchObject({
      completedAt: NONE,
      source: NONE,
      completedBy: NONE,
      canMarkComplete: true,
    })
    expect(detail.steps[3]).toMatchObject({
      scope: 'member',
      kind: 'manual',
      canMarkComplete: false,
    })
    expect(detail).toMatchObject({
      state: 'in_progress',
      requiredDone: 1,
      requiredTotal: 2,
      nextStep: { key: 'invite_teammate' },
      daysStuck: NONE,
    })
  })

  it('shows a staff completion whose actor was purged with no completedBy', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(1) })
    await addCompletion(tenant.id, 'invite_teammate', {
      source: 'staff',
      completedBy: NONE,
      reason: 'Invited them by hand',
    })

    const detail = await getTenantOnboardingDetail(tenant.id)
    const step = detail.steps[1]

    expect(step).toMatchObject({
      source: 'staff',
      completedBy: NONE,
      reason: 'Invited them by hand',
    })
  })

  it("shows a member step's per-member status, the tenant-level completion from an active owner only", async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    const editor = await addMember(tenant, 'editor')
    await addCompletion(tenant.id, 'read_getting_started', {
      userId: editor.id,
      source: 'customer',
      completedBy: editor.id,
      completedAt: daysAgo(1),
    })

    const first = await getTenantOnboardingDetail(tenant.id)
    const before = first.steps[3]
    const ownerDoneAt = new Date()
    await addCompletion(tenant.id, 'read_getting_started', {
      userId: owner.id,
      source: 'customer',
      completedBy: owner.id,
      completedAt: ownerDoneAt,
    })
    const second = await getTenantOnboardingDetail(tenant.id)
    const after = second.steps[3]

    expect(before).toMatchObject({ completedAt: NONE, members: { completed: 1, total: 2 } })
    const editorEntry = before?.members?.entries.find((entry) => entry.user.id === editor.id)
    expect(editorEntry).toMatchObject({ role: 'editor', source: 'customer' })
    expect(after?.completedAt?.toISOString()).toBe(ownerDoneAt.toISOString())
    expect(after?.members).toMatchObject({ completed: 2, total: 2 })
  })

  it('reports a stuck tenant with whole days stuck and its next required step', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })

    const detail = await getTenantOnboardingDetail(tenant.id)

    expect(detail).toMatchObject({
      state: 'stuck',
      daysStuck: 10,
      nextStep: { key: 'configure_settings' },
    })
  })

  it('names who dismissed it', async () => {
    const dismisser = await createTrackedUser({ firstName: 'Dee', lastName: 'Missed' })
    const { tenant } = await createOnboardingTenant({
      startedAt: daysAgo(2),
      dismissedAt: daysAgo(1),
      dismissedBy: dismisser.id,
    })

    const detail = await getTenantOnboardingDetail(tenant.id)

    expect(detail).toMatchObject({
      state: 'dismissed',
      dismissedBy: { id: dismisser.id, name: 'Dee Missed' },
    })
    expect(detail.reminder.blockedBy).toBe('not_in_progress')
  })

  it('lists reminders newest first with staff name, reason, domains and message ids, and blocks a second within 24 hours', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })
    const { user: staff } = await createTrackedStaff('admin', {
      firstName: 'Ria',
      lastName: 'Mind',
    })
    const messageId = randomUUID()
    await addReminderEntry(tenant.id, staff.id, daysAgo(3))
    const latestAt = new Date(Date.now() - 60 * 60 * 1000)
    const latestId = await addReminderEntry(tenant.id, staff.id, latestAt, {
      reason: 'Second nudge',
      recipientCount: 1,
      emailDomains: ['example.test'],
      messageIds: [messageId],
    })

    const detail = await getTenantOnboardingDetail(tenant.id)

    expect(detail.reminders).toHaveLength(2)
    expect(detail.reminders[0]).toMatchObject({
      id: latestId,
      sentBy: { id: staff.id, name: 'Ria Mind' },
      reason: 'Second nudge',
      recipientCount: 1,
      emailDomains: ['example.test'],
      messageIds: [messageId],
    })
    expect(detail.reminders[0]?.sentAt.toISOString()).toBe(latestAt.toISOString())
    expect(detail.reminder).toMatchObject({
      canSend: false,
      blockedBy: 'reminded_recently',
      recipientCount: 1,
      emailDomains: ['example.test'],
    })
    expect(detail.reminder.nextAllowedAt?.getTime()).toBe(latestAt.getTime() + REMINDER_INTERVAL_MS)
  })

  it('allows a reminder to an in-progress tenant with an active owner, and refuses one with none', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(1) })
    const { tenant: ownerless, owner } = await createOnboardingTenant({ startedAt: daysAgo(1) })
    await sql`update users set active = false where id = ${owner.id}`

    const open = await getTenantOnboardingDetail(tenant.id)
    const closed = await getTenantOnboardingDetail(ownerless.id)

    expect(open.reminder).toMatchObject({
      canSend: true,
      blockedBy: NONE,
      lastSentAt: NONE,
      nextAllowedAt: NONE,
    })
    expect(closed.reminder).toMatchObject({
      canSend: false,
      blockedBy: 'no_owner',
      recipientCount: 0,
      emailDomains: [],
    })
  })

  it.each(['suspended', 'archived'] as const)(
    'reads a %s tenant, with no action offered',
    async (lifecycleState) => {
      const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(1), lifecycleState })

      const detail = await getTenantOnboardingDetail(tenant.id)

      expect(detail.tenant.lifecycleState).toBe(lifecycleState)
      expect(detail.reminder.blockedBy).toBe('tenant_state_conflict')
      expect(detail.steps.some((step) => step.canMarkComplete)).toBe(false)
    }
  )

  it('offers no action on a tenant awaiting its owner, nor on an untracked one', async () => {
    const { tenant: awaiting } = await createOnboardingTenant({ startedAt: NONE })
    const { tenant: untracked } = await createOnboardingTenant({ isTracked: false })

    const details = [
      await getTenantOnboardingDetail(awaiting.id),
      await getTenantOnboardingDetail(untracked.id),
    ]

    expect(details.map((detail) => detail.state)).toEqual(['awaiting_owner', 'not_tracked'])
    for (const detail of details) {
      expect(detail.reminder.blockedBy).toBe('not_in_progress')
      expect(detail.steps.some((step) => step.canMarkComplete)).toBe(false)
    }
  })
})

describe('countStuckTenants', () => {
  it('counts a tenant with no progress for more than the configured days', async () => {
    const before = await countStuckTenants()
    await createOnboardingTenant({ startedAt: daysAgo(8) })
    await createOnboardingTenant({ startedAt: daysAgo(6) })

    const after = await countStuckTenants()

    expect(after - before).toBe(1)
  })
})

describe('parity with the customer read', () => {
  it('derives exactly what deriveOnboardingState and getTenantOnboarding derive', async () => {
    const now = new Date()
    const stuckMs = getEnv().ONBOARDING_STUCK_AFTER_DAYS * DAY_MS
    const exactlyStuck = new Date(now.getTime() - stuckMs)
    const almostStuck = new Date(now.getTime() - stuckMs + 1)
    const fixtures = await Promise.all([
      createOnboardingTenant({ startedAt: daysAgo(1, now) }),
      createOnboardingTenant({ startedAt: daysAgo(10, now) }),
      createOnboardingTenant({ startedAt: daysAgo(2, now), dismissedAt: daysAgo(1, now) }),
      createOnboardingTenant({ isTracked: false }),
      createOnboardingTenant({ startedAt: NONE }),
      createOnboardingTenant({ startedAt: daysAgo(4, now) }),
      // Exactly N days idle is stuck; a millisecond less is not.
      createOnboardingTenant({ startedAt: exactlyStuck }),
      createOnboardingTenant({ startedAt: almostStuck }),
      // Idle for 10 days but for a member step: only an active owner's tick is progress.
      createOnboardingTenant({ startedAt: daysAgo(10, now) }),
      createOnboardingTenant({ startedAt: daysAgo(10, now) }),
      createOnboardingTenant({ startedAt: daysAgo(10, now) }),
      // Complete outranks dismissed; a retired key is no progress.
      createOnboardingTenant({ startedAt: daysAgo(10, now), dismissedAt: daysAgo(9, now) }),
    ])
    const tenantAt = (index: number): Tenant => {
      const fixture = fixtures[index]
      if (!fixture) throw new Error(`setup: no tenant ${index}`)
      return fixture.tenant
    }
    const ownerAt = (index: number): string => {
      const fixture = fixtures[index]
      if (!fixture) throw new Error(`setup: no tenant ${index}`)
      return fixture.owner.id
    }
    await addCompletion(tenantAt(5).id, 'configure_settings', { completedAt: daysAgo(3, now) })
    await addCompletion(tenantAt(5).id, 'invite_teammate', { completedAt: daysAgo(2, now) })
    await addCompletion(tenantAt(5).id, 'retired_step', { completedAt: daysAgo(1, now) })
    await addCompletion(tenantAt(1).id, 'retired_step', { completedAt: daysAgo(1, now) })
    // An active owner ticked the member step: progress. A second owner later: the earliest counts.
    const secondOwner = await addMember(tenantAt(8), 'owner')
    await addCompletion(tenantAt(8).id, 'read_getting_started', {
      userId: ownerAt(8),
      source: 'customer',
      completedBy: ownerAt(8),
      completedAt: daysAgo(2, now),
    })
    await addCompletion(tenantAt(8).id, 'read_getting_started', {
      userId: secondOwner.id,
      source: 'customer',
      completedBy: secondOwner.id,
      completedAt: daysAgo(1, now),
    })
    // A deactivated owner's tick does not count.
    const inactiveOwner = await addMember(tenantAt(9), 'owner', { isActive: false })
    await addCompletion(tenantAt(9).id, 'read_getting_started', {
      userId: inactiveOwner.id,
      source: 'customer',
      completedBy: inactiveOwner.id,
      completedAt: daysAgo(1, now),
    })
    // An admin's tick is that member's own, not the tenant's.
    const admin = await addMember(tenantAt(10), 'admin')
    await addCompletion(tenantAt(10).id, 'read_getting_started', {
      userId: admin.id,
      source: 'customer',
      completedBy: admin.id,
      completedAt: daysAgo(1, now),
    })
    await addCompletion(tenantAt(11).id, 'configure_settings', { completedAt: daysAgo(8, now) })
    await addCompletion(tenantAt(11).id, 'invite_teammate', { completedAt: daysAgo(8, now) })

    const states: string[] = []
    for (const { tenant } of fixtures) {
      const row = await tenantRepository.findById(tenant.id)
      if (!row) throw new Error('setup: tenant gone')
      const derived = deriveOnboardingState({
        tenant: row,
        completions: await completionRepository.listForTenant(tenant.id),
        activeOwnerIds: await userMembershipRepository.listActiveOwnerIds(tenant.id),
        stuckAfterDays: getEnv().ONBOARDING_STUCK_AFTER_DAYS,
        now,
      })
      const staff = await getTenantOnboardingDetail(tenant.id, now)
      const customer = await getTenantOnboarding(tenant.id, { userId: NONE }, now)
      const isoOf = (date: Date | null): string | null => date?.toISOString() ?? NONE
      expect({
        id: tenant.id,
        state: staff.state,
        requiredDone: staff.requiredDone,
        requiredTotal: staff.requiredTotal,
        completedAt: isoOf(staff.completedAt),
        lastProgressAt: isoOf(staff.lastProgressAt),
      }).toEqual({
        id: tenant.id,
        state: derived.state,
        requiredDone: derived.requiredDone,
        requiredTotal: derived.requiredTotal,
        completedAt: isoOf(derived.completedAt),
        lastProgressAt: isoOf(derived.lastProgressAt),
      })
      const customerByStaffState: Partial<Record<OnboardingState, OnboardingState>> = {
        stuck: 'in_progress',
        awaiting_owner: 'not_tracked',
      }
      const customerState = customerByStaffState[staff.state] ?? staff.state
      expect(customer.state).toBe(customerState)
      expect(customer.completedAt).toBe(isoOf(staff.completedAt))
      states.push(staff.state)
    }
    // The fixtures reach every state, so the comparison above is not vacuous.
    expect(states).toEqual([
      'in_progress',
      'stuck',
      'dismissed',
      'not_tracked',
      'awaiting_owner',
      'complete',
      'stuck',
      'in_progress',
      'in_progress',
      'stuck',
      'stuck',
      'complete',
    ])
  })
})
