/**
 * @file Migration 0030 against a database that holds rows of every 0029
 * purpose. The suite's own databases are migrated empty in globalSetup, so
 * this file creates a throwaway database, migrates it to 0029, writes a
 * `refresh`, a `sign_in_link` and a `step_up_link` row, applies 0030 and
 * checks that every row survived the re-added CHECKs and that the new
 * `invitation_link` shape is accepted, refused when malformed, and deleted
 * with its invitation. Raw SQL throughout; the database is dropped after the
 * tests, as passwordless-migration-data.test.ts does for 0029.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropScratchDatabase } from '../../helpers/scratch-database'
import { baseDatabaseUrl } from '../../helpers/worker-database'

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'src/database/migrations')
const LAST_MIGRATION_BEFORE_INVITATION_LINKS = 29

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
const scratchName = `${new URL(baseUrl).pathname.slice(1)}_m0030_w${process.env.VITEST_POOL_ID ?? '0'}`
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
const before = migrationsUpTo(LAST_MIGRATION_BEFORE_INVITATION_LINKS)
// postgres.js connects on the first query, so this client is safe to build before the database exists.
const scratch = postgres(scratchUrl, { max: 1, onnotice: () => {} })
const userId = randomUUID()
const tenantId = randomUUID()
const invitationId = randomUUID()
const seeded = { refresh: tokenHash(), sign_in_link: tokenHash(), step_up_link: tokenHash() }
// eslint-disable-next-line unicorn/no-null -- a SQL NULL parameter: postgres.js refuses undefined
const SQL_NULL = null

beforeAll(async () => {
  // The scratch name is fixed per worker, so a run that died mid-file may have left the database behind.
  await dropScratchDatabase(admin, scratchName)
  await admin.unsafe(`create database "${scratchName}"`)
  await migrateScratch(before)
  const older = postgres(scratchUrl, { max: 1, onnotice: () => {} })
  try {
    await older`insert into users (id, email) values (${userId}, 'ada@example.test')`
    await older`
      insert into tenants (id, name, slug) values (${tenantId}, 'Acme Inc', 'acme-m0030')`
    await older`
      insert into tenant_invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at)
      values (${invitationId}, ${tenantId}, 'grace@example.test', 'editor', ${tokenHash()}, ${userId},
        now() + interval '3 days')`
    await older`
      insert into user_tokens (user_id, purpose, session_id, token_hash, expires_at)
      values (${userId}, 'refresh', ${randomUUID()}, ${seeded.refresh}, now() + interval '1 hour')`
    await older`
      insert into user_tokens (purpose, email, app, redirect, token_hash, expires_at)
      values ('sign_in_link', 'grace@example.test', 'web', '/tenants', ${seeded.sign_in_link},
        now() + interval '15 minutes')`
    await older`
      insert into user_tokens (user_id, purpose, session_id, email, app, token_hash, expires_at)
      values (${userId}, 'step_up_link', ${randomUUID()}, 'ada@example.test', 'apex',
        ${seeded.step_up_link}, now() + interval '15 minutes')`
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
})

/**
 * Insert an `invitation_link` row with raw SQL; `overrides` replace single columns.
 */
async function insertInvitationLink(
  overrides: {
    userId?: string
    sessionId?: string
    redirect?: string
    hasInvitation?: boolean
  } = {}
): Promise<string> {
  const hash = tokenHash()
  await scratch`
    insert into user_tokens (purpose, user_id, session_id, email, app, redirect, invitation_id, token_hash, expires_at)
    values ('invitation_link', ${overrides.userId ?? SQL_NULL}, ${overrides.sessionId ?? SQL_NULL},
      'grace@example.test', 'web', ${overrides.redirect ?? SQL_NULL},
      ${overrides.hasInvitation === false ? SQL_NULL : invitationId}, ${hash},
      now() + interval '15 minutes')`
  return hash
}

const SHAPE = { code: '23514', constraint_name: 'user_tokens_shape_check' }

describe('migration 0030 over rows of every 0029 purpose', () => {
  it('keeps the refresh, sign_in_link and step_up_link rows, each with invitation_id NULL', async () => {
    const rows = await scratch<
      { purpose: string; tokenHash: string; invitationId: string | null }[]
    >`
      select purpose, token_hash as "tokenHash", invitation_id as "invitationId"
      from user_tokens order by purpose`

    expect(rows).toEqual([
      // eslint-disable-next-line unicorn/no-null -- the new column starts NULL
      { purpose: 'refresh', tokenHash: seeded.refresh, invitationId: null },
      // eslint-disable-next-line unicorn/no-null -- the new column starts NULL
      { purpose: 'sign_in_link', tokenHash: seeded.sign_in_link, invitationId: null },
      // eslint-disable-next-line unicorn/no-null -- the new column starts NULL
      { purpose: 'step_up_link', tokenHash: seeded.step_up_link, invitationId: null },
    ])
  })

  it('accepts an invitation_link row', async () => {
    const hash = await insertInvitationLink()

    const rows = await scratch`select purpose from user_tokens where token_hash = ${hash}`
    expect(rows).toEqual([{ purpose: 'invitation_link' }])
  })

  it('refuses an invitation_link row with a user, a session, a redirect or no invitation', async () => {
    await expect(insertInvitationLink({ userId })).rejects.toMatchObject(SHAPE)
    await expect(insertInvitationLink({ sessionId: randomUUID() })).rejects.toMatchObject(SHAPE)
    await expect(insertInvitationLink({ redirect: '/tenants' })).rejects.toMatchObject(SHAPE)
    await expect(insertInvitationLink({ hasInvitation: false })).rejects.toMatchObject(SHAPE)
  })

  it('refuses an invitation_id on a sign_in_link row', async () => {
    await expect(scratch`
      insert into user_tokens (purpose, email, app, invitation_id, token_hash, expires_at)
      values ('sign_in_link', 'grace@example.test', 'web', ${invitationId}, ${tokenHash()},
        now() + interval '15 minutes')`).rejects.toMatchObject(SHAPE)
  })

  it('deletes the invitation’s links with the invitation', async () => {
    const hash = await insertInvitationLink()

    await scratch`delete from tenant_invitations where id = ${invitationId}`

    expect(await scratch`select 1 from user_tokens where token_hash = ${hash}`).toHaveLength(0)
  })
})
