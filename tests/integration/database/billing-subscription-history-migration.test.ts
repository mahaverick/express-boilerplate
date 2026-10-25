/**
 * @file Migration 0036's backfill of `tenant_billing_subscriptions`. The
 * suite's own databases are migrated empty in globalSetup, so this file
 * creates a throwaway database, migrates it to 0035, writes billing rows and
 * stored provider events, applies 0036 and reads what the backfill made.
 * Raw SQL throughout; the database is dropped after the tests, as
 * billing-migration-data.test.ts does for 0033.
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
const LAST_PRE_HISTORY_MIGRATION = 35

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
const scratchName = `${new URL(baseUrl).pathname.slice(1)}_m0036_w${process.env.VITEST_POOL_ID ?? '0'}`
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
const legacyFolder = migrationsUpTo(LAST_PRE_HISTORY_MIGRATION)
// postgres.js connects on the first query, so this client is safe to build before the database exists.
const scratch = postgres(scratchUrl, { max: 1, onnotice: () => {} })
const resubscribedId = randomUUID()
const otherId = randomUUID()
const OLD_CHARGED_AT = '2026-09-01T10:00:00.000Z'
const NEW_CHARGED_AT = '2026-10-20T10:00:00.000Z'

beforeAll(async () => {
  // The scratch name is fixed per worker, so a run that died mid-file may have left the database behind.
  await dropScratchDatabase(admin, scratchName)
  await admin.unsafe(`create database "${scratchName}"`)
  await migrateScratch(legacyFolder)
  const legacy = postgres(scratchUrl, { max: 1, onnotice: () => {} })
  try {
    for (const [id, slug] of [
      [resubscribedId, 'resubscribed-co'],
      [otherId, 'other-co'],
    ] as const) {
      await legacy`insert into tenants (id, name, slug) values (${id}, ${slug}, ${slug})`
      await legacy`
        insert into tenant_billing (tenant_id, state, plan_id)
        select ${id}, 'free', id from plans where key = 'free'`
    }
    // The resubscribed workspace now holds sub_NEW; sub_OLD survives only in its events.
    await legacy`
      update tenant_billing set state = 'active', provider = 'razorpay', provider_mode = 'test',
        provider_subscription_id = 'sub_NEW'
      where tenant_id = ${resubscribedId}`
    const events: [string, string, string | null, string][] = [
      ['subscription.charged', 'sub_OLD', resubscribedId, OLD_CHARGED_AT],
      ['subscription.charged', 'sub_NEW', resubscribedId, NEW_CHARGED_AT],
      ['subscription.authenticated', 'sub_ABANDONED', resubscribedId, NEW_CHARGED_AT],
      ['subscription.charged', 'sub_UNRESOLVED', null, NEW_CHARGED_AT],
      ['invoice.paid', 'sub_OTHER', otherId, NEW_CHARGED_AT],
      // A duplicate checkout the sync refused and refunded: charged, never current.
      ['subscription.charged', 'sub_DUP', resubscribedId, NEW_CHARGED_AT],
      // Its id is a prefix of sub_DUP2's, which no alert names.
      ['subscription.charged', 'sub_DUP2', otherId, NEW_CHARGED_AT],
    ]
    for (const [type, subscriptionId, tenantId, at] of events) {
      await legacy`
        insert into billing_events (provider, mode, provider_event_id, type, subscription_id, tenant_id, received_at)
        values ('razorpay', 'test', ${`evt_${randomUUID()}`}, ${type}, ${subscriptionId}, ${tenantId}, ${at}::timestamptz)`
    }
    await legacy`
      insert into billing_alerts (kind, tenant_id, message)
      values ('duplicate_refunded', ${resubscribedId},
        'Cancelled duplicate subscription sub_DUP and refunded 99900 paise in rfnd_X.')`
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

describe('migration 0036: backfill', () => {
  it('records the current subscription and every earlier charged one but a refunded duplicate, each with its own workspace', async () => {
    const rows = await scratch<
      {
        tenant_id: string
        provider: string
        mode: string
        subscription_id: string
        first_seen_at: Date
      }[]
    >`
      select tenant_id, provider, mode, subscription_id, first_seen_at
      from tenant_billing_subscriptions order by subscription_id`
    expect(rows.map((row) => [row.subscription_id, row.tenant_id])).toStrictEqual([
      ['sub_DUP2', otherId],
      ['sub_NEW', resubscribedId],
      ['sub_OLD', resubscribedId],
      ['sub_OTHER', otherId],
    ])
    expect(rows.every((row) => row.provider === 'razorpay' && row.mode === 'test')).toBe(true)
  })

  it('dates each subscription by its earliest record', async () => {
    const rows = await scratch<{ subscription_id: string; first_seen_at: Date }[]>`
      select subscription_id, first_seen_at from tenant_billing_subscriptions
      where tenant_id = ${resubscribedId} order by first_seen_at desc`
    expect(rows.map((row) => row.subscription_id)).toStrictEqual(['sub_NEW', 'sub_OLD'])
    expect(rows[1]?.first_seen_at.toISOString()).toBe(OLD_CHARGED_AT)
  })
})
