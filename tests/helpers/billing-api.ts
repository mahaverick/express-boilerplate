/**
 * @file Shared setup for the owner billing route tests: a handle on the fake
 * payment provider (its state lives in Redis, shared with the app), the
 * seeded Paid prices, workspaces in each billing state, and direct reads and
 * writes of a workspace's billing row. A file using it mocks
 * `@/services/billing/billing-provider.service` with `fakeProviderModule`, so
 * the app talks to the fake and a test can switch payments off.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { billingProviderConfig } from '@/configs/billing.config'
import {
  tenantBillingModel,
  type NewTenantBilling,
  type TenantBillingRecord,
} from '@/database/models/billing.model'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { FakeBillingProvider } from '@/services/billing/fake-billing-provider.service'
import { db, sql } from '@/services/database.service'
import type { BillingProviderClient } from '@/types/billing'
import { createTrackedUser } from './platform-users'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()

/**
 * Whether the app's payment provider is on; a test sets it false to see the
 * payments-off answers, and resets it after.
 */
export const paymentsSwitch = { on: true }

/**
 * The fake provider's config, as `BILLING_FAKE_PROVIDER` builds it.
 */
const fakeConfig = billingProviderConfig({
  BILLING_FAKE_PROVIDER: true,
  BILLING_GST_REGISTERED: false,
  RAZORPAY_KEY_ID: undefined,
  RAZORPAY_KEY_SECRET: undefined,
  RAZORPAY_WEBHOOK_SECRET: undefined,
  RAZORPAY_WEBHOOK_SECRET_PREVIOUS: undefined,
})
if (fakeConfig === null) throw new Error('setup: the fake config is missing')

/**
 * The test's own handle on the fake, sharing the app's Redis state.
 */
export const fake = new FakeBillingProvider(fakeConfig)

/**
 * The module the test files mock `billing-provider.service` with: the fake
 * while `paymentsSwitch.on`, else none.
 * @returns The mocked module.
 */
export function fakeProviderModule(): {
  getBillingProvider: () => BillingProviderClient | null
} {
  return { getBillingProvider: () => (paymentsSwitch.on ? fake : null) }
}

/**
 * The seeded plans and prices, filled by `loadPlans`.
 */
export const plans = { freeId: '', paidId: '', monthPriceId: '', yearPriceId: '' }

/**
 * Read the seeded plans and prices, and forget any provider plan stored on
 * the prices, whose fake plan may be gone with an earlier file's Redis state.
 * @throws {Error} When the billing migration's seed is missing.
 */
export async function loadPlans(): Promise<void> {
  const free = await planRepository.findPlanByKey('free')
  const paid = await planRepository.findPlanByKey('paid')
  if (!free || !paid) throw new Error('setup: the billing migration seeds both plans')
  const month = await planRepository.activePrice(paid.id, 'INR', 'month')
  const year = await planRepository.activePrice(paid.id, 'INR', 'year')
  if (!month || !year) throw new Error('setup: the billing migration seeds both prices')
  Object.assign(plans, {
    freeId: free.id,
    paidId: paid.id,
    monthPriceId: month.id,
    yearPriceId: year.id,
  })
  await forgetProviderPlans()
}

/**
 * Clear the provider plan ids stored on the seeded Paid prices.
 */
export async function forgetProviderPlans(): Promise<void> {
  await sql`update plan_prices set provider = null, provider_mode = null, provider_plan_id = null where plan_id = ${plans.paidId}`
}

const tenantIds: string[] = []

/**
 * Delete the workspaces this file created, with their alerts.
 */
export async function deleteTrackedTenants(): Promise<void> {
  if (tenantIds.length === 0) return
  await sql`delete from billing_alerts where tenant_id = any(${tenantIds})`
  await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
}

/**
 * A Free workspace and its owner.
 * @param ownerOptions - The owner's name.
 * @param ownerOptions.firstName - The owner's first name.
 * @returns The workspace and the owner.
 */
