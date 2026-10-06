/**
 * @file sendBatch against the fake PostHog on 127.0.0.1 (no database, no
 * Redis): the request it makes, and how each answer is classified; and
 * toPosthogBatchEvent's wire form (the signature, and `$geoip_disable`
 * forced on without changing the signature). The host
 * and key come from a mocked `getEnv()`, bound once the fake is listening.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { signAnalyticsEvent } from '@/services/analytics/analytics-signature.service'
import {
  classifyStatus,
  sendBatch,
  toPosthogBatchEvent,
  type PosthogBatchEvent,
} from '@/services/analytics/posthog-batch.service'
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
      POSTHOG_HOST: target.host,
      POSTHOG_PROJECT_KEY: target.key,
    }),
  }
})

const EVENT: PosthogBatchEvent = {
  event: 'invitation_created',
  distinct_id: 'user-1',
  properties: { source: 'audit', $groups: { tenant: 'tenant-1' } },
  uuid: '01890000-0000-7000-8000-000000000001',
  timestamp: '2026-10-02T09:00:00.000Z',
}

const fake: { posthog?: FakePosthog } = {}

/**
 * The running fake.
 * @returns It.
 */
function posthog(): FakePosthog {
  if (!fake.posthog) throw new Error('the fake PostHog is not running')
  return fake.posthog
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
  target.host = fake.posthog.url
})

afterEach(() => {
  posthog().respondWith(200)
  posthog().hang(0)
  posthog().requests.length = 0
  posthog().batches.length = 0
  target.host = posthog().url
  target.key = 'phc_test_key_not_real'
})

afterAll(async () => {
  await fake.posthog?.close()
})

describe('sendBatch', () => {
  it('posts { api_key, batch } as JSON to <POSTHOG_HOST>/batch/ and acknowledges a 200', async () => {
    await expect(sendBatch([EVENT])).resolves.toEqual({ kind: 'ack' })

    const [request] = posthog().requests
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe('/batch/')
    expect(request?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request?.body.toString('utf8') ?? '')).toEqual({
      api_key: 'phc_test_key_not_real',
      batch: [EVENT],
    })
  })

  it('drops a trailing slash from POSTHOG_HOST', async () => {
    target.host = `${posthog().url}/`
    await sendBatch([EVENT])
    expect(posthog().requests[0]?.path).toBe('/batch/')
  })

  it.each([
    [400, { kind: 'rejected', status: 400 }],
    [413, { kind: 'rejected', status: 413 }],
    [422, { kind: 'rejected', status: 422 }],
    [401, { kind: 'retry', status: 401 }],
    [404, { kind: 'retry', status: 404 }],
    [429, { kind: 'retry', status: 429 }],
    [500, { kind: 'retry', status: 500 }],
    [503, { kind: 'retry', status: 503 }],
  ])('classifies a %i answer', async (status, expected) => {
    posthog().respondWith(status)
    await expect(sendBatch([EVENT])).resolves.toEqual(expected)
  })

  it('answers retry, without a status, when nothing listens on the host', async () => {
    const closed = await startFakePosthog()
    await closed.close()
    target.host = closed.url

    await expect(sendBatch([EVENT])).resolves.toEqual({ kind: 'retry' })
  })

  it('answers retry when the signal aborts a hanging request', async () => {
    posthog().hang(5000)

    await expect(sendBatch([EVENT], { signal: AbortSignal.timeout(50) })).resolves.toEqual({
      kind: 'retry',
    })
  })

  it('throws when no project key is configured', async () => {
    target.key = undefined
    await expect(sendBatch([EVENT])).rejects.toThrow('POSTHOG_PROJECT_KEY is not set')
    expect(posthog().requests).toHaveLength(0)
  })
})

describe('classifyStatus', () => {
  it.each([
    [200, 'ack'],
    [204, 'ack'],
    [400, 'rejected'],
    [415, 'rejected'],
    [422, 'rejected'],
    [401, 'retry'],
    [403, 'retry'],
    [404, 'retry'],
    [405, 'retry'],
    [407, 'retry'],
    [408, 'retry'],
    [429, 'retry'],
    [500, 'retry'],
    [502, 'retry'],
    [304, 'retry'],
  ])('classifies %i as %s', (status, kind) => {
    expect(classifyStatus(status).kind).toBe(kind)
  })
})

describe('toPosthogBatchEvent', () => {
  it('sends the row id as uuid, occurred_at as the ISO timestamp, and adds server_sig and $geoip_disable without touching the row', () => {
    const properties = { ...EVENT.properties }

    const sent = toPosthogBatchEvent({
      id: EVENT.uuid,
      event: EVENT.event,
      distinctId: EVENT.distinct_id,
      properties,
      occurredAt: new Date(EVENT.timestamp),
    })

    const signature = signAnalyticsEvent({
      uuid: EVENT.uuid,
      event: EVENT.event,
      distinctId: EVENT.distinct_id,
      source: 'audit',
      // eslint-disable-next-line unicorn/no-null -- the row has no access, as the signature reads it
      access: null,
      // eslint-disable-next-line unicorn/no-null -- nor a target type
      targetType: null,
      // eslint-disable-next-line unicorn/no-null -- nor a target id
      targetId: null,
      tenant: 'tenant-1',
    })
    expect(signature).toMatch(/^[0-9a-f]{32}$/)
    expect(sent).toEqual({
      ...EVENT,
      properties: { ...EVENT.properties, $geoip_disable: true, server_sig: signature },
    })
    expect(properties).toEqual(EVENT.properties)
  })

  it('disables GeoIP even when a stored row says otherwise, and leaves the signature unchanged', () => {
    const row = {
      id: EVENT.uuid,
      event: EVENT.event,
      distinctId: EVENT.distinct_id,
      properties: EVENT.properties,
      occurredAt: new Date(EVENT.timestamp),
    }

    const sent = toPosthogBatchEvent({
      ...row,
      properties: { ...EVENT.properties, $geoip_disable: false },
    })

    expect(sent.properties.$geoip_disable).toBe(true)
    expect(sent.properties.server_sig).toBe(toPosthogBatchEvent(row).properties.server_sig)
  })

  it('signs the eight fields, so changing any of them changes the signature', () => {
    const row = {
      id: EVENT.uuid,
      event: 'member_removed',
      distinctId: 'user-1',
      properties: {
        source: 'audit',
        access: 'platform',
        target_type: 'user',
        target_id: 'user-2',
        $groups: { tenant: 'tenant-1' },
      },
      occurredAt: new Date(EVENT.timestamp),
    }
    const base = toPosthogBatchEvent(row).properties.server_sig
    const variants = [
      { ...row, id: '01890000-0000-7000-8000-000000000002' },
      { ...row, event: 'member_added' },
      { ...row, distinctId: 'user-3' },
      ...(['source', 'access', 'target_type', 'target_id'] as const).map((key) => ({
        ...row,
        properties: { ...row.properties, [key]: 'other' },
      })),
      { ...row, properties: { ...row.properties, $groups: { tenant: 'tenant-2' } } },
    ]
    for (const variant of variants) {
      expect(toPosthogBatchEvent(variant).properties.server_sig).not.toBe(base)
    }
  })
})
