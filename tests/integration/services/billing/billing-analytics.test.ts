/**
 * @file The billing analytics events at their call sites, against this
 * worker's database, Redis and the fake payment provider, read off the
 * outbox: each event's distinct id (the person the change is attributed to,
 * never the system while one is known), its tenant group, its `plan` and
 * `billing_state` after the change, and no PII key; the group marker that
 * follows it and the plan properties the drain fills in; refusals reported
 * after their transaction rolled back, and throttled where they must be; and
 * a change passed in twice written once. Analytics is switched on by mocking
 * `isAnalyticsEnabled`.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { PII_PROPERTY_KEYS } from '@/constants/analytics.constants'
import { BILLING_STATES, PLAN_KEYS } from '@/constants/billing.constants'
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import type { User } from '@/database/models/user.model'
import { ProviderError } from '@/errors/billing-provider-errors'
import { HttpError } from '@/errors/http-error'
import { requireFeature } from '@/middlewares/entitlement.middleware'
import { BillingRepository } from '@/repositories/billing.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { buildTenantGroupIdentify } from '@/services/analytics/analytics-event-builder.service'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { resolveGroupMarkers } from '@/services/analytics/analytics-group-marker.service'
import {
  markCancel,
  trackCheckoutConfirmed,
  trackProviderEvent,
  trackTrialReminder,
} from '@/services/billing/billing-analytics.service'
import { sendPayerLeft, sendTrialEnding } from '@/services/billing/billing-emails.service'
import { emitBillingDiff } from '@/services/billing/billing-events.service'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { processBillingWebhookEvent } from '@/services/billing/billing-webhook.service'
import { cancelPaid, confirmCheckout, startCheckout } from '@/services/billing/checkout.service'
import { countLimitHits } from '@/services/billing/plan-limit-hits.service'
import { db, sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { hashToken } from '@/services/session.service'
import { accept, invite } from '@/services/tenant-invitation.service'
import { createTenant } from '@/services/tenant.service'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { grantSeats } from '../../../helpers/billing'
import {
  confirmBody,
  deleteTrackedTenants,
  fake,
  fakeSubscription,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  plans,
  readBilling,
  setBilling,
  workspace,
} from '../../../helpers/billing-api'
import { withMutatedMethod } from '../../../helpers/mutate'
import { createTrackedUser, deleteTrackedUsers } from '../../../helpers/platform-users'

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true }
})

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../../helpers/billing-api')
  // The real failure mapping, with the fake as the provider.
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

const billingRepository = new BillingRepository()
const invitationRepository = new TenantInvitationRepository()
const PII_KEYS: ReadonlySet<string> = new Set(PII_PROPERTY_KEYS)
const DAY_MS = 24 * 60 * 60 * 1000
const extraTenantIds: string[] = []

beforeAll(async () => {
  await loadPlans()
  registerAnalyticsSubscribers()
})

afterEach(async () => {
  // The changes queue billing mail; a later file in this worker counts the queue's jobs.
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await sql`delete from analytics_outbox where properties->'$groups'->>'tenant' is not null or properties->>'$group_type' = 'tenant'`
  await truncateAuditLogs()
  if (extraTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${extraTenantIds})`
    extraTenantIds.length = 0
  }
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await forgetProviderPlans()
  await closeQueue()
  await closeRedis()
})

/**
 * The outbox rows of one workspace: its events and its group markers, oldest first.
 * @param tenantId - The workspace.
 * @returns The rows.
 */
async function outboxOf(tenantId: string): Promise<AnalyticsOutboxRow[]> {
  return sql<AnalyticsOutboxRow[]>`
    select id, event, distinct_id as "distinctId", properties
    from analytics_outbox
    where properties->'$groups'->>'tenant' = ${tenantId}
      or properties->>'$group_key' = ${tenantId}
    order by occurred_at, id`
}

/**
 * The workspace's events of one type.
 * @param tenantId - The workspace.
 * @param event - The event name.
 * @returns The rows.
 */
async function eventsOf(tenantId: string, event: string): Promise<AnalyticsOutboxRow[]> {
  const rows = await outboxOf(tenantId)
  return rows.filter((row) => row.event === event)
}

/**
 * The one event of a type a workspace has, checked for its group and no PII key.
 * @param tenantId - The workspace.
 * @param event - The event name.
 * @returns The row.
 */
async function oneEvent(tenantId: string, event: string): Promise<AnalyticsOutboxRow> {
  const rows = await eventsOf(tenantId, event)
  expect(rows, `${event} rows`).toHaveLength(1)
  const [row] = rows
  if (row === undefined) throw new Error(`no ${event}`)
  expectBillingShape(row, tenantId)
  return row
}

/**
 * Check a billing event's tenant group, its plan and state traits, and that it carries no PII key.
 * @param row - The event's row.
 * @param tenantId - The workspace it must join.
 */
