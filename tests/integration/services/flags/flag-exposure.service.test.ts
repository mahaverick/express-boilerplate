/**
 * @file recordExposure against the real outbox and Redis: one
 * `$feature_flag_called` row per session, tenant, flag and recorded
 * response; a held-out user recorded as `holdout-<id>`, never `control`;
 * nothing for an evaluation outside the experiment; the dedupe key and its
 * TTL; and an exposure recorded anyway when Redis fails. Analytics is off
 * under `.env.test`, so `isAnalyticsEnabled` is mocked here.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isAnalyticsSignatureValid,
  signedFieldsOf,
} from '@/services/analytics/analytics-signature.service'
import { toPosthogBatchEvent } from '@/services/analytics/posthog-batch.service'
import { exposureDedupeKey, recordExposure } from '@/services/flags/flag-exposure.service'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'
import type { FlagContext, FlagEvaluation, FlagReason } from '@/types/flags'
import { clearOutbox, outboxRowsOf } from '../../../helpers/analytics-outbox'
import { clearFlagKeys } from '../../../helpers/flag-redis'

const analytics = vi.hoisted(() => ({ isEnabled: true }))

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => analytics.isEnabled }
})

// eslint-disable-next-line unicorn/no-null -- the context's contract uses null
const NONE = null
const KEY = 'example_cta_experiment'
const BOLD: FlagEvaluation = { value: 'bold', reason: 'condition_match', conditionIndex: 0 }
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * A request-bound context in a tenant.
 * @param fields - Fields to change.
 * @returns The context.
 */
function contextWith(fields: Partial<FlagContext> = {}): FlagContext {
  const tenantId = randomUUID()
  return {
    distinctId: randomUUID(),
    groups: { tenant: tenantId },
    personProps: {},
    groupProps: { tenant: {} },
    tenantId,
    sessionId: randomUUID(),
    ...fields,
  }
}

beforeEach(async () => {
  analytics.isEnabled = true
  await clearOutbox()
  await clearFlagKeys()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await clearOutbox()
  await clearFlagKeys()
})

describe('recordExposure', () => {
  it('writes one signed-source $feature_flag_called row', async () => {
    const context = contextWith()
    await recordExposure(context, KEY, BOLD, 'react')

    const rows = await outboxRowsOf('$feature_flag_called')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.distinctId).toBe(context.distinctId)
    expect(rows[0]?.properties).toMatchObject({
      $feature_flag: KEY,
      $feature_flag_response: 'bold',
      exposure_origin: 'react',
      source: 'flag',
      access: 'member',
      app: 'api',
      $groups: { tenant: context.tenantId },
    })
  })

  it('drains as a string response, source flag and a valid server signature', async () => {
    await recordExposure(contextWith(), KEY, BOLD, 'react')
    const [row] = await outboxRowsOf('$feature_flag_called')
    if (!row) throw new Error('no exposure row')
    const sent = toPosthogBatchEvent(row)
    expect(sent.properties.$feature_flag_response).toBe('bold')
    expect(typeof sent.properties.$feature_flag_response).toBe('string')
    const fields = signedFieldsOf(
      { uuid: sent.uuid, event: sent.event, distinctId: sent.distinct_id },
      sent.properties
    )
    expect(fields).toMatchObject({ source: 'flag' })
    expect(isAnalyticsSignatureValid(fields, sent.properties.server_sig)).toBe(true)
  })

  it('records once per session, tenant, flag and response', async () => {
    const context = contextWith()
    await recordExposure(context, KEY, BOLD, 'react')
    await recordExposure(context, KEY, BOLD, 'server')
    expect(await outboxRowsOf('$feature_flag_called')).toHaveLength(1)

    await recordExposure(context, KEY, { ...BOLD, value: 'control' }, 'react')
    await recordExposure({ ...context, sessionId: randomUUID() }, KEY, BOLD, 'react')
    const otherTenant = randomUUID()
    await recordExposure(
      { ...context, tenantId: otherTenant, groups: { tenant: otherTenant } },
      KEY,
      BOLD,
      'react'
    )
    expect(await outboxRowsOf('$feature_flag_called')).toHaveLength(4)
  })

  it('records a held-out user as holdout-<id>, never control', async () => {
    await recordExposure(
      contextWith(),
      KEY,
      { value: 'control', reason: 'holdout', holdoutVariant: 'holdout-3605' },
      'react'
    )
    const [row] = await outboxRowsOf('$feature_flag_called')
    expect(row?.properties.$feature_flag_response).toBe('holdout-3605')
  })

  it.each<FlagReason>([
    'out_of_rollout',
    'no_condition_match',
    'fallback:unconfigured',
    'fallback:snapshot_missing',
    'fallback:flag_missing',
    'fallback:inactive',
    'fallback:unsupported',
    'fallback:no_tenant',
    'fallback:inconclusive',
  ])('records nothing for %s, which is outside the experiment', async (reason) => {
    await recordExposure(contextWith(), KEY, { value: 'control', reason }, 'react')
    expect(await outboxRowsOf('$feature_flag_called')).toHaveLength(0)
  })

  it('keys the dedupe on the hashed session and keeps it for the session lifetime', async () => {
    const context = contextWith()
    await recordExposure(context, KEY, BOLD, 'react')
    const key = exposureDedupeKey(context, KEY, 'bold')
    const actor = createHash('sha256').update(String(context.sessionId)).digest('hex').slice(0, 32)
    expect(key).toBe(redisKey('flags', 'exp', actor, String(context.tenantId), KEY, 'bold'))
    const redis = await getRedis()
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(SESSION_TTL_SECONDS - 60)
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS)
  })

  it("keys a worker's read on the user, with no tenant as '-', for a day", async () => {
    const context = contextWith({ sessionId: NONE, tenantId: NONE, groups: {}, groupProps: {} })
    await recordExposure(context, KEY, BOLD, 'server')
    const key = exposureDedupeKey(context, KEY, 'bold')
    const actor = createHash('sha256')
      .update(`worker:${context.distinctId}`)
      .digest('hex')
      .slice(0, 32)
    expect(key).toBe(redisKey('flags', 'exp', actor, '-', KEY, 'bold'))
    const redis = await getRedis()
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(86_400 - 60)
    expect(ttl).toBeLessThanOrEqual(86_400)
  })

  it('records the exposure anyway when the dedupe fails: a duplicate beats a lost exposure', async () => {
    const redis = await getRedis()
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('Redis down'))
    const warn = vi.spyOn(logger, 'warn')
    const context = contextWith()
    await recordExposure(context, KEY, BOLD, 'react')
    await recordExposure(context, KEY, BOLD, 'react')
    expect(await outboxRowsOf('$feature_flag_called')).toHaveLength(2)
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      'Exposure dedupe unavailable; recording the exposure anyway'
    )
  })

  it('records nothing, and sets no dedupe key, while analytics is off', async () => {
    analytics.isEnabled = false
    const context = contextWith()
    await recordExposure(context, KEY, BOLD, 'react')
    expect(await outboxRowsOf('$feature_flag_called')).toHaveLength(0)
    const redis = await getRedis()
    expect(await redis.exists(exposureDedupeKey(context, KEY, 'bold'))).toBe(0)
  })
})