export async function workspace(
  ownerOptions: { firstName?: string } = {}
): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser(ownerOptions)
  const tenant = await tenantRepository.create({
    name: 'Billing Co',
    slug: `bill-own-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  return { tenant, owner }
}

/**
 * Set a workspace's billing columns directly, as earlier writes would have.
 * @param tenantId - The workspace.
 * @param patch - The columns.
 */
export async function setBilling(
  tenantId: string,
  patch: Partial<NewTenantBilling>
): Promise<void> {
  await db.update(tenantBillingModel).set(patch).where(eq(tenantBillingModel.tenantId, tenantId))
}

/**
 * A workspace's billing row.
 * @param tenantId - The workspace.
 * @returns The row.
 * @throws {Error} When it has none.
 */
export async function readBilling(tenantId: string): Promise<TenantBillingRecord> {
  const row = await billingRepository.findByTenantId(tenantId)
  if (!row) throw new Error('setup: the workspace has no billing row')
  return row
}

/**
 * One column of a workspace's billing row.
 * @param tenantId - The workspace.
 * @param key - The column.
 * @returns Its value.
 */
export async function billingColumn<K extends keyof TenantBillingRecord>(
  tenantId: string,
  key: K
): Promise<TenantBillingRecord[K]> {
  const row = await readBilling(tenantId)
  return row[key]
}

/**
 * A subscription's status on the fake.
 * @param subscriptionId - The subscription.
 * @returns Its status.
 */
export async function subscriptionStatus(subscriptionId: string): Promise<string> {
  const sub = await fake.fetchSubscription(subscriptionId)
  return sub.status
}

/**
 * Create a subscription on the fake, as a checkout would.
 * @param notes - The workspace and price the notes name.
 * @param notes.tenantId - The workspace.
 * @param notes.priceId - The price.
 * @param interval - Which seeded price's plan it bills.
 * @param startAt - The deferred first charge, or null.
 * @returns Its id.
 */
export async function fakeSubscription(
  notes: { tenantId: string; priceId: string },
  interval: 'month' | 'year' = 'month',
  startAt: Date | null = null
): Promise<string> {
  const price = await planRepository.activePrice(plans.paidId, 'INR', interval)
  if (!price) throw new Error('setup: missing price')
  const providerPlanId = await fake.ensurePlan({ ...price, providerPlanId: null }, 'Paid')
  const created = await fake.createSubscription({
    providerPlanId,
    totalCount: 60,
    expireBy: new Date(Date.now() + 60 * 60 * 1000),
    startAt,
    notes,
  })
  return created.id
}

/**
 * Put a workspace on a paid, active monthly subscription on the fake.
 * @param tenantId - The workspace.
 * @returns The subscription id and its paid period end.
 */
export async function makePaying(
  tenantId: string
): Promise<{ subscriptionId: string; periodEnd: Date }> {
  const subscriptionId = await fakeSubscription({ tenantId, priceId: plans.monthPriceId })
  const active = await fake.fakeAdvance(subscriptionId, 'active')
  if (active.currentEnd === null) throw new Error('setup: the fake set no period end')
  await setBilling(tenantId, {
    state: 'active',
    planId: plans.paidId,
    priceId: plans.monthPriceId,
    providerSubscriptionId: subscriptionId,
    currentPeriodEnd: active.currentEnd,
    provider: 'fake',
    providerMode: 'test',
  })
  return { subscriptionId, periodEnd: active.currentEnd }
}

/**
 * The body the browser posts after a checkout on the fake.
 * @param subscriptionId - The subscription the checkout was for.
 * @param signedFor - The subscription the signature covers; defaults to the same.
 * @returns The confirm body.
 */
export function confirmBody(
  subscriptionId: string,
  signedFor = subscriptionId
): {
  razorpay_payment_id: string
  razorpay_subscription_id: string
  razorpay_signature: string
} {
  const paymentId = `pay_FAKE${randomUUID().replaceAll('-', '').slice(0, 14)}`
  return {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: fake.fakeSignCheckout(paymentId, signedFor),
  }
}
