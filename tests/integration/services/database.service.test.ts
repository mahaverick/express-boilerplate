// tests/integration/services/database.service.test.ts
//
// Integration test against the real Postgres started by docker-compose.
// These tests never INSERT/UPDATE/DELETE, so they carry no data-isolation
// risk across parallel vitest forks (pool: 'forks' in vitest.config.ts) —
// the first test that mutates rows is the trigger for a per-worker schema
// or transaction-rollback strategy, not this file.
import { afterAll, describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { closeDatabase, isDatabaseReachable, sql } from '@/services/database.service'

describe('database.service', () => {
  afterAll(async () => {
    await closeDatabase()
  })

  it('connects and answers a trivial query', async () => {
    const rows = await sql`select 1 as ok`
    expect(rows[0]?.ok).toBe(1)
  })

  it('reports health', async () => {
    expect(await isDatabaseReachable()).toBe(true)
  })

  // postgres.js sends `connection` in the startup packet, so every pooled
  // connection carries it. SHOW formats the value with a unit (30000 ms reads
  // back as '30s'); pg_settings gives the raw milliseconds.
  it('applies DB_STATEMENT_TIMEOUT_MS to pooled connections', async () => {
    expect(getEnv().DB_STATEMENT_TIMEOUT_MS).toBe(30_000)

    const shown = await sql<{ statement_timeout: string }[]>`show statement_timeout`
    expect(shown[0]?.statement_timeout).toBe('30s')

    const settings = await sql<{ setting: string }[]>`
      select setting from pg_settings where name = 'statement_timeout'
    `
    expect(Number(settings[0]?.setting)).toBe(getEnv().DB_STATEMENT_TIMEOUT_MS)
  })

  it('is safe to close twice', async () => {
    await closeDatabase()
    await expect(closeDatabase()).resolves.toBeUndefined()
  })

  it('reports unhealthy once the pool is closed', async () => {
    expect(await isDatabaseReachable()).toBe(false)
  })
})