function expectBillingShape(row: AnalyticsOutboxRow, tenantId: string): void {
  expect(row.properties.$groups).toEqual({ tenant: tenantId })
  expect(PLAN_KEYS).toContain(row.properties.plan)
  expect(BILLING_STATES).toContain(row.properties.billing_state)
  for (const key of Object.keys(row.properties)) expect(PII_KEYS.has(key), key).toBe(false)
}

/**
 * The distinct id of a workspace's one event of a type.
 * @param tenantId - The workspace.
 * @param event - The event name.
 * @returns The distinct id.
 */
async function distinctIdOf(tenantId: string, event: string): Promise<string> {
  const row = await oneEvent(tenantId, event)
  return row.distinctId
}

/**
 * The properties of a workspace's one event of a type.
 * @param tenantId - The workspace.
 * @param event - The event name.
 * @returns The properties.
 */
async function propertiesOf(tenantId: string, event: string): Promise<Record<string, unknown>> {
  const row = await oneEvent(tenantId, event)
  return row.properties
}

/**
 * The names of a workspace's outbox rows, oldest first.
 * @param tenantId - The workspace.
 * @returns The names.
 */
async function eventNamesOf(tenantId: string): Promise<string[]> {
  const rows = await outboxOf(tenantId)
  return rows.map((row) => row.event)
}

/**
 * The ids of a workspace's outbox rows, oldest first.
 * @param tenantId - The workspace.
 * @returns The ids.
 */
async function rowIdsOf(tenantId: string): Promise<string[]> {
  const rows = await outboxOf(tenantId)
  return rows.map((row) => row.id)
}

/**
 * A workspace's group markers, oldest first.
 * @param tenantId - The workspace.
 * @returns The marker rows.
 */
async function markersOf(tenantId: string): Promise<AnalyticsOutboxRow[]> {
  const rows = await outboxOf(tenantId)
  return rows.filter((row) => row.event === '$groupidentify')
}

/**
 * The uuid and timestamp of every outbox row of a workspace, by event.
 * @param tenantId - The workspace.
 * @returns Each row's event, id and time, oldest first.
 */
async function stampsOf(
  tenantId: string
): Promise<{ event: string; id: string; occurredAt: string }[]> {
  return sql<{ event: string; id: string; occurredAt: string }[]>`
    select event, id, occurred_at::text as "occurredAt"
    from analytics_outbox
    where properties->'$groups'->>'tenant' = ${tenantId}
      or properties->>'$group_key' = ${tenantId}
    order by event, id`
}

/**
 * Empty a workspace's outbox rows, as the drain does once PostHog has them.
 * @param tenantId - The workspace.
 */
async function drainOutboxOf(tenantId: string): Promise<void> {
  await sql`delete from analytics_outbox where properties->'$groups'->>'tenant' = ${tenantId} or properties->>'$group_key' = ${tenantId}`
}

/**
 * Forget a workspace's counted plan refusals.
 * @param tenantId - The workspace.
 */
async function clearLimitHits(tenantId: string): Promise<void> {
  const client = await getRedis()
  await client.del(redisKey('billing', 'limit-hits', tenantId))
}

/**
 * A Free workspace with a second owner who started its checkout and a payer, paying monthly.
 * @returns The workspace, its owner and the subscription.
 */
async function payingWorkspace(): Promise<{
  tenantId: string
  owner: User
  subscriptionId: string
}> {
  const { tenant, owner } = await workspace()
  const { subscriptionId } = await makePaying(tenant.id)
  await setBilling(tenant.id, { payerUserId: owner.id, checkoutStartedBy: owner.id })
  return { tenantId: tenant.id, owner, subscriptionId }
}

