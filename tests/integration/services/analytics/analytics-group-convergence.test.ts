/**
 * @file Group properties converge, against the real per-worker Postgres and
 * the fake PostHog: two markers for one tenant, with a rename committed
 * between them and drained in reverse order, both carry the latest name; a
 * tenant suspended and reactivated between enqueue and send goes out
 * active; `purgeTenant` queues a marker that goes out as the scrub; and a
 * failed tenant read sends nothing and keeps every claimed row for the next
 * drain. Analytics is enabled for this file only, through a mocked `getEnv()`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANALYTICS_LEASE_SECONDS } from '@/constants/analytics.constants'
import { TenantRepository } from '@/repositories/tenant.repository'
import { drainAnalyticsOutbox } from '@/services/analytics/analytics-drain.service'
import { buildTenantGroupIdentify } from '@/services/analytics/analytics-event-builder.service'
import type { PosthogBatchEvent } from '@/services/analytics/posthog-batch.service'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { purgeTenant } from '@/services/platform-purge.service'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { startFakePosthog, type FakePosthog } from '../../../helpers/fake-posthog'
import { withMutatedMethod } from '../../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../../helpers/platform-users'

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

const SECOND_MS = 1000
// The longest backoff (600 s) plus the lease: past it, every leased row is claimable again.
const PAST_LEASE_AND_BACKOFF_MS = (ANALYTICS_LEASE_SECONDS + 600 + 1) * SECOND_MS

const tenantRepository = new TenantRepository()
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
 * @param name - Its name.
 * @returns Its id.
 */
