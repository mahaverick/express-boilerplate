/**
 * @file `POST /tenants/:slug/billing/checkout` and `…/checkout/confirm`, end
 * to end against the real database and the fake payment provider: who may
 * start a checkout, what the session carries, reuse of an unpaid checkout,
 * the refusals, a resubscribe while cancelling, a row left by another
 * provider mode, and a confirm that must match this workspace's own checkout.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { BILLING_OWNER_ONLY_MESSAGE } from '@/constants/billing.constants'
import type { User } from '@/database/models/user.model'
import { ProviderError } from '@/errors/billing-provider-errors'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
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
  paymentsSwitch,
  plans,
  readBilling,
  setBilling,
  subscriptionStatus,
  workspace,
} from '../../helpers/billing-api'
import { withMutatedMethod } from '../../helpers/mutate'
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
const billingRepository = new BillingRepository()
const membershipRepository = new UserMembershipRepository()
const planRepository = new PlanRepository()

const DAY_MS = 24 * 60 * 60 * 1000

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
  await closeRedis()
})

/**
 * POST a JSON body to a tenant path as `user`.
 * @param user - The caller.
 * @param path - The path after `/api/v1/tenants/`.
 * @param body - The JSON body.
 * @returns The response.
 */
function postAs(user: User, path: string, body: object) {
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
 * The fake's subscriptions for a workspace created in the last minute.
 * @param tenantId - The workspace.
 * @returns Each one's id and status.
 */
async function recentSubscriptionsOf(tenantId: string): Promise<{ id: string; status: string }[]> {
  const recent = await fake.listRecentSubscriptions(new Date(Date.now() - 60_000))
  return recent
    .filter((sub) => sub.notes.tenantId === tenantId)
    .map((sub) => ({ id: sub.id, status: sub.status }))
}

/**
 * The `data` of a success response.
 * @param body - The response body.
 * @returns Its data.
 */
function dataOf(body: unknown): Record<string, unknown> {
  return (body as { data: Record<string, unknown> }).data
}

describe('POST /api/v1/tenants/:slug/billing/checkout', () => {
  it('gives the owner a monthly checkout charged now, and stores it as pending', async () => {
    const { tenant, owner } = await workspace({ firstName: 'Ada' })

    const response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    expect(response.status).toBe(200)
    const session = dataOf(response.body)
    expect(session).toMatchObject({
      purpose: 'upgrade',
      keyId: 'rzp_test_FAKE',
      amountMinor: 99_900,
      currency: 'INR',
      interval: 'month',
      startsAt: null,
      prefill: { name: 'Ada', email: owner.email },
    })
    expect(session.subscriptionId).toMatch(/^sub_FAKE/)
    const row = await readBilling(tenant.id)
    expect(row).toMatchObject({
      state: 'free',
      pendingSubscriptionId: session.subscriptionId,
      checkoutStartedBy: owner.id,
      provider: 'fake',
      providerMode: 'test',
    })
    const sub = await fake.fetchSubscription(String(session.subscriptionId))
    expect(sub).toMatchObject({
      status: 'created',
      startAt: null,
      notes: { tenantId: tenant.id, priceId: plans.monthPriceId, appEnv: 'local' },
    })
    const [price] = await planRepository.findPricesByIds([plans.monthPriceId])
    expect(price).toMatchObject({
      provider: 'fake',
      providerMode: 'test',
      providerPlanId: sub.planId,
    })
    const audit = await sql<{ action: string; metadata: unknown }[]>`
      select action, metadata from audit_logs where tenant_id = ${tenant.id} and action like 'billing.%'`
    expect(audit).toEqual([{ action: 'billing.checkout_started', metadata: { interval: 'month' } }])
  })

  it('defers the first charge of a trialing workspace to its trial end', async () => {
    const { tenant, owner } = await workspace()
    const trialEndsAt = new Date(Date.now() + 10 * DAY_MS)
    await setBilling(tenant.id, { state: 'trialing', planId: plans.paidId, trialEndsAt })

    const response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'year' })

    expect(response.status).toBe(200)
    const session = dataOf(response.body)
    expect(session).toMatchObject({
      purpose: 'upgrade',
      amountMinor: 999_000,
      interval: 'year',
      startsAt: trialEndsAt.toISOString(),
    })
    const sub = await fake.fetchSubscription(String(session.subscriptionId))
    expect(sub.startAt?.getTime()).toBe(trialEndsAt.getTime())
  })

  it('refuses an editor with the role 403', async () => {
    const { tenant } = await workspace()
    const { owner: editor } = await workspace()
    await membershipRepository.create({ userId: editor.id, tenantId: tenant.id, role: 'editor' })

    const response = await postAs(editor, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ message: BILLING_OWNER_ONLY_MESSAGE })
    expect(await billingColumn(tenant.id, 'pendingSubscriptionId')).toBeNull()
  })

  it('refuses a staff platform owner, who acts through platform access, with the same 403', async () => {
    const { tenant } = await workspace()
    const { user } = await createTrackedStaff('owner')

    const response = await postAs(user, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ message: BILLING_OWNER_ONLY_MESSAGE })
    expect(await billingColumn(tenant.id, 'pendingSubscriptionId')).toBeNull()
  })

  it('answers the unknown-route 404 on every billing write and the invoices when payments are off', async () => {
    const { tenant, owner } = await workspace()
    paymentsSwitch.on = false

    for (const [path, body] of [
      ['billing/checkout', { interval: 'month' }],
      ['billing/checkout/confirm', confirmBody('sub_FAKEnone')],
      ['billing/interval', { interval: 'year' }],
      ['billing/payment-method', {}],
      ['billing/cancel', {}],
    ] as const) {
      const response = await postAs(owner, `${tenant.slug}/${path}`, body)
      expect(response.status, path).toBe(404)
      expect(response.body, path).toMatchObject({ code: 'not_found' })
    }
    const invoices = await request(app)
      .get(`/api/v1/tenants/${tenant.slug}/billing/invoices`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
    expect(invoices.status).toBe(404)
    expect(invoices.body).toMatchObject({ code: 'not_found' })
  })

  it('refuses an unknown interval with a field error', async () => {
    const { tenant, owner } = await workspace()

    const response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'week' })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { interval: expect.any(Array) as unknown } })
  })

  it('hands back the same unpaid checkout on a second start for the same interval', async () => {
    const { tenant, owner } = await workspace()
    const first = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    const second = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    expect(second.status).toBe(200)
    expect(dataOf(second.body).subscriptionId).toBe(dataOf(first.body).subscriptionId)
  })

  it('replaces an unpaid checkout for another interval, and cancels the old one', async () => {
    const { tenant, owner } = await workspace()
    const first = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    const second = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'year' })

    const firstId = String(dataOf(first.body).subscriptionId)
    const secondId = String(dataOf(second.body).subscriptionId)
    expect(secondId).not.toBe(firstId)
    expect(await billingColumn(tenant.id, 'pendingSubscriptionId')).toBe(secondId)
    expect(await subscriptionStatus(firstId)).toBe('cancelled')
  })

  it('replaces a stored checkout that expired, or that is about to', async () => {
    const { tenant, owner } = await workspace()
    const expired = await fakeSubscription({ tenantId: tenant.id, priceId: plans.monthPriceId })
    await fake.fakeAdvance(expired, 'expired')
    await setBilling(tenant.id, { pendingSubscriptionId: expired })

    const response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    const id = String(dataOf(response.body).subscriptionId)
    expect(id).not.toBe(expired)
    expect(await billingColumn(tenant.id, 'pendingSubscriptionId')).toBe(id)
  })

  it('never replaces a paid checkout whose event has not landed: it brings it in and refuses 409', async () => {
    const { tenant, owner } = await workspace()
    const first = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    const id = String(dataOf(first.body).subscriptionId)
    await fake.fakeAdvance(id, 'active')

    const second = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'year' })

    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ code: 'SUBSCRIPTION_EXISTS' })
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: id,
      pendingSubscriptionId: null,
    })
  })

  it('creates one checkout for two starts at once: both get the same subscription', async () => {
    const { tenant, owner } = await workspace()

    const [a, b] = await Promise.all([
      postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' }),
      postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' }),
    ])

    expect([a.status, b.status]).toEqual([200, 200])
    const id = dataOf(a.body).subscriptionId
    expect(dataOf(b.body).subscriptionId).toBe(id)
    expect(await billingColumn(tenant.id, 'pendingSubscriptionId')).toBe(id)
    const recent = await fake.listRecentSubscriptions(new Date(Date.now() - 60_000))
    const open = recent.filter(
      (sub) => sub.notes.tenantId === tenant.id && sub.status === 'created'
    )
    expect(open.map((sub) => sub.id)).toEqual([id])
  })

  it('refuses 409 SUBSCRIPTION_EXISTS while a paid subscription runs', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)

    const response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'year' })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'SUBSCRIPTION_EXISTS' })
    expect(await billingColumn(tenant.id, 'pendingSubscriptionId')).toBeNull()
  })

  it('refuses 409 SUBSCRIPTION_EXISTS while past due, so the owner changes the card instead', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await fake.fakeAdvance(subscriptionId, 'halted')
    await setBilling(tenant.id, {
      state: 'past_due',
      pastDueSince: new Date(),
      haltedAt: new Date(),
    })

    const response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'SUBSCRIPTION_EXISTS' })
  })

  it('resubscribes while cancelling: the new subscription starts at the period end and takes over', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId, periodEnd } = await makePaying(tenant.id)
    await fake.cancelSubscription(subscriptionId, true)
    await setBilling(tenant.id, { cancelAtPeriodEnd: true })

    const response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'year' })

    expect(response.status).toBe(200)
    const session = dataOf(response.body)
    expect(session).toMatchObject({
      purpose: 'upgrade',
      interval: 'year',
      startsAt: periodEnd.toISOString(),
    })
    const nextId = String(session.subscriptionId)
    expect(await readBilling(tenant.id)).toMatchObject({
      providerSubscriptionId: subscriptionId,
      pendingSubscriptionId: null,
      nextSubscriptionId: nextId,
      nextPriceId: plans.yearPriceId,
    })
    const beforeAuth = await getAs(owner, `${tenant.slug}/billing`)
    expect(dataOf(beforeAuth.body)).toMatchObject({ cancelAtPeriodEnd: true, nextSwitch: null })

    await fake.fakeAdvance(nextId, 'authenticated')
    const confirmed = await postAs(
      owner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody(nextId)
    )

    expect(confirmed.status).toBe(200)
    expect(dataOf(confirmed.body)).toMatchObject({
      state: 'active',
      cancelAtPeriodEnd: true,
      nextSwitch: { interval: 'year', startsAt: periodEnd.toISOString() },
    })
    expect(await readBilling(tenant.id)).toMatchObject({
      providerSubscriptionId: subscriptionId,
      nextSubscriptionId: nextId,
    })
    expect(await subscriptionStatus(subscriptionId)).toBe('active')

    await fake.fakeAdvance(subscriptionId, 'cancelled')
    await syncTenantBilling(tenant.id, 'webhook', { now: new Date(periodEnd.getTime() + 1000) })

    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: nextId,
      nextSubscriptionId: null,
      priceId: plans.yearPriceId,
      cancelAtPeriodEnd: false,
    })
  })

  it('refuses a second resubscribe once the first is authenticated', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await fake.cancelSubscription(subscriptionId, true)
    await setBilling(tenant.id, { cancelAtPeriodEnd: true })
    const first = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    await fake.fakeAdvance(String(dataOf(first.body).subscriptionId), 'authenticated')

    const second = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'year' })

    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ code: 'SUBSCRIPTION_EXISTS' })
  })

  it('takes over a Free row left by another provider mode, and the confirm makes it active', async () => {
    const { tenant, owner } = await workspace()
    await setBilling(tenant.id, {
      provider: 'razorpay',
      providerMode: 'live',
      providerSubscriptionId: `sub_STALE${tenant.id.slice(0, 8)}`,
      nextSubscriptionId: `sub_STALENEXT${tenant.id.slice(0, 8)}`,
      nextPriceId: plans.yearPriceId,
    })

    const response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    expect(response.status).toBe(200)
    const id = String(dataOf(response.body).subscriptionId)
    expect(await readBilling(tenant.id)).toMatchObject({
      provider: 'fake',
      providerMode: 'test',
      providerSubscriptionId: null,
      nextSubscriptionId: null,
      nextPriceId: null,
      pendingSubscriptionId: id,
    })

    await fake.fakeAdvance(id, 'active')
    const confirmed = await postAs(
      owner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody(id)
    )

    expect(confirmed.status).toBe(200)
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: id,
    })
  })

  it('refuses a live row of another provider mode with 409, leaving it for staff', async () => {
    const { tenant, owner } = await workspace()
    await setBilling(tenant.id, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
      provider: 'razorpay',
      providerMode: 'live',
      providerSubscriptionId: `sub_LIVE${tenant.id.slice(0, 8)}`,
    })

    const response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'SUBSCRIPTION_EXISTS' })
    expect(await readBilling(tenant.id)).toMatchObject({
      provider: 'razorpay',
      pendingSubscriptionId: null,
    })
  })
})