describe('billing analytics from a billing change', () => {
  it('sends a webhook-driven activation as the owner who started the checkout, with a group marker', async () => {
    const { tenant, owner } = await workspace()
    const requester = await createTrackedUser()
    const subscriptionId = await fakeSubscription({
      tenantId: tenant.id,
      priceId: plans.monthPriceId,
    })
    await setBilling(tenant.id, {
      pendingSubscriptionId: subscriptionId,
      checkoutStartedBy: owner.id,
    })
    await billingRepository.openUpgradeRequest({
      tenantId: tenant.id,
      requestedBy: requester.id,
      surface: 'members',
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
    })
    await fake.fakeAdvance(subscriptionId, 'active')

    await syncTenantBilling(tenant.id, 'webhook')

    const activated = await oneEvent(tenant.id, 'subscription_activated')
    expect(activated.distinctId).toBe(owner.id)
    expect(activated.properties).toMatchObject({
      interval: 'month',
      plan: 'paid',
      billing_state: 'active',
      source: 'product',
      access: 'system',
    })
    expect(activated.properties).not.toHaveProperty('$process_person_profile')
    const fulfilled = await oneEvent(tenant.id, 'upgrade_request_fulfilled')
    expect(fulfilled.distinctId).toBe(requester.id)
    const markers = await markersOf(tenant.id)
    expect(markers.length).toBeGreaterThan(0)
    expect(markers[0]?.properties).not.toHaveProperty('$group_set')
  })

  it('writes nothing new when the same change is passed in again', async () => {
    const { tenantId, subscriptionId } = await payingWorkspace()
    const before = await readBilling(tenantId)
    await fake.fakeAdvance(subscriptionId, 'halted')
    await syncTenantBilling(tenantId, 'webhook')
    const after = await readBilling(tenantId)
    const written = await outboxOf(tenantId)
    expect(written.map((row) => row.event)).toContain('payment_failed')

    await emitBillingDiff(before, after, 'webhook')

    expect(await rowIdsOf(tenantId)).toEqual(written.map((row) => row.id))
  })

  it('sends a renewal as the payer', async () => {
    const { tenantId, owner, subscriptionId } = await payingWorkspace()
    await setBilling(tenantId, { currentPeriodEnd: new Date(Date.now() + DAY_MS) })
    await fake.fakeAdvance(subscriptionId, 'active')

    await syncTenantBilling(tenantId, 'webhook')

    const renewed = await oneEvent(tenantId, 'subscription_renewed')
    expect(renewed.distinctId).toBe(owner.id)
    expect(renewed.properties).toMatchObject({ plan: 'paid', billing_state: 'active' })
  })

  it('sends a halt as a failed payment and a halt, then the recovery, as the payer', async () => {
    const { tenantId, owner, subscriptionId } = await payingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'halted')

    await syncTenantBilling(tenantId, 'webhook')

    const failed = await oneEvent(tenantId, 'payment_failed')
    expect(failed.distinctId).toBe(owner.id)
    expect(failed.properties).toMatchObject({
      failure_code: 'halted',
      plan: 'paid',
      billing_state: 'past_due',
    })
    expect(failed.properties).not.toHaveProperty('reason')
    expect(await distinctIdOf(tenantId, 'subscription_halted')).toBe(owner.id)

    await fake.fakeAdvance(subscriptionId, 'active')
    await syncTenantBilling(tenantId, 'webhook')

    const recovered = await oneEvent(tenantId, 'subscription_recovered')
    expect(recovered.distinctId).toBe(owner.id)
    expect(recovered.properties).toMatchObject({ billing_state: 'active' })
  })

  it('sends a cancel from the payer bank as customer_bank, and the move to Free with its cause', async () => {
    const { tenantId, owner, subscriptionId } = await payingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'cancelled')

    await syncTenantBilling(tenantId, 'webhook')

    const cancel = await oneEvent(tenantId, 'subscription_cancel_scheduled')
    expect(cancel.distinctId).toBe(owner.id)
    expect(cancel.properties).toMatchObject({ by: 'customer_bank', billing_state: 'active' })

    await fake.fakeAdvance(subscriptionId, 'completed')
    await setBilling(tenantId, { currentPeriodEnd: new Date(Date.now() - 10 * DAY_MS) })
    await syncTenantBilling(tenantId, 'job')

    const downgraded = await oneEvent(tenantId, 'downgraded_to_free')
    expect(downgraded.distinctId).toBe(owner.id)
    expect(downgraded.properties).toMatchObject({
      downgrade_cause: 'cancelled',
      plan: 'free',
      billing_state: 'free',
    })
  })

  it("sends an owner's cancel as that owner, by owner, alongside its audit event under another name", async () => {
    const { tenantId, owner } = await payingWorkspace()

    await cancelPaid({ userId: owner.id }, tenantId)

    const cancel = await oneEvent(tenantId, 'subscription_cancel_scheduled')
    expect(cancel.distinctId).toBe(owner.id)
    expect(cancel.properties).toMatchObject({ by: 'owner', access: 'member' })
    expect(await eventNamesOf(tenantId)).toContain('billing_cancel_scheduled')
  })

  it('sends an interval change once the switch is authenticated, as the owner who started it', async () => {
    const { tenantId, owner } = await payingWorkspace()
    const next = await fakeSubscription(
      { tenantId, priceId: plans.yearPriceId },
      'year',
      new Date(Date.now() + 20 * DAY_MS)
    )
    await setBilling(tenantId, {
      nextSubscriptionId: next,
      nextPriceId: plans.yearPriceId,
      checkoutStartedBy: owner.id,
      payerUserId: null,
    })
    await fake.fakeAdvance(next, 'authenticated')

    await syncTenantBilling(tenantId, 'webhook')

    const scheduled = await oneEvent(tenantId, 'subscription_interval_change_scheduled')
    expect(scheduled.distinctId).toBe(owner.id)
    expect(scheduled.properties).toMatchObject({ plan: 'paid', billing_state: 'active' })
    expect(await eventsOf(tenantId, 'subscription_cancel_scheduled')).toHaveLength(0)
  })

  it('sends a reconcile repair as billing_reconciled with the field it fixed', async () => {
    const { tenantId, subscriptionId } = await payingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'halted')

    await syncTenantBilling(tenantId, 'reconcile')

    expect(await propertiesOf(tenantId, 'billing_reconciled')).toMatchObject({
      field: 'state',
      billing_state: 'past_due',
    })
  })

  it('sends a lapsed trial as trial_ended and a downgrade, as the trial owner', async () => {
    const { tenant, owner } = await workspace()
    await db.transaction(async (tx) => {
      await billingRepository.claimUserTrial(owner.id, tx)
      await billingRepository.setFirstTrialTenant(owner.id, tenant.id, tx)
    })
    await setBilling(tenant.id, {
      state: 'trialing',
      planId: plans.paidId,
      trialStartedAt: new Date(Date.now() - 15 * DAY_MS),
      trialEndsAt: new Date(Date.now() - DAY_MS),
    })
    const before = await readBilling(tenant.id)
    await sql`update tenant_billing set state = 'free', plan_id = ${plans.freeId}, version = version + 1, updated_at = now() where tenant_id = ${tenant.id}`
    const after = await readBilling(tenant.id)

    await emitBillingDiff(before, after, 'job')

    const ended = await oneEvent(tenant.id, 'trial_ended')
    expect(ended.distinctId).toBe(owner.id)
    expect(ended.properties).toMatchObject({ plan: 'free', billing_state: 'free' })
    const downgraded = await oneEvent(tenant.id, 'downgraded_to_free')
    expect(downgraded.properties).toMatchObject({ downgrade_cause: 'trial_ended' })
  })

  it('sends a lapsed trial with no trial owner left as a system event', async () => {
    const { tenant } = await workspace()
    await setBilling(tenant.id, {
      state: 'trialing',
      planId: plans.paidId,
      trialEndsAt: new Date(Date.now() - DAY_MS),
    })
    const before = await readBilling(tenant.id)
    await sql`update tenant_billing set state = 'free', plan_id = ${plans.freeId}, version = version + 1 where tenant_id = ${tenant.id}`

    await emitBillingDiff(before, await readBilling(tenant.id), 'job')

    expect(await oneEvent(tenant.id, 'trial_ended')).toMatchObject({
      distinctId: 'system',
      properties: { $process_person_profile: false },
    })
  })
})

