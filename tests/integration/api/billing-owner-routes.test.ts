/**
 * @file The owner billing routes besides checkout, end to end against the
 * real database and the fake payment provider: the billing read and its
 * owner-only fields, the interval switch, the card change, the cancel (a
 * cycle-end cancel, and a deferred start cancelled back to its trial) and the
 * invoice list.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import {
  BILLING_OWNER_ONLY_MESSAGE,
  INVOICES_OWNER_ONLY_MESSAGE,
} from '@/constants/billing.constants'
import type { User } from '@/database/models/user.model'
import { ProviderError } from '@/errors/billing-provider-errors'
import { BillingRepository } from '@/repositories/billing.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { sql } from '@/services/database.service'
import { closeRedis } from '@/services/redis.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  billingColumn,
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
  subscriptionStatus,
  workspace,
} from '../../helpers/billing-api'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
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
const billingRepository = new BillingRepository()
const membershipRepository = new UserMembershipRepository()

const DAY_MS = 24 * 60 * 60 * 1000

beforeAll(async () => {
  await loadPlans()
})

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await forgetProviderPlans()
  await closeRedis()
})

/**
 * POST a JSON body to a tenant path as `user`.
 * @param user - The caller.
 * @param path - The path after `/api/v1/tenants/`.
 * @param body - The JSON body.
 * @returns The response.
 */
function postAs(user: User, path: string, body: object = {}) {
  return request(app)
    .post(`/api/v1/tenants/${path}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send(body)
}

/**
 * GET a tenant path as `user`.
 * @param user - The caller.
 * @param path - The path after `/api/v1/tenants/`.
 * @returns The response.
 */
function getAs(user: User, path: string) {
  return request(app)
    .get(`/api/v1/tenants/${path}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
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
 * The billing audit entries of a workspace, oldest first.
 * @param tenantId - The workspace.
 * @returns Each entry's action and metadata.
 */
async function billingAudit(tenantId: string): Promise<{ action: string; metadata: unknown }[]> {
  return sql<{ action: string; metadata: unknown }[]>`
    select action, metadata from audit_logs
    where tenant_id = ${tenantId} and action like 'billing.%' order by occurred_at, id`
}

/**
 * A member added to a workspace with a role.
 * @param tenantId - The workspace.
 * @param role - The role.
 * @returns The member.
 */
async function addMember(tenantId: string, role: 'admin' | 'editor' | 'owner'): Promise<User> {
  const user = await createTrackedUser()
  await membershipRepository.create({ userId: user.id, tenantId, role })
  return user
}

describe('GET /api/v1/tenants/:slug/billing', () => {
  it('shows the owner the payer and billing email, and an admin neither email', async () => {
    const { tenant, owner } = await workspace({ firstName: 'Ada' })
    const { periodEnd } = await makePaying(tenant.id)
    await setBilling(tenant.id, { payerUserId: owner.id, billingEmail: owner.email })
    const admin = await addMember(tenant.id, 'admin')

    const ownerView = await getAs(owner, `${tenant.slug}/billing`)
    const adminView = await getAs(admin, `${tenant.slug}/billing`)

    expect(ownerView.status).toBe(200)
    expect(dataOf(ownerView.body)).toStrictEqual({
      state: 'active',
      plan: { key: 'paid', name: 'Paid' },
      interval: 'month',
      price: { id: plans.monthPriceId, interval: 'month', amountMinor: 99_900, currency: 'INR' },
      trialEndsAt: null,
      currentPeriodEnd: periodEnd.toISOString(),
      cancelAtPeriodEnd: false,
      pastDue: null,
      nextSwitch: null,
      payer: { userId: owner.id, name: 'Ada', isMember: true },
      billingEmail: owner.email,
      paymentsEnabled: true,
      dismissedBanners: [],
    })
    expect(adminView.status).toBe(200)
    expect(dataOf(adminView.body)).toMatchObject({ state: 'active', billingEmail: null })
  })

  it('reads payer.isMember false once the payer left the workspace', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const formerOwner = await createTrackedUser({ firstName: 'Grace' })
    await setBilling(tenant.id, { payerUserId: formerOwner.id, billingEmail: formerOwner.email })
    const viewer = await addMember(tenant.id, 'editor')

    const response = await getAs(viewer, `${tenant.slug}/billing`)

    expect(dataOf(response.body)).toMatchObject({
      payer: { userId: formerOwner.id, name: 'Grace', isMember: false },
      billingEmail: null,
    })
  })

  it('gives staff with platform access the read without the owner-only fields', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)
    await setBilling(tenant.id, { payerUserId: owner.id, billingEmail: owner.email })
    const { user } = await createTrackedStaff('owner')

    const response = await getAs(user, `${tenant.slug}/billing`)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({ state: 'active', billingEmail: null })
  })
})

