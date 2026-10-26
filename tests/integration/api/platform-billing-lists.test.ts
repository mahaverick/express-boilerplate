/**
 * @file The staff billing lists of one tenant, end to end against the real
 * database and Redis: state history, provider events and held
 * subscriptions. What the shared list contract does not pin: each item's
 * exact fields (an event never shows a provider id), what each filter
 * value means, a held subscription's standing, tenant isolation, the 404s
 * and the audit window the lists share with the billing read. Paging, sorts,
 * search, filter counts and cursor binding are in `list-contract.test.ts`;
 * the role gates in `platform-route-gates.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import { closeQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { deleteTrackedTenants, loadPlans, setBilling, workspace } from '../../helpers/billing-api'
import { platformTenant } from '../../helpers/platform-staff'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()

const NONE = null

/**
 * The three database-backed lists, by their last path segment.
 */
const LISTS = ['history', 'events', 'subscriptions'] as const

beforeAll(async () => {
  await loadPlans()
})

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await closeQueue()
  await closeRedis()
})

/**
 * A platform viewer's bearer token.
 * @returns The staff user and the token.
 */
async function viewer() {
  return createTrackedStaff('viewer')
}

/**
 * GET one of a tenant's staff billing lists.
 * @param token - The staff token.
 * @param tenantId - The tenant.
 * @param list - The list's last path segment.
 * @param query - The query params.
 * @returns The response.
 */
function listAs(token: string, tenantId: string, list: string, query: Record<string, string> = {}) {
  return request(app)
    .get(`/api/v1/platform/tenants/${tenantId}/billing/${list}`)
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

/**
 * The items of a list response.
 * @param body - The response body.
 * @returns The items.
 */
function itemsOf(body: unknown): Record<string, unknown>[] {
  return (body as { data: { items: Record<string, unknown>[] } }).data.items
}

/**
 * An instant `seconds` before now, as ISO text.
 * @param seconds - How far back.
 * @returns The instant.
 */
function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString()
}

/**
 * Store a provider event for a tenant with the given outcome.
 * @param tenantId - The tenant.
 * @param type - The event type.
 * @param outcome - The processed time and error.
 * @param outcome.processedAt - When it was handled, or null.
 * @param outcome.error - Its error, or null.
 * @param receivedSecondsAgo - How long ago it was received.
 */
async function storeEvent(
  tenantId: string,
  type: string,
  outcome: { processedAt: string | null; error: string | null },
  receivedSecondsAgo: number
): Promise<void> {
  await sql`insert into billing_events (provider, mode, provider_event_id, type, subscription_id, tenant_id, received_at, processed_at, attempts, error)
    values ('fake', 'test', ${`evt_${randomUUID()}`}, ${type}, 'sub_SECRETID', ${tenantId},
      ${secondsAgo(receivedSecondsAgo)}, ${outcome.processedAt}, 1, ${outcome.error})`
}

/**
 * Store a held subscription for a tenant.
 * @param tenantId - The tenant.
 * @param subscriptionId - The provider's subscription id.
 * @param seenSecondsAgo - How long ago it was first seen.
 * @param mode - The provider mode.
 */
async function storeHeld(
  tenantId: string,
  subscriptionId: string,
  seenSecondsAgo: number,
  mode: 'test' | 'live' = 'test'
): Promise<void> {
  await sql`insert into tenant_billing_subscriptions (tenant_id, provider, mode, subscription_id, first_seen_at)
    values (${tenantId}, 'fake', ${mode}, ${subscriptionId}, ${secondsAgo(seenSecondsAgo)})`
}

