/**
 * @file PostHog timeline query result rows for tests, built by column name
 * so a test reads like the event it seeds, and signed as the drainer signs a
 * server event when a test needs a verified row. Positions follow
 * `TIMELINE_SELECT_COLUMNS`.
 */
import { signAnalyticsEvent } from '@/services/analytics/analytics-signature.service'
import { TIMELINE_SELECT_COLUMNS } from '@/services/analytics/timeline-query.service'

// eslint-disable-next-line unicorn/no-null -- PostHog's JSON null for an absent property
const ABSENT = null

/**
 * One seeded event: its columns by name, `properties.<key>` for a property.
 * Unnamed columns are `null`, as PostHog answers for an absent property.
 */
export type SeededEvent = Partial<Record<string, unknown>> & {
  uuid: string
  event: string
  timestamp: string
  distinct_id: string
}

/**
 * A result row in `TIMELINE_SELECT_COLUMNS` order.
 * @param event - The event's columns by name.
 * @returns The positional row.
 */
export function resultRow(event: SeededEvent): unknown[] {
  return TIMELINE_SELECT_COLUMNS.map((column) =>
    Object.hasOwn(event, column) ? event[column] : ABSENT
  )
}

/**
 * A HogQL answer body holding these events, in order.
 * @param events - The events.
 * @returns `{ columns, results }`.
 */
export function queryAnswer(events: readonly SeededEvent[]): {
  columns: readonly string[]
  results: unknown[][]
} {
  return { columns: TIMELINE_SELECT_COLUMNS, results: events.map((event) => resultRow(event)) }
}

/**
 * A column as the signer reads it.
 * @param value - The seeded value.
 * @returns The string, or null when it is absent or empty.
 */
function signedColumn(value: unknown): string | null {
  // eslint-disable-next-line unicorn/no-null -- the signer's "absent"
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * The event with `properties.server_sig` set to this server's signature over
 * its seeded columns, as the drainer signs a server event.
 * @param event - The event's columns by name.
 * @returns The signed event.
 */
export function signedEvent(event: SeededEvent): SeededEvent {
  return {
    ...event,
    'properties.server_sig': signAnalyticsEvent({
      uuid: event.uuid,
      event: event.event,
      distinctId: event.distinct_id,
      source: signedColumn(event['properties.source']),
      access: signedColumn(event['properties.access']),
      targetType: signedColumn(event['properties.target_type']),
      targetId: signedColumn(event['properties.target_id']),
      tenant: signedColumn(event['properties.$groups.tenant']),
    }),
  }
}
