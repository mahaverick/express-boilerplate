// tests/integration/database/worker-isolation.test.ts
//
// Direct, deterministic proof that per-worker test databases (see
// tests/helpers/worker-database.ts) actually isolate concurrent workers —
// independent of whatever workers vitest's scheduler happens to assign
// THIS run to two separate test files. Connects to worker 1's and worker
// 2's dedicated databases directly (both already created and migrated by
// tests/helpers/global-setup.ts, regardless of which worker actually runs
// THIS file) and inserts the identical email into each.
//
// If the isolation were broken — both "worker" URLs secretly resolving to
// the same physical database — the second insert would violate
// migrate.test.ts's case-insensitive unique index and this test would fail
// with a real constraint-violation error, not a mismatched assertion. That
// is what "would fail under cross-talk" means here: this test is the
// negative case made concrete, not just asserted.
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { baseDatabaseUrl, testDatabaseUrlForWorker } from '../../helpers/worker-database'

const base = baseDatabaseUrl()
if (base === undefined) {
  throw new Error('TEST_DATABASE_BASE_URL is not set — did global setup run?')
}

const email = `cross-worker-${Date.now()}@example.test`
const workerOneDb = postgres(testDatabaseUrlForWorker(base, 1), { max: 1 })
const workerTwoDb = postgres(testDatabaseUrlForWorker(base, 2), { max: 1 })

describe('worker database isolation', () => {
  afterAll(async () => {
    await workerOneDb`delete from users where lower(email) = lower(${email})`
    await workerTwoDb`delete from users where lower(email) = lower(${email})`
    await workerOneDb.end({ timeout: 5 })
    await workerTwoDb.end({ timeout: 5 })
  })

  it('lets two different worker databases hold the same email without colliding', async () => {
    const first = await workerOneDb`insert into users (email) values (${email}) returning email`
    expect(first[0]?.email).toBe(email)

    // If worker 1's and worker 2's databases were secretly the same
    // physical database, this insert would violate the case-insensitive
    // unique index instead of succeeding.
    const second = await workerTwoDb`insert into users (email) values (${email}) returning email`
    expect(second[0]?.email).toBe(email)
  })
})
