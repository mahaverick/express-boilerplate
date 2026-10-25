/**
 * @file The attribution audit of every billing analytics event. Each event
 * is triggered once through its real call site (an owner route, a service a
 * route calls, the webhook job, the scheduler's runs, the sync a job runs, a
 * staff service) against this worker's database, Redis and the fake payment
 * provider, and read off the outbox. Every event is checked for its
 * distinct id (the real person, never staff, never a soft-deleted account,
 * the system only where no person is known), its tenant group, its `plan`
 * and `billing_state` against the billing row as the change left it, and no
 * PII key or address in its properties. Adversarial cases: one owner of two
 * workspaces, a payer who left and a new owner who upgrades, staff cancels,
 * a refused invitee, a deleted starter, an activation the webhook alone
 * brings in, a resend after the drain, and an event sent during another
 * person's request carrying no session of theirs. Analytics is switched on
 * by mocking `isAnalyticsEnabled`.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { PII_PROPERTY_KEYS, SYSTEM_DISTINCT_ID } from '@/constants/analytics.constants'
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { BillingRepository } from '@/repositories/billing.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import {
  runFrequentBilling,
  runLifecycleCancelFor,
} from '@/services/billing/billing-scheduler.service'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { processBillingWebhookEvent } from '@/services/billing/billing-webhook.service'
import {
  cancelPaid,
  confirmCheckout,
  startCheckout,
  startIntervalSwitch,
} from '@/services/billing/checkout.service'
import { requestUpgrade } from '@/services/billing/upgrade-request.service'
import { db, sql } from '@/services/database.service'
import { cancelByStaff, extendTrial } from '@/services/platform-billing.service'
import { deleteUser } from '@/services/platform-user.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { hashToken } from '@/services/session.service'
import { accept, invite, resend } from '@/services/tenant-invitation.service'
import { leaveTenant } from '@/services/tenant-membership.service'
import { createTenant } from '@/services/tenant.service'
import { planKeyForState } from '@/utilities/billing-rules.utilities'
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
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../../helpers/platform-users'
import { request } from '../../../helpers/request'

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

const app = createApp()
const billingRepository = new BillingRepository()
const invitationRepository = new TenantInvitationRepository()
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Property keys that would carry personal data: the outbox scrub list, plus
 * the payment details a provider payload holds.
 */
const PII_KEYS: ReadonlySet<string> = new Set([
  ...PII_PROPERTY_KEYS,
  'phone',
  'contact',
  'card',
  'vpa',
  'payload',
  'billing_email',
  'first_name',
  'last_name',
])

/**
 * Users no billing event may ever name: staff who acted in a test.
 */
const neverNamed = new Set<string>()
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
  neverNamed.clear()
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
 * The workspace's product billing events: no group markers and no audit events.
 * @param tenantId - The workspace.
 * @returns The rows.
 */
