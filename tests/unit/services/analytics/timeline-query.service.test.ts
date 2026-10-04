/**
 * @file buildTimelineQuery and logTimelineFailure: the fixed HogQL of every
 * (kind, view, cursor) combination, a property test showing that an id of
 * any shape travels only in `values` and never changes the query text, the
 * group type index check, and the log level of each failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TIMELINE_PROP_KEYS,
  TIMELINE_RANGE_HOURS,
  TIMELINE_RANGES,
  TIMELINE_VIEWS,
} from '@/constants/timeline.constants'
import {
  buildTimelineQuery,
  logTimelineFailure,
  TIMELINE_SELECT_COLUMNS,
} from '@/services/analytics/timeline-query.service'
import { logger } from '@/services/logger.service'
import type { TimelineKind } from '@/types/timeline'

const USER_ID = '0199a1b2-0000-7000-8000-000000000001'
const TENANT_ID = '0199a1b2-0000-7000-8000-000000000002'
const CURSOR = { t: '2026-10-04T10:00:42.886001Z', u: '0199a1b2-0000-7000-8000-0000000000aa' }

const SELECT =
  'select uuid, event, timestamp, distinct_id, properties.$session_id, properties.trace_id, properties.source, properties.access, properties.app, properties.$current_url, properties.$el_text, properties.target_type, properties.target_id, properties.step_key, properties.how, properties.required, properties.method, properties.via_invitation, properties.template_key, properties.bounce_kind, properties.has_reason, properties.cta, properties.table, properties.action, properties.$groups.tenant, properties.server_sig'

const EXCLUDED =
  "  and event not in ('user_timeline_viewed', 'tenant_timeline_viewed', '$identify', '$set', '$groupidentify', '$feature_flag_called', '$create_alias')"

const ORDER = ['order by timestamp desc, uuid desc limit 101']

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TIMELINE_SELECT_COLUMNS', () => {
  it('selects the fixed columns, every allowlisted property in order, then the tenant and the signature', () => {
    expect(TIMELINE_SELECT_COLUMNS.slice(0, 11)).toEqual([
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
    ])
    expect(TIMELINE_SELECT_COLUMNS.slice(11, -2)).toEqual(
      TIMELINE_PROP_KEYS.map((key) => `properties.${key}`)
    )
    expect(TIMELINE_SELECT_COLUMNS.slice(-2)).toEqual([
      'properties.$groups.tenant',
      'properties.server_sig',
    ])
  })
})

describe('buildTimelineQuery', () => {
  it('builds the first page of a user timeline, everything view', () => {
    expect(buildTimelineQuery('user', { id: USER_ID, range: '7d', view: 'all' })).toEqual({
      query: [
        SELECT,
        'from events',
        "where (person_id = (select person_id from person_distinct_ids where distinct_id = {id} limit 1) or (properties.target_type = 'user' and properties.target_id = {id}))",
        '  and timestamp >= now() - toIntervalHour({hours})',
        EXCLUDED,
        ...ORDER,
      ].join('\n'),
      values: { id: USER_ID, hours: 168 },
    })
  })

  it('builds a later page of a tenant timeline, key events view, on the resolved group column', () => {
    expect(
      buildTimelineQuery('tenant', {
        id: TENANT_ID,
        range: '90d',
        view: 'key',
        cursor: CURSOR,
        groupTypeIndex: 2,
      })
    ).toEqual({
      query: [
        SELECT,
        'from events',
        "where ($group_2 = {id} or (properties.target_type = 'tenant' and properties.target_id = {id}))",
        '  and timestamp >= now() - toIntervalHour({hours})',
        '  and (timestamp, uuid) < ({t}, {u})',
        EXCLUDED,
        "  and not startsWith(event, '$')",
        ...ORDER,
      ].join('\n'),
      values: { id: TENANT_ID, hours: 2160, t: CURSOR.t, u: CURSOR.u },
    })
  })

  const combinations = (['user', 'tenant'] as const).flatMap((kind) =>
    TIMELINE_VIEWS.flatMap((view) => [false, true].map((hasCursor) => ({ kind, view, hasCursor })))
  )

  it.each(combinations)(
    '$kind, $view, cursor $hasCursor: the clauses and values that combination calls for',
    ({ kind, view, hasCursor }) => {
      const { query, values } = buildTimelineQuery(kind, {
        id: 'target',
        range: '24h',
        view,
        cursor: hasCursor ? CURSOR : undefined,
        groupTypeIndex: 0,
      })

      expect(query.startsWith(`${SELECT}\nfrom events\nwhere (`)).toBe(true)
      expect(query.includes('person_distinct_ids')).toBe(kind === 'user')
      expect(query.includes('$group_0 = {id}')).toBe(kind === 'tenant')
      expect(query.includes(`properties.target_type = '${kind}'`)).toBe(true)
      expect(query.includes('(timestamp, uuid) < ({t}, {u})')).toBe(hasCursor)
      expect(query.includes("not startsWith(event, '$')")).toBe(view === 'key')
      expect(query).toContain(EXCLUDED)
      expect(query.endsWith(ORDER.join('\n'))).toBe(true)
      // ClickHouse must not choose a row per uuid before the signature is checked.
      expect(query).not.toContain('limit 1 by')
      expect(query).not.toMatch(/limit \d+ by/)
      expect(values).toEqual({
        id: 'target',
        hours: 24,
        ...(hasCursor && { t: CURSOR.t, u: CURSOR.u }),
      })
    }
  )

  it.each(TIMELINE_RANGES)('passes %s as its hours', (range) => {
    expect(buildTimelineQuery('user', { id: USER_ID, range, view: 'all' }).values.hours).toBe(
      TIMELINE_RANGE_HOURS[range]
    )
  })

  it.each([undefined, -1, 5, 1.5, NaN])(
    'refuses a tenant timeline with group type index %s',
    (groupTypeIndex) => {
      expect(() =>
        buildTimelineQuery('tenant', { id: TENANT_ID, range: '7d', view: 'all', groupTypeIndex })
      ).toThrow('group type index from 0 to 4')
    }
  )

  it('ignores the group type index on a user timeline', () => {
    const { query } = buildTimelineQuery('user', {
      id: USER_ID,
      range: '7d',
      view: 'all',
      groupTypeIndex: 3,
    })
    expect(query).not.toContain('$group_')
  })
})

/**
 * A deterministic pseudo-random generator (a 32-bit linear congruential one).
 * @param seed - The seed.
 * @returns A function returning numbers in [0, 1).
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

/**
 * Fragments an injection would be built from.
 */
