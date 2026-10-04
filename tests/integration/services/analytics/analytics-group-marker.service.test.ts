/**
 * @file resolveGroupMarkers against the real per-worker Postgres: a live
 * tenant's marker gets its current name, status and creation time, an
 * archived one its `archived` status, a purged one the scrub, a stored
 * `$group_set` from an older release is replaced, every other row passes
 * through untouched, and the batch's tenants are read in one query (none
 * when the batch has no marker).
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import { tenantModel } from '@/database/models/tenant.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { resolveGroupMarkers } from '@/services/analytics/analytics-group-marker.service'
import { db, sql } from '@/services/database.service'

const OCCURRED_AT = new Date('2030-01-01T00:00:00.000Z')
const tenantIds: string[] = []

/**
 * Insert one tenant row directly.
 * @param name - Its name.
 * @param lifecycle - Its lifecycle state; an archived tenant is also soft-deleted.
 * @returns Its id and creation time.
 */
async function insertTenant(
  name: string,
  lifecycle: 'active' | 'suspended' | 'archived' = 'active'
): Promise<{ id: string; createdAt: Date }> {
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug, lifecycle_state, deleted_at)
    values (${name}, ${`marker-${randomUUID()}`}, ${lifecycle},
      ${lifecycle === 'archived' ? sql`now()` : sql`null`})
    returning id`
  if (!row) throw new Error('tenant insert returned no row')
  tenantIds.push(row.id)
  const [created] = await db
    .select({ createdAt: tenantModel.createdAt })
    .from(tenantModel)
    .where(eq(tenantModel.id, row.id))
  if (!created) throw new Error('tenant read returned no row')
  return { id: row.id, createdAt: created.createdAt }
}

/**
 * A claimed outbox row, as the drainer holds it.
 * @param event - The event name.
 * @param properties - Its stored properties.
 * @returns The row.
 */
function claimed(event: string, properties: Record<string, unknown>): AnalyticsOutboxRow {
  return {
    id: randomUUID(),
    event,
    distinctId: event === '$groupidentify' ? `$tenant_${String(properties.$group_key)}` : 'user-1',
    properties,
    occurredAt: OCCURRED_AT,
    claimedUntil: OCCURRED_AT,
    attempts: 1,
    rejections: 0,
  }
}

/**
 * A stored tenant marker.
 * @param tenantId - The tenant.
 * @param extra - Further stored properties.
 * @returns The claimed row.
 */
function marker(tenantId: string, extra: Record<string, unknown> = {}): AnalyticsOutboxRow {
  return claimed('$groupidentify', {
    source: 'audit',
    $group_type: 'tenant',
    $group_key: tenantId,
    ...extra,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
})

describe('resolveGroupMarkers', () => {
  it("sets a live tenant's current name, status and created_at, and keeps the marker's own properties", async () => {
    const tenant = await insertTenant('Live Co', 'suspended')

    const [resolved] = await resolveGroupMarkers([marker(tenant.id, { trace_id: 'abc' })])

    expect(resolved?.properties).toEqual({
      source: 'audit',
      trace_id: 'abc',
      $group_type: 'tenant',
      $group_key: tenant.id,
      $group_set: {
        name: 'Live Co',
        status: 'suspended',
        created_at: tenant.createdAt.toISOString(),
      },
    })
  })

  it('sends an archived, soft-deleted tenant with its archived status', async () => {
    const tenant = await insertTenant('Archived Co', 'archived')

    const [resolved] = await resolveGroupMarkers([marker(tenant.id)])

    expect(resolved?.properties.$group_set).toMatchObject({
      name: 'Archived Co',
      status: 'archived',
    })
  })

  it('scrubs a tenant with no row: a null name and the status purged', async () => {
    const [resolved] = await resolveGroupMarkers([marker(randomUUID())])

    // eslint-disable-next-line unicorn/no-null -- null is what clears the property in PostHog
    expect(resolved?.properties.$group_set).toEqual({ name: null, status: 'purged' })
  })

  it('replaces a $group_set stored by an older release with the current state', async () => {
    const tenant = await insertTenant('Current Name')

    const [resolved] = await resolveGroupMarkers([
      marker(tenant.id, { $group_set: { name: 'Stale Name', status: 'suspended', extra: 1 } }),
    ])

    expect(resolved?.properties.$group_set).toEqual({
      name: 'Current Name',
      status: 'active',
      created_at: tenant.createdAt.toISOString(),
    })
  })

  it('reads every distinct tenant of the batch in one query, and leaves other rows alone', async () => {
    const first = await insertTenant('First Co')
    const second = await insertTenant('Second Co')
    const read = vi.spyOn(TenantRepository.prototype, 'listGroupSnapshotsByIds')
    const event = claimed('tenant_updated', { source: 'audit', $groups: { tenant: first.id } })
    const otherGroupType = claimed('$groupidentify', { $group_type: 'company', $group_key: 'c-1' })
    const rows = [marker(first.id), event, marker(second.id), marker(first.id), otherGroupType]

    const resolved = await resolveGroupMarkers(rows)

    expect(read).toHaveBeenCalledOnce()
    expect(read.mock.calls[0]?.[0].toSorted((left, right) => left.localeCompare(right))).toEqual(
      [first.id, second.id].toSorted((left, right) => left.localeCompare(right))
    )
    expect(resolved.map((row) => row.id)).toEqual(rows.map((row) => row.id))
    expect(resolved[1]).toBe(event)
    expect(resolved[4]).toBe(otherGroupType)
    expect(
      resolved.map((row) => (row.properties.$group_set as { name?: string } | undefined)?.name)
    ).toEqual(['First Co', undefined, 'Second Co', 'First Co', undefined])
  })

  it('runs no query for a batch without a tenant marker', async () => {
    const read = vi.spyOn(TenantRepository.prototype, 'listGroupSnapshotsByIds')
    const rows = [claimed('user_signed_in', { source: 'product' })]

    expect(await resolveGroupMarkers(rows)).toBe(rows)
    expect(read).not.toHaveBeenCalled()
  })
})
