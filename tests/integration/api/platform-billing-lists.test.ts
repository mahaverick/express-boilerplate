/**
 * @file The staff billing lists of one tenant, end to end against the real
 * database and Redis: state history, provider events and held
 * subscriptions. What the shared list contract does not pin: each item's
 * exact fields (an event never shows a provider id), what each filter
 * value means, a held subscription's standing, tenant isolation, the 404s
 * and the audit window the lists share with the billing read; and the
 * invoice list's provider-backed paging, whose signed cursor binds the
 * tenant, the subscriptions and the status filter. Paging, sorts,
 * search, filter counts and cursor binding are in `list-contract.test.ts`;
 * the role gates in `platform-route-gates.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { ProviderError } from '@/errors/billing-provider-errors'
import { sql } from '@/services/database.service'
import { closeQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import type { InvoiceListOptions, InvoiceView, ProviderInvoicePage } from '@/types/billing'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  deleteTrackedTenants,
  fake,
  fakeSubscription,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  paymentsSwitch,
  plans,
  setBilling,
  workspace,
} from '../../helpers/billing-api'
import { withMutatedMethod } from '../../helpers/mutate'
import { platformTenant } from '../../helpers/platform-staff'
import { createTrackedStaff, deleteTrackedUsers, tokenFor } from '../../helpers/platform-users'
import { request } from '../../helpers/request'

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  // The real failure mapping, with the fake as the provider.
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

const app = createApp()

const NONE = null

/**
 * `expect.any(String)` typed as `string`, because vitest types it as `any`.
 */
const ANY_STRING = expect.any(String) as unknown as string

/**
 * The four staff billing lists (three database-backed, one provider-backed), by their last path segment.
 */
const LISTS = ['history', 'events', 'subscriptions', 'invoices'] as const

beforeAll(async () => {
  await loadPlans()
})