describe('POST /api/v1/tenants/:slug/billing/interval', () => {
  it('refuses a switch to the interval already billed with 409 SAME_INTERVAL', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)

    const response = await postAs(owner, `${tenant.slug}/billing/interval`, { interval: 'month' })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'SAME_INTERVAL' })
  })

  it('starts a yearly subscription from the period end, stored as next, and shows it once authenticated', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId, periodEnd } = await makePaying(tenant.id)

    const response = await postAs(owner, `${tenant.slug}/billing/interval`, { interval: 'year' })

    expect(response.status).toBe(200)
    const session = dataOf(response.body)
    expect(session).toMatchObject({
      purpose: 'switch',
      amountMinor: 999_000,
      interval: 'year',
      startsAt: periodEnd.toISOString(),
    })
    const nextId = String(session.subscriptionId)
    expect(await readBilling(tenant.id)).toMatchObject({
      providerSubscriptionId: subscriptionId,
      nextSubscriptionId: nextId,
      nextPriceId: plans.yearPriceId,
      cancelAtPeriodEnd: false,
    })
    const beforeAuth = await getAs(owner, `${tenant.slug}/billing`)
    expect(dataOf(beforeAuth.body).nextSwitch).toBeNull()
    expect(await billingAudit(tenant.id)).toEqual([
      { action: 'billing.interval_switch_scheduled', metadata: { interval: 'year' } },
    ])

    await fake.fakeAdvance(nextId, 'authenticated')
    const confirmed = await postAs(
      owner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody(nextId)
    )

    expect(confirmed.status).toBe(200)
    expect(dataOf(confirmed.body)).toMatchObject({
      cancelAtPeriodEnd: true,
      nextSwitch: { interval: 'year', startsAt: periodEnd.toISOString() },
    })
  })

  it('refuses a Free workspace with 409 NO_SUBSCRIPTION', async () => {
    const { tenant, owner } = await workspace()

    const response = await postAs(owner, `${tenant.slug}/billing/interval`, { interval: 'year' })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'NO_SUBSCRIPTION' })
  })

  it('refuses a cancelling subscription with 409 NO_SUBSCRIPTION', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)
    await setBilling(tenant.id, { cancelAtPeriodEnd: true })

    const response = await postAs(owner, `${tenant.slug}/billing/interval`, { interval: 'year' })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'NO_SUBSCRIPTION' })
  })
})

describe('POST /api/v1/tenants/:slug/billing/interval before the first charge', () => {
  it('refuses a switch during a deferred start with 409 SWITCH_BEFORE_FIRST_CHARGE', async () => {
    const { tenant, owner } = await workspace()
    const trialEndsAt = new Date(Date.now() + 5 * DAY_MS)
    const subscriptionId = await fakeSubscription(
      { tenantId: tenant.id, priceId: plans.monthPriceId },
      'month',
      trialEndsAt
    )
    await fake.fakeAdvance(subscriptionId, 'authenticated')
    await setBilling(tenant.id, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      trialEndsAt,
      currentPeriodEnd: trialEndsAt,
      providerSubscriptionId: subscriptionId,
      provider: 'fake',
      providerMode: 'test',
    })

    const response = await postAs(owner, `${tenant.slug}/billing/interval`, { interval: 'year' })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'SWITCH_BEFORE_FIRST_CHARGE' })
    expect(await billingColumn(tenant.id, 'nextSubscriptionId')).toBeNull()
  })
})

