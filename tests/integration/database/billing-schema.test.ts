/**
 * @file What migration 0033 built, asserted against the live per-worker
 * database with raw SQL, so no application check stands in for the
 * database's: every billing table exists, its CHECKs refuse an unknown value,
 * one active price per plan, currency, country and interval, and a deleted
 * tenant takes its billing row with it.
 */
import { randomUUID } from 'node:crypto'
import { getTableName } from 'drizzle-orm'
import { afterEach, describe, expect, expectTypeOf, it } from 'vite-plus/test'
import {
  billingAlertModel,
  billingEventModel,
  billingSettingsModel,
  billingStateHistoryModel,
  planModel,
  planPriceModel,
  tenantBillingModel,
  tenantEntitlementGrantModel,
  upgradeRequestModel,
  userBannerDismissalModel,
  userTrialModel,
  type EntitlementGrant,
  type TenantBillingRecord,
} from '@/database/models/billing.model'
import { sql } from '@/services/database.service'
import type { BillingStateInput, EntitlementGrantInput } from '@/types/billing'
import { truncateAuditLogs } from '../../helpers/audit-log'

const tenantIds: string[] = []
const userIds: string[] = []
const priceIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (priceIds.length > 0) await sql`delete from plan_prices where id = any(${priceIds})`
  priceIds.length = 0
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
  userIds.length = 0
})

/**
 * Inserts a customer tenant with raw SQL, tracked for cleanup, and returns its id.
 */
async function insertTenant(): Promise<string> {
  const id = randomUUID()
  await sql`insert into tenants (id, name, slug) values (${id}, 'Billing Co', ${`billing-${id}`})`
  tenantIds.push(id)
  return id
}

/**
 * Inserts a user with raw SQL, tracked for cleanup, and returns its id.
 */
async function insertUser(): Promise<string> {
  const id = randomUUID()
  await sql`insert into users (id, email) values (${id}, ${`billing-${id}@example.test`})`
  userIds.push(id)
  return id
}

/**
 * The id of a seeded plan.
 */
