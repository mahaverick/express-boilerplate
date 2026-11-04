/**
 * @file Migration 0040 against a database that holds a refresh row and a
 * sign-in link from before it. The suite's own databases are migrated empty
 * in globalSetup, so the hand-added backfill runs only here: this file
 * creates a throwaway database, migrates it to 0039, writes both rows,
 * applies 0040 and checks that the refresh row now names the `web` client
 * and the link names none. Raw SQL throughout; the database is dropped after
 * the tests, as invitation-links-migration.test.ts does for 0030.
 */
import { randomBytes, randomUUID } from 'node:crypto'
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
const LAST_MIGRATION_BEFORE_REFRESH_CLIENT = 39

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
const scratchName = `${new URL(baseUrl).pathname.slice(1)}_m0040_w${process.env.VITEST_POOL_ID ?? '0'}`
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

/**
 * A fresh 64-character hex digest for a token row.
 */
function tokenHash(): string {
  return randomBytes(32).toString('hex')
}

const admin = postgres(baseUrl, { max: 1, onnotice: () => {} })
const before = migrationsUpTo(LAST_MIGRATION_BEFORE_REFRESH_CLIENT)
// postgres.js connects on the first query, so this client is safe to build before the database exists.
const scratch = postgres(scratchUrl, { max: 1, onnotice: () => {} })
const userId = randomUUID()
const seeded = { refresh: tokenHash(), sign_in_link: tokenHash() }

beforeAll(async () => {
  // The scratch name is fixed per worker, so a run that died mid-file may have left the database behind.
  await dropScratchDatabase(admin, scratchName)
  await admin.unsafe(`create database "${scratchName}"`)
  await migrateScratch(before)
  const older = postgres(scratchUrl, { max: 1, onnotice: () => {} })
  try {
    await older`insert into users (id, email) values (${userId}, 'ada@example.test')`
    await older`
      insert into user_tokens (user_id, purpose, session_id, token_hash, expires_at)
      values (${userId}, 'refresh', ${randomUUID()}, ${seeded.refresh}, now() + interval '1 hour')`
    await older`
      insert into user_tokens (purpose, email, app, token_hash, expires_at)
      values ('sign_in_link', 'grace@example.test', 'web', ${seeded.sign_in_link},
        now() + interval '15 minutes')`
  } finally {
    await older.end({ timeout: 5 })
  }
  await migrateScratch(MIGRATIONS_FOLDER)
}, 60_000)

afterAll(async () => {
  await scratch.end({ timeout: 5 })
  await dropScratchDatabase(admin, scratchName)
  await admin.end({ timeout: 5 })
  fs.rmSync(before, { recursive: true, force: true })
}, 60_000)

describe('migration 0040: refresh rows record their client', () => {
  it('backfills a refresh row from before it as a web session', async () => {
    const rows = await scratch`
      select client, device_name from user_tokens where token_hash = ${seeded.refresh}`
    expect(rows).toEqual([{ client: 'web', device_name: null }])
  })

  it('leaves a sign-in link with no client', async () => {
    const rows = await scratch`
      select client, device_name from user_tokens where token_hash = ${seeded.sign_in_link}`
    expect(rows).toEqual([{ client: null, device_name: null }])
  })
})