describe('POST /api/v1/tenants/:slug/billing/payment-method', () => {
  it('refuses a workspace with no subscription with 409 NO_SUBSCRIPTION', async () => {
    const { tenant, owner } = await workspace()

    const response = await postAs(owner, `${tenant.slug}/billing/payment-method`)

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'NO_SUBSCRIPTION' })
  })

  it('opens the current subscription for a card change, and its confirm makes the caller the payer', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setBilling(tenant.id, { payerUserId: owner.id, billingEmail: owner.email })
    const secondOwner = await addMember(tenant.id, 'owner')

    const response = await postAs(secondOwner, `${tenant.slug}/billing/payment-method`)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({
      purpose: 'card_change',
      subscriptionId,
      amountMinor: 99_900,
      interval: 'month',
      startsAt: null,
      prefill: { email: secondOwner.email },
    })
    expect(await billingAudit(tenant.id)).toEqual([
      { action: 'billing.card_change_started', metadata: {} },
    ])

    const confirmed = await postAs(
      secondOwner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody(subscriptionId)
    )

    expect(confirmed.status).toBe(200)
    expect(await readBilling(tenant.id)).toMatchObject({
      payerUserId: secondOwner.id,
      billingEmail: secondOwner.email,
      providerSubscriptionId: subscriptionId,
    })
  })
})

describe('POST /api/v1/tenants/:slug/billing/checkout/confirm for a card change', () => {
  it('refuses a re-post of a confirmed card change without a fresh start', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await postAs(owner, `${tenant.slug}/billing/payment-method`)
    const body = confirmBody(subscriptionId)
    const first = await postAs(owner, `${tenant.slug}/billing/checkout/confirm`, body)
    expect(first.status).toBe(200)
    expect(await readBilling(tenant.id)).toMatchObject({
      cardChangeStartedAt: null,
      cardChangeStartedBy: null,
    })

    const again = await postAs(owner, `${tenant.slug}/billing/checkout/confirm`, body)

    expect(again.status).toBe(400)
    expect(again.body).toMatchObject({ code: 'CHECKOUT_MISMATCH' })
  })

  it('refuses the current subscription with no card change started', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)

    const response = await postAs(
      owner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody(subscriptionId)
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CHECKOUT_MISMATCH' })
  })

  it('refuses a card change confirmed by an owner who did not start it', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    const secondOwner = await addMember(tenant.id, 'owner')
    await postAs(owner, `${tenant.slug}/billing/payment-method`)

    const response = await postAs(
      secondOwner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody(subscriptionId)
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CHECKOUT_MISMATCH' })
  })

  it('refuses a card change started longer ago than a checkout lives', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await postAs(owner, `${tenant.slug}/billing/payment-method`)
    await setBilling(tenant.id, { cardChangeStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })

    const response = await postAs(
      owner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody(subscriptionId)
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CHECKOUT_MISMATCH' })
  })
})

