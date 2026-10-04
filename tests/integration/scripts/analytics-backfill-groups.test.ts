/**
 * @file Exercises `runAnalyticsBackfillGroups` against the real per-worker
 * Postgres: the exit code and what it prints. What it queues is covered in
 * `tests/integration/services/analytics/analytics-backfill.service.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AnalyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { runAnalyticsBackfillGroups } from '@/scripts/analytics-backfill-groups'
import { sql } from '@/services/database.service'
import { withMutatedMethod } from '../../helpers/mutate'

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true }
})

const state: { tenantId?: string } = {}

beforeAll(async () => {
  // At least one tenant, so there is a batch to queue.
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values ('Backfill script', ${`backfill-script-${randomUUID()}`})
    returning id`
  if (!row) throw new Error('tenant insert returned no row')
  state.tenantId = row.id
})

afterEach(async () => {
  vi.restoreAllMocks()
  await sql`delete from analytics_outbox`
})

afterAll(async () => {
  if (state.tenantId) await sql`delete from tenants where id = ${state.tenantId}`
})

describe('runAnalyticsBackfillGroups', () => {
  it('prints the counts and exits 0, ignoring pnpm’s --', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const code = await runAnalyticsBackfillGroups(['--'])

    expect(code).toBe(0)
    expect(stdout).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Queued \d+ tenant group markers in \d+ batches; the analytics Worker sends them\.\n$/
      )
    )
  })

  it('exits 1 with the reason when an insert fails', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await withMutatedMethod(
      AnalyticsOutboxRepository.prototype,
      'insertMany',
      () => Promise.reject(new Error('insert refused')),
      async () => {
        expect(await runAnalyticsBackfillGroups([])).toBe(1)
      }
    )

    expect(stderr).toHaveBeenCalledWith(
      'Queuing batch 1 failed; 0 tenants were queued before it: insert refused\n'
    )
  })

  it('exits 1 with the usage line for any argument', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await runAnalyticsBackfillGroups(['--', 'extra'])

    expect(code).toBe(1)
    expect(stderr).toHaveBeenCalledWith('Usage: pnpm analytics:backfill-groups\n')
  })
})
