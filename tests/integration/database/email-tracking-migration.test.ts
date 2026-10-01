/**
 * @file Migration 0020's backfill, observed the only way it can be: the
 * suite's own databases are migrated empty in globalSetup, so this file
 * creates a throwaway database, migrates it to 0019, writes legacy
 * `email_logs` rows, then applies 0020 and reads what the backfill made.
 * Raw SQL throughout. The database is dropped afterwards.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { baseDatabaseUrl } from '../../helpers/worker-database'

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'src/database/migrations')
const LAST_LEGACY_MIGRATION = 19

/**
 * The base URL every test database is derived from.
 * @returns The stashed base URL.
 * @throws {Error} When global setup has not run.
 */
function requireBaseUrl(): string {
  const base = baseDatabaseUrl()
  if (base === undefined)
    throw new Error('TEST_DATABASE_BASE_URL is not set — did global setup run?')
  return base
}

const baseUrl = requireBaseUrl()
const scratchName = `${new URL(baseUrl).pathname.slice(1)}_m0020_w${process.env.VITEST_POOL_ID ?? '0'}`
const scratchUrl = (() => {
  const url = new URL(baseUrl)
  url.pathname = `/${scratchName}`
  return url.href
})()

interface JournalEntry {
  idx: number
}

interface Journal {
  entries: JournalEntry[]
}

/**
 * A copy of the migrations folder whose journal stops at `lastIndex`, so
 * the migrator applies nothing after it.
 * @param lastIndex - The last migration to keep.
 * @returns The copy's path.
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
 * Apply a folder's migrations to the scratch database.
 * @param folder - The migrations folder.
 * @returns Resolves once they are applied.
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
const legacyFolder = migrationsUpTo(LAST_LEGACY_MIGRATION)
// postgres.js connects on the first query, so this client is safe to build before the database exists.
const scratch = postgres(scratchUrl, { max: 1 })

const SENT_AT = '2026-01-02T03:04:05.678Z'
const FAILED_AT = '2026-01-03T00:00:00.000Z'

beforeAll(async () => {
  // A scratch name is fixed per worker, so a run that died mid-file left it behind.
  await admin.unsafe(`drop database if exists "${scratchName}" with (force)`)
  await admin.unsafe(`create database "${scratchName}"`)
  await migrateScratch(legacyFolder)
  const legacy = postgres(scratchUrl, { max: 1 })
  try {
    await legacy`
      insert into email_logs (id, recipient, template_key, status, provider_message_id, created_at)
      values ('00000000-0000-7000-8000-000000000001', 'Ada@Example.test', 'password_reset', 'sent', '<nodemailer-1@example.test>', ${SENT_AT}::timestamptz)
    `
    await legacy`
      insert into email_logs (id, recipient, template_key, status, error_code, created_at)
      values ('00000000-0000-7000-8000-000000000002', 'grace@example.test', 'password_changed', 'failed', 'ECONNECTION', ${FAILED_AT}::timestamptz)
    `
  } finally {
    await legacy.end({ timeout: 5 })
  }
  await migrateScratch(MIGRATIONS_FOLDER)
}, 60_000)

afterAll(async () => {
  await scratch.end({ timeout: 5 })
  await admin.unsafe(`drop database if exists "${scratchName}" with (force)`)
  await admin.end({ timeout: 5 })
  fs.rmSync(legacyFolder, { recursive: true, force: true })
})

describe('migration 0020: backfill', () => {
  it('makes one message per legacy attempt, reusing its id, day and recipient', async () => {
    const rows = await scratch`
      select id, recipient, template_key, status, failure_origin, sender_class,
             message_id_header, variables, user_id, tenant_id, link_app, job_key,
             created_at, status_updated_at
      from email_messages order by id
    `
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: '00000000-0000-7000-8000-000000000001',
      recipient: 'Ada@Example.test',
      template_key: 'password_reset',
      status: 'sent',
      sender_class: 'transactional',
      message_id_header: '<legacy-00000000-0000-7000-8000-000000000001@invalid>',
      variables: {},
    })
    for (const column of ['failure_origin', 'user_id', 'tenant_id', 'link_app', 'job_key']) {
      expect(rows[0]?.[column]).toBeNull()
    }
    expect((rows[0]?.created_at as Date).toISOString()).toBe(SENT_AT)
    expect((rows[0]?.status_updated_at as Date).toISOString()).toBe(SENT_AT)
    expect(rows[1]).toMatchObject({
      id: '00000000-0000-7000-8000-000000000002',
      template_key: 'password_changed',
      status: 'failed',
      failure_origin: 'send',
      sender_class: 'general',
      message_id_header: '<legacy-00000000-0000-7000-8000-000000000002@invalid>',
    })
    expect((rows[1]?.created_at as Date).toISOString()).toBe(FAILED_AT)
  })

  it('points every legacy attempt at its message', async () => {
    const rows = await scratch<
      { id: string; message_id: string }[]
    >`select id, message_id from email_logs order by id`
    expect(rows.map((row) => [row.id, row.message_id])).toEqual([
      ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001'],
      ['00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000002'],
    ])
  })

  it('leaves email_logs.message_id nullable, for attempts an older replica records', async () => {
    const [column] = await scratch`
      select is_nullable from information_schema.columns
      where table_name = 'email_logs' and column_name = 'message_id'
    `
    expect(column?.is_nullable).toBe('YES')
  })

  it('widens the audit target-type CHECK to the email targets', async () => {
    const [tenant] = await scratch`select id from tenants where is_platform`
    const tenantId = tenant?.id as string
    for (const targetType of ['email_message', 'email_suppression']) {
      await expect(scratch`
        insert into audit_logs (actor_kind, access, tenant_id, action, target_type, target_id)
        values ('system', 'system', ${tenantId}, 'email.resent', ${targetType}, ${tenantId})
      `).resolves.toBeDefined()
    }
  })
})