describe('attribution across payers and owners', () => {
  it('names the new owner, never the earlier payer, when a Free workspace upgrades again by webhook alone', async () => {
    const { tenant, owner: earlierPayer } = await workspace()
    const upgrader = await createTrackedUser()
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${upgrader.id}, ${tenant.id}, 'owner')`
    await setBilling(tenant.id, {
      payerUserId: earlierPayer.id,
      checkoutStartedBy: earlierPayer.id,
      billingEmail: earlierPayer.email,
    })
    const session = await startCheckout({ userId: upgrader.id }, tenant.id, 'month')
    await fake.fakeAdvance(session.subscriptionId, 'active')

    await syncTenantBilling(tenant.id, 'webhook')
    await fake.fakeAdvance(session.subscriptionId, 'halted')
    await syncTenantBilling(tenant.id, 'webhook')

    expect(await readBilling(tenant.id)).toMatchObject({
      payerUserId: upgrader.id,
      billingEmail: null,
    })
    const written = await outboxOf(tenant.id)
    const rows = written.filter(
      (row) => row.event !== '$groupidentify' && !row.event.startsWith('billing_')
    )
    expect(rows.map((row) => row.event)).toEqual(
      expect.arrayContaining(['subscription_activated', 'payment_failed', 'subscription_halted'])
    )
    for (const row of rows) expect(row.distinctId, row.event).toBe(upgrader.id)
  })

  it('names the checkout starter for the first charge of an upgrade made during a trial', async () => {
    const { tenantId, owner } = await payingWorkspace()
    const earlierPayer = await createTrackedUser()
    const trialEnd = new Date(Date.now() + DAY_MS)
    await setBilling(tenantId, {
      payerUserId: earlierPayer.id,
      checkoutStartedBy: owner.id,
      trialEndsAt: trialEnd,
      currentPeriodEnd: trialEnd,
    })
    const before = await readBilling(tenantId)
    await sql`update tenant_billing set current_period_end = ${new Date(Date.now() + 31 * DAY_MS).toISOString()}::timestamptz, version = version + 1 where tenant_id = ${tenantId}`

    await emitBillingDiff(before, await readBilling(tenantId), 'webhook')

    expect(await distinctIdOf(tenantId, 'subscription_renewed')).toBe(owner.id)
  })

  it('never names a soft-deleted payer: the next person is named', async () => {
    const { tenantId, owner, subscriptionId } = await payingWorkspace()
    const goneUser = await createTrackedUser()
    await sql`update users set deleted_at = now() where id = ${goneUser.id}`
    await setBilling(tenantId, { payerUserId: goneUser.id, checkoutStartedBy: owner.id })
    await fake.fakeAdvance(subscriptionId, 'halted')

    await syncTenantBilling(tenantId, 'webhook')

    expect(await distinctIdOf(tenantId, 'subscription_halted')).toBe(owner.id)
  })

  it('sends a staff-made change as the payer, never as staff', async () => {
    const { tenantId, owner } = await payingWorkspace()
    const staffMember = await createTrackedUser()
    const before = await readBilling(tenantId)
    await sql`update tenant_billing set cancel_at_period_end = true, version = version + 1 where tenant_id = ${tenantId}`

    await emitBillingDiff(before, await readBilling(tenantId), 'staff', {
      actorUserId: staffMember.id,
      isStaffCancel: true,
    })

    const cancel = await oneEvent(tenantId, 'subscription_cancel_scheduled')
    expect(cancel).toMatchObject({
      distinctId: owner.id,
      properties: { by: 'staff', access: 'system' },
    })
  })

  it("sends an owner's cancel as by owner even when the provider's webhook lands it first", async () => {
    const { tenantId, owner } = await payingWorkspace()
    const original = fake.cancelSubscription.bind(fake)

    await withMutatedMethod(
      fake,
      'cancelSubscription',
      async (id: string, isAtCycleEnd: boolean) => {
        const cancelled = await original(id, isAtCycleEnd)
        // The provider's webhook is synced before the owner's own write.
        await fake.fakeAdvance(id, 'cancelled')
        await syncTenantBilling(tenantId, 'webhook')
        return cancelled
      },
      async () => {
        await cancelPaid({ userId: owner.id }, tenantId)
      }
    )

    const cancel = await oneEvent(tenantId, 'subscription_cancel_scheduled')
    expect(cancel).toMatchObject({
      distinctId: owner.id,
      properties: { by: 'owner', access: 'member' },
    })
  })
})

describe('a payer the confirm set', () => {
  it('keeps the owner who paid and confirmed as the payer when the activation lands later', async () => {
    const { tenant, owner: payingOwner } = await workspace()
    const reopener = await createTrackedUser()
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${reopener.id}, ${tenant.id}, 'owner')`
    const session = await startCheckout({ userId: payingOwner.id }, tenant.id, 'month')
    const reopened = await startCheckout({ userId: reopener.id }, tenant.id, 'month')
    expect(reopened.subscriptionId).toBe(session.subscriptionId)
    // Still `created` at the provider: the confirm's own sync changes nothing, and only the payer is recorded.

    await confirmCheckout(
      { userId: payingOwner.id },
      tenant.id,
      confirmBody(session.subscriptionId)
    )
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'free',
      payerUserId: payingOwner.id,
      billingEmail: payingOwner.email,
    })
    await fake.fakeAdvance(session.subscriptionId, 'active')
    await syncTenantBilling(tenant.id, 'webhook')

    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      payerUserId: payingOwner.id,
      billingEmail: payingOwner.email,
    })
  })

  it('sends a confirm posted again for an uncharged checkout with the same uuid and timestamp', async () => {
    const { tenant, owner } = await workspace()
    const session = await startCheckout({ userId: owner.id }, tenant.id, 'month')
    // Not charged yet, with an immediate start: neither start time is set, so the time is the creation's.
    const sub = await fake.fetchSubscription(session.subscriptionId)
    expect(sub).toMatchObject({ currentStart: null, startAt: null })
    expect(sub.createdAt).toBeInstanceOf(Date)

    await confirmCheckout({ userId: owner.id }, tenant.id, confirmBody(session.subscriptionId))
    const firstStamps = await stampsOf(tenant.id)
    const first = firstStamps.filter((stamp) => stamp.event === 'checkout_confirmed')
    expect(first).toHaveLength(1)
    await drainOutboxOf(tenant.id)
    await confirmCheckout({ userId: owner.id }, tenant.id, confirmBody(session.subscriptionId))

    const againStamps = await stampsOf(tenant.id)
    const again = againStamps.filter((stamp) => stamp.event === 'checkout_confirmed')
    expect(again).toEqual(first)
  })
})