describe('GET /api/v1/platform/tenants/:id/billing/history', () => {
  it("lists only this tenant's state changes, newest first, with their fields", async () => {
    const { tenant } = await workspace()
    const other = await workspace()
    await sql`delete from billing_state_history where tenant_id in (${tenant.id}, ${other.tenant.id})`
    await sql`insert into billing_state_history (tenant_id, from_state, to_state, cause, source, at) values
      (${tenant.id}, ${NONE}, 'trialing', 'created', 'job', ${secondsAgo(30)}),
      (${tenant.id}, 'trialing', 'free', 'trial_ended', 'job', ${secondsAgo(20)}),
      (${tenant.id}, 'free', 'trialing', 'trial_extended', 'staff', ${secondsAgo(10)}),
      (${other.tenant.id}, 'free', 'active', 'subscription_activated', 'webhook', ${secondsAgo(5)})`
    const { token } = await viewer()

    const response = await listAs(token, tenant.id, 'history')

    expect(response.status).toBe(200)
    const items = itemsOf(response.body)
    expect(items.map((item) => item.cause)).toStrictEqual([
      'trial_extended',
      'trial_ended',
      'created',
    ])
    expect(items[0]).toStrictEqual({
      id: expect.any(String),
      from: 'free',
      to: 'trialing',
      cause: 'trial_extended',
      source: 'staff',
      at: expect.any(String),
    })
    expect(items[2]).toMatchObject({ from: null, to: 'trialing' })
  })

  it('filters by source and searches the states and the cause', async () => {
    const { tenant } = await workspace()
    await sql`delete from billing_state_history where tenant_id = ${tenant.id}`
    await sql`insert into billing_state_history (tenant_id, from_state, to_state, cause, source, at) values
      (${tenant.id}, 'trialing', 'free', 'trial_ended', 'job', ${secondsAgo(20)}),
      (${tenant.id}, 'free', 'active', 'subscription_activated', 'webhook', ${secondsAgo(10)}),
      (${tenant.id}, 'active', 'past_due', 'payment_failed', 'webhook', ${secondsAgo(5)})`
    const { token } = await viewer()

    const webhook = await listAs(token, tenant.id, 'history', { source: 'webhook' })
    const pastDue = await listAs(token, tenant.id, 'history', { search: 'PAST_DUE' })
    const cause = await listAs(token, tenant.id, 'history', { search: 'trial_end' })

    expect(itemsOf(webhook.body).map((item) => item.cause)).toStrictEqual([
      'payment_failed',
      'subscription_activated',
    ])
    expect(itemsOf(pastDue.body).map((item) => item.cause)).toStrictEqual(['payment_failed'])
    expect(itemsOf(cause.body).map((item) => item.cause)).toStrictEqual(['trial_ended'])
  })

  it('refuses an unknown source with a field error', async () => {
    const { tenant } = await workspace()
    const { token } = await viewer()

    const response = await listAs(token, tenant.id, 'history', { source: 'webhook,robot' })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      errors: {
        source: [
          'source must be a comma-separated list of: webhook, confirm, reconcile, job, staff, owner.',
        ],
      },
    })
  })
})

describe('GET /api/v1/platform/tenants/:id/billing/events', () => {
  it('shows each event by type, outcome and times, never its provider ids', async () => {
    const { tenant } = await workspace()
    const other = await workspace()
    await storeEvent(
      tenant.id,
      'subscription.charged',
      { processedAt: secondsAgo(39), error: NONE },
      40
    )
    await storeEvent(
      tenant.id,
      'subscription.activated',
      { processedAt: secondsAgo(29), error: 'unknown_subscription' },
      30
    )
    await storeEvent(
      tenant.id,
      'payment.failed',
      { processedAt: NONE, error: 'ProviderError: 503' },
      20
    )
    await storeEvent(tenant.id, 'subscription.halted', { processedAt: NONE, error: NONE }, 10)
    await storeEvent(
      other.tenant.id,
      'subscription.cancelled',
      { processedAt: NONE, error: NONE },
      5
    )
    const { token } = await viewer()

    const response = await listAs(token, tenant.id, 'events')

    expect(response.status).toBe(200)
    const items = itemsOf(response.body)
    expect(items.map((item) => [item.type, item.status])).toStrictEqual([
      ['subscription.halted', 'pending'],
      ['payment.failed', 'failed'],
      ['subscription.activated', 'unused'],
      ['subscription.charged', 'processed'],
    ])
    expect(Object.keys(items[1] ?? {}).toSorted()).toStrictEqual([
      'attempts',
      'error',
      'id',
      'mode',
      'processedAt',
      'provider',
      'receivedAt',
      'status',
      'type',
    ])
    expect(items[1]).toMatchObject({
      provider: 'fake',
      mode: 'test',
      attempts: 1,
      processedAt: null,
      error: 'ProviderError: 503',
    })
    expect(JSON.stringify(response.body)).not.toContain('SECRETID')
  })

  it('filters by each status and searches the type and the error', async () => {
    const { tenant } = await workspace()
    await storeEvent(
      tenant.id,
      'subscription.charged',
      { processedAt: secondsAgo(39), error: NONE },
      40
    )
    await storeEvent(
      tenant.id,
      'subscription.activated',
      { processedAt: secondsAgo(29), error: 'payments_off' },
      30
    )
    await storeEvent(
      tenant.id,
      'payment.failed',
      { processedAt: NONE, error: 'ProviderError: 503' },
      20
    )
    await storeEvent(tenant.id, 'subscription.halted', { processedAt: NONE, error: NONE }, 10)
    const { token } = await viewer()

    /**
     * The types a status filter lists.
     */
    const typesFor = async (query: Record<string, string>) => {
      const response = await listAs(token, tenant.id, 'events', query)
      return itemsOf(response.body).map((item) => item.type)
    }

    expect(await typesFor({ status: 'processed' })).toStrictEqual(['subscription.charged'])
    expect(await typesFor({ status: 'unused' })).toStrictEqual(['subscription.activated'])
    expect(await typesFor({ status: 'failed' })).toStrictEqual(['payment.failed'])
    expect(await typesFor({ status: 'pending' })).toStrictEqual(['subscription.halted'])
    expect(await typesFor({ status: 'failed,unused' })).toStrictEqual([
      'payment.failed',
      'subscription.activated',
    ])
    expect(await typesFor({ search: 'PAYMENTS_OFF' })).toStrictEqual(['subscription.activated'])
    expect(await typesFor({ search: 'payment.' })).toStrictEqual(['payment.failed'])
  })
})

