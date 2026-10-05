/**
 * @file The two HogQL queries of the staff Errors views: a user's error
 * issues and a tenant's. The query text is fixed; the id and the window
 * travel as HogQL placeholders in `values`. The one token written into the
 * text at run time is the `tenant` group type's index, checked to be an
 * integer from 0 to 4 first. Rows are grouped by PostHog's issue id; every
 * column describing the most recent event is taken with
 * `argMax(column, (timestamp, uuid))`, so all of them come from one event
 * even when two share a timestamp, and its signature can be verified.
 */
import { ANALYTICS_SIGNATURE_PROPERTY } from '@/constants/analytics.constants'
import {
  ERROR_ISSUE_ID_PROPERTY,
  ERRORS_VIEW_AHEAD_MINUTES,
  ERRORS_VIEW_DAYS,
  ERRORS_VIEW_LIMIT,
} from '@/constants/errors-view.constants'
import { MAX_GROUP_TYPE_INDEX } from '@/services/analytics/timeline-query.service'
import type { TimelineKind } from '@/types/timeline'

/**
 * The most recent event's columns, in order: what the mapper shows and what
 * the signature covers.
 */
const LATEST_EVENT_COLUMNS: readonly string[] = [
  'uuid',
  'distinct_id',
  'properties.$exception_list',
  'properties.app',
  'properties.source',
  'properties.access',
  'properties.target_type',
  'properties.target_id',
  'properties.$groups.tenant',
  `properties.${ANALYTICS_SIGNATURE_PROPERTY}`,
]

/**
 * The selected columns, in order: the issue id, the count, the first and
 * last timestamps, then the most recent event's columns. The mapper reads
 * each result row by these positions, and the test fake answers in the same
 * order.
 */
export const ERRORS_SELECT_COLUMNS: readonly string[] = [
  `properties.${ERROR_ISSUE_ID_PROPERTY} as issue_id`,
  'count() as occurrences',
  'min(timestamp) as first_seen',
  'max(timestamp) as last_seen',
  ...LATEST_EVENT_COLUMNS.map((column) => `argMax(${column}, (timestamp, uuid))`),
]

/**
 * A user's matching clause: the user's own events, by distinct id.
 */
const USER_MATCH = 'distinct_id = {id}'

/**
 * A tenant's matching clause: the events of its group. `GROUP_COLUMN` stands
 * for the group's `$group_<n>` column.
 */
const TENANT_MATCH = 'GROUP_COLUMN = {id}'

/**
 * What one Errors query reads.
 */
export interface ErrorsQueryParameters {
  /**
   * The user or tenant id.
   */
  id: string
  /**
   * The `tenant` group type's index; required for a tenant's errors.
   */
  groupTypeIndex?: number | undefined
}

/**
 * The matching clause: a user's own events by distinct id, or the tenant
 * group's events by its `$group_<n>` column.
 * @param kind - Whose errors.
 * @param groupTypeIndex - The `tenant` group type's index, for a tenant.
 * @returns The clause.
 * @throws {Error} For a tenant without an integer group type index from 0 to 4.
 */
function matchOf(kind: TimelineKind, groupTypeIndex: number | undefined): string {
  if (kind === 'user') return USER_MATCH
  if (
    groupTypeIndex === undefined ||
    !Number.isSafeInteger(groupTypeIndex) ||
    groupTypeIndex < 0 ||
    groupTypeIndex > MAX_GROUP_TYPE_INDEX
  ) {
    throw new Error('A tenant errors query needs a group type index from 0 to 4')
  }
  const column = `$group_${String(groupTypeIndex)}`
  return TENANT_MATCH.replace('GROUP_COLUMN', () => column)
}

/**
 * The fixed HogQL of one Errors view and its placeholder values: the
 * `$exception` events of the last `ERRORS_VIEW_DAYS` days, and no more than
 * `ERRORS_VIEW_AHEAD_MINUTES` minutes ahead of now, that PostHog has
 * grouped into an issue, one row per issue, most recently seen first, at
 * most `ERRORS_VIEW_LIMIT`.
 * @param kind - A user's or a tenant's errors.
 * @param parameters - The id and, for a tenant, the group type index.
 * @returns The query text and its `values`.
 * @throws {Error} For a tenant without an integer group type index from 0 to 4.
 */
export function buildErrorsQuery(
  kind: TimelineKind,
  parameters: ErrorsQueryParameters
): { query: string; values: Record<string, string | number> } {
  const match = matchOf(kind, parameters.groupTypeIndex)
  const issueId = `properties.${ERROR_ISSUE_ID_PROPERTY}`
  const lines = [
    `select ${ERRORS_SELECT_COLUMNS.join(', ')}`,
    'from events',
    "where event = '$exception'",
    `  and ${match}`,
    '  and timestamp > now() - toIntervalDay({days})',
    '  and timestamp <= now() + toIntervalMinute({aheadMinutes})',
    `  and ${issueId} != ''`,
    `group by ${issueId}`,
    `order by last_seen desc limit ${String(ERRORS_VIEW_LIMIT)}`,
  ]
  return {
    query: lines.join('\n'),
    values: { id: parameters.id, days: ERRORS_VIEW_DAYS, aheadMinutes: ERRORS_VIEW_AHEAD_MINUTES },
  }
}
