/**
 * @file Exercises `runAnalyticsBackfillGroups` against the real per-worker
 * Postgres and the fake PostHog: the exit code and what it prints. What it
 * sends is covered in
 * `tests/integration/services/analytics/analytics-backfill.service.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runAnalyticsBackfillGroups } from '@/scripts/analytics-backfill-groups'
import { sql } from '@/services/database.service'
import { startFakePosthog, type FakePosthog } from '../../helpers/fake-posthog'

const target = vi.hoisted(() => ({ host: 'http://127.0.0.1:1' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
      POSTHOG_HOST: target.host,
    }),
  }
})

const state: { posthog?: FakePosthog; tenantId?: string } = {}

beforeAll(async () => {
  state.posthog = await startFakePosthog()
  target.host = state.posthog.url
  // At least one tenant, so there is a batch for PostHog to answer.
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values ('Backfill script', ${`backfill-script-${randomUUID()}`})
    returning id`
  if (!row) throw new Error('tenant insert returned no row')
  state.tenantId = row.id
})

afterEach(() => {
  vi.restoreAllMocks()
  state.posthog?.respondWith(200)
})

afterAll(async () => {
  if (state.tenantId) await sql`delete from tenants where id = ${state.tenantId}`
  await state.posthog?.close()
})

describe('runAnalyticsBackfillGroups', () => {
  it('prints the counts and exits 0, ignoring pnpm’s --', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const code = await runAnalyticsBackfillGroups(['--'])

    expect(code).toBe(0)
    expect(stdout).toHaveBeenCalledWith(
      expect.stringMatching(/^Sent \d+ tenant groups in \d+ batches\.\n$/)
    )
  })

  it('exits 1 with the reason when PostHog rejects a batch', async () => {
    state.posthog?.respondWith(400)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await runAnalyticsBackfillGroups([])

    expect(code).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^PostHog answered rejected 400/))
  })

  it('exits 1 with the usage line for any argument', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await runAnalyticsBackfillGroups(['--', 'extra'])

    expect(code).toBe(1)
    expect(stderr).toHaveBeenCalledWith('Usage: pnpm analytics:backfill-groups\n')
  })
})