async function planId(key: 'free' | 'paid'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from plans where key = ${key}`
  if (!row) throw new Error(`no ${key} plan`)
  return row.id
}

/**
 * Inserts a price on a plan with raw SQL, tracked for cleanup, and returns its id.
 */
async function insertPrice(row: {
  planId: string
  interval?: string
  currency?: string
  amountMinor?: number
  active?: boolean
}): Promise<string> {
  const [inserted] = await sql<{ id: string }[]>`
    insert into plan_prices (plan_id, currency, interval, amount_minor, active)
    values (${row.planId}, ${row.currency ?? 'INR'}, ${row.interval ?? 'month'},
      ${row.amountMinor ?? 100}, ${row.active ?? true})
    returning id`
  if (!inserted) throw new Error('price insert returned no row')
  priceIds.push(inserted.id)
  return inserted.id
}

/**
 * Inserts a billing row for a tenant on the Free plan with the given state.
 */
async function insertBilling(tenantId: string, state: string): Promise<void> {
  await sql`
    insert into tenant_billing (tenant_id, state, plan_id)
    values (${tenantId}, ${state}, ${await planId('free')})`
}

describe('billing tables', () => {
  it.each([
    [planModel, 'plans'],
    [planPriceModel, 'plan_prices'],
    [tenantBillingModel, 'tenant_billing'],
    [userTrialModel, 'user_trials'],
    [tenantEntitlementGrantModel, 'tenant_entitlement_grants'],
    [billingSettingsModel, 'billing_settings'],
    [billingEventModel, 'billing_events'],
    [billingStateHistoryModel, 'billing_state_history'],
    [upgradeRequestModel, 'upgrade_requests'],
    [userBannerDismissalModel, 'user_banner_dismissals'],
    [billingAlertModel, 'billing_alerts'],
  ])('%#: the model names a table the migration created', async (model, table) => {
    expect(getTableName(model)).toBe(table)
    const rows = await sql`select 1 from information_schema.tables where table_name = ${table}`
    expect(rows).toHaveLength(1)
  })

  it('give a billing record every field the state rules read', () => {
    expectTypeOf<TenantBillingRecord>().toExtend<BillingStateInput>()
    expectTypeOf<EntitlementGrant>().toExtend<EntitlementGrantInput>()
  })
})

describe('billing CHECKs', () => {
  it('refuses a billing state outside the known set', async () => {
    const tenantId = await insertTenant()
    await expect(insertBilling(tenantId, 'cancelled')).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'tenant_billing_state_check',
    })
  })

  it('accepts each known billing state', async () => {
    for (const state of ['trialing', 'free', 'active', 'past_due']) {
      const tenantId = await insertTenant()
      await expect(insertBilling(tenantId, state)).resolves.toBeUndefined()
    }
  })

  it('refuses a plan key other than free and paid', async () => {
    await expect(sql`
      insert into plans (key, name, entitlements) values ('team', 'Team', '{}'::jsonb)`).rejects.toMatchObject(
      { code: '23514', constraint_name: 'plans_key_check' }
    )
  })

  it.each([
    ['an interval', { interval: 'week' }, 'plan_prices_interval_check'],
    ['a currency', { currency: 'USD' }, 'plan_prices_currency_check'],
    ['an amount', { amountMinor: 0 }, 'plan_prices_amount_check'],
  ])('refuses %s outside the allowed values on a price', async (_label, fields, constraint) => {
    await expect(insertPrice({ planId: await planId('free'), ...fields })).rejects.toMatchObject({
      code: '23514',
      constraint_name: constraint,
    })
  })

  it.each([
    [
      'a second settings row',
      () =>
        sql`insert into billing_settings (id, trial_enabled, trial_days, past_due_grace_days) values (2, true, 14, 7)`,
      'billing_settings_single_row_check',
    ],
    [
      'a trial of 0 days',
      () => sql`update billing_settings set trial_days = 0`,
      'billing_settings_trial_days_check',
    ],
    [
      'a trial of 91 days',
      () => sql`update billing_settings set trial_days = 91`,
      'billing_settings_trial_days_check',
    ],
    [
      'a grace of 31 days',
      () => sql`update billing_settings set past_due_grace_days = 31`,
      'billing_settings_grace_days_check',
    ],
  ])('refuses %s', async (_label, query, constraint) => {
    await expect(query()).rejects.toMatchObject({ code: '23514', constraint_name: constraint })
  })

  it('refuses a history source outside the known set', async () => {
    const tenantId = await insertTenant()
    await expect(sql`
      insert into billing_state_history (tenant_id, from_state, to_state, cause, source)
      values (${tenantId}, null, 'free', 'created', 'browser')`).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'billing_state_history_source_check',
    })
  })

  it('refuses an alert kind outside the known set', async () => {
    await expect(sql`
      insert into billing_alerts (kind, message) values ('card_expiring', 'A card expires soon.')`).rejects.toMatchObject(
      { code: '23514', constraint_name: 'billing_alerts_kind_check' }
    )
  })
})

describe('plan_prices_active_unique', () => {
  it('refuses a second active monthly INR price with no country on one plan', async () => {
    const free = await planId('free')
    await insertPrice({ planId: free })
    await expect(insertPrice({ planId: free })).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'plan_prices_active_unique',
    })
  })

  it('keeps any number of retired prices beside the active one', async () => {
    const free = await planId('free')
    await insertPrice({ planId: free })
    await insertPrice({ planId: free, active: false })
    await expect(insertPrice({ planId: free, active: false })).resolves.toBeTypeOf('string')
  })

  it('allows one active price per interval', async () => {
    const free = await planId('free')
    await insertPrice({ planId: free, interval: 'month' })
    await expect(insertPrice({ planId: free, interval: 'year' })).resolves.toBeTypeOf('string')
  })
})

describe('billing foreign keys', () => {
  it('deletes a tenant billing row with its tenant', async () => {
    const tenantId = await insertTenant()
    await insertBilling(tenantId, 'free')

    await sql`delete from tenants where id = ${tenantId}`

    expect(await sql`select 1 from tenant_billing where tenant_id = ${tenantId}`).toHaveLength(0)
  })

  it('keeps a billing row and clears its payer when the payer is deleted', async () => {
    const tenantId = await insertTenant()
    const userId = await insertUser()
    await insertBilling(tenantId, 'free')
    await sql`update tenant_billing set payer_user_id = ${userId} where tenant_id = ${tenantId}`

    await sql`delete from users where id = ${userId}`

    const [row] = await sql`select payer_user_id from tenant_billing where tenant_id = ${tenantId}`
    expect(row).toEqual({ payer_user_id: null })
  })

  it('refuses to delete a plan a billing row is on', async () => {
    const tenantId = await insertTenant()
    await insertBilling(tenantId, 'free')

    // ON DELETE RESTRICT answers restrict_violation, not the deferred foreign_key_violation.
    await expect(sql`delete from plans where key = 'free'`).rejects.toMatchObject({
      code: '23001',
      constraint_name: 'tenant_billing_plan_id_plans_id_fk',
    })
  })

  it('keeps one open upgrade request per tenant and requester', async () => {
    const tenantId = await insertTenant()
    const userId = await insertUser()
    /**
     * Inserts an open request from this member in this tenant.
     */
    const insertRequest = () => sql`
      insert into upgrade_requests (tenant_id, requested_by, surface, expires_at)
      values (${tenantId}, ${userId}, 'members_limit', now() + interval '30 days')`
    await insertRequest()

    await expect(insertRequest()).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'upgrade_requests_open_unique',
    })
    await sql`update upgrade_requests set fulfilled_at = now() where tenant_id = ${tenantId}`
    await expect(insertRequest()).resolves.toBeDefined()
  })
})
