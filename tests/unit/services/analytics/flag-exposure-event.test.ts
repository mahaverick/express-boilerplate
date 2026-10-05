/**
 * @file The experiment exposure event: the outbox row
 * `buildFlagExposureEvent` builds, with source `flag`, and its signature,
 * which the real `toPosthogBatchEvent` adds and the timeline verifier reads
 * back as a server event. No database is involved.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  buildFlagExposureEvent,
  type AnalyticsSource,
} from '@/services/analytics/analytics-event-builder.service'
import {
  isAnalyticsSignatureValid,
  signedFieldsOf,
} from '@/services/analytics/analytics-signature.service'
import { toPosthogBatchEvent } from '@/services/analytics/posthog-batch.service'

const AT = new Date('2026-10-05T12:00:00.000Z')
const USER_ID = '0199b000-0000-7000-8000-000000000001'
const TENANT_ID = '0199b000-0000-7000-8000-000000000002'
// eslint-disable-next-line unicorn/no-null -- the input's contract is null for no tenant
const NONE = null

describe('buildFlagExposureEvent', () => {
  it('builds $feature_flag_called with the flag, the recorded response, the origin and source flag', () => {
    expect(
      buildFlagExposureEvent(
        {
          flagKey: 'example_cta_experiment',
          response: 'bold',
          origin: 'react',
          distinctId: USER_ID,
          tenantId: TENANT_ID,
          at: AT,
        },
        { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
      )
    ).toEqual({
      event: '$feature_flag_called',
      distinctId: USER_ID,
      occurredAt: AT,
      properties: {
        $feature_flag: 'example_cta_experiment',
        $feature_flag_response: 'bold',
        exposure_origin: 'react',
        source: 'flag',
        access: 'member',
        app: 'api',
        $groups: { tenant: TENANT_ID },
        trace_id: 'a'.repeat(32),
        span_id: 'b'.repeat(16),
      },
    })
  })

  it('joins no group without a tenant, and marks an Apex exposure as platform access', () => {
    const row = buildFlagExposureEvent(
      {
        flagKey: 'example_cta_experiment',
        response: 'holdout-3605',
        origin: 'apex',
        distinctId: USER_ID,
        tenantId: NONE,
        at: AT,
      },
      {}
    )
    expect(row.properties).not.toHaveProperty('$groups')
    expect(row.properties).toMatchObject({
      access: 'platform',
      $feature_flag_response: 'holdout-3605',
    })
  })

  it("carries the browser session only when it is the exposed user's", () => {
    const input = {
      flagKey: 'example_cta_experiment',
      response: 'control',
      origin: 'server' as const,
      distinctId: USER_ID,
      tenantId: NONE,
      at: AT,
    }
    expect(
      buildFlagExposureEvent(input, { posthogSessionId: 'session', userId: USER_ID }).properties
    ).toMatchObject({ $session_id: 'session' })
    expect(
      buildFlagExposureEvent(input, { posthogSessionId: 'session', userId: TENANT_ID }).properties
    ).not.toHaveProperty('$session_id')
  })

  it('is signed as a server event with source flag when the drainer sends it', () => {
    const row = buildFlagExposureEvent(
      {
        flagKey: 'example_cta_experiment',
        response: 'bold',
        origin: 'react',
        distinctId: USER_ID,
        tenantId: TENANT_ID,
        at: AT,
      },
      {}
    )
    const sent = toPosthogBatchEvent({
      ...row,
      id: '0199b000-0000-7000-8000-0000000000e1',
      occurredAt: AT,
    })
    const fields = signedFieldsOf(
      { uuid: sent.uuid, event: sent.event, distinctId: sent.distinct_id },
      sent.properties
    )
    expect(fields).toMatchObject({ source: 'flag', access: 'member', tenant: TENANT_ID })
    expect(isAnalyticsSignatureValid(fields, sent.properties.server_sig)).toBe(true)
    expect(
      isAnalyticsSignatureValid({ ...fields, source: 'product' }, sent.properties.server_sig)
    ).toBe(false)
  })

  it("adds 'flag' to the analytics sources", () => {
    expectTypeOf<Extract<AnalyticsSource, 'flag'>>().toEqualTypeOf<'flag'>()
  })
})
