/**
 * @file The staff billing routes of one tenant, end to end against the real
 * database, Redis and the fake payment provider: the read (a staff view with
 * the provider fields, sources, grants, history and events, never the
 * owner-only fields), the resync, the trial extension, grants and their
 * revocation, and the staff cancel. Each write is audited with platform
 * access, and the analytics events a staff change sends name the payer or
 * the trial's owner, never the staff member. The route gates are pinned in
 * `platform-route-gates.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import type { User } from '@/database/models/user.model'
import { ProviderError } from '@/errors/billing-provider-errors'
import { BillingRepository } from '@/repositories/billing.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { sql } from '@/services/database.service'
import { emitEntitlementsChanged } from '@/services/notification-emitter.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import { createTenant } from '@/services/tenant.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { grantSeats } from '../../helpers/billing'
import {
  deleteTrackedTenants,
  fake,
  fakeSubscription,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  paymentsSwitch,
  plans,
  readBilling,
  setBilling,
  subscriptionStatus,
  workspace,
} from '../../helpers/billing-api'
import { withMutatedMethod } from '../../helpers/mutate'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true }
})

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  // The real failure mapping, with the fake as the provider.
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

vi.mock('@/services/notification-emitter.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/notification-emitter.service')>()
  return { ...actual, emitEntitlementsChanged: vi.fn(actual.emitEntitlementsChanged) }
})

const app = createApp()
const billingRepository = new BillingRepository()
const membershipRepository = new UserMembershipRepository()

const DAY_MS = 24 * 60 * 60 * 1000
/**
 * `expect.any(String)` typed as `string`, because vitest types it as `any`.
 */
const ANY_STRING = expect.any(String) as unknown as string
/**
 * `expect.any(Array)` typed as `unknown[]`, because vitest types it as `any`.
 */
const ANY_ARRAY = expect.any(Array) as unknown as unknown[]
const REASON = 'Customer asked on ticket 4411'
const extraTenantIds: string[] = []

beforeAll(async () => {
  await loadPlans()
  registerAnalyticsSubscribers()
})

