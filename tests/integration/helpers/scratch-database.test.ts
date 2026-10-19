/**
 * @file `dropScratchDatabase` against the real Postgres: it refuses any name
 * that is not a scratch name, and it waits out a client of the caller's own
 * role that is still connected (55006) instead of failing. The scratch
 * database here is created and dropped by this file alone.
 */
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { dropScratchDatabase } from '../../helpers/scratch-database'
import { waitUntil } from '../../helpers/timing'
import { baseDatabaseUrl } from '../../helpers/worker-database'

/**
 * The base URL every test database is derived from.
 * @returns The URL global setup recorded.
 * @throws {Error} When global setup has not run.
 */
function requireBaseUrl(): string {
  const base = baseDatabaseUrl()
  if (base === undefined)
    throw new Error('TEST_DATABASE_BASE_URL is not set: did global setup run?')
  return base
}

const baseUrl = requireBaseUrl()
const baseName = new URL(baseUrl).pathname.slice(1)
const scratchName = `${baseName}_m0000_w${process.env.VITEST_POOL_ID ?? '0'}`
const scratchUrl = (() => {
  const url = new URL(baseUrl)
  url.pathname = `/${scratchName}`
  return url.href
})()

const admin = postgres(baseUrl, { max: 1, onnotice: () => {} })

/**
 * Whether the scratch database exists.
 * @returns True while it does.
 */
async function hasScratchDatabase(): Promise<boolean> {
  const rows = await admin`select 1 from pg_database where datname = ${scratchName}`
  return rows.length > 0
}

afterAll(async () => {
  await dropScratchDatabase(admin, scratchName)
  await admin.end({ timeout: 5 })
})

describe('dropScratchDatabase', () => {
  it('refuses a name that is not a scratch name, dropping nothing', async () => {
    await expect(dropScratchDatabase(admin, baseName)).rejects.toThrow(/not a scratch database/)
    await expect(dropScratchDatabase(admin, `${scratchName}; drop`)).rejects.toThrow(
      /not a scratch database/
    )
  })

  it('waits for a connected client of its own role to leave, then drops', async () => {
    await dropScratchDatabase(admin, scratchName)
    await admin.unsafe(`create database "${scratchName}"`)
    const holder = postgres(scratchUrl, { max: 1, onnotice: () => {} })
    await holder`select 1`

    const dropping = dropScratchDatabase(admin, scratchName)
    // The first drop meets the holder and answers 55006; the helper is then between retries.
    await waitUntil(
      async () => {
        const rows = await admin`
          select 1 from pg_stat_activity
          where datname = ${scratchName} and pid <> pg_backend_pid()`
        return rows.length > 0
      },
      { message: 'the holder is connected' }
    )
    await holder.end({ timeout: 5 })
    await dropping

    expect(await hasScratchDatabase()).toBe(false)
  })
})