async function billingEventsOf(tenantId: string): Promise<AnalyticsOutboxRow[]> {
  const rows = await outboxOf(tenantId)
  return rows.filter((row) => row.event !== '$groupidentify' && row.properties.source === 'product')
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
 * Check an event's tenant group, that it names no staff member, and that no
 * PII key or address is among its properties.
 * @param row - The event's row.
 * @param tenantId - The workspace it must join.
 */
function expectGroupAndNoPii(row: AnalyticsOutboxRow, tenantId: string): void {
  expect(row.properties.$groups, `${row.event} group`).toEqual({ tenant: tenantId })
  expect(neverNamed.has(row.distinctId), `${row.event} names staff`).toBe(false)
  for (const key of Object.keys(row.properties)) {
    expect(PII_KEYS.has(key), `${row.event} carries ${key}`).toBe(false)
  }
  expect(JSON.stringify(row.properties), `${row.event} carries an address`).not.toContain('@')
  if (row.distinctId === SYSTEM_DISTINCT_ID) {
    expect(row.properties).toMatchObject({ access: 'system', $process_person_profile: false })
  }
}

/**
 * The workspace's one event of a type, checked for its group, its plan and
 * state against the billing row as it stands now (the change's after), its
 * distinct id, and no PII.
 * @param tenantId - The workspace.
 * @param event - The event name.
 * @param distinctId - The person (or the system) it must be sent as.
 * @returns The row.
 */
async function expectAudited(
  tenantId: string,
  event: string,
  distinctId: string
): Promise<AnalyticsOutboxRow> {
  const rows = await eventsOf(tenantId, event)
  expect(rows, `${event} rows`).toHaveLength(1)
  const [row] = rows
  if (row === undefined) throw new Error(`no ${event}`)
  expectGroupAndNoPii(row, tenantId)
  const after = await readBilling(tenantId)
  expect(row.properties, `${event} plan and state`).toMatchObject({
    plan: planKeyForState(after.state),
    billing_state: after.state,
  })
  expect(row.distinctId, `${event} distinct id`).toBe(distinctId)
  return row
}

/**
 * Empty a workspace's outbox rows, as the drain does once PostHog has them.
 * @param tenantId - The workspace.
 */
async function drainOutboxOf(tenantId: string): Promise<void> {
  await sql`delete from analytics_outbox where properties->'$groups'->>'tenant' = ${tenantId} or properties->>'$group_key' = ${tenantId}`
}

/**
 * The uuid and timestamp of a workspace's rows of one event.
 * @param tenantId - The workspace.
 * @param event - The event name.
 * @returns Each row's id and time.
 */
async function stampsOf(
  tenantId: string,
  event: string
): Promise<{ id: string; occurredAt: string; distinctId: string }[]> {
  return sql<{ id: string; occurredAt: string; distinctId: string }[]>`
    select id, occurred_at::text as "occurredAt", distinct_id as "distinctId"
    from analytics_outbox
    where properties->'$groups'->>'tenant' = ${tenantId} and event = ${event}
    order by id`
}

/**
 * Deliver one subscription webhook the way its job does.
 * @param subscriptionId - The subscription the event names.
 * @param eventType - The provider's event type.
 */
async function webhook(subscriptionId: string, eventType: string): Promise<void> {
  await processBillingWebhookEvent({
    eventRowId: randomUUID(),
    providerEventId: `evt_${randomUUID()}`,
    eventType,
    subscriptionId,
    paymentId: null,
    disputeId: null,
  })
}

/**
 * Add a member to a workspace.
 * @param tenantId - The workspace.
 * @param role - Their role.
 * @returns The new member.
 */
async function addMember(tenantId: string, role: 'owner' | 'editor' | 'viewer'): Promise<User> {
  const member = await createTrackedUser()
  await sql`insert into user_memberships (user_id, tenant_id, role) values (${member.id}, ${tenantId}, ${role})`
  return member
}

/**
 * A staff admin, recorded as someone no event may name.
 * @returns The staff member.
 */
async function staffAdmin(): Promise<User> {
  const { user } = await createTrackedStaff('admin')
  neverNamed.add(user.id)
  return user
}

/**
 * A Free workspace with a payer who is its owner, paying monthly.
 * @returns The workspace, its owner (the payer) and the subscription.
 */
async function payingWorkspace(): Promise<{ tenant: Tenant; payer: User; subscriptionId: string }> {
  const { tenant, owner } = await workspace()
  const { subscriptionId } = await makePaying(tenant.id)
  await setBilling(tenant.id, { payerUserId: owner.id, checkoutStartedBy: owner.id })
  return { tenant, payer: owner, subscriptionId }
}

/**
 * Make a workspace the user's first trial, running until `trialEndsAt`.
 * @param tenantId - The workspace.
 * @param userId - The trial's owner.
 * @param trialEndsAt - When it ends.
 */
async function trialOf(tenantId: string, userId: string, trialEndsAt: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await billingRepository.claimUserTrial(userId, tx)
    await billingRepository.setFirstTrialTenant(userId, tenantId, tx)
  })
  await setBilling(tenantId, {
    state: 'trialing',
    planId: plans.paidId,
    trialStartedAt: new Date(trialEndsAt.getTime() - 14 * DAY_MS),
    trialEndsAt,
  })
}

/**
 * A pending invitation written as an invite would, with its raw token.
 * @param tenantId - The workspace.
 * @param email - The invited address.
 * @param invitedBy - Who invited.
 * @param role - The role offered.
 * @returns The raw token and the invitation id.
 */
async function pendingInvitation(
  tenantId: string,
  email: string,
  invitedBy: string,
  role: 'owner' | 'viewer'
): Promise<{ rawToken: string; id: string }> {
  const rawToken = randomBytes(32).toString('base64url')
  const created = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId,
        email,
        role,
        tokenHash: hashToken(rawToken),
        invitedBy,
        expiresAt: new Date(Date.now() + DAY_MS),
      },
      tx
    )
  )
  return { rawToken, id: created.id }
}