afterEach(async () => {
  paymentsSwitch.on = true
  vi.mocked(emitEntitlementsChanged).mockClear()
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
 * A staff member's bearer token at a platform role, signed in just now.
 * @param role - The platform role.
 * @param firstName - The staff member's first name.
 * @returns The staff user and the token.
 */
async function staff(
  role: 'viewer' | 'manager' | 'admin',
  firstName = 'Sam'
): Promise<{ user: User; token: string }> {
  return createTrackedStaff(role, { firstName })
}

/**
 * GET a tenant's staff billing view.
 * @param token - The staff token.
 * @param tenantId - The tenant.
 * @returns The response.
 */
function readAs(token: string, tenantId: string) {
  return request(app)
    .get(`/api/v1/platform/tenants/${tenantId}/billing`)
    .set('Authorization', `Bearer ${token}`)
}

/**
 * POST a JSON body to a path under a tenant's staff billing routes.
 * @param token - The staff token.
 * @param tenantId - The tenant.
 * @param path - The path after `/billing`, empty for none.
 * @param body - The JSON body.
 * @returns The response.
 */
function postAs(token: string, tenantId: string, path: string, body: object) {
  return request(app)
    .post(`/api/v1/platform/tenants/${tenantId}/billing${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

/**
 * The `data` of a success response.
 * @param body - The response body.
 * @returns Its data.
 */
function dataOf(body: unknown): Record<string, unknown> {
  return (body as { data: Record<string, unknown> }).data
}

/**
 * The billing audit entries of a tenant, oldest first.
 * @param tenantId - The tenant.
 * @returns Each entry's action, access, actor and metadata.
 */
async function billingAudit(
  tenantId: string
): Promise<{ action: string; access: string; actorId: string | null; metadata: unknown }[]> {
  return sql<{ action: string; access: string; actorId: string | null; metadata: unknown }[]>`
    select action, access, actor_user_id as "actorId", metadata from audit_logs
    where tenant_id = ${tenantId} and action like 'billing.%' order by occurred_at, id`
}

/**
 * A tenant's analytics events of one name, oldest first.
 * @param tenantId - The tenant.
 * @param event - The event name.
 * @returns The rows.
 */
async function eventsOf(tenantId: string, event: string): Promise<AnalyticsOutboxRow[]> {
  return sql<AnalyticsOutboxRow[]>`
    select id, event, distinct_id as "distinctId", properties
    from analytics_outbox
    where properties->'$groups'->>'tenant' = ${tenantId} and event = ${event}
    order by occurred_at, id`
}

/**
 * The variables of a tenant's tracked mails of one template.
 * @param tenantId - The tenant.
 * @param templateKey - The template.
 * @returns Each mail's variables.
 */
async function mailVariablesOf(
  tenantId: string,
  templateKey: string
): Promise<Record<string, string>[]> {
  const rows = await sql<{ variables: Record<string, string> }[]>`
    select variables from email_messages where tenant_id = ${tenantId} and template_key = ${templateKey}`
  return rows.map((row) => row.variables)
}

/**
 * Whether a date is within a minute of a target.
 * @param value - The ISO string or date read.
 * @param target - The expected time.
 * @returns True when close.
 */
function isNear(value: unknown, target: number): boolean {
  const time = new Date(value as string).getTime()
  return Math.abs(time - target) < 60_000
}

/**
 * A paying workspace whose payer is its owner.
 * @returns The workspace, its owner and the subscription.
 */
async function payingWorkspace() {
  const { tenant, owner } = await workspace({ firstName: 'Ada' })
  const { subscriptionId, periodEnd } = await makePaying(tenant.id)
  await setBilling(tenant.id, { payerUserId: owner.id, billingEmail: owner.email })
  return { tenant, owner, subscriptionId, periodEnd }
}

/**
 * Put a workspace on an authenticated subscription that first charges at
 * its trial's end: an upgrade made during a trial.
 * @param tenantId - The workspace.
 * @param trialEndsAt - The trial's end.
 * @returns The subscription id.
 */
async function deferredStart(tenantId: string, trialEndsAt: Date): Promise<string> {
  const subscriptionId = await fakeSubscription(
    { tenantId, priceId: plans.monthPriceId },
    'month',
    trialEndsAt
  )
  await fake.fakeAdvance(subscriptionId, 'authenticated')
  await setBilling(tenantId, {
    state: 'active',
    planId: plans.paidId,
    priceId: plans.monthPriceId,
    trialEndsAt,
    currentPeriodEnd: trialEndsAt,
    providerSubscriptionId: subscriptionId,
    provider: 'fake',
    providerMode: 'test',
  })
  return subscriptionId
}

describe('GET /api/v1/platform/tenants/:id/billing', () => {
  it('shows a viewer the billing with provider fields and sources, never the billing email', async () => {
    const { tenant, owner, subscriptionId, periodEnd } = await payingWorkspace()
    const { token } = await staff('viewer')

    const response = await readAs(token, tenant.id)

    expect(response.status).toBe(200)
    const data = dataOf(response.body)
    expect(data).toMatchObject({
      state: 'active',
      plan: { key: 'paid', name: 'Paid' },
      interval: 'month',
      currentPeriodEnd: periodEnd.toISOString(),
      payer: { userId: owner.id, name: 'Ada', isMember: true },
      billingEmail: null,
      paymentsEnabled: true,
      dismissedBanners: [],
      provider: 'fake',
      providerMode: 'test',
      providerSubscriptionId: subscriptionId,
      pendingSubscriptionId: null,
      nextSubscriptionId: null,
      syncedAt: null,
      disputeOpen: false,
      sources: { members: 'plan', advanced_example: 'plan' },
      grants: [],
      history: [],
      events: [],
    })
    expect(data.entitlements).toMatchObject({
      plan: { key: 'paid' },
      state: 'active',
      features: { advanced_example: true },
      limits: { members: { limit: null, used: 1 } },
    })
    expect(data.entitlements).not.toHaveProperty('sources')
  })

  it('lists the newest 20 history rows and events, events by type and status only', async () => {
    const { tenant } = await workspace()
    for (let index = 0; index < 22; index += 1) {
      await sql`insert into billing_state_history (tenant_id, from_state, to_state, cause, source, at)
        values (${tenant.id}, 'free', 'trialing', ${`cause_${String(index)}`}, 'staff', ${new Date(Date.now() - (22 - index) * 1000).toISOString()}::timestamptz)`
    }
    for (let index = 0; index < 21; index += 1) {
      await billingRepository.recordEvent({
        provider: 'fake',
        mode: 'test',
        providerEventId: `evt_${randomUUID()}`,
        type: `subscription.event_${String(index)}`,
        subscriptionId: 'sub_FAKEX',
        tenantId: tenant.id,
        receivedAt: new Date(Date.now() - (21 - index) * 1000),
      })
    }
    const { token } = await staff('viewer')

    const read = await readAs(token, tenant.id)
    const data = dataOf(read.body)

    const history = data.history as { cause: string; source: string }[]
    expect(history).toHaveLength(20)
    expect(history[0]).toMatchObject({
      from: 'free',
      to: 'trialing',
      cause: 'cause_21',
      source: 'staff',
    })
    expect(Object.keys(history[0] ?? {}).toSorted()).toEqual([
      'at',
      'cause',
      'from',
      'source',
      'to',
    ])
    const events = data.events as Record<string, unknown>[]
    expect(events).toHaveLength(20)
    expect(events[0]).toMatchObject({
      type: 'subscription.event_20',
      processedAt: null,
      error: null,
    })
    expect(Object.keys(events[0] ?? {}).toSorted()).toEqual([
      'error',
      'processedAt',
      'receivedAt',
      'type',
    ])
  })

  it('audits the view once in a throttle window, with platform access', async () => {
    const { tenant } = await workspace()
    const { token, user } = await staff('viewer')

    await readAs(token, tenant.id)
    await readAs(token, tenant.id)

    expect(await billingAudit(tenant.id)).toEqual([
      { action: 'billing.viewed', access: 'platform', actorId: user.id, metadata: {} },
    ])
  })

  it('reads an archived tenant', async () => {
    const { tenant } = await workspace()
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenant.id}`
    const { token } = await staff('viewer')

    const response = await readAs(token, tenant.id)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({ state: 'free' })
  })

  it('answers the platform tenant 404 tenant_billing_not_found and writes no billing row', async () => {
    const platform = await platformTenant()
    const { token } = await staff('admin')

    const read = await readAs(token, platform.id)
    const extend = await postAs(token, platform.id, '/extend-trial', { days: 7, reason: REASON })
    const grant = await postAs(token, platform.id, '/grants', {
      key: 'members',
      value: 10,
      expiresAt: null,
      reason: REASON,
    })

    for (const response of [read, extend, grant]) {
      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ code: 'tenant_billing_not_found' })
    }
    expect(await billingRepository.findByTenantId(platform.id)).toBeUndefined()
  })

  it('answers an unknown tenant 404 tenant_not_found', async () => {
    const { token } = await staff('viewer')

    const response = await readAs(token, randomUUID())

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'tenant_not_found' })
  })
})

