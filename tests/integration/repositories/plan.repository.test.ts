/**
 * @file PlanRepository against the real per-worker database. Plans and
 * settings are seeded rows, so each test that changes one restores it. Prices
 * and grants the tests add are deleted in `afterEach`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { HttpError } from '@/errors/http-error'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql, withTransaction } from '@/services/database.service'
import { backendPid, deferred, waitForWaiter } from '../../helpers/lock-probe'

const repository = new PlanRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

/**
 * The Paid plan, which the migration seeds.
 */
async function paidPlan() {
  const plan = await repository.findPlanByKey('paid')
  if (plan === undefined) throw new Error('setup: the migration seeds the Paid plan')
  return plan
}

describe('PlanRepository', () => {
  const priceIds: string[] = []
  const tenantIds: string[] = []
  const restoreIds: string[] = []
  const userIds: string[] = []

  afterEach(async () => {
    if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
    if (priceIds.length > 0) await sql`delete from plan_prices where id = any(${priceIds})`
    if (restoreIds.length > 0) {
      await sql`update plan_prices set active = true, retired_at = null where id = any(${restoreIds})`
    }
    if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
    restoreIds.length = 0
    userIds.length = 0
    tenantIds.length = 0
    priceIds.length = 0
  })

  /**
   * Creates a tenant, tracked for cleanup.
   */
  async function createTenant(): Promise<string> {
    const suffix = randomUUID().slice(0, 8)
    const tenant = await tenantRepository.createWithoutOwner({
      name: `Plan ${suffix}`,
      slug: `plan-${suffix}`,
    })
    tenantIds.push(tenant.id)
    return tenant.id
  }

  it('lists the seeded plans in order and finds them by id and key', async () => {
    const plans = await repository.listPlans()
    expect(plans.map((plan) => plan.key)).toEqual(['free', 'paid'])
    const free = await repository.findPlanByKey('free')
    const byId = await repository.findPlan(free?.id ?? '')
    expect(byId?.key).toBe('free')
    expect(await repository.findPlan(randomUUID())).toBeUndefined()
  })

  it('updates a plan by version and refuses a stale version', async () => {
    const paid = await paidPlan()
    const updated = await withTransaction((tx) =>
      repository.updatePlanVersioned(paid.id, paid.version, { description: 'Probe' }, tx)
    )
    expect(updated?.version).toBe(paid.version + 1)
    const stale = await withTransaction((tx) =>
      repository.updatePlanVersioned(paid.id, paid.version, { description: 'Stale' }, tx)
    )
    expect(stale).toBeUndefined()
    await withTransaction((tx) =>
      repository.updatePlanVersioned(
        paid.id,
        paid.version + 1,
        { description: paid.description },
        tx
      )
    )
  })

  it('finds the seeded active prices', async () => {
    const paid = await paidPlan()
    const monthly = await repository.activePrice(paid.id, 'INR', 'month')
    expect(monthly?.amountMinor).toBe(99_900)
    const yearly = await repository.activePrice(paid.id, 'INR', 'year')
    expect(yearly?.amountMinor).toBe(999_000)
    expect(await repository.listPrices(paid.id)).toHaveLength(2)
  })

  it('leaves exactly one active price and stamps retired_at on the old one', async () => {
    const paid = await paidPlan()
    const before = await repository.activePrice(paid.id, 'INR', 'month')
    const created = await withTransaction((tx) =>
      repository.insertPriceRetiringActive(
        { planId: paid.id, currency: 'INR', interval: 'month', amountMinor: 149_900 },
        tx
      )
    )
    priceIds.push(created.id)
    if (before) restoreIds.push(before.id)
    const prices = await repository.listPrices(paid.id)
    const monthly = prices.filter((price) => price.interval === 'month')
    expect(monthly.filter((price) => price.active).map((price) => price.id)).toEqual([created.id])
    const retired = monthly.find((price) => price.id === before?.id)
    expect(retired?.active).toBe(false)
    expect(retired?.retiredAt).toBeInstanceOf(Date)
  })

  it('answers 409 to the loser of two concurrent price changes and keeps one active price', async () => {
    const paid = await paidPlan()
    const before = await repository.activePrice(paid.id, 'INR', 'month')
    if (before) restoreIds.push(before.id)
    const gate = deferred()
    const holderPid = deferred<number>()
    const winner = withTransaction(async (tx) => {
      const created = await repository.insertPriceRetiringActive(
        { planId: paid.id, currency: 'INR', interval: 'month', amountMinor: 159_900 },
        tx
      )
      priceIds.push(created.id)
      holderPid.resolve(await backendPid(tx))
      await gate.promise
      return created
    })
    const pid = await holderPid.promise
    const loser = (async (): Promise<unknown> => {
      try {
        await withTransaction((tx) =>
          repository.insertPriceRetiringActive(
            { planId: paid.id, currency: 'INR', interval: 'month', amountMinor: 169_900 },
            tx
          )
        )
        return undefined
      } catch (error) {
        return error
      }
    })()
    await waitForWaiter(pid, loser)
    gate.resolve()
    const created = await winner
    const error = await loser
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(409)
    const prices = await repository.listPrices(paid.id)
    const active = prices.filter((price) => price.interval === 'month' && price.active)
    expect(active.map((price) => price.id)).toEqual([created.id])
    expect(prices.some((price) => price.amountMinor === 169_900)).toBe(false)
  })

  it('stores and locks a provider plan id', async () => {
    const paid = await paidPlan()
    const before = await repository.activePrice(paid.id, 'INR', 'year')
    if (before) restoreIds.push(before.id)
    const created = await withTransaction((tx) =>
      repository.insertPriceRetiringActive(
        { planId: paid.id, currency: 'INR', interval: 'year', amountMinor: 1_199_000 },
        tx
      )
    )
    priceIds.push(created.id)
    const providerPlanId = `plan_${randomUUID().slice(0, 8)}`
    const updated = await withTransaction(async (tx) => {
      const locked = await repository.lockPrice(created.id, tx)
      expect(locked?.id).toBe(created.id)
      return repository.setProviderPlanId(created.id, 'razorpay', 'test', providerPlanId, tx)
    })
    expect(updated?.providerPlanId).toBe(providerPlanId)
    expect(updated?.providerMode).toBe('test')
  })

  it('reads and versions the settings row', async () => {
    const before = await repository.getSettings()
    const updated = await withTransaction((tx) =>
      repository.updateSettingsVersioned(before.version, { trialDays: before.trialDays + 1 }, tx)
    )
    expect(updated?.trialDays).toBe(before.trialDays + 1)
    const stale = await withTransaction((tx) =>
      repository.updateSettingsVersioned(before.version, { trialDays: before.trialDays }, tx)
    )
    expect(stale).toBeUndefined()
    await withTransaction((tx) =>
      repository.updateSettingsVersioned(before.version + 1, { trialDays: before.trialDays }, tx)
    )
  })

  it('lists live grants, revokes one, and expires only grants past expires_at', async () => {
    const tenantId = await createTenant()
    const day = 86_400_000
    const { open, past, future } = await withTransaction(async (tx) => ({
      open: await repository.insertGrant(
        { tenantId, key: 'members', value: 10, reason: 'Pilot' },
        tx
      ),
      past: await repository.insertGrant(
        {
          tenantId,
          key: 'members',
          value: 8,
          reason: 'Pilot',
          expiresAt: new Date(Date.now() - day),
        },
        tx
      ),
      future: await repository.insertGrant(
        {
          tenantId,
          key: 'members',
          value: 9,
          reason: 'Pilot',
          expiresAt: new Date(Date.now() + day),
        },
        tx
      ),
    }))
    const live = await repository.listActiveGrants(tenantId)
    expect(live.map((grant) => grant.id).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [open.id, future.id].toSorted((a, b) => a.localeCompare(b))
    )
    expect(await repository.listGrants(tenantId)).toHaveLength(3)

    const expired = await withTransaction((tx) => repository.expireDueGrants(new Date(), tx))
    const mine = expired.filter((grant) => grant.tenantId === tenantId)
    expect(mine.map((grant) => grant.id)).toEqual([past.id])
    const again = await withTransaction((tx) => repository.expireDueGrants(new Date(), tx))
    expect(again.filter((grant) => grant.tenantId === tenantId)).toEqual([])

    const staff = await userRepository.create({
      email: `plan-repo-${randomUUID()}@example.test`,
    })
    userIds.push(staff.id)
    const revoked = await withTransaction((tx) =>
      repository.revokeGrant(tenantId, open.id, staff.id, tx)
    )
    expect(revoked?.revokedBy).toBe(staff.id)
    expect(revoked?.revokedAt).toBeInstanceOf(Date)
    expect(
      await withTransaction((tx) => repository.revokeGrant(tenantId, open.id, staff.id, tx))
    ).toBeUndefined()
    const remaining = await repository.listActiveGrants(tenantId)
    expect(remaining.map((grant) => grant.id)).toEqual([future.id])
  })
})