describe('every billing event at its real call site', () => {
  it('trial_started: a new workspace that takes its creator trial, as the creator', async () => {
    const creator = await createTrackedUser()

    const tenant = await createTenant(
      { userId: creator.id },
      { name: 'Audit Co', slug: `audit-${randomUUID().slice(0, 8)}` }
    )
    extraTenantIds.push(tenant.id)

    await expectAudited(tenant.id, 'trial_started', creator.id)
  })

  it('trial_started: a staff-made workspace whose trial starts when its first owner accepts, as that owner, never the staff inviter', async () => {
    const staff = await staffAdmin()
    const { tenant } = await workspace()
    await setBilling(tenant.id, { trialOnOwnerAccept: true })
    const firstOwner = await createTrackedUser()
    const { rawToken } = await pendingInvitation(tenant.id, firstOwner.email, staff.id, 'owner')

    await accept(rawToken, firstOwner.id)

    await expectAudited(tenant.id, 'trial_started', firstOwner.id)
  })

  it('trial_reminder_sent: the frequent run, as the trial owner', async () => {
    const { tenant, owner } = await workspace()
    const now = new Date()
    await trialOf(tenant.id, owner.id, new Date(now.getTime() + 2 * DAY_MS - 60_000))

    await runFrequentBilling(now)

    const reminders = await eventsOf(tenant.id, 'trial_reminder_sent')
    expect(reminders.length).toBeGreaterThan(0)
    for (const row of reminders) {
      expectGroupAndNoPii(row, tenant.id)
      expect(row.distinctId).toBe(owner.id)
      expect(row.properties).toMatchObject({ plan: 'paid', billing_state: 'trialing' })
    }
    expect(reminders.map((row) => row.properties.days_left)).toContain(2)
  })

  it('trial_extended: a staff extension, as the trial owner, never staff', async () => {
    const staff = await staffAdmin()
    const { tenant, owner } = await workspace()
    await trialOf(tenant.id, owner.id, new Date(Date.now() + 3 * DAY_MS))

    await extendTrial({ userId: staff.id }, tenant.id, 7, 'Audit extension')

    const extended = await expectAudited(tenant.id, 'trial_extended', owner.id)
    expect(extended.properties).toMatchObject({ days: 7, access: 'system' })
  })

  it('trial_ended and downgraded_to_free: the frequent run ends a lapsed trial, as the trial owner', async () => {
    const { tenant, owner } = await workspace()
    await trialOf(tenant.id, owner.id, new Date(Date.now() - 60_000))

    await runFrequentBilling(new Date())

    await expectAudited(tenant.id, 'trial_ended', owner.id)
    const downgraded = await expectAudited(tenant.id, 'downgraded_to_free', owner.id)
    expect(downgraded.properties).toMatchObject({ downgrade_cause: 'trial_ended' })
  })

  it('plan_limit_approaching: the invite that crosses into the band, as the inviter', async () => {
    const { tenant, owner } = await workspace()
    await grantSeats(tenant.id, 10)

    for (let index = 0; index < 8; index += 1) {
      await invite(
        { userId: owner.id },
        tenant.id,
        `seat-${String(index)}-${randomUUID()}@example.test`,
        'editor'
      )
    }

    const approaching = await expectAudited(tenant.id, 'plan_limit_approaching', owner.id)
    expect(approaching.properties).toMatchObject({ key: 'members', used: 8, limit: 10 })
  })

  it('plan_limit_reached: an invite past the limit, as the inviter, with the use and cap', async () => {
    const { tenant, owner } = await workspace()
    const inviter = await addMember(tenant.id, 'owner')
    await addMember(tenant.id, 'viewer')

    await expect(
      invite({ userId: inviter.id }, tenant.id, `c-${randomUUID()}@example.test`, 'editor')
    ).rejects.toMatchObject({ statusCode: 402 })

    const reached = await expectAudited(tenant.id, 'plan_limit_reached', inviter.id)
    expect(reached.properties).toMatchObject({ key: 'members', used: 3, limit: 3 })
    expect(reached.distinctId).not.toBe(owner.id)
  })

  it('plan_limit_reached: the resend of an expired invitation past the limit, as the resender', async () => {
    const { tenant, owner } = await workspace()
    const { id } = await pendingInvitation(
      tenant.id,
      `late-${randomUUID()}@example.test`,
      owner.id,
      'viewer'
    )
    await sql`update tenant_invitations set expires_at = now() - interval '1 day', last_sent_at = now() - interval '2 days' where id = ${id}`
    await addMember(tenant.id, 'viewer')
    await addMember(tenant.id, 'viewer')

    await expect(resend({ userId: owner.id }, tenant.id, id)).rejects.toMatchObject({
      statusCode: 402,
    })

    await expectAudited(tenant.id, 'plan_limit_reached', owner.id)
  })

  it('plan_feature_blocked: GET insights on Free, as the member, with their own session', async () => {
    const { tenant, owner } = await workspace()
    const session = randomUUID()

    const refused = await request(app)
      .get(`/api/v1/tenants/${tenant.slug}/insights`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .set('X-POSTHOG-SESSION-ID', session)

    expect(refused.status).toBe(402)
    const blocked = await expectAudited(tenant.id, 'plan_feature_blocked', owner.id)
    expect(blocked.properties).toMatchObject({
      key: 'advanced_example',
      access: 'member',
      $session_id: session,
    })
  })

  it('upgrade_requested: a member asking, as that member', async () => {
    const { tenant } = await workspace()
    const editor = await addMember(tenant.id, 'editor')

    await requestUpgrade({ userId: editor.id }, tenant.id, { key: 'members', surface: 'limit' })

    const requested = await expectAudited(tenant.id, 'upgrade_requested', editor.id)
    expect(requested.properties).toMatchObject({ key: 'members', surface: 'limit' })
  })

  it('checkout_started, checkout_confirmed, subscription_activated and upgrade_request_fulfilled: an owner upgrades', async () => {
    const { tenant, owner } = await workspace()
    const editor = await addMember(tenant.id, 'editor')
    await requestUpgrade({ userId: editor.id }, tenant.id, { surface: 'banner' })

    const session = await startCheckout({ userId: owner.id }, tenant.id, 'month')
    const started = await expectAudited(tenant.id, 'checkout_started', owner.id)
    expect(started.properties).toMatchObject({
      interval: 'month',
      currency: 'INR',
      during_trial: false,
      plan: 'free',
    })
    await fake.fakeAdvance(session.subscriptionId, 'active')
    await confirmCheckout({ userId: owner.id }, tenant.id, confirmBody(session.subscriptionId))

    await expectAudited(tenant.id, 'checkout_confirmed', owner.id)
    const activated = await expectAudited(tenant.id, 'subscription_activated', owner.id)
    expect(activated.properties).toMatchObject({ interval: 'month', plan: 'paid' })
    await expectAudited(tenant.id, 'upgrade_request_fulfilled', editor.id)
  })

  it('subscription_renewed: the charged webhook, as the payer', async () => {
    const { tenant, payer, subscriptionId } = await payingWorkspace()
    // The paid period just ended, before the cycle the charge pays started.
    await setBilling(tenant.id, { currentPeriodEnd: new Date(Date.now() - 60_000) })

    await webhook(subscriptionId, 'subscription.charged')

    await expectAudited(tenant.id, 'subscription_renewed', payer.id)
  })

  it('payment_failed, subscription_halted and subscription_recovered: the webhooks, as the payer', async () => {
    const { tenant, subscriptionId } = await payingWorkspace()
    const payer = await addMember(tenant.id, 'owner')
    await setBilling(tenant.id, { payerUserId: payer.id })
    await fake.fakeAdvance(subscriptionId, 'halted')

    await webhook(subscriptionId, 'subscription.halted')

    const failed = await expectAudited(tenant.id, 'payment_failed', payer.id)
    expect(failed.properties).toMatchObject({ failure_code: 'halted', billing_state: 'past_due' })
    await expectAudited(tenant.id, 'subscription_halted', payer.id)

    await fake.fakeAdvance(subscriptionId, 'active')
    await webhook(subscriptionId, 'subscription.activated')

    const recovered = await expectAudited(tenant.id, 'subscription_recovered', payer.id)
    expect(recovered.properties).toMatchObject({ billing_state: 'active' })
  })

  it("subscription_cancel_scheduled by owner: the owner's cancel, as that owner", async () => {
    const { tenant } = await payingWorkspace()
    const canceller = await addMember(tenant.id, 'owner')

    await cancelPaid({ userId: canceller.id }, tenant.id)

    const cancel = await expectAudited(tenant.id, 'subscription_cancel_scheduled', canceller.id)
    expect(cancel.properties).toMatchObject({ by: 'owner', access: 'member' })
  })

  it('subscription_cancel_scheduled by customer_bank, then downgraded_to_free: the webhook and the frequent run, as the payer', async () => {
    const { tenant, payer, subscriptionId } = await payingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'cancelled')

    await webhook(subscriptionId, 'subscription.cancelled')

    const cancel = await expectAudited(tenant.id, 'subscription_cancel_scheduled', payer.id)
    expect(cancel.properties).toMatchObject({ by: 'customer_bank', billing_state: 'active' })

    await fake.fakeAdvance(subscriptionId, 'completed')
    await setBilling(tenant.id, { currentPeriodEnd: new Date(Date.now() - 10 * DAY_MS) })
    await runFrequentBilling(new Date())

    const downgraded = await expectAudited(tenant.id, 'downgraded_to_free', payer.id)
    expect(downgraded.properties).toMatchObject({ downgrade_cause: 'cancelled', plan: 'free' })
  })

  it('downgraded_to_free for a failed payment: the frequent run once grace ends, as the payer', async () => {
    const { tenant, payer, subscriptionId } = await payingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'halted')
    await webhook(subscriptionId, 'subscription.halted')
    await setBilling(tenant.id, {
      pastDueSince: new Date(Date.now() - 20 * DAY_MS),
      haltedAt: new Date(Date.now() - 20 * DAY_MS),
    })

    await runFrequentBilling(new Date())

    const downgraded = await expectAudited(tenant.id, 'downgraded_to_free', payer.id)
    expect(downgraded.properties).toMatchObject({ downgrade_cause: 'payment_failed' })
  })

  it('subscription_interval_change_scheduled: a switch another owner started, as that owner', async () => {
    const { tenant } = await payingWorkspace()
    const switcher = await addMember(tenant.id, 'owner')

    const session = await startIntervalSwitch({ userId: switcher.id }, tenant.id, 'year')
    await fake.fakeAdvance(session.subscriptionId, 'authenticated')
    await webhook(session.subscriptionId, 'subscription.authenticated')

    await expectAudited(tenant.id, 'subscription_interval_change_scheduled', switcher.id)
  })

  it('payer_left: the payer leaves the workspace, as the payer', async () => {
    const { tenant } = await payingWorkspace()
    const payer = await addMember(tenant.id, 'owner')
    await setBilling(tenant.id, { payerUserId: payer.id })

    await leaveTenant({ userId: payer.id }, tenant.id)

    await expectAudited(tenant.id, 'payer_left', payer.id)
  })

  it('billing_reconciled: the reconcile sync, as the payer', async () => {
    const { tenant, payer, subscriptionId } = await payingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'halted')

    await syncTenantBilling(tenant.id, 'reconcile')

    const reconciled = await expectAudited(tenant.id, 'billing_reconciled', payer.id)
    expect(reconciled.properties).toMatchObject({ field: 'state' })
  })

  it('duplicate_subscription_refunded: the reconcile sweep finds a second paid subscription, as the payer', async () => {
    const { tenant, payer } = await payingWorkspace()
    const duplicate = await fakeSubscription({ tenantId: tenant.id, priceId: plans.monthPriceId })
    await fake.fakeAdvance(duplicate, 'active')

    await syncTenantBilling(tenant.id, 'reconcile', { extraSubscriptionIds: [duplicate] })

    await expectAudited(tenant.id, 'duplicate_subscription_refunded', payer.id)
  })

  it('dispute_opened: the dispute webhook, as the payer', async () => {
    const { tenant, payer, subscriptionId } = await payingWorkspace()
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
    await expectAudited(tenant.id, 'dispute_opened', payer.id)
    const first = await stampsOf(tenant.id, 'dispute_opened')
    await drainOutboxOf(tenant.id)
    // The flag is already set: a redelivery after the drain sends nothing new.
    await processBillingWebhookEvent({ ...job, eventRowId: randomUUID() })

    expect(first).toHaveLength(1)
    expect(await stampsOf(tenant.id, 'dispute_opened')).toEqual([])
  })
})

