/**
 * @file backfillTenantGroups against the real per-worker Postgres and the fake
 * PostHog: every tenant row, archived and soft-deleted ones included, is sent
 * once as a `$groupidentify`, page by page, and a batch PostHog does not
 * acknowledge stops the run with an error. Other files' tenants live in the
 * same database, so assertions pick out this file's own.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { backfillTenantGroups } from '@/services/analytics/analytics-backfill.service'
import type { PosthogBatchEvent } from '@/services/analytics/posthog-batch.service'
import { sql } from '@/services/database.service'
import { startFakePosthog, type FakePosthog } from '../../../helpers/fake-posthog'

const target = vi.hoisted((): { host: string; key: string | undefined } => ({
  host: 'http://127.0.0.1:1',
  key: 'phc_test_key_not_real',
}))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_PROJECT_KEY: target.key,
      POSTHOG_HOST: target.host,
    }),
  }
})

// vitest types `expect.any(...)` as `any`; one typed instance for every assertion below.
const ANY_STRING = expect.any(String) as unknown as string

const state: { posthog?: FakePosthog; tenantIds: string[] } = { tenantIds: [] }

/**
 * The running fake.
 * @returns It.
 */
function posthog(): FakePosthog {
  if (!state.posthog) throw new Error('the fake PostHog is not running')
  return state.posthog
}

/**
 * Insert one tenant row directly.
 * @param lifecycle - Its lifecycle state; an archived tenant is also soft-deleted.
 * @returns Its id and name.
 */
async function insertTenant(
  lifecycle: 'active' | 'suspended' | 'archived'
): Promise<{ id: string; name: string }> {
  const name = `Backfill ${randomUUID()}`
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug, lifecycle_state)
    values (${name}, ${`backfill-${randomUUID()}`}, ${lifecycle})
    returning id`
  if (!row) throw new Error('tenant insert returned no row')
  if (lifecycle === 'archived')
    await sql`update tenants set deleted_at = now() where id = ${row.id}`
  state.tenantIds.push(row.id)
  return { id: row.id, name }
}

/**
 * The `$groupidentify` events the fake received for one tenant.
 * @param tenantId - The tenant.
 * @returns Those events.
 */
function groupEventsFor(tenantId: string): PosthogBatchEvent[] {
  return posthog()
    .batches.flat()
    .filter((event) => event.properties.$group_key === tenantId)
}

beforeAll(async () => {
  state.posthog = await startFakePosthog()
  target.host = state.posthog.url
})

afterEach(() => {
  posthog().respondWith(200)
  posthog().batches.length = 0
  posthog().requests.length = 0
  target.key = 'phc_test_key_not_real'
})

afterAll(async () => {
  if (state.tenantIds.length > 0) await sql`delete from tenants where id = any(${state.tenantIds})`
  await state.posthog?.close()
})

describe('backfillTenantGroups', () => {
  it('sends every tenant once as a $groupidentify with its name, status and created_at', async () => {
    const active = await insertTenant('active')
    const archived = await insertTenant('archived')

    const result = await backfillTenantGroups()

    const [total] = await sql<{ count: number }[]>`select count(*)::int as count from tenants`
    expect(result.tenants).toBe(total?.count)
    expect(groupEventsFor(active.id)).toEqual([
      {
        event: '$groupidentify',
        distinct_id: `$tenant_${active.id}`,
        uuid: ANY_STRING,
        timestamp: ANY_STRING,
        properties: {
          source: 'backfill',
          access: 'system',
          app: 'api',
          $group_type: 'tenant',
          $group_key: active.id,
          $group_set: {
            name: active.name,
            status: 'active',
            created_at: ANY_STRING,
          },
        },
      },
    ])
    expect(groupEventsFor(archived.id)).toHaveLength(1)
    expect(groupEventsFor(archived.id)[0]?.properties.$group_set).toMatchObject({
      status: 'archived',
    })
  })

  it('pages: no batch exceeds the page size and no tenant is sent twice', async () => {
    await insertTenant('active')
    await insertTenant('suspended')

    const result = await backfillTenantGroups(1)

    expect(result.batches).toBe(result.tenants)
    expect(posthog().batches.every((batch) => batch.length === 1)).toBe(true)
    const keys = posthog()
      .batches.flat()
      .map((event) => event.properties.$group_key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('stops with an error at the first batch PostHog does not acknowledge', async () => {
    await insertTenant('active')
    posthog().respondWith(400)

    await expect(backfillTenantGroups()).rejects.toThrow(
      'PostHog answered rejected 400 to batch 1; 0 tenants were sent before it'
    )
    expect(posthog().batches).toHaveLength(1)
  })

  it('refuses to run when analytics is not configured', async () => {
    target.key = undefined
    await expect(backfillTenantGroups()).rejects.toThrow('POSTHOG_PROJECT_KEY is not set')
    expect(posthog().requests).toHaveLength(0)
  })
})
