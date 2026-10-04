/**
 * @file Every event the drainer sends is signed, against the real per-worker
 * Postgres and the fake PostHog: an audit event, a `$set` row and a
 * resolved `$groupidentify` marker each reach PostHog with a `server_sig`
 * that `isAnalyticsSignatureValid` accepts over the fields as sent, while the
 * outbox rows themselves never hold one. Analytics is enabled for this file
 * only, through a mocked `getEnv()`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { drainAnalyticsOutbox } from '@/services/analytics/analytics-drain.service'
import { buildTenantGroupIdentify } from '@/services/analytics/analytics-event-builder.service'
import {
  isAnalyticsSignatureValid,
  signedFieldsOf,
} from '@/services/analytics/analytics-signature.service'
import type { PosthogBatchEvent } from '@/services/analytics/posthog-batch.service'
import { sql } from '@/services/database.service'
import { startFakePosthog, type FakePosthog } from '../../../helpers/fake-posthog'

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
 * Insert one outbox row.
 * @param event - Its event name.
 * @param distinctId - Its distinct id.
 * @param properties - Its stored properties.
 */
async function seed(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>
): Promise<void> {
  await sql`
    insert into analytics_outbox (event, distinct_id, properties, occurred_at)
    values (${event}, ${distinctId}, ${JSON.stringify(properties)}::jsonb, now() - interval '1 second')`
}

/**
 * Whether a sent event's `server_sig` verifies over the fields it was sent with.
 * @param sent - The event as the fake received it.
 * @returns The verifier's answer.
 */
function isVerified(sent: PosthogBatchEvent): boolean {
  return isAnalyticsSignatureValid(
    signedFieldsOf(
      { uuid: sent.uuid, event: sent.event, distinctId: sent.distinct_id },
      sent.properties
    ),
    String(sent.properties.server_sig)
  )
}

beforeAll(async () => {
  state.posthog = await startFakePosthog()
  target.host = state.posthog.url
  await sql`delete from analytics_outbox`
})

afterEach(async () => {
  posthog().batches.length = 0
  posthog().requests.length = 0
  await sql`delete from analytics_outbox`
})

afterAll(async () => {
  if (state.tenantIds.length > 0) await sql`delete from tenants where id = any(${state.tenantIds})`
  await state.posthog?.close()
})

describe('drainAnalyticsOutbox signing', () => {
  it('sends an audit event, a $set row and a group marker each with a server_sig that verifies', async () => {
    const slug = `signed-${randomUUID()}`
    const [tenant] = await sql<{ id: string }[]>`
      insert into tenants (name, slug) values ('Signed Co', ${slug}) returning id`
    if (!tenant) throw new Error('tenant insert returned no row')
    state.tenantIds.push(tenant.id)
    await seed('member_removed', 'user-1', {
      source: 'audit',
      access: 'platform',
      app: 'api',
      target_type: 'user',
      target_id: 'user-2',
      $groups: { tenant: tenant.id },
    })
    await seed('$set', 'user-2', { source: 'audit', access: 'platform', $set: { is_staff: false } })
    const marker = buildTenantGroupIdentify({ id: tenant.id }, {}, 'audit', new Date())
    await seed(marker.event, marker.distinctId, marker.properties)

    await expect(drainAnalyticsOutbox()).resolves.toMatchObject({ sent: 3 })

    const sent = posthog().batches.flat()
    expect(sent.map((event) => event.event).toSorted((a, b) => a.localeCompare(b))).toEqual([
      '$groupidentify',
      '$set',
      'member_removed',
    ])
    for (const event of sent) {
      expect(event.properties.server_sig).toMatch(/^[0-9a-f]{32}$/)
      expect(isVerified(event)).toBe(true)
    }
    // A signature over other fields does not verify: a forged target is caught.
    const forged = sent.find((event) => event.event === 'member_removed')
    if (!forged) throw new Error('member_removed was not sent')
    expect(
      isVerified({ ...forged, properties: { ...forged.properties, target_id: 'user-9' } })
    ).toBe(false)
  })

  it('never stores the signature in the outbox', async () => {
    await seed('user_signed_in', 'user-1', { source: 'product' })
    const kept = posthog()
    kept.respondWith(503)
    try {
      await drainAnalyticsOutbox()
    } finally {
      kept.respondWith(200)
    }
    expect(posthog().batches.flat()[0]?.properties.server_sig).toMatch(/^[0-9a-f]{32}$/)
    const [row] = await sql<{ properties: Record<string, unknown> }[]>`
      select properties from analytics_outbox`
    expect(row?.properties).toEqual({ source: 'product' })
  })
})