describe('POST /api/v1/tenants/:slug/billing/checkout/confirm', () => {
  it('makes a paid checkout active and records the owner as payer', async () => {
    const { tenant, owner } = await workspace({ firstName: 'Ada' })
    const started = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    const id = String(dataOf(started.body).subscriptionId)
    await fake.fakeAdvance(id, 'active')

    const response = await postAs(owner, `${tenant.slug}/billing/checkout/confirm`, confirmBody(id))

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({
      state: 'active',
      plan: { key: 'paid' },
      interval: 'month',
      price: { id: plans.monthPriceId, interval: 'month', amountMinor: 99_900, currency: 'INR' },
      payer: { userId: owner.id, name: 'Ada', isMember: true },
      billingEmail: owner.email,
      paymentsEnabled: true,
    })
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: id,
      pendingSubscriptionId: null,
      payerUserId: owner.id,
      billingEmail: owner.email,
    })
    const history = await billingRepository.listHistory(tenant.id, 5)
    expect(history.map((entry) => entry.source)).toEqual(['confirm'])
  })

  it('refuses a bad signature with 400 CHECKOUT_MISMATCH and changes nothing', async () => {
    const { tenant, owner } = await workspace()
    const started = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    const id = String(dataOf(started.body).subscriptionId)
    await fake.fakeAdvance(id, 'active')
    const before = await readBilling(tenant.id)

    const response = await postAs(owner, `${tenant.slug}/billing/checkout/confirm`, {
      ...confirmBody(id),
      razorpay_signature: 'f'.repeat(64),
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CHECKOUT_MISMATCH' })
    expect(await readBilling(tenant.id)).toStrictEqual(before)
  })

  it("refuses tenant B's checkout posted to tenant A with 400 CHECKOUT_MISMATCH; A is unchanged", async () => {
    const a = await workspace()
    const b = await workspace()
    await membershipRepository.create({ userId: a.owner.id, tenantId: b.tenant.id, role: 'owner' })
    await postAs(a.owner, `${a.tenant.slug}/billing/checkout`, { interval: 'month' })
    const startedB = await postAs(a.owner, `${b.tenant.slug}/billing/checkout`, {
      interval: 'month',
    })
    const idB = String(dataOf(startedB.body).subscriptionId)
    await fake.fakeAdvance(idB, 'active')
    const beforeA = await readBilling(a.tenant.id)

    const response = await postAs(
      a.owner,
      `${a.tenant.slug}/billing/checkout/confirm`,
      confirmBody(idB)
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CHECKOUT_MISMATCH' })
    expect(await readBilling(a.tenant.id)).toStrictEqual(beforeA)
  })

  it("refuses a stored id whose subscription's notes name another workspace, even with a valid signature", async () => {
    const a = await workspace()
    const b = await workspace()
    const idB = await fakeSubscription({ tenantId: b.tenant.id, priceId: plans.monthPriceId })
    await fake.fakeAdvance(idB, 'active')
    await setBilling(a.tenant.id, { pendingSubscriptionId: idB })
    const beforeA = await readBilling(a.tenant.id)

    const response = await postAs(
      a.owner,
      `${a.tenant.slug}/billing/checkout/confirm`,
      confirmBody(idB)
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CHECKOUT_MISMATCH' })
    expect(await readBilling(a.tenant.id)).toStrictEqual(beforeA)
  })

  it('refuses a signature made for another subscription than the posted one', async () => {
    const { tenant, owner } = await workspace()
    const started = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    const id = String(dataOf(started.body).subscriptionId)

    const response = await postAs(
      owner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody(id, 'sub_FAKEother')
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CHECKOUT_MISMATCH' })
  })

  it('tells the owner a checkout that was replaced to open Billing, with 400 CHECKOUT_MISMATCH', async () => {
    const { tenant, owner } = await workspace()
    const first = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    const replacedId = String(dataOf(first.body).subscriptionId)
    const second = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'year' })
    expect(String(dataOf(second.body).subscriptionId)).not.toBe(replacedId)

    const response = await postAs(
      owner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody(replacedId)
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      code: 'CHECKOUT_MISMATCH',
      message: 'This checkout was replaced. Open Billing to see the current one.',
    })
  })

  it('refuses a confirm when the workspace has no checkout', async () => {
    const { tenant, owner } = await workspace()

    const response = await postAs(
      owner,
      `${tenant.slug}/billing/checkout/confirm`,
      confirmBody('sub_FAKEnothing')
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'CHECKOUT_MISMATCH' })
  })

  it('refuses an admin with the role 403', async () => {
    const { tenant, owner } = await workspace()
    const { owner: admin } = await workspace()
    await membershipRepository.create({ userId: admin.id, tenantId: tenant.id, role: 'admin' })
    const started = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    const id = String(dataOf(started.body).subscriptionId)

    const response = await postAs(admin, `${tenant.slug}/billing/checkout/confirm`, confirmBody(id))

    expect(response.status).toBe(403)
  })
})

