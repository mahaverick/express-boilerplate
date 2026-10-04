/**
 * @file The signer and the verifier read an event the same way. Each event is
 * signed by the real `toPosthogBatchEvent`, laid out as the HogQL result row
 * `TIMELINE_SELECT_COLUMNS` selects (an absent property as `''`, as PostHog
 * reads it), and read back by the real `mapTimelineResults`, which must find
 * it verified. No database is involved.
 */
import { describe, expect, it } from 'vitest'
import { buildTenantGroupIdentify } from '@/services/analytics/analytics-event-builder.service'
import { toPosthogBatchEvent } from '@/services/analytics/posthog-batch.service'
import { mapTimelineResults } from '@/services/analytics/timeline-mapper.service'
import { TIMELINE_SELECT_COLUMNS } from '@/services/analytics/timeline-query.service'

const TARGET = { kind: 'user', id: 'user-2' } as const
const SENT_AT = new Date('2026-10-04T10:00:42.886Z')

/**
 * Sign an event as the drainer does.
 * @param n - A number to make its uuid unique.
 * @param event - Its name.
 * @param distinctId - Its distinct id.
 * @param properties - Its stored properties.
 * @returns The `/batch/` event.
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
 * The result row PostHog would return for a sent event, in column order.
 * @param sent - The `/batch/` event.
 * @returns The row.
 */
function resultOf(sent: ReturnType<typeof signed>): unknown[] {
  const groups = sent.properties.$groups as { tenant?: unknown } | undefined
  return TIMELINE_SELECT_COLUMNS.map((column) => {
    if (column === 'uuid') return sent.uuid
    if (column === 'event') return sent.event
    if (column === 'timestamp') return '2026-10-04T10:00:42.886001Z'
    if (column === 'distinct_id') return sent.distinct_id
    if (column === 'properties.$groups.tenant') return groups?.tenant ?? ''
    return sent.properties[column.replace('properties.', '')] ?? ''
  })
}

const MARKER = buildTenantGroupIdentify({ id: 'tenant-1' }, {}, 'audit', SENT_AT)

describe('a signed event read back by the timeline mapper', () => {
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
    const [row] = mapTimelineResults([resultOf(sent)], TARGET)
    expect(row?.verified).toBe(true)
    expect(row?.source).toBe(sent.properties.source)
  })

  it('shows no target props for a numeric target_id, which was signed as absent', () => {
    const [row] = mapTimelineResults([resultOf(numeric)], TARGET)
    expect(row?.props.target_id).toBeUndefined()
    expect(row?.props.target_type).toBe('user')
  })

  it('reads a changed target_id as unverified', () => {
    const result = resultOf(audit)
    const index = TIMELINE_SELECT_COLUMNS.indexOf('properties.target_id')
    result[index] = 'user-9'
    const [row] = mapTimelineResults([result], TARGET)
    expect(row?.verified).toBe(false)
    expect(row?.source).toBe('browser')
  })
})
