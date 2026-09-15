// tests/integration/services/database.service.test.ts
//
// Integration test against the real Postgres started by docker-compose.
// These tests never INSERT/UPDATE/DELETE, so they carry no data-isolation
// risk across parallel vitest forks (pool: 'forks' in vitest.config.ts) —
// the first test that mutates rows is the trigger for a per-worker schema
// or transaction-rollback strategy, not this file.
import { afterAll, describe, expect, it } from 'vitest'
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

  it('is safe to close twice', async () => {
    await closeDatabase()
    await expect(closeDatabase()).resolves.toBeUndefined()
  })

  it('reports unhealthy once the pool is closed', async () => {
    expect(await isDatabaseReachable()).toBe(false)
  })
})
