/**
 * @file mapTimelineResults: the property allowlist, `source` defaulting to
 * browser, `path` reduced to the pathname, `elementText` on clicks only and
 * truncated, untrusted column types, the signature (verified rows keep their
 * server fields; forged target matches are dropped; other unverified rows
 * are demoted), and dedupe by uuid preferring a verified copy.
 */
import { describe, expect, it } from 'vitest'
import { TIMELINE_PROP_KEYS } from '@/constants/timeline.constants'
import { cursorAfter, mapTimelineResults } from '@/services/analytics/timeline-mapper.service'
import { resultRow, signedEvent, type SeededEvent } from '../../../helpers/timeline-rows'

const USER_ID = '0199a1b2-0000-7000-8000-000000000001'
const OTHER_ID = '0199a1b2-0000-7000-8000-000000000009'
const TENANT_ID = '0199a1b2-0000-7000-8000-000000000003'
const USER_TARGET = { kind: 'user', id: USER_ID } as const
const TENANT_TARGET = { kind: 'tenant', id: TENANT_ID } as const

const BASE: SeededEvent = {
  uuid: '0199a1b2-0000-7000-8000-0000000000a1',
  event: 'invitation_created',
  timestamp: '2026-10-04T10:00:42.886001Z',
  distinct_id: '0199a1b2-0000-7000-8000-000000000001',
}

// eslint-disable-next-line unicorn/no-null -- the row's JSON null
const NONE = null

/**
 * Map one seeded event.
 * @param event - The event's columns by name, over BASE.
 * @returns The mapped row.
 */
function mapOne(event: Partial<SeededEvent>): ReturnType<typeof mapTimelineResults>[number] {
  const [row] = mapTimelineResults([resultRow({ ...BASE, ...event })], USER_TARGET)
  if (!row) throw new Error('the row was dropped')
  return row
}

