/**
 * @file Direct, deterministic proof that per-worker test databases (see
 * `tests/helpers/worker-database.ts`) isolate concurrent workers,
 * whichever workers vitest's scheduler assigns this run to. It connects to
 * worker 1's and worker 2's databases directly and inserts the identical
 * email into each: if the two URLs resolved to the same database, the second
 * insert would violate the users table's case-insensitive unique email index
 * (asserted in `migrate.test.ts`) with a real constraint-violation error, not
 * a mismatched assertion.
 */
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vite-plus/test'
import { sql } from '@/services/database.service'
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

    // Were the two worker databases the same database, this insert would violate the case-insensitive unique index instead of succeeding.
    const second = await workerTwoDb`insert into users (email) values (${email}) returning email`
    expect(second[0]?.email).toBe(email)
  })

  it("this worker's shared client (database.service.ts) is on its own worker database, not the shared base", async () => {
    // The inserts above show two separate worker databases exist, not that database.service.ts's sql and db (what every real test uses) point at one of them instead of the base database; if useWorkerDatabase() did nothing, only this assertion would fail.
    const [row] = await sql`select current_database() as name`
    const expected = `${new URL(base).pathname.slice(1)}_w${process.env.VITEST_POOL_ID}`
    expect(row?.name).toBe(expected)
  })
})