describe('POST /api/v1/platform/tenants/:id/billing/extend-trial', () => {
  it('puts a Free tenant on a 7-day trial from now and clears the reminder claims', async () => {
    const { tenant, owner } = await workspace()
    const stamp = new Date(Date.now() - 30 * DAY_MS)
    await setBilling(tenant.id, {
      trialStartedAt: new Date(Date.now() - 40 * DAY_MS),
      trialEndsAt: stamp,
      trialMidpointSentAt: stamp,
      trialReminder3dSentAt: stamp,
      trialReminderLastDaySentAt: stamp,
    })
    const trialsBefore = await sql`select 1 from user_trials where user_id = ${owner.id}`
    const { token, user } = await staff('manager')

    const response = await postAs(token, tenant.id, '/extend-trial', { days: 7, reason: REASON })

    expect(response.status).toBe(200)
    const data = dataOf(response.body)
    expect(data).toMatchObject({ state: 'trialing', plan: { key: 'paid' } })
    expect(isNear(data.trialEndsAt, Date.now() + 7 * DAY_MS)).toBe(true)
    const row = await readBilling(tenant.id)
    expect(row).toMatchObject({
      state: 'trialing',
      planId: plans.paidId,
      trialMidpointSentAt: null,
      trialReminder3dSentAt: null,
      trialReminderLastDaySentAt: null,
    })
    expect(isNear(row.trialStartedAt, Date.now())).toBe(true)
    const [history] = await billingRepository.listHistory(tenant.id, 1)
    expect(history).toMatchObject({
      fromState: 'free',
      toState: 'trialing',
      cause: 'trial_extended',
      source: 'staff',
    })
    expect(await billingAudit(tenant.id)).toEqual([
      {
        action: 'billing.trial_extended',
        access: 'platform',
        actorId: user.id,
        metadata: { days: 7, reason: REASON, trialEndsAt: row.trialEndsAt?.toISOString() },
      },
    ])
    // Staff bypass the one-trial-per-person rule: no claim is made for anyone.
    expect(await sql`select 1 from user_trials where user_id = ${owner.id}`).toHaveLength(
      trialsBefore.length
    )
    expect(vi.mocked(emitEntitlementsChanged)).toHaveBeenCalledWith(owner.id, {
      tenantId: tenant.id,
      slug: tenant.slug,
    })
  })

  it("adds the days to a running trial's end, keeps its start and clears the reminder claims", async () => {
    const owner = await createTrackedUser({ firstName: 'Tara' })
    const tenant = await createTenant(
      { userId: owner.id },
      { name: 'Trial Co', slug: `trial-${randomUUID().slice(0, 8)}` }
    )
    extraTenantIds.push(tenant.id)
    const before = await readBilling(tenant.id)
    expect(before.state).toBe('trialing')
    const stamp = new Date()
    await setBilling(tenant.id, {
      trialMidpointSentAt: stamp,
      trialReminder3dSentAt: stamp,
      trialReminderLastDaySentAt: stamp,
    })
    const { token, user } = await staff('manager')

    const response = await postAs(token, tenant.id, '/extend-trial', { days: 5, reason: REASON })

    expect(response.status).toBe(200)
    const row = await readBilling(tenant.id)
    expect(row.trialEndsAt?.getTime()).toBe((before.trialEndsAt?.getTime() ?? 0) + 5 * DAY_MS)
    expect(row.trialStartedAt?.getTime()).toBe(before.trialStartedAt?.getTime())
    expect(row).toMatchObject({
      state: 'trialing',
      trialMidpointSentAt: null,
      trialReminder3dSentAt: null,
      trialReminderLastDaySentAt: null,
    })
    const [history] = await billingRepository.listHistory(tenant.id, 1)
    expect(history).toMatchObject({ cause: 'trial_extended', source: 'staff' })
    // The event is the trial owner's, never the staff member's.
    const [event] = await eventsOf(tenant.id, 'trial_extended')
    expect(event?.distinctId).toBe(owner.id)
    expect(event?.distinctId).not.toBe(user.id)
    expect(event?.properties).toMatchObject({ days: 5, billing_state: 'trialing' })
  })

  it.each(['active', 'past_due'] as const)(
    'refuses a %s tenant with 409 TRIAL_NOT_EXTENDABLE and changes nothing',
    async (state) => {
      const { tenant } = await payingWorkspace()
      await setBilling(tenant.id, {
        state,
        ...(state === 'past_due' && { pastDueSince: new Date() }),
      })
      const before = await readBilling(tenant.id)
      const { token } = await staff('manager')

      const response = await postAs(token, tenant.id, '/extend-trial', { days: 7, reason: REASON })

      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({ code: 'TRIAL_NOT_EXTENDABLE' })
      const after = await readBilling(tenant.id)
      expect(after.version).toBe(before.version)
      expect(await billingAudit(tenant.id)).toEqual([])
    }
  )

  it.each([0, 91, 1.5, '7'])('refuses days %s with a field error', async (days) => {
    const { tenant } = await workspace()
    const { token } = await staff('manager')

    const response = await postAs(token, tenant.id, '/extend-trial', { days, reason: REASON })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { days: ANY_ARRAY } })
  })

  it('refuses a missing reason with a field error', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('manager')

    const response = await postAs(token, tenant.id, '/extend-trial', { days: 7 })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { reason: ANY_ARRAY } })
  })
})