describe('GET /api/v1/platform/tenants/:id/billing/subscriptions', () => {
  it("marks the billing row's current, pending and next subscriptions, newest first seen", async () => {
    const { tenant } = await workspace()
    const other = await workspace()
    await storeHeld(tenant.id, 'sub_EARLIER', 50)
    await storeHeld(tenant.id, 'sub_LIVEMODE', 40, 'live')
    await storeHeld(tenant.id, 'sub_CURRENT', 30)
    await storeHeld(tenant.id, 'sub_PENDING', 20)
    await storeHeld(tenant.id, 'sub_NEXT', 10)
    await storeHeld(other.tenant.id, 'sub_THEIRS', 5)
    await setBilling(tenant.id, {
      provider: 'fake',
      providerMode: 'test',
      providerSubscriptionId: 'sub_CURRENT',
      pendingSubscriptionId: 'sub_PENDING',
      nextSubscriptionId: 'sub_NEXT',
    })
    const { token } = await viewer()

    const response = await listAs(token, tenant.id, 'subscriptions')

    expect(response.status).toBe(200)
    const items = itemsOf(response.body)
    expect(items.map((item) => [item.subscriptionId, item.standing])).toStrictEqual([
      ['sub_NEXT', 'next'],
      ['sub_PENDING', 'pending'],
      ['sub_CURRENT', 'current'],
      ['sub_LIVEMODE', 'earlier'],
      ['sub_EARLIER', 'earlier'],
    ])
    expect(items[2]).toStrictEqual({
      id: expect.any(String),
      subscriptionId: 'sub_CURRENT',
      provider: 'fake',
      mode: 'test',
      firstSeenAt: expect.any(String),
      standing: 'current',
    })
  })

  it('reads a subscription of another mode than the row as earlier, even with the same id', async () => {
    const { tenant } = await workspace()
    await storeHeld(tenant.id, 'sub_SAME', 10, 'live')
    await setBilling(tenant.id, {
      provider: 'fake',
      providerMode: 'test',
      providerSubscriptionId: 'sub_SAME',
    })
    const { token } = await viewer()

    const response = await listAs(token, tenant.id, 'subscriptions', { mode: 'live' })

    expect(itemsOf(response.body).map((item) => item.standing)).toStrictEqual(['earlier'])
  })

  it('searches the subscription id', async () => {
    const { tenant } = await workspace()
    await storeHeld(tenant.id, 'sub_ALPHA1', 20)
    await storeHeld(tenant.id, 'sub_BETA2', 10)
    const { token } = await viewer()

    const response = await listAs(token, tenant.id, 'subscriptions', { search: 'alpha' })

    expect(itemsOf(response.body).map((item) => item.subscriptionId)).toStrictEqual(['sub_ALPHA1'])
  })
})

describe('every staff billing list', () => {
  it.each(LISTS)('%s answers an unknown tenant 404 tenant_not_found', async (list) => {
    const { token } = await viewer()

    const response = await listAs(token, randomUUID(), list)

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'tenant_not_found' })
  })

  it.each(LISTS)('%s answers the platform tenant 404 tenant_billing_not_found', async (list) => {
    const platform = await platformTenant()
    const { token } = await viewer()

    const response = await listAs(token, platform.id, list)

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'tenant_billing_not_found' })
  })

  it.each(LISTS)('%s reads an archived tenant', async (list) => {
    const { tenant } = await workspace()
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenant.id}`
    const { token } = await viewer()

    const response = await listAs(token, tenant.id, list)

    expect(response.status).toBe(200)
  })

  it('shares one billing.viewed audit entry with the billing read in a throttle window', async () => {
    const { tenant } = await workspace()
    const { token, user } = await viewer()

    for (const list of LISTS) {
      const response = await listAs(token, tenant.id, list)
      expect(response.status).toBe(200)
    }
    const read = await request(app)
      .get(`/api/v1/platform/tenants/${tenant.id}/billing`)
      .set('Authorization', `Bearer ${token}`)
    expect(read.status).toBe(200)

    const entries = await sql<{ action: string; access: string; actorId: string | null }[]>`
      select action, access, actor_user_id as "actorId" from audit_logs
      where tenant_id = ${tenant.id} and action like 'billing.%'`
    // toEqual: the driver's result array is its own class.
    expect(entries).toEqual([{ action: 'billing.viewed', access: 'platform', actorId: user.id }])
  })
})
