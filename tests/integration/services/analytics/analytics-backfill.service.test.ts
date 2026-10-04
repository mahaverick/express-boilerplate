/**
 * @file backfillTenantGroups against the real per-worker Postgres: every
 * tenant row, archived and soft-deleted ones included, is queued once in the
 * outbox as a `$groupidentify` marker with no `$group_set`, page by page; a
 * failed insert stops the run with an error; and nothing is queued while
 * analytics is off. The drainer turns the markers into group properties
 * (analytics-group-marker.service.test.ts). Other files' tenants live in
 * the same database, so assertions pick out this file's own.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { backfillTenantGroups } from '@/services/analytics/analytics-backfill.service'
import { sql } from '@/services/database.service'
import { outboxRows, outboxRowsOf } from '../../../helpers/analytics-outbox'
import { withMutatedMethod } from '../../../helpers/mutate'

const analytics = vi.hoisted(() => ({ isEnabled: true }))

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => analytics.isEnabled }
})

const state: { tenantIds: string[] } = { tenantIds: [] }

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
 * The queued markers for one tenant.
 * @param tenantId - The tenant.
 * @returns Those outbox rows.
 */
async function markersFor(tenantId: string) {
  const rows = await outboxRowsOf('$groupidentify')
  return rows.filter((row) => row.properties.$group_key === tenantId)
}

beforeEach(async () => {
  await sql`delete from analytics_outbox`
})

afterEach(() => {
  analytics.isEnabled = true
})

afterAll(async () => {
  await sql`delete from analytics_outbox`
  if (state.tenantIds.length > 0) await sql`delete from tenants where id = any(${state.tenantIds})`
})

describe('backfillTenantGroups', () => {
  it('queues every tenant once as a marker, with no name or status stored', async () => {
    const active = await insertTenant('active')
    const archived = await insertTenant('archived')

    const result = await backfillTenantGroups()

    const [total] = await sql<{ count: number }[]>`select count(*)::int as count from tenants`
    expect(result.tenants).toBe(total?.count)
    expect(await outboxRows()).toHaveLength(result.tenants)
    expect(await markersFor(active.id)).toEqual([
      expect.objectContaining({
        event: '$groupidentify',
        distinctId: `$tenant_${active.id}`,
        properties: { source: 'backfill', $group_type: 'tenant', $group_key: active.id },
      }),
    ])
    expect(await markersFor(archived.id)).toHaveLength(1)
    const stored = JSON.stringify(await outboxRows())
    expect(stored).not.toContain(active.name)
    expect(stored).not.toContain('$group_set')
  })

  it('pages: one insert per page and no tenant queued twice', async () => {
    await insertTenant('active')
    await insertTenant('suspended')

    const result = await backfillTenantGroups(1)

    expect(result.batches).toBe(result.tenants)
    const queued = await outboxRows()
    const keys = queued.map((row) => row.properties.$group_key)
    expect(keys).toHaveLength(result.tenants)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('stops with an error at the first insert that fails, keeping the pages before it', async () => {
    await insertTenant('active')
    await insertTenant('active')
    const calls = { count: 0 }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the repository as `this`
    const realInsertMany = AnalyticsOutboxRepository.prototype.insertMany

    await withMutatedMethod(
      AnalyticsOutboxRepository.prototype,
      'insertMany',
      async function (this: AnalyticsOutboxRepository, rows, executor) {
        calls.count += 1
        if (calls.count === 2) throw new Error('insert refused')
        await realInsertMany.call(this, rows, executor)
      },
      async () => {
        await expect(backfillTenantGroups(1)).rejects.toThrow(
          'Queuing batch 2 failed; 1 tenants were queued before it'
        )
      }
    )
    expect(await outboxRows()).toHaveLength(1)
  })

  it('refuses to run when analytics is not configured', async () => {
    analytics.isEnabled = false
    await expect(backfillTenantGroups()).rejects.toThrow('POSTHOG_PROJECT_KEY is not set')
    expect(await outboxRows()).toEqual([])
  })
})