describe('POST /api/v1/tenants/:slug/billing/cancel', () => {
  it('cancels at the cycle end: the workspace reads cancelling and keeps Paid', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)

    const response = await postAs(owner, `${tenant.slug}/billing/cancel`)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({
      state: 'active',
      plan: { key: 'paid' },
      cancelAtPeriodEnd: true,
    })
    expect(await billingColumn(tenant.id, 'cancelAtPeriodEnd')).toBe(true)
    expect(await subscriptionStatus(subscriptionId)).toBe('active')
    expect(await billingAudit(tenant.id)).toEqual([
      { action: 'billing.cancel_scheduled', metadata: {} },
    ])

    await syncTenantBilling(tenant.id, 'webhook')
    expect(await billingColumn(tenant.id, 'cancelAtPeriodEnd')).toBe(true)
  })

  it('refuses a second cancel with 409 NO_SUBSCRIPTION', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)
    await postAs(owner, `${tenant.slug}/billing/cancel`)

    const response = await postAs(owner, `${tenant.slug}/billing/cancel`)

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'NO_SUBSCRIPTION' })
  })

  it('refuses a Free workspace with 409 NO_SUBSCRIPTION', async () => {
    const { tenant, owner } = await workspace()

    const response = await postAs(owner, `${tenant.slug}/billing/cancel`)

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'NO_SUBSCRIPTION' })
  })

  it('refuses an admin with the role 403 and cancels nothing', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    const admin = await addMember(tenant.id, 'admin')

    const response = await postAs(admin, `${tenant.slug}/billing/cancel`)

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ message: BILLING_OWNER_ONLY_MESSAGE })
    expect(await billingColumn(tenant.id, 'cancelAtPeriodEnd')).toBe(false)
    expect(await subscriptionStatus(subscriptionId)).toBe('active')
  })

  it('cancels a deferred start now and returns the workspace to its trial, which a later sync keeps', async () => {
    const { tenant, owner } = await workspace()
    const trialEndsAt = new Date(Date.now() + 5 * DAY_MS)
    const subscriptionId = await fakeSubscription(
      { tenantId: tenant.id, priceId: plans.monthPriceId },
      'month',
      trialEndsAt
    )
    await fake.fakeAdvance(subscriptionId, 'authenticated')
    await setBilling(tenant.id, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      trialEndsAt,
      currentPeriodEnd: trialEndsAt,
      providerSubscriptionId: subscriptionId,
      provider: 'fake',
      providerMode: 'test',
    })

    const response = await postAs(owner, `${tenant.slug}/billing/cancel`)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({
      state: 'trialing',
      plan: { key: 'paid' },
      trialEndsAt: trialEndsAt.toISOString(),
      cancelAtPeriodEnd: false,
      price: null,
    })
    expect(await subscriptionStatus(subscriptionId)).toBe('cancelled')
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'trialing',
      planId: plans.paidId,
      priceId: null,
      currentPeriodEnd: null,
      providerSubscriptionId: subscriptionId,
    })
    const [history] = await billingRepository.listHistory(tenant.id, 1)
    expect(history).toMatchObject({
      fromState: 'active',
      toState: 'trialing',
      cause: 'cancelled',
      source: 'owner',
    })

    await syncTenantBilling(tenant.id, 'webhook')
    expect(await readBilling(tenant.id)).toMatchObject({ state: 'trialing', priceId: null })
  })

  it('cancels a deferred start whose trial has ended to Free', async () => {
    const { tenant, owner } = await workspace()
    const startAt = new Date(Date.now() + 2 * DAY_MS)
    const subscriptionId = await fakeSubscription(
      { tenantId: tenant.id, priceId: plans.monthPriceId },
      'month',
      startAt
    )
    await fake.fakeAdvance(subscriptionId, 'authenticated')
    await setBilling(tenant.id, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      trialEndsAt: new Date(Date.now() - DAY_MS),
      currentPeriodEnd: startAt,
      providerSubscriptionId: subscriptionId,
      provider: 'fake',
      providerMode: 'test',
    })

    const response = await postAs(owner, `${tenant.slug}/billing/cancel`)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({ state: 'free', plan: { key: 'free' } })
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'free',
      planId: plans.freeId,
      priceId: null,
    })
    await syncTenantBilling(tenant.id, 'webhook')
    expect(await billingColumn(tenant.id, 'state')).toBe('free')
  })

  it('cancels a scheduled switch too, once it is authenticated', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)
    const switched = await postAs(owner, `${tenant.slug}/billing/interval`, { interval: 'year' })
    const nextId = String(dataOf(switched.body).subscriptionId)
    await fake.fakeAdvance(nextId, 'authenticated')
    await postAs(owner, `${tenant.slug}/billing/checkout/confirm`, confirmBody(nextId))

    const response = await postAs(owner, `${tenant.slug}/billing/cancel`)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({ cancelAtPeriodEnd: true, nextSwitch: null })
    expect(await readBilling(tenant.id)).toMatchObject({
      nextSubscriptionId: null,
      nextPriceId: null,
      cancelAtPeriodEnd: true,
    })
    expect(await subscriptionStatus(nextId)).toBe('cancelled')
  })
})