const HOSTILE_FRAGMENTS = [
  "'",
  '"',
  '`',
  '{',
  '}',
  '{id}',
  '\\',
  '--',
  '/*',
  '*/',
  ';',
  ' or 1=1',
  ')',
  '(',
  '\n',
  '\u{0}',
  'é',
  '𝓾',
  '\u{202E}',
  'select',
  '$group_0',
]

/**
 * An id assembled from hostile fragments.
 * @param random - The generator.
 * @returns The id, 1–12 fragments long.
 */
function hostileId(random: () => number): string {
  const length = 1 + Math.floor(random() * 12)
  return Array.from(
    { length },
    () => HOSTILE_FRAGMENTS[Math.floor(random() * HOSTILE_FRAGMENTS.length)] ?? ''
  ).join('')
}

describe('buildTimelineQuery with hostile ids', () => {
  const random = seededRandom(20_261_004)
  const ids = Array.from({ length: 200 }, () => hostileId(random))

  it.each([['user'], ['tenant']] as [TimelineKind][])(
    '%s: an id only ever travels in values, and never changes the query text',
    (kind) => {
      const baseline = buildTimelineQuery(kind, {
        id: 'baseline',
        range: '7d',
        view: 'all',
        cursor: CURSOR,
        groupTypeIndex: 1,
      }).query
      for (const id of ids) {
        const { query, values } = buildTimelineQuery(kind, {
          id,
          range: '7d',
          view: 'all',
          cursor: CURSOR,
          groupTypeIndex: 1,
        })
        expect(query).toBe(baseline)
        expect(values.id).toBe(id)
      }
    }
  )

  it('keeps a hostile cursor in values too', () => {
    const baseline = buildTimelineQuery('user', {
      id: USER_ID,
      range: '7d',
      view: 'all',
      cursor: CURSOR,
    }).query
    for (const id of ids.slice(0, 50)) {
      const built = buildTimelineQuery('user', {
        id: USER_ID,
        range: '7d',
        view: 'all',
        cursor: { t: id, u: id },
      })
      expect(built.query).toBe(baseline)
      expect([built.values.t, built.values.u]).toEqual([id, id])
    }
  })
})

describe('logTimelineFailure', () => {
  it.each([401, 403, 404])('logs %i at error as a misconfiguration', (status) => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})

    logTimelineFailure({ kind: 'http_error', status }, 'timeline query')

    expect(error).toHaveBeenCalledWith('Timeline key or project misconfigured', {
      operation: 'timeline query',
      status,
    })
  })

  it.each([429, 500, 502, 503])('logs %i at warn', (status) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})

    logTimelineFailure({ kind: 'http_error', status }, 'timeline query')

    expect(warn).toHaveBeenCalledWith('PostHog refused a timeline call', {
      operation: 'timeline query',
      status,
    })
    expect(error).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'network'] as const)('logs a %s at warn', (kind) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    logTimelineFailure({ kind }, 'group types')

    expect(warn).toHaveBeenCalledWith('PostHog did not answer a timeline call', {
      operation: 'group types',
      outcome: kind,
    })
  })

  it('logs any other 4xx at error as a rejected call', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})

    logTimelineFailure({ kind: 'http_error', status: 400 }, 'timeline query')

    expect(error).toHaveBeenCalledWith('PostHog rejected a timeline call', {
      operation: 'timeline query',
      status: 400,
    })
  })
})