describe('a failed owner cancel', () => {
  it('forgets the owner, so a later suspension cancel reads by suspension', async () => {
    const { tenantId, owner, subscriptionId } = await payingWorkspace()

    await withMutatedMethod(
      fake,
      'cancelSubscription',
      () => Promise.reject(new ProviderError('POST /subscriptions/x/cancel', 503, {})),
      async () => {
        await expect(cancelPaid({ userId: owner.id }, tenantId)).rejects.toBeDefined()
      }
    )
    const client = await getRedis()
    expect(
      await client.exists(redisKey('billing', 'cancel-marker', tenantId, subscriptionId))
    ).toBe(0)
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenantId}`
    await fake.fakeAdvance(subscriptionId, 'cancelled')
    await syncTenantBilling(tenantId, 'job')

    expect(await propertiesOf(tenantId, 'subscription_cancel_scheduled')).toMatchObject({
      by: 'suspension',
    })
  })
})

describe('a staff cancel marker on a suspended workspace', () => {
  it('reads a cancel the webhook brings in as by suspension, since the marker may outlive a failed staff cancel', async () => {
    const { tenantId, subscriptionId } = await payingWorkspace()
    await markCancel(tenantId, subscriptionId, { by: 'staff' })
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenantId}`
    await fake.fakeAdvance(subscriptionId, 'cancelled')

    await syncTenantBilling(tenantId, 'webhook')

    expect(await propertiesOf(tenantId, 'subscription_cancel_scheduled')).toMatchObject({
      by: 'suspension',
    })
  })
})