describe('staff are never the person', () => {
  it('a staff cancel at the cycle end goes to the payer, by staff', async () => {
    const staff = await staffAdmin()
    const { tenant, payer } = await payingWorkspace()

    await cancelByStaff({ userId: staff.id }, tenant.id, 'cycle_end', 'Audit cancel')

    const cancel = await expectAudited(tenant.id, 'subscription_cancel_scheduled', payer.id)
    expect(cancel.properties).toMatchObject({ by: 'staff', access: 'system' })
  })

  it('a staff cancel now goes to the payer, and the move to Free reads staff', async () => {
    const staff = await staffAdmin()
    const { tenant, payer } = await payingWorkspace()

    await cancelByStaff({ userId: staff.id }, tenant.id, 'now', 'Audit cancel')

    await expectAudited(tenant.id, 'subscription_cancel_scheduled', payer.id)
    const downgraded = await expectAudited(tenant.id, 'downgraded_to_free', payer.id)
    expect(downgraded.properties).toMatchObject({ downgrade_cause: 'staff', access: 'system' })
    for (const row of await billingEventsOf(tenant.id)) {
      expect(row.distinctId, row.event).not.toBe(staff.id)
    }
  })

  it("a suspension's and an archive's cancel go to the payer, by suspension, and the archive's move to Free reads lifecycle", async () => {
    const { tenant, payer } = await payingWorkspace()
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenant.id}`

    await runLifecycleCancelFor(tenant.id)

    const cancel = await expectAudited(tenant.id, 'subscription_cancel_scheduled', payer.id)
    expect(cancel.properties).toMatchObject({ by: 'suspension' })

    const archived = await payingWorkspace()
    await sql`update tenants set lifecycle_state = 'archived' where id = ${archived.tenant.id}`
    await runLifecycleCancelFor(archived.tenant.id)
    await expectAudited(archived.tenant.id, 'subscription_cancel_scheduled', archived.payer.id)
    await setBilling(archived.tenant.id, {
      currentPeriodEnd: new Date(Date.now() - 10 * DAY_MS),
    })
    await runFrequentBilling(new Date())

    const downgraded = await expectAudited(
      archived.tenant.id,
      'downgraded_to_free',
      archived.payer.id
    )
    expect(downgraded.properties).toMatchObject({ downgrade_cause: 'lifecycle' })
  })
})

describe('adversarial attribution', () => {
  it('one owner of two workspaces: each event carries the workspace it happened in', async () => {
    const { tenant: first, owner } = await workspace()
    const second = await workspace()
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${owner.id}, ${second.tenant.id}, 'owner')`
    await addMember(first.id, 'viewer')
    await addMember(first.id, 'viewer')

    await expect(
      invite({ userId: owner.id }, first.id, `x-${randomUUID()}@example.test`, 'editor')
    ).rejects.toMatchObject({ statusCode: 402 })
    const session = await startCheckout({ userId: owner.id }, second.tenant.id, 'month')
    await fake.fakeAdvance(session.subscriptionId, 'active')
    await webhook(session.subscriptionId, 'subscription.activated')

    await expectAudited(first.id, 'plan_limit_reached', owner.id)
    await expectAudited(second.tenant.id, 'subscription_activated', owner.id)
    const firstEvents = await billingEventsOf(first.id)
    expect(firstEvents.map((row) => row.event)).toEqual(['plan_limit_reached'])
    expect(await readBilling(first.id)).toMatchObject({ state: 'free' })
    for (const row of await billingEventsOf(second.tenant.id)) {
      expect(row.properties.$groups).toEqual({ tenant: second.tenant.id })
    }
  })

  it('a payer who left, then a new owner who upgrades: the payer keeps their own events, the new owner gets the new ones', async () => {
    const { tenant, subscriptionId } = await payingWorkspace()
    const leaver = await addMember(tenant.id, 'owner')
    await setBilling(tenant.id, { payerUserId: leaver.id, checkoutStartedBy: leaver.id })
    const upgrader = await addMember(tenant.id, 'owner')

    await leaveTenant({ userId: leaver.id }, tenant.id)
    await expectAudited(tenant.id, 'payer_left', leaver.id)
    await fake.fakeAdvance(subscriptionId, 'cancelled')
    await webhook(subscriptionId, 'subscription.cancelled')
    // Still their card until the period ends.
    await expectAudited(tenant.id, 'subscription_cancel_scheduled', leaver.id)
    await fake.fakeAdvance(subscriptionId, 'completed')
    await setBilling(tenant.id, { currentPeriodEnd: new Date(Date.now() - 10 * DAY_MS) })
    await runFrequentBilling(new Date())
    await expectAudited(tenant.id, 'downgraded_to_free', leaver.id)
    await drainOutboxOf(tenant.id)

    const session = await startCheckout({ userId: upgrader.id }, tenant.id, 'month')
    await fake.fakeAdvance(session.subscriptionId, 'active')
    await webhook(session.subscriptionId, 'subscription.activated')
    await fake.fakeAdvance(session.subscriptionId, 'halted')
    await webhook(session.subscriptionId, 'subscription.halted')

    expect(await readBilling(tenant.id)).toMatchObject({ payerUserId: upgrader.id })
    const rows = await billingEventsOf(tenant.id)
    expect(rows.map((row) => row.event)).toEqual(
      expect.arrayContaining([
        'checkout_started',
        'subscription_activated',
        'payment_failed',
        'subscription_halted',
      ])
    )
    for (const row of rows) {
      expectGroupAndNoPii(row, tenant.id)
      expect(row.distinctId, row.event).toBe(upgrader.id)
    }
  })

  it("an owner's cancel that only brings in the bank's earlier cancel reads customer_bank, as the payer", async () => {
    const { tenant, payer, subscriptionId } = await payingWorkspace()
    const canceller = await addMember(tenant.id, 'owner')
    await fake.fakeAdvance(subscriptionId, 'cancelled')

    await cancelPaid({ userId: canceller.id }, tenant.id)

    const cancel = await expectAudited(tenant.id, 'subscription_cancel_scheduled', payer.id)
    expect(cancel.properties).toMatchObject({ by: 'customer_bank', access: 'system' })
  })

  it('a refused invitee is a system event with no use or cap, never the invitee', async () => {
    const { tenant, owner } = await workspace()
    await addMember(tenant.id, 'viewer')
    await addMember(tenant.id, 'viewer')
    await addMember(tenant.id, 'viewer')
    const invitee = await createTrackedUser()
    const { rawToken } = await pendingInvitation(tenant.id, invitee.email, owner.id, 'viewer')

    await expect(accept(rawToken, invitee.id)).rejects.toMatchObject({ statusCode: 402 })

    const reached = await expectAudited(tenant.id, 'plan_limit_reached', SYSTEM_DISTINCT_ID)
    expect(reached.properties).toMatchObject({ key: 'members', access: 'system' })
    expect(reached.properties).not.toHaveProperty('used')
    expect(reached.properties).not.toHaveProperty('limit')
  })

  it('a soft-deleted starter is never named: the owner who paid and confirmed is', async () => {
    const { tenant, owner: starter } = await workspace()
    const confirmer = await addMember(tenant.id, 'owner')
    const session = await startCheckout({ userId: starter.id }, tenant.id, 'month')
    await confirmCheckout({ userId: confirmer.id }, tenant.id, confirmBody(session.subscriptionId))
    await drainOutboxOf(tenant.id)
    await sql`update users set deleted_at = now() where id = ${starter.id}`
    await fake.fakeAdvance(session.subscriptionId, 'active')

    await webhook(session.subscriptionId, 'subscription.activated')

    await expectAudited(tenant.id, 'subscription_activated', confirmer.id)
  })

  it('a starter whose account is gone before the confirm: checkout_confirmed names the owner who confirmed', async () => {
    const { tenant, owner: starter } = await workspace()
    const confirmer = await addMember(tenant.id, 'owner')
    const session = await startCheckout({ userId: starter.id }, tenant.id, 'month')
    await drainOutboxOf(tenant.id)
    await sql`update users set deleted_at = now() where id = ${starter.id}`
    await fake.fakeAdvance(session.subscriptionId, 'active')

    await confirmCheckout({ userId: confirmer.id }, tenant.id, confirmBody(session.subscriptionId))

    await expectAudited(tenant.id, 'checkout_confirmed', confirmer.id)
  })

  it('a staff-given trial with no claimant: its reminder, end and downgrade go to the payer, as its extension does', async () => {
    const { tenant } = await workspace()
    const payer = await addMember(tenant.id, 'owner')
    const now = new Date()
    // A workspace that paid before, put on a trial by staff; no one claimed it as their own trial.
    await setBilling(tenant.id, {
      state: 'trialing',
      planId: plans.paidId,
      payerUserId: payer.id,
      trialStartedAt: new Date(now.getTime() - 12 * DAY_MS),
      trialEndsAt: new Date(now.getTime() + 2 * DAY_MS - 60_000),
    })

    await runFrequentBilling(now)
    const reminders = await eventsOf(tenant.id, 'trial_reminder_sent')
    expect(reminders.length).toBeGreaterThan(0)
    for (const row of reminders) expect(row.distinctId).toBe(payer.id)

    await setBilling(tenant.id, { trialEndsAt: new Date(Date.now() - 60_000) })
    await runFrequentBilling(new Date())

    await expectAudited(tenant.id, 'trial_ended', payer.id)
    const downgraded = await expectAudited(tenant.id, 'downgraded_to_free', payer.id)
    expect(downgraded.properties).toMatchObject({ downgrade_cause: 'trial_ended' })
  })

  it('a starter deleted by staff before the activation: the sync never names them, and no person is left', async () => {
    const staff = await staffAdmin()
    const { tenant, owner: starter } = await workspace()
    await addMember(tenant.id, 'owner')
    const session = await startCheckout({ userId: starter.id }, tenant.id, 'month')
    await drainOutboxOf(tenant.id)

    await deleteUser({ userId: staff.id }, starter.id, 'Audit delete')
    await fake.fakeAdvance(session.subscriptionId, 'active')
    await webhook(session.subscriptionId, 'subscription.activated')

    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      payerUserId: null,
      checkoutStartedBy: null,
    })
    await expectAudited(tenant.id, 'subscription_activated', SYSTEM_DISTINCT_ID)
  })

  it('a webhook-only activation with no confirm, and a lost pending id, goes to the starter in the workspace the notes name', async () => {
    const { tenant, owner } = await workspace()
    const other = await workspace()
    const session = await startCheckout({ userId: owner.id }, tenant.id, 'month')
    // The pending id was lost: only the subscription's notes name the workspace.
    await setBilling(tenant.id, { pendingSubscriptionId: null })
    await drainOutboxOf(tenant.id)
    await fake.fakeAdvance(session.subscriptionId, 'active')

    await webhook(session.subscriptionId, 'subscription.activated')

    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: session.subscriptionId,
    })
    await expectAudited(tenant.id, 'subscription_activated', owner.id)
    expect(await outboxOf(other.tenant.id)).toEqual([])
  })

  it('an adopted confirm records checkout_confirmed once, as the starter, and its repeat records no second', async () => {
    const { tenant, owner } = await workspace()
    const session = await startCheckout({ userId: owner.id }, tenant.id, 'month')
    await fake.fakeAdvance(session.subscriptionId, 'active')
    await webhook(session.subscriptionId, 'subscription.activated')
    expect(await readBilling(tenant.id)).toMatchObject({
      providerSubscriptionId: session.subscriptionId,
      pendingSubscriptionId: null,
    })
    expect(await stampsOf(tenant.id, 'checkout_confirmed')).toEqual([])
    const body = confirmBody(session.subscriptionId)

    await confirmCheckout({ userId: owner.id }, tenant.id, body)
    await confirmCheckout({ userId: owner.id }, tenant.id, body)

    await expectAudited(tenant.id, 'checkout_confirmed', owner.id)
    expect(await readBilling(tenant.id)).toMatchObject({ billingEmail: owner.email })
  })

  it('a confirm posted again after the drain gives the same uuid and timestamp', async () => {
    const { tenant, owner } = await workspace()
    const session = await startCheckout({ userId: owner.id }, tenant.id, 'month')

    await confirmCheckout({ userId: owner.id }, tenant.id, confirmBody(session.subscriptionId))
    const first = await stampsOf(tenant.id, 'checkout_confirmed')
    await drainOutboxOf(tenant.id)
    await confirmCheckout({ userId: owner.id }, tenant.id, confirmBody(session.subscriptionId))

    expect(first).toHaveLength(1)
    expect(await stampsOf(tenant.id, 'checkout_confirmed')).toEqual(first)
  })

  it("an event sent as the starter during another owner's request carries no session of that request", async () => {
    const { tenant, owner: starter } = await workspace()
    const confirmer = await addMember(tenant.id, 'owner')
    const session = await startCheckout({ userId: starter.id }, tenant.id, 'month')
    await fake.fakeAdvance(session.subscriptionId, 'active')

    const confirmed = await request(app)
      .post(`/api/v1/tenants/${tenant.slug}/billing/checkout/confirm`)
      .set('Authorization', `Bearer ${tokenFor(confirmer)}`)
      .set('X-POSTHOG-SESSION-ID', randomUUID())
      .send(confirmBody(session.subscriptionId))

    expect(confirmed.status).toBe(200)
    const activated = await expectAudited(tenant.id, 'subscription_activated', starter.id)
    const checkoutConfirmed = await expectAudited(tenant.id, 'checkout_confirmed', starter.id)
    expect(activated.properties).not.toHaveProperty('$session_id')
    expect(checkoutConfirmed.properties).not.toHaveProperty('$session_id')
  })
})
