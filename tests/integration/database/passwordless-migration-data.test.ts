/**
 * @file Migration 0029 against a database that holds password-era rows. The
 * suite's own databases are migrated empty in globalSetup, so this file
 * creates a throwaway database, migrates it to 0028, writes the rows 0029
 * deletes and the rows it keeps, applies 0029 and reads what is left. Raw SQL
 * throughout; the database is dropped after the tests, as
 * email-tracking-migration.test.ts does for 0020.
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
const LAST_PASSWORD_MIGRATION = 28

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
const scratchName = `${new URL(baseUrl).pathname.slice(1)}_m0029_w${process.env.VITEST_POOL_ID ?? '0'}`
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
const legacyFolder = migrationsUpTo(LAST_PASSWORD_MIGRATION)
// postgres.js connects on the first query, so this client is safe to build before the database exists.
const scratch = postgres(scratchUrl, { max: 1, onnotice: () => {} })
const userId = randomUUID()
const refreshHash = tokenHash()
const signInHash = tokenHash()

beforeAll(async () => {
  // The scratch name is fixed per worker, so a run that died mid-file may have left the database behind.
  await dropScratchDatabase(admin, scratchName)
  await admin.unsafe(`create database "${scratchName}"`)
  await migrateScratch(legacyFolder)
  const legacy = postgres(scratchUrl, { max: 1, onnotice: () => {} })
  try {
    await legacy`
      insert into users (id, email, password_hash)
      values (${userId}, 'ada@example.test', '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`
    for (const purpose of ['email_verification', 'password_reset']) {
      await legacy`
        insert into user_tokens (user_id, purpose, token_hash, expires_at)
        values (${userId}, ${purpose}, ${tokenHash()}, now() + interval '1 hour')`
    }
    await legacy`
      insert into user_tokens (user_id, purpose, session_id, token_hash, expires_at)
      values (${userId}, 'refresh', ${randomUUID()}, ${refreshHash}, now() + interval '1 hour')`
    await legacy`
      insert into user_tokens (purpose, email, app, token_hash, expires_at)
      values ('sign_in_link', 'grace@example.test', 'web', ${signInHash}, now() + interval '15 minutes')`
    for (const type of [
      'verify_email',
      'password_reset_requested',
      'password_changed',
      'tenant_invitation',
    ]) {
      await legacy`
        insert into notifications (user_id, type, title, body)
        values (${userId}, ${type}, 'Title', 'Body')`
      await legacy`
        insert into notification_preferences (user_id, notification_type, email_enabled, in_app_enabled)
        values (${userId}, ${type}, true, false)`
    }
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
}, 60_000)

describe('migration 0029 over password-era rows', () => {
  it('deletes the email_verification and password_reset tokens and keeps the refresh and link rows', async () => {
    const rows = await scratch<{ purpose: string; tokenHash: string }[]>`
      select purpose, token_hash as "tokenHash" from user_tokens order by purpose`

    expect(rows).toEqual([
      { purpose: 'refresh', tokenHash: refreshHash },
      { purpose: 'sign_in_link', tokenHash: signInHash },
    ])
  })

  it('deletes the removed notification types and their preferences, and keeps the others', async () => {
    const notifications = await scratch`select type from notifications where user_id = ${userId}`
    const preferences = await scratch`
      select notification_type from notification_preferences where user_id = ${userId}`

    expect(notifications).toEqual([{ type: 'tenant_invitation' }])
    expect(preferences).toEqual([{ notification_type: 'tenant_invitation' }])
  })

  it('drops users.password_hash and keeps the user', async () => {
    const columns = await scratch`
      select 1 from information_schema.columns
      where table_name = 'users' and column_name = 'password_hash'`
    const users = await scratch`select id from users where id = ${userId}`

    expect(columns).toHaveLength(0)
    expect(users).toEqual([{ id: userId }])
  })

  it.each(['email_verification', 'password_reset'])(
    'refuses a new %s token with the narrowed purpose CHECK',
    async (purpose) => {
      await expect(scratch`
        insert into user_tokens (user_id, purpose, token_hash, expires_at)
        values (${userId}, ${purpose}, ${tokenHash()}, now() + interval '1 hour')`).rejects.toMatchObject(
        {
          code: '23514',
          constraint_name: 'user_tokens_purpose_check',
        }
      )
    }
  )

  it('refuses a refresh row that carries an address with the narrowed shape CHECK', async () => {
    await expect(scratch`
      insert into user_tokens (user_id, purpose, email, token_hash, expires_at)
      values (${userId}, 'refresh', 'ada@example.test', ${tokenHash()}, now() + interval '1 hour')`).rejects.toMatchObject(
      {
        code: '23514',
        constraint_name: 'user_tokens_shape_check',
      }
    )
  })
})
