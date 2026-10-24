/**
 * @file Migration 0033 against a database that already holds tenants. The
 * suite's own databases are migrated empty in globalSetup, so this file
 * creates a throwaway database, migrates it to 0032, writes an active, an
 * archived and a soft-deleted tenant beside the seeded platform tenant,
 * applies 0033 and reads the seed rows and the backfill. Raw SQL throughout;
 * the database is dropped after the tests, as
 * passwordless-migration-data.test.ts does for 0029.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { dropScratchDatabase } from '../../helpers/scratch-database'
import { baseDatabaseUrl } from '../../helpers/worker-database'

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'src/database/migrations')
const LAST_PRE_BILLING_MIGRATION = 32

/**
 * The base URL every test database is derived from.
 * @throws {Error} When global setup has not run.
 */
function requireBaseUrl(): string {
  const base = baseDatabaseUrl()
  if (base === undefined)
    throw new Error('TEST_DATABASE_BASE_URL is not set — did global setup run?')
  return base
}

const baseUrl = requireBaseUrl()
const scratchName = `${new URL(baseUrl).pathname.slice(1)}_m0033_w${process.env.VITEST_POOL_ID ?? '0'}`
const scratchUrl = (() => {
  const url = new URL(baseUrl)
  url.pathname = `/${scratchName}`
  return url.href
})()

/**
 * Drizzle's migration journal (`meta/_journal.json`), narrowed to its entries.
 */
interface Journal {
  entries: { idx: number }[]
}

/**
 * A temporary copy of the migrations folder whose journal stops at
 * `lastIndex`, so the migrator applies nothing after it. Returns the copy's path.
 */
function migrationsUpTo(lastIndex: number): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'))
  fs.cpSync(MIGRATIONS_FOLDER, folder, { recursive: true })
  const journalPath = path.join(folder, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIndex)
  fs.writeFileSync(journalPath, JSON.stringify(journal))
  return folder
}

/**
 * Applies a folder's migrations to the scratch database.
 */
async function migrateScratch(folder: string): Promise<void> {
  const client = postgres(scratchUrl, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(client), { migrationsFolder: folder })
  } finally {
    await client.end({ timeout: 5 })
  }
}

const admin = postgres(baseUrl, { max: 1, onnotice: () => {} })
const legacyFolder = migrationsUpTo(LAST_PRE_BILLING_MIGRATION)
// postgres.js connects on the first query, so this client is safe to build before the database exists.
const scratch = postgres(scratchUrl, { max: 1, onnotice: () => {} })
const activeTenantId = randomUUID()
const archivedTenantId = randomUUID()
const deletedTenantId = randomUUID()

beforeAll(async () => {
  // The scratch name is fixed per worker, so a run that died mid-file may have left the database behind.
  await dropScratchDatabase(admin, scratchName)
  await admin.unsafe(`create database "${scratchName}"`)
  await migrateScratch(legacyFolder)
  const legacy = postgres(scratchUrl, { max: 1, onnotice: () => {} })
  try {
    await legacy`
      insert into tenants (id, name, slug) values (${activeTenantId}, 'Active Co', 'active-co')`
    await legacy`
      insert into tenants (id, name, slug, lifecycle_state, deleted_at)
      values (${archivedTenantId}, 'Archived Co', 'archived-co', 'archived', now())`
    await legacy`
      insert into tenants (id, name, slug, deleted_at)
      values (${deletedTenantId}, 'Deleted Co', 'deleted-co', now())`
  } finally {
    await legacy.end({ timeout: 5 })
  }
  await migrateScratch(MIGRATIONS_FOLDER)
}, 60_000)

afterAll(async () => {
  await scratch.end({ timeout: 5 })
  await dropScratchDatabase(admin, scratchName)
  await admin.end({ timeout: 5 })
  fs.rmSync(legacyFolder, { recursive: true, force: true })
})

describe('migration 0033 over existing tenants', () => {
  it('seeds the Free and Paid plans with their entitlements', async () => {
    const plans = await scratch`
      select key, name, entitlements, sort_order, version from plans order by sort_order`

    expect(plans).toEqual([
      {
        key: 'free',
        name: 'Free',
        entitlements: { members: 3, advanced_example: false },
        sort_order: 0,
        version: 1,
      },
      {
        key: 'paid',
        name: 'Paid',
        entitlements: { members: null, advanced_example: true },
        sort_order: 1,
        version: 1,
      },
    ])
  })

  it('seeds the two active INR prices on Paid with no provider ids', async () => {
    const prices = await scratch`
      select p.key, pp.currency, pp.country, pp.interval, pp.amount_minor, pp.active,
        pp.provider, pp.provider_mode, pp.provider_plan_id, pp.retired_at
      from plan_prices pp join plans p on p.id = pp.plan_id
      order by pp.amount_minor`
    const common = {
      key: 'paid',
      currency: 'INR',
      country: null,
      active: true,
      provider: null,
      provider_mode: null,
      provider_plan_id: null,
      retired_at: null,
    }

    expect(prices).toEqual([
      { ...common, interval: 'month', amount_minor: 99_900 },
      { ...common, interval: 'year', amount_minor: 999_000 },
    ])
  })

  it('seeds the one settings row with a 14-day trial and a 7-day grace', async () => {
    const settings = await scratch`
      select id, trial_enabled, trial_days, past_due_grace_days, version, updated_by
      from billing_settings`

    expect(settings).toEqual([
      {
        id: 1,
        trial_enabled: true,
        trial_days: 14,
        past_due_grace_days: 7,
        version: 1,
        updated_by: null,
      },
    ])
  })

  it('gives every customer tenant, archived and deleted ones too, a free row on the Free plan', async () => {
    const rows = await scratch<{ tenant_id: string; state: string; key: string }[]>`
      select tb.tenant_id, tb.state, p.key
      from tenant_billing tb join plans p on p.id = tb.plan_id`

    expect(rows.toSorted((a, b) => a.tenant_id.localeCompare(b.tenant_id))).toEqual(
      [activeTenantId, archivedTenantId, deletedTenantId]
        .toSorted((a, b) => a.localeCompare(b))
        .map((tenantId) => ({ tenant_id: tenantId, state: 'free', key: 'free' }))
    )
  })

  it('gives the platform tenant no billing row', async () => {
    const rows = await scratch`
      select 1 from tenant_billing tb join tenants t on t.id = tb.tenant_id where t.is_platform`
    const platform = await scratch`select 1 from tenants where is_platform`

    expect(platform).toHaveLength(1)
    expect(rows).toHaveLength(0)
  })

  it('leaves the backfilled rows with no trial, period or provider', async () => {
    const [row] = await scratch`
      select price_id, trial_started_at, trial_ends_at, current_period_end, cancel_at_period_end,
        provider, provider_subscription_id, version
      from tenant_billing where tenant_id = ${activeTenantId}`

    expect(row).toEqual({
      price_id: null,
      trial_started_at: null,
      trial_ends_at: null,
      current_period_end: null,
      cancel_at_period_end: false,
      provider: null,
      provider_subscription_id: null,
      version: 1,
    })
  })

  it('accepts the plan and billing audit target types', async () => {
    const [platform] = await scratch<{ id: string }[]>`select id from tenants where is_platform`
    if (!platform) throw new Error('no platform tenant')
    for (const targetType of ['plan', 'billing']) {
      await expect(scratch`
        insert into audit_logs (actor_kind, access, tenant_id, action, target_type, target_id)
        values ('system', 'system', ${platform.id}, 'billing.probe', ${targetType}, ${platform.id})`).resolves.toBeDefined()
    }
  })
})
