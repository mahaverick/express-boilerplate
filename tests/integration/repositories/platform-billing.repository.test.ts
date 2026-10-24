/**
 * @file PlatformBillingRepository against the real per-worker database.
 * Counts are asserted as deltas, since other files share this worker's
 * database. Tenants and alerts the tests add are deleted in `afterEach`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { PlatformBillingRepository } from '@/repositories/platform-billing.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql, withTransaction } from '@/services/database.service'
import { listParamsSchema } from '@/validators/list.validators'

const alertListSchema = listParamsSchema({
  sorts: ['-at', 'at'],
  defaultSort: '-at',
  filters: {},
})

/**
 * The shared list params the controller would parse from `query`.
 */
function paramsOf(query: Record<string, string>) {
  return alertListSchema.parse(query).params
}

const repository = new PlatformBillingRepository()
const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()

describe('PlatformBillingRepository', () => {
  const tenantIds: string[] = []
  const alertIds: string[] = []

  afterEach(async () => {
    if (alertIds.length > 0) await sql`delete from billing_alerts where id = any(${alertIds})`
    if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
    tenantIds.length = 0
    alertIds.length = 0
  })

  /**
   * Creates a tenant with a billing record in `state` on `planKey`.
   */
  async function billedTenant(
    planKey: 'free' | 'paid',
    state: 'free' | 'trialing' | 'active' | 'past_due',
    priceId?: string
  ): Promise<string> {
    const suffix = randomUUID().slice(0, 8)
    const tenant = await tenantRepository.createWithoutOwner({
      name: `Platform billing ${suffix}`,
      slug: `pb-${suffix}`,
    })
    tenantIds.push(tenant.id)
    const plan = await planRepository.findPlanByKey(planKey)
    if (plan === undefined) throw new Error('setup: the migration seeds the plans')
    await withTransaction((tx) =>
      billingRepository.insertForTenant(
        { tenantId: tenant.id, state, planId: plan.id, ...(priceId && { priceId }) },
        tx
      )
    )
    return tenant.id
  }

  it('counts workspaces by plan and state with every cell present', async () => {
    const before = await repository.countTenantsByPlanAndState()
    await billedTenant('free', 'free')
    await billedTenant('paid', 'active')
    const after = await repository.countTenantsByPlanAndState()
    expect(after.free.free).toBe(before.free.free + 1)
    expect(after.paid.active).toBe(before.paid.active + 1)
    expect(after.paid.trialing).toBe(before.paid.trialing)
    expect(Object.keys(after.free).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'active',
      'free',
      'past_due',
      'trialing',
    ])
  })

  it('counts paying subscribers by price', async () => {
    const paid = await planRepository.findPlanByKey('paid')
    const price = await planRepository.activePrice(paid?.id ?? '', 'INR', 'month')
    if (price === undefined) throw new Error('setup: the migration seeds the prices')
    const countsBefore = await repository.countSubscribersByPrice()
    const before = countsBefore[price.id] ?? 0
    await billedTenant('paid', 'active', price.id)
    await billedTenant('paid', 'past_due', price.id)
    await billedTenant('paid', 'trialing', price.id)
    const countsAfter = await repository.countSubscribersByPrice()
    expect(countsAfter[price.id]).toBe(before + 2)
  })

  it('returns billing columns for the ids asked for', async () => {
    const free = await billedTenant('free', 'free')
    const paid = await billedTenant('paid', 'active')
    const rows = await repository.billingColumnsForTenants([free, paid, randomUUID()])
    const byTenant = new Map(rows.map((row) => [row.tenantId, [row.planKey, row.state]]))
    expect(rows).toHaveLength(2)
    expect(byTenant.get(free)).toEqual(['free', 'free'])
    expect(byTenant.get(paid)).toEqual(['paid', 'active'])
    expect(await repository.billingColumnsForTenants([])).toEqual([])
  })

  it('pages alerts newest first and joins the workspace', async () => {
    const tenantId = await billedTenant('free', 'free')
    const first = await billingRepository.insertAlert({
      kind: 'dispute',
      tenantId,
      message: `probe-${tenantId} first`,
    })
    const second = await billingRepository.insertAlert({
      kind: 'webhook_failing',
      message: `probe-${tenantId} second`,
    })
    alertIds.push(first.id, second.id)
    const page = await repository.listAlerts(paramsOf({ search: `probe-${tenantId}` }))
    expect(page.items.map((item) => item.alert.id)).toEqual([second.id, first.id])
    expect(page.items[0]?.tenant).toBeNull()
    expect(page.items[1]?.tenant?.id).toBe(tenantId)
  })
})
