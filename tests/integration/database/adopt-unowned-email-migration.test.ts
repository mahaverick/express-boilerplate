/**
 * @file Migration 0031 against a database that holds mail sent before its
 * recipient had an account. The suite's own databases are migrated empty in
 * globalSetup, so this file creates a throwaway database, migrates it to
 * 0030, writes users and `email_messages` rows, applies 0031 and reads who
 * owns each message. Raw SQL throughout; the database is dropped after the
 * tests, as passwordless-migration-data.test.ts does for 0029.
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
const LAST_MIGRATION_BEFORE = 30

/**
 * The base URL every test database is derived from.
 * @returns The URL.
 * @throws {Error} When global setup has not run.
 */
function requireBaseUrl(): string {
  const base = baseDatabaseUrl()
  if (base === undefined)
    throw new Error('TEST_DATABASE_BASE_URL is not set — did global setup run?')
  return base
}

const baseUrl = requireBaseUrl()
const scratchName = `${new URL(baseUrl).pathname.slice(1)}_m0031_w${process.env.VITEST_POOL_ID ?? '0'}`
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
 * A temporary copy of the migrations folder whose journal stops at `lastIndex`.
 * @param lastIndex - The last migration the copy keeps.
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
const earlierFolder = migrationsUpTo(LAST_MIGRATION_BEFORE)
// postgres.js connects on the first query, so this client is safe to build before the database exists.
const scratch = postgres(scratchUrl, { max: 1, onnotice: () => {} })

const ada = randomUUID()
const grace = randomUUID()
const earlierHolder = randomUUID()
const laterHolder = randomUUID()
const goneOnly = randomUUID()

/**
 * The messages this file writes, by name, each with the id it is stored under.
 */
const message = {
  toAda: randomUUID(),
  toAdaUpperCase: randomUUID(),
  ownedByGrace: randomUUID(),
  toNobody: randomUUID(),
  beforeEarlierLeft: randomUUID(),
  ownedByEarlier: randomUUID(),
  afterEarlierLeft: randomUUID(),
  toGoneOnly: randomUUID(),
}

beforeAll(async () => {
  // The scratch name is fixed per worker, so a run that died mid-file may have left the database behind.
  await dropScratchDatabase(admin, scratchName)
  await admin.unsafe(`create database "${scratchName}"`)
  await migrateScratch(earlierFolder)
  const before = postgres(scratchUrl, { max: 1, onnotice: () => {} })
  try {
    await before`
      insert into users (id, email, deleted_at) values
        (${ada}, 'ada@example.test', null),
        (${grace}, 'grace@example.test', null),
        (${earlierHolder}, 'shared@example.test', now() - interval '1 hour'),
        (${laterHolder}, 'shared@example.test', null),
        (${goneOnly}, 'gone@example.test', now() - interval '1 hour')`
    // An empty owner is stored as NULL by `nullif`, so the table reads as the rows it writes.
    const rows: [string, string, string, string][] = [
      [message.toAda, 'ada@example.test', '', '10 minutes'],
      [message.toAdaUpperCase, 'ADA@Example.test', '', '10 minutes'],
      [message.ownedByGrace, 'ada@example.test', grace, '10 minutes'],
      [message.toNobody, 'nobody@example.test', '', '10 minutes'],
      [message.beforeEarlierLeft, 'shared@example.test', '', '2 hours'],
      [message.ownedByEarlier, 'shared@example.test', earlierHolder, '2 hours'],
      [message.afterEarlierLeft, 'shared@example.test', '', '30 minutes'],
      [message.toGoneOnly, 'gone@example.test', '', '10 minutes'],
    ]
    for (const [id, recipient, userId, age] of rows) {
      const header = '<' + id + '@example.test>'
      await before`
        insert into email_messages (id, recipient, template_key, user_id, sender_class, message_id_header, status, created_at)
        values (${id}, ${recipient}, 'tenant_invitation', nullif(${userId}, ''), 'transactional', ${header}, 'sent', now() - ${age}::interval)`
    }
  } finally {
    await before.end({ timeout: 5 })
  }
  await migrateScratch(MIGRATIONS_FOLDER)
}, 60_000)

afterAll(async () => {
  await scratch.end({ timeout: 5 })
  await dropScratchDatabase(admin, scratchName)
  await admin.end({ timeout: 5 })
  fs.rmSync(earlierFolder, { recursive: true, force: true })
})

/**
 * The account a message belongs to after the migration.
 * @param id - The message.
 * @returns Its `user_id`, or null.
 */
async function ownerOf(id: string): Promise<string | null> {
  const [row] = await scratch<{ userId: string | null }[]>`
    select user_id as "userId" from email_messages where id = ${id}`
  if (!row) throw new Error(`message ${id} is gone`)
  return row.userId
}

describe('migration 0031 over mail sent before the account existed', () => {
  it("gives the live account its address's unowned mail, whatever the case", async () => {
    expect(await ownerOf(message.toAda)).toBe(ada)
    expect(await ownerOf(message.toAdaUpperCase)).toBe(ada)
  })

  it('never moves mail another account owns', async () => {
    expect(await ownerOf(message.ownedByGrace)).toBe(grace)
    expect(await ownerOf(message.ownedByEarlier)).toBe(earlierHolder)
  })

  it('leaves mail to an address no live account holds unowned', async () => {
    expect(await ownerOf(message.toNobody)).toBeNull()
    expect(await ownerOf(message.toGoneOnly)).toBeNull()
  })

  it('adopts only the mail sent after an earlier holder of the address left', async () => {
    expect(await ownerOf(message.beforeEarlierLeft)).toBeNull()
    expect(await ownerOf(message.afterEarlierLeft)).toBe(laterHolder)
  })
})
