/**
 * @file The only two HogQL queries the server sends PostHog: a user's
 * timeline and a tenant's. The query text is fixed; every id, the range and
 * the cursor travel as HogQL placeholders in `values`. The one token written
 * into the text at run time is the `tenant` group type's index, checked to be
 * an integer from 0 to 4 first. Also how a failed PostHog call is logged.
 */
import { ANALYTICS_SIGNATURE_PROPERTY } from '@/constants/analytics.constants'
import {
  TIMELINE_EXCLUDED_EVENTS,
  TIMELINE_PAGE_SIZE,
  TIMELINE_PROP_KEYS,
  TIMELINE_RANGE_HOURS,
  type TimelineRange,
  type TimelineView,
} from '@/constants/timeline.constants'
import type { PosthogApiResult } from '@/services/analytics/posthog-api.service'
import { logger } from '@/services/logger.service'
import type { TimelineCursor, TimelineKind } from '@/types/timeline'

/**
 * The selected columns, in order: the row fields, the allowlisted
 * properties, then the event's tenant group and its signature. The mapper
 * reads each result row by these positions, and the test fake answers in the
 * same order.
 */
export const TIMELINE_SELECT_COLUMNS: readonly string[] = [
  'uuid',
  'event',
  'timestamp',
  'distinct_id',
  'properties.$session_id',
  'properties.trace_id',
  'properties.source',
  'properties.access',
  'properties.app',
  'properties.$current_url',
  'properties.$el_text',
  ...TIMELINE_PROP_KEYS.map((key) => `properties.${key}`),
  'properties.$groups.tenant',
  `properties.${ANALYTICS_SIGNATURE_PROPERTY}`,
]

/**
 * PostHog's highest group type index: a project has at most five group types.
 */
export const MAX_GROUP_TYPE_INDEX = 4

/**
 * An event name the excluded-events list may hold: lowercase letters and
 * underscores, with an optional leading `$`. Nothing that can close a quote.
 */
const EVENT_NAME_LITERAL = /^\$?[a-z_]+$/

/**
 * Fixed event names as a HogQL string tuple, written into the query text.
 * @param names - The names, from a constant.
 * @returns `('a', 'b', …)`.
 * @throws {Error} When a name is not a plain event name.
 */
function eventNameTuple(names: readonly string[]): string {
  for (const name of names) {
    if (!EVENT_NAME_LITERAL.test(name)) throw new Error(`Not a plain event name: ${name}`)
  }
  const quoted = names.map((name) => `'${name}'`).join(', ')
  return `(${quoted})`
}

const EXCLUDED_EVENTS = eventNameTuple(TIMELINE_EXCLUDED_EVENTS)

/**
 * The matching clause of a user timeline: the events of the user's PostHog
 * person (their merged pre-login events included), and staff actions that
 * target them.
 */
const USER_MATCH =
  "person_id = (select person_id from person_distinct_ids where distinct_id = {id} limit 1) or (properties.target_type = 'user' and properties.target_id = {id})"

/**
 * The matching clause of a tenant timeline: the events of the tenant's group,
 * and staff actions that target it. `GROUP_COLUMN` stands for the group's
 * `$group_<n>` column.
 */
const TENANT_MATCH =
  "GROUP_COLUMN = {id} or (properties.target_type = 'tenant' and properties.target_id = {id})"

/**
 * The tenant matching clause for one group type index.
 * @param groupTypeIndex - The `tenant` group type's index, already checked.
 * @returns The clause.
 */
function tenantMatch(groupTypeIndex: number): string {
  const column = `$group_${String(groupTypeIndex)}`
  return TENANT_MATCH.replace('GROUP_COLUMN', () => column)
}

/**
 * What one timeline query reads.
 */
export interface TimelineQueryParameters {
  /**
   * The user or tenant id.
   */
  id: string
  range: TimelineRange
  view: TimelineView
  /**
   * The decoded cursor of a later page; absent on a first page.
   */
  cursor?: TimelineCursor | undefined
  /**
   * The `tenant` group type's index; required for a tenant timeline.
   */
  groupTypeIndex?: number | undefined
}

/**
 * The fixed HogQL of one timeline page and its placeholder values.
 *
 * Rows newer than the range, older than the cursor when there is one, and not
 * in `TIMELINE_EXCLUDED_EVENTS`; `key` also leaves out every `$` event.
 * Newest first by `(timestamp, uuid)`, and one row more than a page, which
 * only says whether another page exists. No `limit … by uuid`: PostHog may
 * store a resent event twice, and a forged event may reuse a real one's uuid,
 * so ClickHouse must not pick one per uuid before the signature is checked.
 * The mapper dedupes after verifying.
 * @param kind - A user's or a tenant's timeline.
 * @param parameters - The id, range, view, cursor and group type index.
 * @returns The query text and its `values`.
 * @throws {Error} For a tenant timeline without an integer group type index from 0 to 4.
 */
export function buildTimelineQuery(
  kind: TimelineKind,
  parameters: TimelineQueryParameters
): { query: string; values: Record<string, string | number> } {
  let match = USER_MATCH
  if (kind === 'tenant') {
    const index = parameters.groupTypeIndex
    if (
      index === undefined ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index > MAX_GROUP_TYPE_INDEX
    ) {
      throw new Error('A tenant timeline needs a group type index from 0 to 4')
    }
    match = tenantMatch(index)
  }
  const values: Record<string, string | number> = {
    id: parameters.id,
    hours: TIMELINE_RANGE_HOURS[parameters.range],
  }
  const lines = [
    `select ${TIMELINE_SELECT_COLUMNS.join(', ')}`,
    'from events',
    `where (${match})`,
    '  and timestamp >= now() - toIntervalHour({hours})',
  ]
  if (parameters.cursor !== undefined) {
    lines.push('  and (timestamp, uuid) < ({t}, {u})')
    values.t = parameters.cursor.t
    values.u = parameters.cursor.u
  }
  lines.push(`  and event not in ${EXCLUDED_EVENTS}`)
  if (parameters.view === 'key') lines.push("  and not startsWith(event, '$')")
  lines.push(`order by timestamp desc, uuid desc limit ${String(TIMELINE_PAGE_SIZE + 1)}`)
  return { query: lines.join('\n'), values }
}

/**
 * Statuses that say the key or the project is wrong, not the request.
 */
const MISCONFIGURED_STATUSES: ReadonlySet<number> = new Set([401, 403, 404])

/**
 * Log why a timeline call to PostHog failed, never with the key: `error`
 * for an answer that says the key, the project or the query is wrong (any
 * 4xx but 429), `warn` for a 429, a 5xx, a timeout or a network failure.
 * @param result - The failed call.
 * @param operation - What was asked, e.g. `'timeline query'`.
 */
export function logTimelineFailure(
  result: Exclude<PosthogApiResult, { kind: 'ok' }>,
  operation: string
): void {
  if (result.kind !== 'http_error') {
    logger.warn('PostHog did not answer a timeline call', { operation, outcome: result.kind })
    return
  }
  const { status } = result
  if (MISCONFIGURED_STATUSES.has(status)) {
    logger.error('Timeline key or project misconfigured', { operation, status })
    return
  }
  if (status === 429 || status >= 500) {
    logger.warn('PostHog refused a timeline call', { operation, status })
    return
  }
  logger.error('PostHog rejected a timeline call', { operation, status })
}
