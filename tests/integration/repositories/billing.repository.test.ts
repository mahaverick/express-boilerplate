/**
 * @file BillingRepository against the real per-worker database. Every tenant
 * and user a test creates is deleted in `afterEach`; the billing tables
 * cascade from both.
 */
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql as drizzleSql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { tenantBillingModel } from '@/database/models/billing.model'
import { BillingRepository } from '@/repositories/billing.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql, withTransaction } from '@/services/database.service'

const repository = new BillingRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

/**
 * A promise and the function that settles it, so one transaction can wait for another.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  const signal: { release?: () => void } = {}
  const promise = new Promise<void>((resolve) => {
    signal.release = resolve
  })
  return { promise, resolve: () => signal.release?.() }
}

describe('BillingRepository', () => {
  const tenantIds: string[] = []
  const userIds: string[] = []
  const alertIds: string[] = []

  afterEach(async () => {
    if (alertIds.length > 0) await sql`delete from billing_alerts where id = any(${alertIds})`
    alertIds.length = 0
    if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
    if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
    tenantIds.length = 0
    userIds.length = 0
  })

  /**
   * Creates a tenant with a Free billing record, tracked for cleanup.
   */
  async function billedTenant(): Promise<string> {
    const suffix = randomUUID().slice(0, 8)
    // The repository gives the new tenant its Free billing row.
    const tenant = await tenantRepository.createWithoutOwner({
      name: `Billing ${suffix}`,
      slug: `billing-${suffix}`,
    })
    tenantIds.push(tenant.id)
    return tenant.id
  }

  /**
   * Creates a user, tracked for cleanup.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: `billing-repo-${randomUUID()}@example.test` })
    userIds.push(user.id)
    return user.id
  }

  it('inserts, finds and locks a billing record', async () => {
    const tenantId = await billedTenant()
    const found = await repository.findByTenantId(tenantId)
    expect(found?.state).toBe('free')
    const locked = await withTransaction((tx) => repository.lockByTenantId(tenantId, tx))
    expect(locked?.tenantId).toBe(tenantId)
    expect(await repository.findByTenantId(randomUUID())).toBeUndefined()
  })

  it('updates when the version matches and returns undefined when it is stale', async () => {
    const tenantId = await billedTenant()
    const updated = await withTransaction((tx) =>
      repository.updateVersioned(tenantId, 1, { cancelAtPeriodEnd: true }, tx)
    )
    expect(updated?.version).toBe(2)
    expect(updated?.cancelAtPeriodEnd).toBe(true)
    const stale = await withTransaction((tx) =>
      repository.updateVersioned(tenantId, 1, { cancelAtPeriodEnd: false }, tx)
    )
    expect(stale).toBeUndefined()
    const reread = await repository.findByTenantId(tenantId)
    expect(reread?.cancelAtPeriodEnd).toBe(true)
  })

  it('finds a record by its current, pending or next subscription id', async () => {
    const tenantId = await billedTenant()
    const tag = randomUUID().slice(0, 8)
    await withTransaction((tx) =>
      repository.updateVersioned(
        tenantId,
        1,
        {
          providerSubscriptionId: `sub_cur_${tag}`,
          pendingSubscriptionId: `sub_pen_${tag}`,
          nextSubscriptionId: `sub_nxt_${tag}`,
        },
        tx
      )
    )
    for (const id of [`sub_cur_${tag}`, `sub_pen_${tag}`, `sub_nxt_${tag}`]) {
      const found = await repository.findBySubscriptionId(id)
      expect(found?.tenantId).toBe(tenantId)
    }
    expect(await repository.findBySubscriptionId(`sub_none_${tag}`)).toBeUndefined()
  })

  it('appends history and lists it newest first within the limit', async () => {
    const tenantId = await billedTenant()
    await withTransaction(async (tx) => {
      await repository.appendHistory(
        { tenantId, fromState: null, toState: 'free', cause: 'created', source: 'job' },
        tx
      )
      await repository.appendHistory(
        { tenantId, fromState: 'free', toState: 'active', cause: 'paid', source: 'webhook' },
        tx
      )
    })
    const all = await repository.listHistory(tenantId, 10)
    expect(all.map((entry) => entry.toState)).toEqual(['active', 'free'])
    expect(await repository.listHistory(tenantId, 1)).toHaveLength(1)
  })

  it('records an event once and reports the second delivery as a duplicate', async () => {
    const tenantId = await billedTenant()
    const providerEventId = `evt_${randomUUID()}`
    const row = {
      provider: 'razorpay',
      mode: 'test',
      providerEventId,
      type: 'subscription.charged',
      tenantId,
    } as const
    expect(await repository.recordEvent(row)).toBe('inserted')
    expect(await repository.recordEvent(row)).toBe('duplicate')
    const stored = await repository.findEvent('razorpay', 'test', providerEventId)
    expect(stored?.processedAt).toBeNull()
    if (stored === undefined) throw new Error('event missing')

    await repository.markEventFailed(stored.id, 'x'.repeat(600))
    const failed = await repository.findEvent('razorpay', 'test', providerEventId)
    expect(failed?.attempts).toBe(1)
    expect(failed?.error).toHaveLength(500)

    await repository.markEventProcessed(stored.id)
    const done = await repository.findEvent('razorpay', 'test', providerEventId)
    expect(done?.attempts).toBe(2)
    expect(done?.error).toBeNull()
    expect(done?.processedAt).toBeInstanceOf(Date)
    const events = await repository.listEvents(tenantId, 5)
    expect(events.map((event) => event.id)).toEqual([stored.id])
  })

  it('marks an event processed with an outcome and the workspace it resolved to', async () => {
    const tenantId = await billedTenant()
    const providerEventId = `evt_${randomUUID()}`
    await repository.recordEvent({
      provider: 'razorpay',
      mode: 'test',
      providerEventId,
      type: 'subscription.halted',
    })
    const stored = await repository.findEvent('razorpay', 'test', providerEventId)
    if (stored === undefined) throw new Error('event missing')

    await repository.setEventTenant(stored.id, tenantId)
    const resolved = await repository.findEventById(stored.id)
    expect(resolved?.tenantId).toBe(tenantId)
    await repository.markEventProcessed(stored.id, { tenantId, error: 'provider_mismatch' })

    const done = await repository.findEvent('razorpay', 'test', providerEventId)
    expect(done).toMatchObject({ tenantId, error: 'provider_mismatch', attempts: 1 })
    expect(done?.processedAt).toBeInstanceOf(Date)
  })

  it('finds an alert naming a text among the alerts with no workspace', async () => {
    const text = `sub_${randomUUID()}`
    const tenantId = await billedTenant()
    expect(await repository.hasAlertNaming(null, 'reconcile_repair', text)).toBe(false)
    const scoped = await repository.insertAlert({
      kind: 'reconcile_repair',
      tenantId,
      message: `Subscription ${text} is scoped.`,
    })
    alertIds.push(scoped.id)
    expect(await repository.hasAlertNaming(null, 'reconcile_repair', text)).toBe(false)

    const unscoped = await repository.insertAlert({
      kind: 'reconcile_repair',
      tenantId: null,
      message: `Subscription ${text} has no workspace.`,
    })
    alertIds.push(unscoped.id)

    expect(await repository.hasAlertNaming(null, 'reconcile_repair', text)).toBe(true)
  })

  it('stores an alert for a workspace', async () => {
    const tenantId = await billedTenant()
    const alert = await repository.insertAlert({
      kind: 'dispute',
      tenantId,
      message: 'A customer opened a dispute.',
    })
    alertIds.push(alert.id)
    expect(alert.kind).toBe('dispute')
  })

  it('claims each due row once across two concurrent transactions', async () => {
    const ids = [
      await billedTenant(),
      await billedTenant(),
      await billedTenant(),
      await billedTenant(),
    ]
    const mine = inArray(tenantBillingModel.tenantId, ids)
    const first = deferred()
    const second = deferred()
    const firstClaim = withTransaction(async (tx) => {
      const rows = await repository.claimDue(tenantBillingModel.trialMidpointSentAt, mine, 2, tx)
      first.resolve()
      await second.promise
      return rows
    })
    await first.promise
    const secondClaim = withTransaction(async (tx) => {
      const rows = await repository.claimDue(tenantBillingModel.trialMidpointSentAt, mine, 10, tx)
      second.resolve()
      return rows
    })
    const [a, b] = await Promise.all([firstClaim, secondClaim])
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
    const claimed = [...a, ...b].map((row) => row.tenantId)
    expect(new Set(claimed).size).toBe(4)
    expect([...a, ...b].every((row) => row.trialMidpointSentAt instanceof Date)).toBe(true)
    const again = await withTransaction((tx) =>
      repository.claimDue(tenantBillingModel.trialMidpointSentAt, mine, 10, tx)
    )
    expect(again).toHaveLength(0)
  })

  it('claims at most the limit', async () => {
    const ids = [await billedTenant(), await billedTenant(), await billedTenant()]
    const rows = await withTransaction((tx) =>
      repository.claimDue(
        tenantBillingModel.winback7dSentAt,
        inArray(tenantBillingModel.tenantId, ids),
        1,
        tx
      )
    )
    expect(rows).toHaveLength(1)
  })

  it('lists the records in a state that meet a condition', async () => {
    const tenantId = await billedTenant()
    const rows = await repository.listDueForState(
      'free',
      eq(tenantBillingModel.tenantId, tenantId),
      10
    )
    expect(rows.map((row) => row.tenantId)).toEqual([tenantId])
    expect(
      await repository.listDueForState('active', eq(tenantBillingModel.tenantId, tenantId), 10)
    ).toEqual([])
  })

  it('remembers banner dismissals once per banner', async () => {
    const tenantId = await billedTenant()
    const userId = await createUser()
    await repository.dismissBanner(userId, tenantId, 'trial_ending')
    await repository.dismissBanner(userId, tenantId, 'trial_ending')
    await repository.dismissBanner(userId, tenantId, 'past_due')
    expect(await repository.listDismissals(userId, tenantId)).toEqual(['past_due', 'trial_ending'])
  })

  it('returns alreadyRequested on a second open request and fulfils it once', async () => {
    const tenantId = await billedTenant()
    const userId = await createUser()
    const row = {
      tenantId,
      requestedBy: userId,
      surface: 'members',
      entitlementKey: 'members',
      expiresAt: new Date(Date.now() + 86_400_000),
    }
    const first = await repository.openUpgradeRequest(row)
    expect(first.alreadyRequested).toBe(false)
    const second = await repository.openUpgradeRequest(row)
    expect(second.alreadyRequested).toBe(true)
    expect(second.request.id).toBe(first.request.id)
    expect(await repository.listOpenUpgradeRequests(tenantId)).toHaveLength(1)
    const fulfilled = await withTransaction((tx) => repository.fulfilUpgradeRequests(tenantId, tx))
    expect(fulfilled.map((request) => request.id)).toEqual([first.request.id])
    expect(await repository.listOpenUpgradeRequests(tenantId)).toHaveLength(0)
    const reopened = await repository.openUpgradeRequest(row)
    expect(reopened.alreadyRequested).toBe(false)
  })

  it('reopens an expired request instead of treating it as open', async () => {
    const tenantId = await billedTenant()
    const userId = await createUser()
    const expired = await repository.openUpgradeRequest({
      tenantId,
      requestedBy: userId,
      surface: 'members',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    await db.execute(
      drizzleSql`update upgrade_requests set expires_at = now() - interval '1 day' where id = ${expired.request.id}`
    )
    const reopened = await repository.openUpgradeRequest({
      tenantId,
      requestedBy: userId,
      surface: 'members',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    expect(reopened.alreadyRequested).toBe(false)
    expect(reopened.request.id).toBe(expired.request.id)
  })

  it('lets only one claim take a user trial', async () => {
    const userId = await createUser()
    const tenantId = await billedTenant()
    const results = await Promise.all([
      withTransaction((tx) => repository.claimUserTrial(userId, tx)),
      withTransaction((tx) => repository.claimUserTrial(userId, tx)),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await withTransaction((tx) => repository.claimUserTrial(userId, tx))).toBe(false)
    await withTransaction((tx) => repository.setFirstTrialTenant(userId, tenantId, tx))
    const [row] = await sql`select first_trial_tenant_id from user_trials where user_id = ${userId}`
    expect(row?.['first_trial_tenant_id']).toBe(tenantId)
  })
})