afterEach(async () => {
  paymentsSwitch.on = true
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await forgetProviderPlans()
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
      id: ANY_STRING,
      from: 'free',
      to: 'trialing',
      cause: 'trial_extended',
      source: 'staff',
      at: ANY_STRING,
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
      'error',
      'id',
      'mode',
      'processedAt',
      'provider',
      'receivedAt',
      'recordedOutcomes',
      'status',
      'type',
    ])
    expect(items[1]).toMatchObject({
      provider: 'fake',
      mode: 'test',
      recordedOutcomes: 1,
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
      id: ANY_STRING,
      subscriptionId: 'sub_CURRENT',
      provider: 'fake',
      mode: 'test',
      firstSeenAt: ANY_STRING,
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

/**
 * The page part of a list response.
 * @param body - The response body.
 * @returns The page cursors and flags.
 */
function pageOf(body: unknown): {
  nextCursor: string | null
  prevCursor: string | null
  hasNext: boolean
  hasPrev: boolean
  limit: number
} {
  return (body as { data: { page: ReturnType<typeof pageOf> } }).data.page
}

/**
 * One invoice of a fake provider page.
 * @param id - The invoice id.
 * @param subscriptionId - The subscription it bills.
 * @returns The invoice.
 */
function invoice(id: string, subscriptionId: string): InvoiceView & { subscriptionId: string } {
  return {
    id,
    subscriptionId,
    amountMinor: 99_900,
    currency: 'INR',
    status: 'paid',
    issuedAt: new Date().toISOString(),
    paidAt: new Date().toISOString(),
    url: 'https://rzp.io/i/payer-page',
  }
}

/**
 * A stand-in for the provider's invoice list that answers one fixed page
 * with a provider cursor, recording each call's cursor and options.
 * @param calls - Where each call is recorded.
 * @param page - The page to answer.
 * @returns The stand-in.
 */
function pagedInvoices(
  calls: { ids: string[]; cursor: string | null; options: unknown }[],
  page: ProviderInvoicePage
) {
  return (ids: string[], cursor: string | null, options?: InvoiceListOptions) => {
    calls.push({ ids, cursor, options })
    return Promise.resolve(page)
  }
}

describe('GET /api/v1/platform/tenants/:id/billing/invoices', () => {
  it("lists the current and earlier subscriptions' invoices, each with its subscription and no link", async () => {
    const { tenant } = await workspace()
    const earlier = await fakeSubscription({ tenantId: tenant.id, priceId: plans.monthPriceId })
    await fake.fakeAdvance(earlier, 'active')
    await storeHeld(tenant.id, earlier, 3600)
    const { subscriptionId } = await makePaying(tenant.id)
    const { token } = await viewer()

    const response = await listAs(token, tenant.id, 'invoices')

    expect(response.status).toBe(200)
    const items = itemsOf(response.body)
    expect(items.map((item) => item.subscriptionId)).toStrictEqual([subscriptionId, earlier])
    expect(Object.keys(items[0] ?? {}).toSorted()).toStrictEqual([
      'amountMinor',
      'currency',
      'id',
      'issuedAt',
      'paidAt',
      'status',
      'subscriptionId',
    ])
    expect(pageOf(response.body)).toStrictEqual({
      nextCursor: null,
      prevCursor: null,
      hasNext: false,
      hasPrev: false,
      limit: 20,
    })
  })

  it("never lists another tenant's subscriptions", async () => {
    const mine = await workspace()
    const theirs = await workspace()
    await makePaying(mine.tenant.id)
    const other = await makePaying(theirs.tenant.id)
    const { token } = await viewer()

    const response = await listAs(token, mine.tenant.id, 'invoices')

    const items = itemsOf(response.body)
    expect(items).toHaveLength(1)
    expect(items.map((item) => item.subscriptionId)).not.toContain(other.subscriptionId)
  })

  it('filters by status', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const { token } = await viewer()

    const paid = await listAs(token, tenant.id, 'invoices', { status: 'paid,issued' })
    const issued = await listAs(token, tenant.id, 'invoices', { status: 'issued' })
    const bad = await listAs(token, tenant.id, 'invoices', { status: 'draft' })

    expect(itemsOf(paid.body).map((item) => item.status)).toStrictEqual(['paid'])
    expect(itemsOf(issued.body)).toStrictEqual([])
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({
      errors: {
        status: ['status must be a comma-separated list of: issued, paid, cancelled, expired.'],
      },
    })
  })

  it("signs the provider's cursor and hands it back on the next page, with the status filter", async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    const { token } = await viewer()
    const calls: { ids: string[]; cursor: string | null; options: unknown }[] = []
    let first: Awaited<ReturnType<typeof listAs>> | undefined
    let second: Awaited<ReturnType<typeof listAs>> | undefined

    await withMutatedMethod(
      fake,
      'listInvoices',
      pagedInvoices(calls, { items: [invoice('inv_A', subscriptionId)], nextCursor: '0:20' }),
      async () => {
        first = await listAs(token, tenant.id, 'invoices', { status: 'paid' })
        const cursor = pageOf(first.body).nextCursor ?? ''
        second = await listAs(token, tenant.id, 'invoices', { status: 'paid', cursor })
      }
    )

    expect(first?.status).toBe(200)
    const firstPage = pageOf(first?.body)
    expect(firstPage).toMatchObject({ hasNext: true, hasPrev: false, prevCursor: null })
    expect(firstPage.nextCursor).not.toBe('0:20')
    expect(second?.status).toBe(200)
    expect(pageOf(second?.body)).toMatchObject({ hasPrev: true, prevCursor: null })
    expect(calls).toStrictEqual([
      { ids: [subscriptionId], cursor: null, options: { statuses: ['paid'], maxReads: 10 } },
      { ids: [subscriptionId], cursor: '0:20', options: { statuses: ['paid'], maxReads: 10 } },
    ])
  })

  it("refuses an unsigned cursor, and a cursor from another tenant's subscriptions, another filter or the owner's list", async () => {
    const { tenant, owner } = await workspace()
    const other = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await makePaying(other.tenant.id)
    const { token } = await viewer()
    const calls: { ids: string[]; cursor: string | null; options: unknown }[] = []
    let staffCursor = ''
    let ownerCursor = ''

    await withMutatedMethod(
      fake,
      'listInvoices',
      pagedInvoices(calls, { items: [invoice('inv_A', subscriptionId)], nextCursor: '0:20' }),
      async () => {
        const staffPage = await listAs(token, tenant.id, 'invoices', { status: 'paid' })
        staffCursor = pageOf(staffPage.body).nextCursor ?? ''
        const ownerPage = await request(app)
          .get(`/api/v1/tenants/${tenant.slug}/billing/invoices`)
          .set('Authorization', `Bearer ${tokenFor(owner)}`)
        ownerCursor = pageOf(ownerPage.body).nextCursor ?? ''
      }
    )
    expect(staffCursor).not.toBe('')
    expect(ownerCursor).not.toBe('')

    const refusals = [
      await listAs(token, tenant.id, 'invoices', { cursor: '0:20' }),
      await listAs(token, other.tenant.id, 'invoices', { status: 'paid', cursor: staffCursor }),
      await listAs(token, tenant.id, 'invoices', { cursor: staffCursor }),
      await listAs(token, tenant.id, 'invoices', { cursor: ownerCursor }),
    ]
    for (const response of refusals) {
      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ code: 'CURSOR_INVALID' })
    }
  })

  it('caps an unfiltered page at 10 provider calls too', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    const { token } = await viewer()
    const calls: { ids: string[]; cursor: string | null; options: unknown }[] = []

    await withMutatedMethod(
      fake,
      'listInvoices',
      pagedInvoices(calls, { items: [], nextCursor: '0:200' }),
      async () => {
        const response = await listAs(token, tenant.id, 'invoices')
        expect(response.status).toBe(200)
        expect(itemsOf(response.body)).toStrictEqual([])
        expect(pageOf(response.body)).toMatchObject({ hasNext: true })
      }
    )

    expect(calls).toStrictEqual([
      { ids: [subscriptionId], cursor: null, options: { maxReads: 10 } },
    ])
  })

  it('refuses a cursor from another tenant listing the very same subscriptions', async () => {
    const mine = await workspace()
    const theirs = await workspace()
    // Both rows name one scheduled subscription and nothing else, so only the tenant tells their cursors apart.
    for (const tenantId of [mine.tenant.id, theirs.tenant.id]) {
      await setBilling(tenantId, {
        provider: 'fake',
        providerMode: 'test',
        providerSubscriptionId: null,
        nextSubscriptionId: 'sub_SHARED',
      })
    }
    const { token } = await viewer()
    const calls: { ids: string[]; cursor: string | null; options: unknown }[] = []
    let refused: Awaited<ReturnType<typeof listAs>> | undefined

    await withMutatedMethod(
      fake,
      'listInvoices',
      pagedInvoices(calls, { items: [invoice('inv_A', 'sub_SHARED')], nextCursor: '0:20' }),
      async () => {
        const first = await listAs(token, mine.tenant.id, 'invoices')
        const cursor = pageOf(first.body).nextCursor ?? ''
        refused = await listAs(token, theirs.tenant.id, 'invoices', { cursor })
      }
    )

    expect(calls.map((call) => call.ids)).toStrictEqual([['sub_SHARED']])
    expect(refused?.status).toBe(400)
    expect(refused?.body).toMatchObject({ code: 'CURSOR_INVALID' })
  })

  it('refuses a cursor over the length cap with a field error', async () => {
    const { tenant } = await workspace()
    const { token } = await viewer()

    const response = await listAs(token, tenant.id, 'invoices', { cursor: 'a'.repeat(4097) })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { cursor: expect.any(Array) as unknown } })
    expect(response.body).not.toMatchObject({ code: 'CURSOR_INVALID' })
  })

  it('refuses any cursor with payments off', async () => {
    const { tenant } = await workspace()
    const { token } = await viewer()
    paymentsSwitch.on = false

    const response = await listAs(token, tenant.id, 'invoices', { cursor: 'not-a-cursor' })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CURSOR_INVALID' })
  })

  it('answers an empty page with payments off', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const { token } = await viewer()
    paymentsSwitch.on = false

    const response = await listAs(token, tenant.id, 'invoices')

    expect(response.status).toBe(200)
    expect(itemsOf(response.body)).toStrictEqual([])
    expect(pageOf(response.body)).toMatchObject({ hasNext: false, nextCursor: null })
  })

  it('answers 503 when the provider is down', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const { token } = await viewer()
    let response: Awaited<ReturnType<typeof listAs>> | undefined

    await withMutatedMethod(
      fake,
      'listInvoices',
      () => Promise.reject(new ProviderError('GET /invoices', 503)),
      async () => {
        response = await listAs(token, tenant.id, 'invoices')
      }
    )

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
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

  it.each(LISTS)('%s alone writes one billing.viewed audit entry', async (list) => {
    const { tenant } = await workspace()
    const { token, user } = await viewer()

    const response = await listAs(token, tenant.id, list)

    expect(response.status).toBe(200)
    const entries = await sql<{ action: string; access: string; actorId: string | null }[]>`
      select action, access, actor_user_id as "actorId" from audit_logs
      where tenant_id = ${tenant.id} and action like 'billing.%'`
    // toEqual: the driver's result array is its own class.
    expect(entries).toEqual([{ action: 'billing.viewed', access: 'platform', actorId: user.id }])
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
