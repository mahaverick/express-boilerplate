/**
 * @file buildErrorsQuery: the exact fixed HogQL of a user's and a tenant's
 * Errors view, ids and the window only in `values`, and the group type
 * index check.
 */
import { describe, expect, it } from 'vitest'
import { buildErrorsQuery } from '@/services/analytics/errors-query.service'

const USER_ID = '0199a1b2-0000-7000-8000-000000000001'
const TENANT_ID = '0199a1b2-0000-7000-8000-000000000002'

const SELECT =
  'select properties.$exception_issue_id as issue_id, count() as occurrences, min(timestamp) as first_seen, max(timestamp) as last_seen, argMax(uuid, (timestamp, uuid)), argMax(distinct_id, (timestamp, uuid)), argMax(properties.$exception_list, (timestamp, uuid)), argMax(properties.app, (timestamp, uuid)), argMax(properties.source, (timestamp, uuid)), argMax(properties.access, (timestamp, uuid)), argMax(properties.target_type, (timestamp, uuid)), argMax(properties.target_id, (timestamp, uuid)), argMax(properties.$groups.tenant, (timestamp, uuid)), argMax(properties.server_sig, (timestamp, uuid))'

/**
 * The expected query for one matching clause.
 * @param match - The clause.
 * @returns The query text.
 */
function expected(match: string): string {
  return [
    SELECT,
    'from events',
    "where event = '$exception'",
    `  and ${match}`,
    '  and timestamp > now() - toIntervalDay({days})',
    "  and properties.$exception_issue_id != ''",
    'group by properties.$exception_issue_id',
    'order by last_seen desc limit 50',
  ].join('\n')
}

describe('buildErrorsQuery', () => {
  it("matches a user's own events by distinct id, the id in values", () => {
    expect(buildErrorsQuery('user', { id: USER_ID })).toEqual({
      query: expected('distinct_id = {id}'),
      values: { id: USER_ID, days: 30 },
    })
  })

  it("matches a tenant's group column at its index", () => {
    expect(buildErrorsQuery('tenant', { id: TENANT_ID, groupTypeIndex: 3 })).toEqual({
      query: expected('$group_3 = {id}'),
      values: { id: TENANT_ID, days: 30 },
    })
  })

  it.each(["'); drop table events; --", '{id}', '$group_0 = 1 or 1'])(
    'keeps the query text fixed for the id %j',
    (id) => {
      const { query, values } = buildErrorsQuery('user', { id })

      expect(query).toBe(expected('distinct_id = {id}'))
      expect(values.id).toBe(id)
    }
  )

  it.each([undefined, -1, 5, 1.5])('refuses a tenant query with group type index %s', (index) => {
    expect(() => buildErrorsQuery('tenant', { id: TENANT_ID, groupTypeIndex: index })).toThrow(
      'A tenant errors query needs a group type index from 0 to 4'
    )
  })
})
