/**
 * @file Every onboarding completion path yields exactly one
 * `onboarding_step_completed` outbox row, through the real services and the
 * subscribers createApp() registers: an automatic completion and a
 * member's tick as product events, a staff completion from its audit entry
 * (never also as a product event), and the reconcile as a system event. A
 * repeat completes nothing and writes nothing. Analytics is off under
 * `.env.test`, so `isAnalyticsEnabled` is mocked on here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { sql } from '@/services/database.service'
import { resetDomainEventSubscribers } from '@/services/domain-events.service'
import { completeStepAsMember, registerOnboardingSubscribers } from '@/services/onboarding.service'
import { completeTenantStep, reconcileOnboarding } from '@/services/platform-onboarding.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { updateSettings } from '@/services/tenant.service'
import { clearOutbox, outboxRows } from '../../helpers/analytics-outbox'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { createOnboardingTenant, daysAgo, deleteOnboardingTenants } from '../../helpers/onboarding'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'

const analytics = vi.hoisted(() => ({ isEnabled: true }))

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => analytics.isEnabled }
})

const STEP_EVENT = 'onboarding_step_completed'

beforeAll(() => {
  resetDomainEventSubscribers()
  createApp()
})

beforeEach(async () => {
  analytics.isEnabled = true
  await clearOutbox()
})

afterEach(async () => {
  await clearOutbox()
  await truncateAuditLogs()
  await deleteOnboardingTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  resetDomainEventSubscribers()
  registerOnboardingSubscribers()
  registerAnalyticsSubscribers()
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * One tenant's `onboarding_step_completed` rows: the reconcile sweeps every
 * tenant in this worker's database, so rows are matched by tenant group.
 * @param tenantId - The tenant.
 * @returns Its rows, oldest first.
 */
async function stepRowsOf(tenantId: string): Promise<AnalyticsOutboxRow[]> {
  const rows = await outboxRows()
  return rows.filter((row) => {
    const groups = row.properties.$groups as { tenant?: string } | undefined
    return row.event === STEP_EVENT && groups?.tenant === tenantId
  })
}

describe('one onboarding_step_completed per completion', () => {
  it('an automatic completion is a product event from the member whose action completed it', async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(1) })

    await updateSettings({ userId: owner.id }, tenant.id, { timezone: 'Europe/Paris' })
    await updateSettings({ userId: owner.id }, tenant.id, { timezone: 'Asia/Tokyo' })

    const rows = await stepRowsOf(tenant.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      distinctId: owner.id,
      properties: {
        source: 'product',
        access: 'member',
        step_key: 'configure_settings',
        how: 'auto',
        required: true,
      },
    })
  })

  it("a member's tick is a product event, and ticking it again writes nothing", async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(1) })

    await completeStepAsMember({ userId: owner.id }, tenant.id, 'read_getting_started')
    await completeStepAsMember({ userId: owner.id }, tenant.id, 'read_getting_started')

    const rows = await stepRowsOf(tenant.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      distinctId: owner.id,
      properties: {
        source: 'product',
        step_key: 'read_getting_started',
        how: 'manual',
        required: false,
      },
    })
  })

  it('a staff completion arrives once, from its audit entry, with the same property shape', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(1) })
    const { user: staff } = await createTrackedStaff('admin')

    await completeTenantStep({ userId: staff.id }, tenant.id, 'invite_teammate', 'Done on a call')

    const rows = await stepRowsOf(tenant.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      distinctId: staff.id,
      properties: {
        source: 'audit',
        access: 'platform',
        step_key: 'invite_teammate',
        how: 'manual',
        required: true,
        has_reason: true,
      },
    })
    expect(JSON.stringify(rows)).not.toContain('Done on a call')
  })

  it('a settings save through platform access completes nothing and writes no step event', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(1) })
    const { user: staff } = await createTrackedStaff('admin')

    await updateSettings({ userId: staff.id }, tenant.id, { timezone: 'Asia/Tokyo' })

    expect(await stepRowsOf(tenant.id)).toEqual([])
  })

  it('a reconciled step is a system event dated when its source action happened', async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    await updateSettings({ userId: owner.id }, tenant.id, { timezone: 'Europe/Paris' })
    await sql`delete from onboarding_completions where tenant_id = ${tenant.id}`
    await clearOutbox()

    await reconcileOnboarding()
    await reconcileOnboarding()

    const [entry] = await sql<{ occurred_at: Date }[]>`
      select occurred_at from audit_logs
      where tenant_id = ${tenant.id} and action = 'tenant.settings_updated'`
    const rows = await stepRowsOf(tenant.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      distinctId: 'system',
      properties: {
        source: 'product',
        access: 'system',
        step_key: 'configure_settings',
        how: 'auto',
        $process_person_profile: false,
      },
    })
    expect(rows[0]?.occurredAt.toISOString()).toBe(new Date(entry?.occurred_at ?? 0).toISOString())
  })
})