const realUpdate = BillingRepository.prototype.updateVersioned

/**
 * `updateVersioned` as if another writer always got there first: the real
 * update with a version no row holds, so it changes nothing.
 * @param callArguments - The real call's arguments.
 * @returns Undefined, as for a stale version.
 */
function staleUpdate(
  this: BillingRepository,
  ...callArguments: Parameters<typeof realUpdate>
): ReturnType<typeof realUpdate> {
  const [tenantId, , patch, tx] = callArguments
  return realUpdate.call(this, tenantId, -1, patch, tx)
}

describe('owner billing writes when something fails', () => {
  it('answers 503 BILLING_BUSY with Retry-After when the row keeps moving, and cancels the checkout it made', async () => {
    const { tenant, owner } = await workspace()

    let response: Awaited<ReturnType<typeof postAs>> | undefined
    await withMutatedMethod(
      BillingRepository.prototype,
      'updateVersioned',
      staleUpdate,
      async () => {
        response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
      }
    )

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: 'BILLING_BUSY' })
    expect(response?.headers['retry-after']).toBe('30')
    expect(await billingColumn(tenant.id, 'pendingSubscriptionId')).toBeNull()
    const subs = await recentSubscriptionsOf(tenant.id)
    expect(subs.length).toBeGreaterThan(0)
    expect(subs.every((sub) => sub.status === 'cancelled')).toBe(true)
  })

  it('answers 503 PAYMENT_PROVIDER_UNAVAILABLE with Retry-After 30 when the provider may answer later', async () => {
    const { tenant, owner } = await workspace()

    let response: Awaited<ReturnType<typeof postAs>> | undefined
    await withMutatedMethod(
      fake,
      'createSubscription',
      () => Promise.reject(new ProviderError('POST /subscriptions', 503)),
      async () => {
        response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
      }
    )

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
    expect(response?.headers['retry-after']).toBe('30')
    expect(await billingColumn(tenant.id, 'pendingSubscriptionId')).toBeNull()
  })

  it('answers 502 PAYMENT_PROVIDER_UNAVAILABLE with no Retry-After when the provider refuses the call', async () => {
    const { tenant, owner } = await workspace()

    let response: Awaited<ReturnType<typeof postAs>> | undefined
    await withMutatedMethod(
      fake,
      'createSubscription',
      () =>
        Promise.reject(
          new ProviderError('POST /subscriptions', 400, { code: 'BAD_REQUEST_ERROR' })
        ),
      async () => {
        response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
      }
    )

    expect(response?.status).toBe(502)
    expect(response?.body).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
    expect(response?.headers['retry-after']).toBeUndefined()
  })

  it('retries the confirm sync once when the row moved under both of its passes', async () => {
    const { tenant, owner } = await workspace()
    const started = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    const id = String(dataOf(started.body).subscriptionId)
    await fake.fakeAdvance(id, 'active')
    let calls = 0

    let response: Awaited<ReturnType<typeof postAs>> | undefined
    await withMutatedMethod(
      BillingRepository.prototype,
      'updateVersioned',
      async function (this: BillingRepository, ...callArguments: Parameters<typeof realUpdate>) {
        calls += 1
        // The sync's two passes both lose; the confirm's retry runs a fresh sync.
        if (calls <= 2) return staleUpdate.apply(this, callArguments)
        return realUpdate.apply(this, callArguments)
      },
      async () => {
        response = await postAs(owner, `${tenant.slug}/billing/checkout/confirm`, confirmBody(id))
      }
    )

    expect(calls).toBeGreaterThan(2)
    expect(response?.status).toBe(200)
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: id,
    })
  })

  it('answers 503 BILLING_BUSY when the confirm sync keeps losing', async () => {
    const { tenant, owner } = await workspace()
    const started = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    const id = String(dataOf(started.body).subscriptionId)
    await fake.fakeAdvance(id, 'active')

    let response: Awaited<ReturnType<typeof postAs>> | undefined
    await withMutatedMethod(
      BillingRepository.prototype,
      'updateVersioned',
      staleUpdate,
      async () => {
        response = await postAs(owner, `${tenant.slug}/billing/checkout/confirm`, confirmBody(id))
      }
    )

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: 'BILLING_BUSY' })
    expect(response?.headers['retry-after']).toBe('30')
    expect(await billingColumn(tenant.id, 'state')).toBe('free')
  })

  it('brings in a replaced checkout that was paid meanwhile instead of cancelling it', async () => {
    const { tenant, owner } = await workspace()
    const first = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
    const firstId = String(dataOf(first.body).subscriptionId)
    const realCreate = fake.createSubscription.bind(fake)

    let second: Awaited<ReturnType<typeof postAs>> | undefined
    await withMutatedMethod(
      fake,
      'createSubscription',
      async (input) => {
        // The first checkout is paid between the read that found it unpaid and its replacement.
        await fake.fakeAdvance(firstId, 'active')
        return realCreate(input)
      },
      async () => {
        second = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'year' })
      }
    )

    expect(second?.status).toBe(200)
    expect(await subscriptionStatus(firstId)).toBe('active')
    expect(await readBilling(tenant.id)).toMatchObject({
      state: 'active',
      providerSubscriptionId: firstId,
    })
  })

  it('cancels the checkout a pass made when the next pass needs another first charge', async () => {
    const { tenant, owner } = await workspace()
    const trialEndsAt = new Date(Date.now() + 10 * DAY_MS)
    const realCreate = fake.createSubscription.bind(fake)
    let creates = 0

    let response: Awaited<ReturnType<typeof postAs>> | undefined
    await withMutatedMethod(
      fake,
      'createSubscription',
      async (input) => {
        creates += 1
        const sub = await realCreate(input)
        // After the first pass creates its checkout, a trial starts: the next pass defers the charge.
        if (creates === 1) {
          await setBilling(tenant.id, { state: 'trialing', planId: plans.paidId, trialEndsAt })
        }
        return sub
      },
      async () => {
        response = await postAs(owner, `${tenant.slug}/billing/checkout`, { interval: 'month' })
      }
    )

    expect(response?.status).toBe(200)
    const chosen = String(dataOf(response?.body).subscriptionId)
    expect(dataOf(response?.body).startsAt).toBe(trialEndsAt.toISOString())
    const subs = await recentSubscriptionsOf(tenant.id)
    expect(subs).toHaveLength(2)
    expect(subs.filter((sub) => sub.id !== chosen).map((sub) => sub.status)).toEqual(['cancelled'])
  })
})