describe('mapTimelineResults', () => {
  it('maps a signed server event with every field', () => {
    const event = signedEvent({
      ...BASE,
      'properties.$session_id': '0199a1b2-0000-7000-8000-0000000000f1',
      'properties.trace_id': 'a'.repeat(32),
      'properties.source': 'audit',
      'properties.access': 'platform',
      'properties.app': 'api',
      'properties.target_type': 'invitation',
      'properties.target_id': 'invitation-1',
      'properties.has_reason': false,
      'properties.$groups.tenant': TENANT_ID,
    })

    const [row] = mapTimelineResults([resultRow(event)], USER_TARGET)

    expect(row).toEqual({
      uuid: BASE.uuid,
      event: 'invitation_created',
      timestamp: '2026-10-04T10:00:42.886001Z',
      distinctId: BASE.distinct_id,
      source: 'audit',
      access: 'platform',
      app: 'api',
      sessionId: '0199a1b2-0000-7000-8000-0000000000f1',
      traceId: 'a'.repeat(32),
      path: NONE,
      elementText: NONE,
      props: { target_type: 'invitation', target_id: 'invitation-1', has_reason: false },
      verified: true,
      tenant: TENANT_ID,
    })
  })

  it('demotes an unsigned server-looking event to a browser row with no target', () => {
    expect(
      mapOne({
        'properties.$session_id': '0199a1b2-0000-7000-8000-0000000000f1',
        'properties.trace_id': 'a'.repeat(32),
        'properties.source': 'audit',
        'properties.access': 'platform',
        'properties.app': 'api',
        'properties.target_type': 'invitation',
        'properties.target_id': 'invitation-1',
        'properties.has_reason': false,
      })
    ).toEqual({
      uuid: BASE.uuid,
      event: 'invitation_created',
      timestamp: '2026-10-04T10:00:42.886001Z',
      distinctId: BASE.distinct_id,
      source: 'browser',
      access: NONE,
      app: 'api',
      sessionId: '0199a1b2-0000-7000-8000-0000000000f1',
      traceId: 'a'.repeat(32),
      path: NONE,
      elementText: NONE,
      props: { has_reason: false },
      verified: false,
      tenant: NONE,
    })
  })

  it('keeps every allowlisted property of a signed row and drops any column past them', () => {
    const allProperties = Object.fromEntries(
      TIMELINE_PROP_KEYS.map((key, index) => [`properties.${key}`, `value-${String(index)}`])
    )
    const row = [
      ...resultRow(signedEvent({ ...BASE, ...allProperties })),
      'an unselected column',
      { $ip: '203.0.113.7' },
    ]

    const [mapped] = mapTimelineResults([row], USER_TARGET)

    expect(mapped?.props).toEqual(
      Object.fromEntries(TIMELINE_PROP_KEYS.map((key, index) => [key, `value-${String(index)}`]))
    )
    expect(JSON.stringify(mapped)).not.toContain('an unselected column')
    expect(JSON.stringify(mapped)).not.toContain('203.0.113.7')
  })

  it('drops a property whose value is not a string, number or boolean, or is empty', () => {
    expect(
      mapOne({
        'properties.target_type': { nested: 'object' },
        'properties.target_id': ['list'],
        'properties.step_key': '',
        'properties.required': true,
        'properties.method': 0,
      }).props
    ).toEqual({ required: true, method: 0 })
  })

  it('shows no target props on a verified row whose signed target was absent, when a replay adds numeric ones', () => {
    const signed = signedEvent({
      ...BASE,
      'properties.source': 'audit',
      'properties.access': 'platform',
    })
    const replay = { ...signed, 'properties.target_type': 1, 'properties.target_id': 2 }

    const [row] = mapTimelineResults([resultRow(replay)], USER_TARGET)

    expect(row?.verified).toBe(true)
    expect(row?.props).not.toHaveProperty('target_type')
    expect(row?.props).not.toHaveProperty('target_id')
  })

  it('drops a boolean target_id', () => {
    const signed = signedEvent({ ...BASE, 'properties.source': 'audit' })
    const replay = { ...signed, 'properties.target_id': true }

    const [row] = mapTimelineResults([resultRow(replay)], USER_TARGET)

    expect(row?.verified).toBe(true)
    expect(row?.props).toEqual({})
  })

  it('keeps the string target of a signed row', () => {
    const [row] = mapTimelineResults(
      [
        resultRow(
          signedEvent({
            ...BASE,
            'properties.source': 'audit',
            'properties.target_type': 'invitation',
            'properties.target_id': 'invitation-1',
          })
        ),
      ],
      USER_TARGET
    )

    expect(row?.verified).toBe(true)
    expect(row?.props).toEqual({ target_type: 'invitation', target_id: 'invitation-1' })
  })

  it('defaults source to browser, and an unknown access or app to null', () => {
    const row = mapOne({
      event: '$pageview',
      'properties.source': 'backfill',
      'properties.access': 'root',
      'properties.app': 'mobile',
    })

    expect([row.source, row.access, row.app]).toEqual(['browser', NONE, NONE])
    expect(mapOne({ event: '$pageview' }).source).toBe('browser')
  })

  it("reads PostHog's empty string for an absent property as null", () => {
    const row = mapOne({
      'properties.$session_id': '',
      'properties.trace_id': '',
      'properties.app': '',
      'properties.$current_url': '',
    })

    expect([row.sessionId, row.traceId, row.app, row.path]).toEqual([NONE, NONE, NONE, NONE])
  })

  it('keeps only the pathname of the page URL', () => {
    expect(
      mapOne({
        event: '$pageview',
        'properties.$current_url':
          'https://app.example.test/reset-password?token=secret-token#section',
      }).path
    ).toBe('/reset-password')
  })

  it.each(['not a url', 'javascript:alert(1)', 'mailto:ops@example.test'])(
    'gives a path of null for %s',
    (url) => {
      expect(mapOne({ 'properties.$current_url': url }).path).toBeNull()
    }
  )

  it.each(['$autocapture', '$rageclick'])('keeps the element text of a %s', (event) => {
    expect(mapOne({ event, 'properties.$el_text': 'Save' }).elementText).toBe('Save')
  })

  it('drops the element text of any other event', () => {
    expect(
      mapOne({ event: '$pageview', 'properties.$el_text': 'Ada Lovelace' }).elementText
    ).toBeNull()
  })

  it('cuts element text to 80 characters without splitting a surrogate pair', () => {
    const long = `${'a'.repeat(79)}𝓾𝓾𝓾`

    const elementText = mapOne({ event: '$autocapture', 'properties.$el_text': long }).elementText

    expect(elementText).toBe(`${'a'.repeat(79)}𝓾`)
    expect([...(elementText ?? '')]).toHaveLength(80)
  })

  it('keeps the first row of each uuid, in order', () => {
    const rows = mapTimelineResults(
      [
        resultRow({ ...BASE, uuid: 'b', event: 'first' }),
        resultRow({ ...BASE, uuid: 'a', event: 'second' }),
        resultRow({ ...BASE, uuid: 'b', event: 'duplicate' }),
      ],
      USER_TARGET
    )

    expect(rows.map((row) => [row.uuid, row.event])).toEqual([
      ['b', 'first'],
      ['a', 'second'],
    ])
  })

  it('drops a row that is not an array or lacks its uuid, event, timestamp or distinct id', () => {
    const rows = mapTimelineResults(
      [
        'not a row',
        { uuid: 'x' },
        resultRow({ ...BASE, uuid: '' }),
        resultRow({ ...BASE, event: 7 as unknown as string }),
        resultRow({ ...BASE, timestamp: '' }),
        resultRow({ ...BASE, distinct_id: '' }),
        resultRow(BASE),
      ],
      USER_TARGET
    )

    expect(rows.map((row) => row.uuid)).toEqual([BASE.uuid])
  })

  it("marks a row whose signature is not this server's as unverified, and demotes it", () => {
    const forged = {
      ...BASE,
      'properties.source': 'audit',
      'properties.access': 'platform',
      'properties.server_sig': '0'.repeat(32),
    }

    const row = mapOne(forged)

    expect([row.verified, row.source, row.access]).toEqual([false, 'browser', NONE])
  })

  it('drops an unverified row naming the user but sent by another distinct id', () => {
    const forged = resultRow({
      ...BASE,
      distinct_id: OTHER_ID,
      'properties.source': 'audit',
      'properties.target_type': 'user',
      'properties.target_id': USER_ID,
    })
    const signed = resultRow(
      signedEvent({
        ...BASE,
        uuid: '0199a1b2-0000-7000-8000-0000000000b2',
        distinct_id: OTHER_ID,
        'properties.source': 'audit',
        'properties.access': 'platform',
        'properties.target_type': 'user',
        'properties.target_id': USER_ID,
      })
    )

    const rows = mapTimelineResults([forged, signed], USER_TARGET)

    expect(rows.map((row) => [row.uuid, row.verified, row.props.target_id])).toEqual([
      ['0199a1b2-0000-7000-8000-0000000000b2', true, USER_ID],
    ])
  })

  it("keeps the user's own unverified row naming them, demoted", () => {
    const own = resultRow({
      ...BASE,
      distinct_id: USER_ID,
      'properties.target_type': 'user',
      'properties.target_id': USER_ID,
    })

    const [row] = mapTimelineResults([own], USER_TARGET)

    expect(row?.props).toEqual({})
    expect(row?.verified).toBe(false)
  })

  it('drops an unverified row naming the tenant from outside its group, and demotes one inside it', () => {
    const outside = resultRow({
      ...BASE,
      uuid: '0199a1b2-0000-7000-8000-0000000000c1',
      'properties.target_type': 'tenant',
      'properties.target_id': TENANT_ID,
      'properties.$groups.tenant': '0199a1b2-0000-7000-8000-000000000004',
    })
    const ungrouped = resultRow({
      ...BASE,
      uuid: '0199a1b2-0000-7000-8000-0000000000c2',
      'properties.target_type': 'tenant',
      'properties.target_id': TENANT_ID,
    })
    const inside = resultRow({
      ...BASE,
      uuid: '0199a1b2-0000-7000-8000-0000000000c3',
      'properties.target_type': 'tenant',
      'properties.target_id': TENANT_ID,
      'properties.$groups.tenant': TENANT_ID,
    })

    const rows = mapTimelineResults([outside, ungrouped, inside], TENANT_TARGET)

    expect(rows.map((row) => [row.uuid, row.tenant, row.props])).toEqual([
      ['0199a1b2-0000-7000-8000-0000000000c3', TENANT_ID, {}],
    ])
  })

  it('applies the drop rule of the timeline kind only', () => {
    const namingUser = resultRow({
      ...BASE,
      distinct_id: OTHER_ID,
      'properties.target_type': 'user',
      'properties.target_id': USER_ID,
    })

    expect(mapTimelineResults([namingUser], TENANT_TARGET)).toHaveLength(1)
  })

  it('keeps the signed copy when a forged row reuses its uuid, in the first position', () => {
    const unverified = resultRow({ ...BASE, 'properties.source': 'audit' })
    const verified = resultRow(signedEvent({ ...BASE, 'properties.source': 'audit' }))
    const other = resultRow({ ...BASE, uuid: '0199a1b2-0000-7000-8000-0000000000d1' })

    const rows = mapTimelineResults([unverified, other, verified], USER_TARGET)

    expect(rows.map((row) => [row.uuid, row.verified, row.source])).toEqual([
      [BASE.uuid, true, 'audit'],
      ['0199a1b2-0000-7000-8000-0000000000d1', false, 'browser'],
    ])
  })
})

describe('cursorAfter', () => {
  it("reads a raw row's timestamp string and uuid", () => {
    expect(cursorAfter(resultRow(BASE))).toEqual({ t: BASE.timestamp, u: BASE.uuid })
  })

  it('reads a row the mapper would drop just the same', () => {
    const forged = resultRow({
      ...BASE,
      distinct_id: OTHER_ID,
      'properties.target_type': 'user',
      'properties.target_id': USER_ID,
    })

    expect(mapTimelineResults([forged], USER_TARGET)).toEqual([])
    expect(cursorAfter(forged)).toEqual({ t: BASE.timestamp, u: BASE.uuid })
  })

  it('gives undefined for a row with no uuid or timestamp, or no row', () => {
    expect(cursorAfter(resultRow({ ...BASE, timestamp: '' }))).toBeUndefined()
    expect(cursorAfter('not a row')).toBeUndefined()
  })
})