describe('POST /api/v1/platform/tenants/:id/billing/grants', () => {
  it('raises the members limit with a grant whose source shows as grant', async () => {
    const { tenant, owner } = await workspace()
    const { token, user } = await staff('manager', 'Grace')

    const response = await postAs(token, tenant.id, '/grants', {
      key: 'members',
      value: 10,
      expiresAt: null,
      reason: REASON,
    })

    expect(response.status).toBe(200)
    const data = dataOf(response.body)
    expect(data.entitlements).toMatchObject({ limits: { members: { limit: 10 } } })
    expect(data.sources).toMatchObject({ members: 'grant' })
    const grants = data.grants as Record<string, unknown>[]
    expect(grants).toEqual([
      {
        id: ANY_STRING,
        key: 'members',
        value: 10,
        reason: REASON,
        grantedBy: { userId: user.id, name: 'Grace' },
        createdAt: ANY_STRING,
        expiresAt: null,
        revokedAt: null,
        status: 'active',
      },
    ])
    expect(await billingAudit(tenant.id)).toEqual([
      {
        action: 'billing.grant_added',
        access: 'platform',
        actorId: user.id,
        metadata: { key: 'members', value: 10, expiresAt: null, reason: REASON },
      },
    ])
    expect(vi.mocked(emitEntitlementsChanged)).toHaveBeenCalledWith(owner.id, {
      tenantId: tenant.id,
      slug: tenant.slug,
    })
  })

  it('grants an unlimited members cap with null, and a feature with true until a future date', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('manager')
    const expiresAt = new Date(Date.now() + 10 * DAY_MS).toISOString()

    await postAs(token, tenant.id, '/grants', {
      key: 'members',
      value: null,
      expiresAt: null,
      reason: REASON,
    })
    const response = await postAs(token, tenant.id, '/grants', {
      key: 'advanced_example',
      value: true,
      expiresAt,
      reason: REASON,
    })

    expect(response.status).toBe(200)
    const data = dataOf(response.body)
    expect(data.entitlements).toMatchObject({
      features: { advanced_example: true },
      limits: { members: { limit: null } },
    })
    expect(data.sources).toEqual({ members: 'grant', advanced_example: 'grant' })
    expect((data.grants as { expiresAt: string | null }[])[0]?.expiresAt).toBe(expiresAt)
  })

  it.each([
    [{ key: 'seats', value: 10 }, 'key'],
    [{ key: 'members', value: true }, 'value'],
    [{ key: 'members', value: 0 }, 'value'],
    [{ key: 'members', value: -2 }, 'value'],
    [{ key: 'members', value: 2.5 }, 'value'],
    [{ key: 'advanced_example', value: 5 }, 'value'],
    [{ key: 'advanced_example', value: null }, 'value'],
    [{ key: 'advanced_example', value: false }, 'value'],
    [{ key: 'members', value: 1_000_001 }, 'value'],
    [{ key: 'members', value: 1e15 }, 'value'],
    [{ key: 'members', value: 2 ** 53 + 2 }, 'value'],
  ])('refuses %j with a field error on %s', async (fields, field) => {
    const { tenant } = await workspace()
    const { token } = await staff('manager')

    const response = await postAs(token, tenant.id, '/grants', {
      ...fields,
      expiresAt: null,
      reason: REASON,
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { [field]: ANY_ARRAY } })
    expect(await billingAudit(tenant.id)).toEqual([])
  })

  it('reports an unknown key and a past expiry together', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('manager')

    const response = await postAs(token, tenant.id, '/grants', {
      key: 'seats',
      value: 10,
      expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
      reason: REASON,
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { key: ANY_ARRAY, expiresAt: ANY_ARRAY } })
  })

  it('grants the largest limit allowed', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('manager')

    const response = await postAs(token, tenant.id, '/grants', {
      key: 'members',
      value: 1_000_000,
      expiresAt: null,
      reason: REASON,
    })

    expect(response.status).toBe(200)
    expect(dataOf(response.body).entitlements).toMatchObject({
      limits: { members: { limit: 1_000_000 } },
    })
  })

  it('refuses an expiry in the past with a field error', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('manager')

    const response = await postAs(token, tenant.id, '/grants', {
      key: 'members',
      value: 10,
      expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
      reason: REASON,
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { expiresAt: ANY_ARRAY } })
  })
})