describe('a cancel the provider made before the owner asked', () => {
  it("reads as the customer's bank, sent as the payer, when the owner's cancel only brings it in", async () => {
    const { tenantId, owner, subscriptionId } = await payingWorkspace()
    const payer = await createTrackedUser()
    await setBilling(tenantId, { payerUserId: payer.id })
    // Cancelled at the provider; the webhook has not landed yet.
    await fake.fakeAdvance(subscriptionId, 'cancelled')

    await cancelPaid({ userId: owner.id }, tenantId)

    expect(await readBilling(tenantId)).toMatchObject({ cancelAtPeriodEnd: true })
    const cancel = await oneEvent(tenantId, 'subscription_cancel_scheduled')
    expect(cancel).toMatchObject({
      distinctId: payer.id,
      properties: { by: 'customer_bank', access: 'system' },
    })
  })
})

describe('event times fixed by stable data', () => {
  it('sends a change again after the drain with the same uuid and timestamp', async () => {
    const { tenantId, subscriptionId } = await payingWorkspace()
    const before = await readBilling(tenantId)
    await fake.fakeAdvance(subscriptionId, 'halted')
    await syncTenantBilling(tenantId, 'webhook')
    const after = await readBilling(tenantId)
    const first = await stampsOf(tenantId)
    await drainOutboxOf(tenantId)

    await emitBillingDiff(before, after, 'webhook')

    expect(await stampsOf(tenantId)).toEqual(first)
  })

  it('sends a reminder, a confirm and a provider event again later with the same uuid and timestamp', async () => {
    const { tenantId, owner, subscriptionId } = await payingWorkspace()
    const row = await readBilling(tenantId)
    const trialRow = {
      ...row,
      state: 'trialing' as const,
      trialEndsAt: new Date(Date.now() + 2 * DAY_MS),
    }
    const sub = await fake.fetchSubscription(subscriptionId)
    /**
     * Send each event once, as at `now`.
     * @param now - The time the sends run at.
     */
    const sendAll = async (now: Date): Promise<void> => {
      await trackTrialReminder(trialRow, 'trial_ending', now)
      await trackCheckoutConfirmed(tenantId, owner.id, sub)
      await trackProviderEvent(row, 'dispute_opened', 'disp_FAKEstable')
      await trackProviderEvent(row, 'duplicate_subscription_refunded', 'sub_FAKEdup')
    }
    await sendAll(new Date())
    const first = await stampsOf(tenantId)
    expect(first.map((stamp) => stamp.event)).toEqual(
      expect.arrayContaining([
        'trial_reminder_sent',
        'checkout_confirmed',
        'dispute_opened',
        'duplicate_subscription_refunded',
      ])
    )
    await drainOutboxOf(tenantId)

    await sendAll(new Date(Date.now() + 60 * 60 * 1000))

    expect(await stampsOf(tenantId)).toEqual(first)
  })
})