describe('GET /api/v1/tenants/:slug/billing/invoices', () => {
  it('lists the paid invoices for the owner', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)

    const response = await getAs(owner, `${tenant.slug}/billing/invoices`)

    expect(response.status).toBe(200)
    const page = dataOf(response.body) as { items: unknown[]; page: Record<string, unknown> }
    expect(page.items).toEqual([
      expect.objectContaining({ amountMinor: 99_900, currency: 'INR', status: 'paid' }),
    ])
    expect(page.page).toMatchObject({ nextCursor: null, hasNext: false, hasPrev: false })
  })

  it('hides the invoices from an admin with the role 403', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const admin = await addMember(tenant.id, 'admin')

    const response = await getAs(admin, `${tenant.slug}/billing/invoices`)

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ message: INVOICES_OWNER_ONLY_MESSAGE })
  })

  it('hides the invoices from staff with platform access with the same 403', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const { user } = await createTrackedStaff('owner')

    const response = await getAs(user, `${tenant.slug}/billing/invoices`)

    expect(response.status).toBe(403)
  })

  it('refuses an unsigned cursor with 400 CURSOR_INVALID', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)

    const response = await getAs(owner, `${tenant.slug}/billing/invoices?cursor=0:20`)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CURSOR_INVALID' })
  })
})

describe('POST /api/v1/tenants/:slug/billing/cancel when the provider moves or fails', () => {
  it('cancels at the cycle end when a deferred start was charged just before the cancel', async () => {
    const { tenant, owner } = await workspace()
    const trialEndsAt = new Date(Date.now() + 5 * DAY_MS)
    const subscriptionId = await fakeSubscription(
      { tenantId: tenant.id, priceId: plans.monthPriceId },
      'month',
      trialEndsAt
    )
    await fake.fakeAdvance(subscriptionId, 'authenticated')
    await setBilling(tenant.id, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      trialEndsAt,
      currentPeriodEnd: trialEndsAt,
      providerSubscriptionId: subscriptionId,
      provider: 'fake',
      providerMode: 'test',
    })
    const realFetch = fake.fetchSubscription.bind(fake)
    let fetches = 0

    let response: Awaited<ReturnType<typeof postAs>> | undefined
    await withMutatedMethod(
      fake,
      'fetchSubscription',
      async (id: string) => {
        const sub = await realFetch(id)
        fetches += 1
        // The first charge lands right after the first read.
        if (id === subscriptionId && fetches === 1) await fake.fakeAdvance(subscriptionId, 'active')
        return sub
      },
      async () => {
        response = await postAs(owner, `${tenant.slug}/billing/cancel`)
      }
    )

    expect(response?.status).toBe(200)
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      cancelAtPeriodEnd: true,
      priceId: plans.monthPriceId,
    })
    expect(await subscriptionStatus(subscriptionId)).toBe('active')
  })

  it('writes the current cancel and answers 503 when the scheduled switch cannot be cancelled; a retry clears it', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    const switched = await postAs(owner, `${tenant.slug}/billing/interval`, { interval: 'year' })
    const nextId = String(dataOf(switched.body).subscriptionId)
    const realCancel = fake.cancelSubscription.bind(fake)

    let response: Awaited<ReturnType<typeof postAs>> | undefined
    await withMutatedMethod(
      fake,
      'cancelSubscription',
      async (id: string, isAtCycleEnd: boolean) => {
        if (id === nextId) throw new ProviderError(`POST /subscriptions/${id}/cancel`, 503)
        return realCancel(id, isAtCycleEnd)
      },
      async () => {
        response = await postAs(owner, `${tenant.slug}/billing/cancel`)
      }
    )

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
    expect(await readBilling(tenant.id)).toMatchObject({
      providerSubscriptionId: subscriptionId,
      cancelAtPeriodEnd: true,
      nextSubscriptionId: nextId,
    })

    const retry = await postAs(owner, `${tenant.slug}/billing/cancel`)

    expect(retry.status).toBe(200)
    expect(await readBilling(tenant.id)).toMatchObject({
      cancelAtPeriodEnd: true,
      nextSubscriptionId: null,
      nextPriceId: null,
    })
    expect(await subscriptionStatus(nextId)).toBe('cancelled')
  })
})
