/**
 * @file The signer and the verifier read an event the same way. Each event is
 * signed by the real `toPosthogBatchEvent`, then its fields are read back by
 * `signedFieldsOf` from the properties it sent and checked by
 * `isAnalyticsSignatureValid`. No database is involved.
 */
import { describe, expect, it } from 'vitest'
import { ANALYTICS_SIGNATURE_PROPERTY } from '@/constants/analytics.constants'
import { buildTenantGroupIdentify } from '@/services/analytics/analytics-event-builder.service'
import {
  isAnalyticsSignatureValid,
  signedFieldsOf,
} from '@/services/analytics/analytics-signature.service'
import { toPosthogBatchEvent } from '@/services/analytics/posthog-batch.service'

const SENT_AT = new Date('2026-10-04T10:00:42.886Z')

/**
 * Signs a stored outbox event as the drainer does, giving a `/batch/` event.
 * `n` is a single digit that makes its uuid unique.
 */
function signed(n: number, event: string, distinctId: string, properties: Record<string, unknown>) {
  return toPosthogBatchEvent({
    id: `0199a1b2-0000-7000-8000-00000000000${String(n)}`,
    event,
    distinctId,
    properties,
    occurredAt: SENT_AT,
  })
}

/**
 * Whether the event's signature verifies over the fields read back from its
 * properties, with `override` applied to them first.
 */
function isVerified(
  sent: ReturnType<typeof signed>,
  override: Record<string, unknown> = {}
): boolean {
  const fields = signedFieldsOf(
    { uuid: sent.uuid, event: sent.event, distinctId: sent.distinct_id },
    { ...sent.properties, ...override }
  )
  return isAnalyticsSignatureValid(fields, sent.properties[ANALYTICS_SIGNATURE_PROPERTY])
}

const MARKER = buildTenantGroupIdentify({ id: 'tenant-1' }, {}, 'audit', SENT_AT)

describe('a signed event read back by the verifier', () => {
  const audit = signed(1, 'member_removed', 'user-1', {
    source: 'audit',
    access: 'platform',
    app: 'api',
    target_type: 'user',
    target_id: 'user-2',
    $groups: { tenant: 'tenant-1' },
  })
  const noGroups = signed(2, 'user_signed_in', 'user-1', { source: 'product' })
  const marker = signed(3, MARKER.event, MARKER.distinctId, MARKER.properties)
  const numeric = signed(4, 'member_removed', 'user-1', {
    source: 'audit',
    access: 'platform',
    target_type: 'user',
    target_id: 42,
  })

  it.each([
    ['an audit row with a target and a tenant', audit],
    ['a row with no $groups', noGroups],
    ['a $groupidentify marker', marker],
    ['a row with a numeric target_id', numeric],
  ])('verifies %s', (_name, sent) => {
    expect(isVerified(sent)).toBe(true)
  })

  it('signs a numeric target_id as absent', () => {
    const fields = signedFieldsOf(
      { uuid: numeric.uuid, event: numeric.event, distinctId: numeric.distinct_id },
      numeric.properties
    )
    expect(fields.targetId).toBeNull()
    expect(fields.targetType).toBe('user')
  })

  it('reads a changed target_id as unverified', () => {
    expect(isVerified(audit, { target_id: 'user-9' })).toBe(false)
  })
})