describe('billing analytics at their own call sites', () => {
  it('sends trial_started as the creator of a workspace that starts a trial', async () => {
    const creator = await createTrackedUser()

    const tenant = await createTenant(
      { userId: creator.id },
      { name: 'Trial Co', slug: `trial-${randomUUID().slice(0, 8)}` }
    )
    extraTenantIds.push(tenant.id)

    const started = await oneEvent(tenant.id, 'trial_started')
    expect(started.distinctId).toBe(creator.id)
    expect(started.properties).toMatchObject({ plan: 'paid', billing_state: 'trialing' })
  })

  it('sends trial_reminder_sent with the days left, as the trial owner', async () => {
    const { tenant, owner } = await workspace()
    await db.transaction(async (tx) => {
      await billingRepository.claimUserTrial(owner.id, tx)
      await billingRepository.setFirstTrialTenant(owner.id, tenant.id, tx)
    })
    await setBilling(tenant.id, {
      state: 'trialing',
      planId: plans.paidId,
      trialStartedAt: new Date(Date.now() - 12 * DAY_MS),
      trialEndsAt: new Date(Date.now() + 2 * DAY_MS - 60_000),
    })

    await sendTrialEnding(await readBilling(tenant.id), new Date())

    const reminder = await oneEvent(tenant.id, 'trial_reminder_sent')
    expect(reminder.distinctId).toBe(owner.id)
    expect(reminder.properties).toMatchObject({ days_left: 2, billing_state: 'trialing' })
  })

  it('sends checkout_started and checkout_confirmed as the owner', async () => {
    const { tenant, owner } = await workspace()

    const session = await startCheckout({ userId: owner.id }, tenant.id, 'month')

    const started = await oneEvent(tenant.id, 'checkout_started')
    expect(started.distinctId).toBe(owner.id)
    expect(started.properties).toMatchObject({
      interval: 'month',
      amount_minor: session.amountMinor,
      currency: 'INR',
      during_trial: false,
      plan: 'free',
      billing_state: 'free',
      access: 'member',
    })

    await fake.fakeAdvance(session.subscriptionId, 'active')
    await confirmCheckout({ userId: owner.id }, tenant.id, confirmBody(session.subscriptionId))

    const confirmed = await oneEvent(tenant.id, 'checkout_confirmed')
    expect(confirmed.distinctId).toBe(owner.id)
    expect(confirmed.properties).toMatchObject({ plan: 'paid', billing_state: 'active' })
    expect(await distinctIdOf(tenant.id, 'subscription_activated')).toBe(owner.id)
  })

  it('sends payer_left as the payer who left', async () => {
    const { tenantId, owner } = await payingWorkspace()

    await sendPayerLeft(tenantId, owner.id, new Date())

    expect(await distinctIdOf(tenantId, 'payer_left')).toBe(owner.id)
  })

  it('sends dispute_opened once, as the payer, when a dispute first opens', async () => {
    const { tenantId, owner, subscriptionId } = await payingWorkspace()
    const client = await getRedis()
    const raw = await client.hGet(redisKey('billing-fake'), `sub:${subscriptionId}`)
    const paymentId = (JSON.parse(raw ?? '{}') as { payments: { paymentId: string }[] }).payments[0]
      ?.paymentId
    if (paymentId === undefined) throw new Error('setup: the fake took no payment')
    const disputeId = `disp_FAKE${randomUUID().slice(0, 8)}`
    await fake.fakeSetDispute(disputeId, 'open')
    const job = {
      eventRowId: randomUUID(),
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment.dispute.created',
      subscriptionId: null,
      paymentId,
      disputeId,
    }

    await processBillingWebhookEvent(job)
    await processBillingWebhookEvent({ ...job, eventRowId: randomUUID() })

    const opened = await oneEvent(tenantId, 'dispute_opened')
    expect(opened.distinctId).toBe(owner.id)
    expect(opened.properties).toMatchObject({ plan: 'paid', billing_state: 'active' })
  })

  it('sends duplicate_subscription_refunded as the payer', async () => {
    const { tenantId, owner } = await payingWorkspace()
    const duplicate = await fakeSubscription({ tenantId, priceId: plans.monthPriceId })
    await fake.fakeAdvance(duplicate, 'active')

    await syncTenantBilling(tenantId, 'reconcile', { extraSubscriptionIds: [duplicate] })

    expect(await distinctIdOf(tenantId, 'duplicate_subscription_refunded')).toBe(owner.id)
  })
})

describe('plan refusals', () => {
  it('reports an invite past the members limit after its rollback, every time, as the inviter', async () => {
    const { tenant, owner } = await workspace()
    const actor = { userId: owner.id }
    await invite(actor, tenant.id, `a-${randomUUID()}@example.test`, 'editor')
    await invite(actor, tenant.id, `b-${randomUUID()}@example.test`, 'editor')

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        invite(actor, tenant.id, `c-${randomUUID()}@example.test`, 'editor')
      ).rejects.toMatchObject({ statusCode: 402 })
    }

    const pending = await sql`select id from tenant_invitations where tenant_id = ${tenant.id}`
    expect(pending).toHaveLength(2)
    const reached = await eventsOf(tenant.id, 'plan_limit_reached')
    expect(reached).toHaveLength(2)
    for (const row of reached) expectBillingShape(row, tenant.id)
    expect(reached[0]).toMatchObject({
      distinctId: owner.id,
      properties: { key: 'members', used: 3, limit: 3, plan: 'free', billing_state: 'free' },
    })
  })

  it('reports no approaching limit on Free at 3 of 3, where the app shows none', async () => {
    const { tenant, owner } = await workspace()
    const actor = { userId: owner.id }

    await invite(actor, tenant.id, `a-${randomUUID()}@example.test`, 'editor')
    await invite(actor, tenant.id, `b-${randomUUID()}@example.test`, 'editor')

    expect(await eventsOf(tenant.id, 'plan_limit_approaching')).toHaveLength(0)
  })

  it('reports the crossing into the approaching band of a 10-seat limit at 8, once', async () => {
    const { tenant, owner } = await workspace()
    await grantSeats(tenant.id, 10)
    const actor = { userId: owner.id }

    // The owner holds one seat; eight invitations take the workspace to 9 of 10.
    for (let index = 0; index < 8; index += 1) {
      await invite(actor, tenant.id, `seat-${String(index)}-${randomUUID()}@example.test`, 'editor')
    }

    const approaching = await oneEvent(tenant.id, 'plan_limit_approaching')
    expect(approaching).toMatchObject({
      distinctId: owner.id,
      properties: { key: 'members', used: 8, limit: 10, access: 'member' },
    })
  })

  it('reports a join refused at the door as a system event with no use or cap', async () => {
    const { tenant, owner } = await workspace()
    const extra = [await createTrackedUser(), await createTrackedUser(), await createTrackedUser()]
    for (const member of extra) {
      await sql`insert into user_memberships (user_id, tenant_id, role) values (${member.id}, ${tenant.id}, 'viewer')`
    }
    const invitee = await createTrackedUser()
    const rawToken = randomBytes(32).toString('base64url')
    await db.transaction((tx) =>
      invitationRepository.createPending(
        {
          tenantId: tenant.id,
          email: invitee.email,
          role: 'viewer',
          tokenHash: hashToken(rawToken),
          invitedBy: owner.id,
          expiresAt: new Date(Date.now() + DAY_MS),
        },
        tx
      )
    )

    await expect(accept(rawToken, invitee.id)).rejects.toMatchObject({ statusCode: 402 })

    const reached = await oneEvent(tenant.id, 'plan_limit_reached')
    expect(reached.distinctId).toBe('system')
    expect(reached.properties).toMatchObject({ key: 'members', access: 'system' })
    expect(reached.properties).not.toHaveProperty('used')
    expect(reached.properties).not.toHaveProperty('limit')
  })

  it('reports a feature refusal once an hour per workspace and key, and none for staff', async () => {
    const { tenant, owner } = await workspace()
    await clearLimitHits(tenant.id)
    const gate = requireFeature('advanced_example')
    /**
     * Run the gate for one caller.
     * @param access - How they reached the workspace.
     * @returns What the gate passed on.
     */
    const run = async (access: 'member' | 'platform'): Promise<unknown> => {
      let passed: unknown
      await gate(
        {
          principal: {
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            isPlatformTenant: false,
            role: 'owner',
            memberRole: access === 'member' ? 'owner' : null,
            platformRole: access === 'member' ? null : 'admin',
            access,
          },
          user: { id: owner.id },
        } as never,
        {} as never,
        (value?: unknown) => {
          passed = value
        }
      )
      return passed
    }

    expect(await run('platform')).toBeInstanceOf(HttpError)
    expect(await eventsOf(tenant.id, 'plan_feature_blocked')).toHaveLength(0)
    expect(await run('member')).toBeInstanceOf(HttpError)
    expect(await run('member')).toBeInstanceOf(HttpError)

    const blocked = await oneEvent(tenant.id, 'plan_feature_blocked')
    expect(blocked).toMatchObject({
      distinctId: owner.id,
      properties: { key: 'advanced_example', plan: 'free', billing_state: 'free' },
    })
    // The group's count takes every member refusal, the hour's quiet ones too; staff's none.
    const hits = await countLimitHits([tenant.id])
    expect(hits.get(tenant.id)).toBe(2)
  })
})