/**
 * The id of a tenant's one grant.
 * @param tenantId - The tenant.
 * @returns The grant id.
 */
async function grantIdOf(tenantId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from tenant_entitlement_grants where tenant_id = ${tenantId}`
  if (!row) throw new Error('setup: no grant')
  return row.id
}

describe('POST /api/v1/platform/tenants/:id/billing/grants/:grantId/revoke', () => {
  it('revokes a grant: the limit falls back to the plan and the grant reads revoked', async () => {
    const { tenant, owner } = await workspace()
    await grantSeats(tenant.id, 10)
    const grantId = await grantIdOf(tenant.id)
    const { token, user } = await staff('manager')

    const response = await postAs(token, tenant.id, `/grants/${grantId}/revoke`, {
      reason: REASON,
    })

    expect(response.status).toBe(200)
    const data = dataOf(response.body)
    expect(data.entitlements).toMatchObject({ limits: { members: { limit: 3 } } })
    expect(data.sources).toMatchObject({ members: 'plan' })
    expect(data.grants).toEqual([
      expect.objectContaining({
        id: grantId,
        status: 'revoked',
        revokedAt: ANY_STRING,
        grantedBy: null,
      }),
    ])
    expect(await billingAudit(tenant.id)).toEqual([
      {
        action: 'billing.grant_revoked',
        access: 'platform',
        actorId: user.id,
        metadata: { key: 'members', reason: REASON },
      },
    ])
    expect(vi.mocked(emitEntitlementsChanged)).toHaveBeenCalledWith(owner.id, {
      tenantId: tenant.id,
      slug: tenant.slug,
    })
  })

  it("answers 404 for another tenant's grant and leaves it in place", async () => {
    const { tenant } = await workspace()
    const { tenant: other } = await workspace()
    await grantSeats(other.id, 10)
    const otherGrantId = await grantIdOf(other.id)
    const { token } = await staff('manager')

    const response = await postAs(token, tenant.id, `/grants/${otherGrantId}/revoke`, {
      reason: REASON,
    })

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'grant_not_found' })
    const [row] = await sql<{ revokedAt: Date | null }[]>`
      select revoked_at as "revokedAt" from tenant_entitlement_grants where id = ${otherGrantId}`
    expect(row?.revokedAt).toBeNull()
    expect(await billingAudit(other.id)).toEqual([])
  })

  it('answers 404 for an unknown grant id', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('manager')

    const response = await postAs(token, tenant.id, `/grants/${randomUUID()}/revoke`, {
      reason: REASON,
    })

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'grant_not_found' })
  })

  it('answers a second revoke with the same view and no second audit entry', async () => {
    const { tenant } = await workspace()
    await grantSeats(tenant.id, 10)
    const grantId = await grantIdOf(tenant.id)
    const { token } = await staff('manager')
    await postAs(token, tenant.id, `/grants/${grantId}/revoke`, { reason: REASON })

    const response = await postAs(token, tenant.id, `/grants/${grantId}/revoke`, {
      reason: REASON,
    })

    expect(response.status).toBe(200)
    expect(await billingAudit(tenant.id)).toHaveLength(1)
  })
})

describe('POST /api/v1/platform/tenants/:id/billing/resync', () => {
  it('syncs the tenant with its provider and audits the resync', async () => {
    const { tenant, subscriptionId } = await payingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'cancelled')
    const { token, user } = await staff('manager')

    const response = await postAs(token, tenant.id, '/resync', { reason: REASON })

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({ cancelAtPeriodEnd: true })
    const row = await readBilling(tenant.id)
    expect(row.syncedAt).not.toBeNull()
    expect(await billingAudit(tenant.id)).toEqual([
      {
        action: 'billing.resynced',
        access: 'platform',
        actorId: user.id,
        metadata: { reason: REASON },
      },
    ])
  })

  it("reports a resync's move to Free by the provider's cause, never as a staff cancel", async () => {
    const { tenant, subscriptionId } = await payingWorkspace()
    const longAgo = new Date(Date.now() - 30 * DAY_MS)
    await setBilling(tenant.id, { state: 'past_due', pastDueSince: longAgo, haltedAt: longAgo })
    await fake.fakeAdvance(subscriptionId, 'cancelled')
    const { token } = await staff('manager')

    const response = await postAs(token, tenant.id, '/resync', { reason: REASON })

    expect(response.status).toBe(200)
    expect(await readBilling(tenant.id)).toMatchObject({ state: 'free' })
    expect(await eventsOf(tenant.id, 'subscription_cancel_scheduled')).toEqual([])
    const [downgrade] = await eventsOf(tenant.id, 'downgraded_to_free')
    expect(downgrade?.properties).toMatchObject({ downgrade_cause: 'payment_failed' })
    const mails = await mailVariablesOf(tenant.id, 'moved_to_free')
    expect(mails.length).toBeGreaterThan(0)
    expect(mails.map((mail) => mail.downgradeCause)).not.toContain('staff')
    expect(mails[0]).toMatchObject({ downgradeCause: 'payment_failed' })
  })

  it('answers 503 when the provider is down, and audits nothing', async () => {
    const { tenant } = await payingWorkspace()
    const { token } = await staff('manager')
    let response: Awaited<ReturnType<typeof postAs>> | undefined

    await withMutatedMethod(
      fake,
      'fetchSubscription',
      (id: string) => Promise.reject(new ProviderError(`GET /subscriptions/${id}`, 503)),
      async () => {
        response = await postAs(token, tenant.id, '/resync', { reason: REASON })
      }
    )

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
    expect(await billingAudit(tenant.id)).toEqual([])
  })
})

describe('POST /api/v1/platform/tenants/:id/billing/cancel', () => {
  it('cancels at the cycle end: writes cancelAtPeriodEnd itself and keeps Paid', async () => {
    const { tenant, subscriptionId } = await payingWorkspace()
    const { token, user } = await staff('admin')
    const cancel = vi.spyOn(fake, 'cancelSubscription')

    const response = await postAs(token, tenant.id, '/cancel', {
      when: 'cycle_end',
      reason: REASON,
    })

    expect(response.status).toBe(200)
    expect(cancel).toHaveBeenCalledWith(subscriptionId, true)
    cancel.mockRestore()
    expect(dataOf(response.body)).toMatchObject({ state: 'active', cancelAtPeriodEnd: true })
    expect(await readBilling(tenant.id)).toMatchObject({ state: 'active', cancelAtPeriodEnd: true })
    expect(await subscriptionStatus(subscriptionId)).toBe('active')
    expect(await billingAudit(tenant.id)).toEqual([
      {
        action: 'billing.cancelled_by_staff',
        access: 'platform',
        actorId: user.id,
        metadata: { when: 'cycle_end', reason: REASON },
      },
    ])
  })

  it('cancels now: the provider cancel is immediate and the tenant moves to Free', async () => {
    const { tenant, subscriptionId } = await payingWorkspace()
    const { token } = await staff('admin')
    const cancel = vi.spyOn(fake, 'cancelSubscription')

    const response = await postAs(token, tenant.id, '/cancel', { when: 'now', reason: REASON })

    expect(response.status).toBe(200)
    expect(cancel).toHaveBeenCalledWith(subscriptionId, false)
    cancel.mockRestore()
    expect(dataOf(response.body)).toMatchObject({ state: 'free', plan: { key: 'free' } })
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'free',
      planId: plans.freeId,
      priceId: null,
      cancelAtPeriodEnd: false,
    })
    expect(await subscriptionStatus(subscriptionId)).toBe('cancelled')
    const [history] = await billingRepository.listHistory(tenant.id, 1)
    expect(history).toMatchObject({
      fromState: 'active',
      toState: 'free',
      cause: 'cancelled',
      source: 'staff',
    })
  })

  it('cancels a deferred start now even when asked for the cycle end, back to its trial', async () => {
    const { tenant } = await workspace()
    const trialEndsAt = new Date(Date.now() + 5 * DAY_MS)
    const subscriptionId = await deferredStart(tenant.id, trialEndsAt)
    const { token } = await staff('admin')
    const cancel = vi.spyOn(fake, 'cancelSubscription')

    const response = await postAs(token, tenant.id, '/cancel', {
      when: 'cycle_end',
      reason: REASON,
    })

    expect(response.status).toBe(200)
    expect(cancel).toHaveBeenCalledWith(subscriptionId, false)
    cancel.mockRestore()
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'trialing',
      priceId: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    })
    expect(await subscriptionStatus(subscriptionId)).toBe('cancelled')
  })

  it('sends the staff cancel as the payer, never the staff member', async () => {
    const { tenant, owner } = await payingWorkspace()
    const { token, user } = await staff('admin')

    await postAs(token, tenant.id, '/cancel', { when: 'cycle_end', reason: REASON })

    const [event] = await eventsOf(tenant.id, 'subscription_cancel_scheduled')
    expect(event?.distinctId).toBe(owner.id)
    expect(event?.properties).toMatchObject({ by: 'staff' })
    const productEvents = await sql<{ distinctId: string }[]>`
      select distinct_id as "distinctId" from analytics_outbox
      where properties->'$groups'->>'tenant' = ${tenant.id} and event not like 'billing_%'
        and event <> '$groupidentify'`
    expect(productEvents.map((row) => row.distinctId)).not.toContain(user.id)
  })

  it('cancels a past-due tenant now: Free, with the failed-payment stamps cleared', async () => {
    const { tenant, subscriptionId } = await payingWorkspace()
    const since = new Date(Date.now() - DAY_MS)
    await setBilling(tenant.id, { state: 'past_due', pastDueSince: since, haltedAt: since })
    const { token } = await staff('admin')

    const response = await postAs(token, tenant.id, '/cancel', { when: 'now', reason: REASON })

    expect(response.status).toBe(200)
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'free',
      planId: plans.freeId,
      pastDueSince: null,
      haltedAt: null,
      pausedAt: null,
    })
    expect(await subscriptionStatus(subscriptionId)).toBe('cancelled')
  })

  it('sends a staff cancel now as downgraded_to_free {staff} to the payer, and mails the staff cause', async () => {
    const { tenant, owner } = await payingWorkspace()
    const { token, user } = await staff('admin')

    await postAs(token, tenant.id, '/cancel', { when: 'now', reason: REASON })

    const [downgrade] = await eventsOf(tenant.id, 'downgraded_to_free')
    expect(downgrade?.distinctId).toBe(owner.id)
    expect(downgrade?.distinctId).not.toBe(user.id)
    expect(downgrade?.properties).toMatchObject({ downgrade_cause: 'staff' })
    const [scheduled] = await eventsOf(tenant.id, 'subscription_cancel_scheduled')
    expect(scheduled?.distinctId).toBe(owner.id)
    expect(scheduled?.properties).toMatchObject({ by: 'staff' })
    const mails = await mailVariablesOf(tenant.id, 'moved_to_free')
    expect(mails.length).toBeGreaterThan(0)
    expect(mails.every((mail) => mail.downgradeCause === 'staff')).toBe(true)
  })

  it("sends a staff cancel as by staff even when the provider's webhook lands it first", async () => {
    const { tenant, owner } = await payingWorkspace()
    const { token, user } = await staff('admin')
    const original = fake.cancelSubscription.bind(fake)
    let response: Awaited<ReturnType<typeof postAs>> | undefined

    await withMutatedMethod(
      fake,
      'cancelSubscription',
      async (id: string, isAtCycleEnd: boolean) => {
        const cancelled = await original(id, isAtCycleEnd)
        // The provider's webhook is synced before the staff cancel's own write.
        await fake.fakeAdvance(id, 'cancelled')
        await syncTenantBilling(tenant.id, 'webhook')
        return cancelled
      },
      async () => {
        response = await postAs(token, tenant.id, '/cancel', {
          when: 'cycle_end',
          reason: REASON,
        })
      }
    )

    expect(response?.status).toBe(200)
    const events = await eventsOf(tenant.id, 'subscription_cancel_scheduled')
    expect(events).toHaveLength(1)
    expect(events[0]?.distinctId).toBe(owner.id)
    expect(events[0]?.distinctId).not.toBe(user.id)
    expect(events[0]?.properties).toMatchObject({ by: 'staff' })
  })

  it('audits a cancel of a subscription that had already ended at the provider', async () => {
    const { tenant, subscriptionId } = await payingWorkspace()
    await fake.fakeAdvance(subscriptionId, 'cancelled')
    const { token, user } = await staff('admin')

    const response = await postAs(token, tenant.id, '/cancel', { when: 'now', reason: REASON })

    expect(response.status).toBe(200)
    expect(await billingAudit(tenant.id)).toEqual([
      {
        action: 'billing.cancelled_by_staff',
        access: 'platform',
        actorId: user.id,
        metadata: { when: 'now', reason: REASON },
      },
    ])
  })

  it('refuses a tenant with nothing to cancel with 409 NO_SUBSCRIPTION', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('admin')

    const response = await postAs(token, tenant.id, '/cancel', { when: 'now', reason: REASON })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'NO_SUBSCRIPTION' })
    expect(await billingAudit(tenant.id)).toEqual([])
  })

  it('answers 503 when the provider cancel fails, and writes nothing', async () => {
    const { tenant, subscriptionId } = await payingWorkspace()
    const before = await readBilling(tenant.id)
    const { token } = await staff('admin')
    let response: Awaited<ReturnType<typeof postAs>> | undefined

    await withMutatedMethod(
      fake,
      'cancelSubscription',
      (id: string) => Promise.reject(new ProviderError(`POST /subscriptions/${id}/cancel`, 503)),
      async () => {
        response = await postAs(token, tenant.id, '/cancel', { when: 'now', reason: REASON })
      }
    )

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
    const after = await readBilling(tenant.id)
    expect(after.version).toBe(before.version)
    expect(await subscriptionStatus(subscriptionId)).toBe('active')
    expect(await billingAudit(tenant.id)).toEqual([])
  })

  it('refuses a bad when with a field error', async () => {
    const { tenant } = await payingWorkspace()
    const { token } = await staff('admin')

    const response = await postAs(token, tenant.id, '/cancel', { when: 'later', reason: REASON })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { when: ANY_ARRAY } })
  })
})

describe('a staff member who is also an owner of the tenant', () => {
  it('still reads no billing email through the staff view', async () => {
    const { tenant } = await payingWorkspace()
    const { user, token } = await staff('viewer')
    await membershipRepository.create({ userId: user.id, tenantId: tenant.id, role: 'owner' })

    const response = await readAs(token, tenant.id)

    expect(dataOf(response.body)).toMatchObject({ billingEmail: null })
  })
})
