/**
 * @file Billing rows at workspace creation and the one trial per person,
 * against the real per-worker database.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { initialBillingFor, startDeferredTrial } from '@/services/billing/trial.service'
import { sql, withTransaction } from '@/services/database.service'
import { createTenant } from '@/services/tenant.service'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { grantSeats, putTenantOnPaid } from '../../../helpers/billing'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

const DAY_MS = 24 * 60 * 60 * 1000

describe('workspace billing at creation', () => {
  const tenantIds: string[] = []
  const userIds: string[] = []

  beforeEach(async () => {
    await sql`update billing_settings set trial_enabled = true, trial_days = 14`
  })

  afterEach(async () => {
    await truncateAuditLogs()
    await sql`update billing_settings set trial_enabled = true, trial_days = 14`
    if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
    if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
    tenantIds.length = 0
    userIds.length = 0
  })

  /**
   * A fresh user, tracked for cleanup.
   */
  async function newUser(): Promise<string> {
    const user = await userRepository.create({ email: `trial-${randomUUID()}@example.test` })
    userIds.push(user.id)
    return user.id
  }

  /**
   * Create a workspace through the service as `userId`.
   */
  async function make(userId: string): Promise<string> {
    const tenant = await createTenant(
      { userId },
      { name: 'Trial Co', slug: `trial-${randomUUID().slice(0, 12)}` }
    )
    tenantIds.push(tenant.id)
    return tenant.id
  }

  /**
   * A staff-made workspace waiting for its owner.
   */
  async function waiting(): Promise<string> {
    const tenant = await withTransaction(async (tx) =>
      tenantRepository.createWithoutOwner(
        { name: 'Staff Made', slug: `staff-${randomUUID().slice(0, 12)}` },
        tx,
        await initialBillingFor(null, tx)
      )
    )
    tenantIds.push(tenant.id)
    return tenant.id
  }

  it('starts a person first workspace on a 14-day trial of the Paid plan', async () => {
    const userId = await newUser()
    const before = Date.now()
    const tenantId = await make(userId)

    const row = await billingRepository.findByTenantId(tenantId)
    const paid = await planRepository.findPlanByKey('paid')
    expect(row?.state).toBe('trialing')
    expect(row?.planId).toBe(paid?.id)
    const ends = row?.trialEndsAt?.getTime() ?? 0
    expect(ends - before).toBeGreaterThan(14 * DAY_MS - 60_000)
    expect(ends - before).toBeLessThan(14 * DAY_MS + 60_000)
    const [claim] =
      await sql`select first_trial_tenant_id from user_trials where user_id = ${userId}`
    expect(claim?.first_trial_tenant_id).toBe(tenantId)
  })

  it('puts their second workspace on Free', async () => {
    const userId = await newUser()
    await make(userId)
    const second = await make(userId)

    const row = await billingRepository.findByTenantId(second)
    const free = await planRepository.findPlanByKey('free')
    expect(row).toMatchObject({ state: 'free', planId: free?.id, trialEndsAt: null })
  })

  it('puts the first workspace on Free when trials are off', async () => {
    await sql`update billing_settings set trial_enabled = false`
    const userId = await newUser()
    const tenantId = await make(userId)

    const row = await billingRepository.findByTenantId(tenantId)
    expect(row?.state).toBe('free')
    const claims = await sql`select 1 from user_trials where user_id = ${userId}`
    expect(claims).toHaveLength(0)
  })

  it('gives exactly one of two parallel creates by one person the trial', async () => {
    const userId = await newUser()
    const ids = await Promise.all([make(userId), make(userId)])

    const rows = await Promise.all(ids.map((id) => billingRepository.findByTenantId(id)))
    const states = rows.map((row) => row?.state ?? 'missing')
    expect(states.toSorted((a, b) => a.localeCompare(b))).toEqual(['free', 'trialing'])
  })

  it('creates a staff workspace on Free and waiting for its first owner', async () => {
    const tenantId = await waiting()

    const row = await billingRepository.findByTenantId(tenantId)
    expect(row).toMatchObject({ state: 'free', trialOnOwnerAccept: true })
  })

  it('waits for no owner when trials are off', async () => {
    await sql`update billing_settings set trial_enabled = false`
    const row = await withTransaction((tx) => initialBillingFor(null, tx))
    expect(row.trialOnOwnerAccept).toBe(false)
  })

  describe('startDeferredTrial', () => {
    it('starts the trial on the first owner accept, once', async () => {
      const tenantId = await waiting()
      const ownerId = await newUser()

      expect(await withTransaction((tx) => startDeferredTrial(tenantId, ownerId, tx))).toBe(true)
      expect(await withTransaction((tx) => startDeferredTrial(tenantId, ownerId, tx))).toBe(false)

      const row = await billingRepository.findByTenantId(tenantId)
      expect(row).toMatchObject({ state: 'trialing', trialOnOwnerAccept: false })
      expect(row?.trialEndsAt).not.toBeNull()
    })

    it('keeps the workspace Free for an owner who already had a trial', async () => {
      const ownerId = await newUser()
      await make(ownerId)
      const tenantId = await waiting()

      expect(await withTransaction((tx) => startDeferredTrial(tenantId, ownerId, tx))).toBe(false)

      const row = await billingRepository.findByTenantId(tenantId)
      expect(row).toMatchObject({ state: 'free', trialOnOwnerAccept: false })
    })

    it('does nothing for a workspace that is not waiting', async () => {
      const ownerId = await newUser()
      const tenantId = await make(ownerId)
      const other = await newUser()

      expect(await withTransaction((tx) => startDeferredTrial(tenantId, other, tx))).toBe(false)
      const claims = await sql`select 1 from user_trials where user_id = ${other}`
      expect(claims).toHaveLength(0)
    })

    it('inserts a Free row, never a Paid one, when a customer workspace has none', async () => {
      const ownerId = await newUser()
      const tenantId = await make(ownerId)
      await sql`delete from tenant_billing where tenant_id = ${tenantId}`

      expect(await withTransaction((tx) => startDeferredTrial(tenantId, ownerId, tx))).toBe(false)
      const row = await billingRepository.findByTenantId(tenantId)
      expect(row?.state).toBe('free')
    })

    it('leaves a workspace on the Paid plan alone', async () => {
      const ownerId = await newUser()
      const tenantId = await make(ownerId)
      await putTenantOnPaid(tenantId)
      await grantSeats(tenantId, 10)

      expect(await withTransaction((tx) => startDeferredTrial(tenantId, ownerId, tx))).toBe(false)
      const row = await billingRepository.findByTenantId(tenantId)
      expect(row?.state).toBe('active')
    })
  })
})