describe('the tenant group plan properties', () => {
  it('fills in every billing property of a Paid workspace when its marker is sent', async () => {
    const { tenantId, owner } = await payingWorkspace()
    await sql`insert into billing_state_history (tenant_id, from_state, to_state, cause, source) values (${tenantId}, 'free', 'active', 'subscription_activated', 'confirm')`
    await billingRepository.openUpgradeRequest({
      tenantId,
      requestedBy: owner.id,
      surface: 'members',
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
    })
    await clearLimitHits(tenantId)
    const marker = buildTenantGroupIdentify({ id: tenantId }, {}, 'product', new Date())

    const [resolved] = await resolveGroupMarkers([
      {
        ...marker,
        id: randomUUID(),
        occurredAt: new Date(),
        claimedUntil: null,
        attempts: 1,
        rejections: 0,
      },
    ])

    expect(resolved?.properties.$group_set).toMatchObject({
      plan: 'paid',
      billing_state: 'active',
      billing_interval: 'month',
      trial_start_date: null,
      trial_end_date: null,
      trial_plan_name: null,
      limit_hits_30d: 0,
      open_upgrade_requests: 1,
      paid_since: expect.any(String) as unknown,
    })
  })

  it('counts the refusals of the last 30 days, and names the trial plan of a trialing workspace', async () => {
    const { tenant, owner } = await workspace()
    await clearLimitHits(tenant.id)
    const actor = { userId: owner.id }
    await invite(actor, tenant.id, `a-${randomUUID()}@example.test`, 'editor')
    await invite(actor, tenant.id, `b-${randomUUID()}@example.test`, 'editor')
    await expect(
      invite(actor, tenant.id, `c-${randomUUID()}@example.test`, 'editor')
    ).rejects.toBeInstanceOf(HttpError)
    const [marker] = await markersOf(tenant.id)
    if (marker === undefined) throw new Error('no marker')
    await setBilling(tenant.id, {
      state: 'trialing',
      planId: plans.paidId,
      trialStartedAt: new Date(),
      trialEndsAt: new Date(Date.now() + 14 * DAY_MS),
    })

    const [resolved] = await resolveGroupMarkers([
      { ...marker, occurredAt: new Date(), claimedUntil: null, attempts: 1, rejections: 0 },
    ])

    expect(resolved?.properties.$group_set).toMatchObject({
      plan: 'paid',
      billing_state: 'trialing',
      billing_interval: null,
      trial_plan_name: 'Paid',
      trial_start_date: expect.any(String) as unknown,
      limit_hits_30d: 1,
      paid_since: null,
    })
  })
})