async function insertTenant(name: string): Promise<string> {
  const slug = `converge-${randomUUID()}`
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values (${name}, ${slug}) returning id`
  if (!row) throw new Error('tenant insert returned no row')
  state.tenantIds.push(row.id)
  return row.id
}

/**
 * Queue one marker for a tenant, as the builder writes it.
 * @param tenantId - The tenant.
 * @param occurredAt - Its event time.
 * @returns The outbox row id.
 */
async function queueMarker(tenantId: string, occurredAt: Date): Promise<string> {
  const row = buildTenantGroupIdentify({ id: tenantId }, {}, 'audit', occurredAt)
  const [inserted] = await sql<{ id: string }[]>`
    insert into analytics_outbox (event, distinct_id, properties, occurred_at)
    values (${row.event}, ${row.distinctId}, ${JSON.stringify(row.properties)}::jsonb,
      ${occurredAt.toISOString()}::timestamptz)
    returning id`
  if (!inserted) throw new Error('outbox insert returned no row')
  return inserted.id
}

/**
 * The `$groupidentify` events the fake received for one tenant, in send order.
 * @param tenantId - The tenant.
 * @returns Those events.
 */
function sentMarkersFor(tenantId: string): PosthogBatchEvent[] {
  return posthog()
    .batches.flat()
    .filter((event) => event.event === '$groupidentify' && event.properties.$group_key === tenantId)
}

beforeAll(async () => {
  state.posthog = await startFakePosthog()
  target.host = state.posthog.url
})

beforeEach(async () => {
  await sql`delete from analytics_outbox`
})

afterEach(async () => {
  vi.restoreAllMocks()
  posthog().batches.length = 0
  posthog().requests.length = 0
  await sql`delete from analytics_outbox`
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

afterAll(async () => {
  if (state.tenantIds.length > 0) await sql`delete from tenants where id = any(${state.tenantIds})`
  await state.posthog?.close()
})

describe('group marker convergence', () => {
  it('sends the latest name on both markers when a rename lands between them and they drain in reverse order', async () => {
    const tenantId = await insertTenant('Before Rename')
    const now = new Date()
    const older = await queueMarker(tenantId, new Date(now.getTime() - 2 * SECOND_MS))
    await sql`update tenants set name = 'After Rename' where id = ${tenantId}`
    await queueMarker(tenantId, new Date(now.getTime() - SECOND_MS))
    // The older marker is still leased by an earlier drain whose send is being retried.
    const leasedUntil = new Date(now.getTime() + 60 * SECOND_MS)
    await sql`
      update analytics_outbox set claimed_until = ${leasedUntil.toISOString()}::timestamptz
      where id = ${older}`

    const later = new Date(now.getTime() + PAST_LEASE_AND_BACKOFF_MS)
    await expect(drainAnalyticsOutbox(now)).resolves.toMatchObject({ sent: 1 })
    await expect(drainAnalyticsOutbox(later)).resolves.toMatchObject({ sent: 1 })

    const sent = sentMarkersFor(tenantId)
    expect(sent.map((event) => event.uuid).at(-1)).toBe(older)
    expect(sent.map((event) => event.properties.$group_set)).toEqual([
      expect.objectContaining({ name: 'After Rename', status: 'active' }),
      expect.objectContaining({ name: 'After Rename', status: 'active' }),
    ])
  })

  it('sends the state at send time when a tenant is suspended and reactivated after the marker was queued', async () => {
    const tenantId = await insertTenant('Bouncing Co')
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenantId}`
    await queueMarker(tenantId, new Date(Date.now() - SECOND_MS))
    await sql`update tenants set lifecycle_state = 'active' where id = ${tenantId}`

    await drainAnalyticsOutbox()

    expect(sentMarkersFor(tenantId).map((event) => event.properties.$group_set)).toEqual([
      expect.objectContaining({ name: 'Bouncing Co', status: 'active' }),
    ])
  })

  it('queues a marker in purgeTenant that goes out as the scrub', async () => {
    const { user: owner } = await createTrackedStaff('owner')
    const member = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Purged Co',
      slug: `purged-${randomUUID()}`,
      ownerId: member.id,
    })
    state.tenantIds.push(tenant.id)
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenant.id}`

    await purgeTenant({ userId: owner.id }, tenant.id, 'Customer asked, ticket 7')
    const [queued] = await sql<{ properties: Record<string, unknown> }[]>`
      select properties from analytics_outbox
      where event = '$groupidentify' and properties ->> '$group_key' = ${tenant.id}`
    expect(queued?.properties).toEqual({
      source: 'audit',
      $group_type: 'tenant',
      $group_key: tenant.id,
    })

    await drainAnalyticsOutbox()

    // eslint-disable-next-line unicorn/no-null -- null is what clears the group's name in PostHog
    const scrub = { name: null, status: 'purged' }
    expect(sentMarkersFor(tenant.id).map((event) => event.properties.$group_set)).toEqual([scrub])
    expect(JSON.stringify(posthog().batches)).not.toContain('Purged Co')
  })

  it('sends nothing and keeps every claimed row when the tenant read fails', async () => {
    const tenantId = await insertTenant('Unread Co')
    const now = new Date()
    await queueMarker(tenantId, new Date(now.getTime() - SECOND_MS))
    await sql`
      insert into analytics_outbox (event, distinct_id, properties, occurred_at)
      values ('user_signed_in', 'user-1', '{"source":"product"}'::jsonb,
        ${new Date(now.getTime() - SECOND_MS).toISOString()}::timestamptz)`
    const warn = vi.spyOn(logger, 'warn')

    await withMutatedMethod(
      TenantRepository.prototype,
      'listGroupSnapshotsByIds',
      () => Promise.reject(new Error('tenant read failed')),
      async () => {
        await expect(drainAnalyticsOutbox(now)).resolves.toEqual({
          sent: 0,
          retried: 2,
          rejected: 0,
          dropped: 0,
        })
      }
    )

    expect(posthog().requests).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      'analytics batch deferred: reading the tenants of its group markers failed',
      expect.objectContaining({ rows: 2 })
    )
    const rows = await sql<{ attempts: number }[]>`select attempts from analytics_outbox`
    expect(rows.map((row) => row.attempts)).toEqual([1, 1])
    // Leased like a retryable answer: claimable again once the lease and backoff pass.
    const later = new Date(now.getTime() + PAST_LEASE_AND_BACKOFF_MS)
    await expect(drainAnalyticsOutbox(now)).resolves.toMatchObject({ sent: 0, retried: 0 })
    await expect(drainAnalyticsOutbox(later)).resolves.toMatchObject({ sent: 2 })
  })
})
