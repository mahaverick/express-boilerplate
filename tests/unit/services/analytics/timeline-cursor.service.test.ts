/**
 * @file The timeline cursor: a round trip keeps PostHog's microsecond
 * timestamp string exactly, so two rows in one millisecond stay apart, and
 * anything malformed or tampered with decodes to undefined.
 */
import { describe, expect, it } from 'vitest'
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
} from '@/services/analytics/timeline-cursor.service'
import { encodeCursor } from '@/utilities/cursor.utilities'

const UUID = '0199a1b2-0000-7000-8000-0000000000aa'

describe('the timeline cursor', () => {
  it.each([
    '2026-10-04T10:00:42.886001Z',
    '2026-10-04T10:00:42.886002Z',
    '2026-10-04T10:00:42Z',
    '2026-10-04T10:00:42.5+00:00',
    '2026-10-04T12:00:42.123456+02:00',
    '2026-10-04T10:00:42.1Z',
    '2024-02-29T23:59:59.999999-05:30',
    '1900-01-01T00:00:00Z',
    '2299-12-31T23:59:59.999999+14:00',
  ])('round-trips %s verbatim', (t) => {
    expect(decodeTimelineCursor(encodeTimelineCursor({ t, u: UUID }))).toEqual({ t, u: UUID })
  })

  it('keeps two timestamps in one millisecond distinct, where a Date would merge them', () => {
    const first = encodeTimelineCursor({ t: '2026-10-04T10:00:42.886001Z', u: UUID })
    const second = encodeTimelineCursor({ t: '2026-10-04T10:00:42.886002Z', u: UUID })

    expect(decodeTimelineCursor(first)?.t).not.toBe(decodeTimelineCursor(second)?.t)
    expect(new Date('2026-10-04T10:00:42.886001Z').toISOString()).toBe(
      new Date('2026-10-04T10:00:42.886002Z').toISOString()
    )
  })

  it('is base64url JSON of { t, u }', () => {
    const encoded = encodeTimelineCursor({ t: '2026-10-04T10:00:42.886001Z', u: UUID })

    expect(encoded).toMatch(/^[\w-]+$/)
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual({
      t: '2026-10-04T10:00:42.886001Z',
      u: UUID,
    })
  })

  it.each([
    ['not base64 JSON', '%%%'],
    ['empty', ''],
    ['a JSON string', encodeCursor({ t: 'x' }).slice(0, 4)],
    ['a seven-digit fraction', encodeCursor({ t: '2026-10-04T10:00:42.8860011Z', u: UUID })],
    ['a date without a time', encodeCursor({ t: '2026-10-04', u: UUID })],
    ['no zone', encodeCursor({ t: '2026-10-04T10:00:42.886001', u: UUID })],
    ['an injected timestamp', encodeCursor({ t: "2026-10-04T10:00:42Z' or 1=1", u: UUID })],
    ['month 13', encodeCursor({ t: '2026-13-01T00:00:00.000000Z', u: UUID })],
    ['30 February', encodeCursor({ t: '2026-02-30T00:00:00.000000Z', u: UUID })],
    ['29 February in a common year', encodeCursor({ t: '2025-02-29T00:00:00Z', u: UUID })],
    ['hour 24', encodeCursor({ t: '2026-10-04T24:00:00Z', u: UUID })],
    ['minute 60', encodeCursor({ t: '2026-10-04T10:60:00Z', u: UUID })],
    ['second 60', encodeCursor({ t: '2026-10-04T10:00:60Z', u: UUID })],
    ['an offset of 99:99', encodeCursor({ t: '2026-10-04T10:00:00+99:99', u: UUID })],
    ['an offset past 14 hours', encodeCursor({ t: '2026-10-04T10:00:00+15:00', u: UUID })],
    ['year 0000', encodeCursor({ t: '0000-01-01T00:00:00.000000Z', u: UUID })],
    ['year 1899', encodeCursor({ t: '1899-12-31T23:59:59Z', u: UUID })],
    ['year 2300', encodeCursor({ t: '2300-01-01T00:00:00Z', u: UUID })],
    ['a uuid that is not one', encodeCursor({ t: '2026-10-04T10:00:42Z', u: 'not-a-uuid' })],
    ['a missing uuid', encodeCursor({ t: '2026-10-04T10:00:42Z' })],
    ['an extra key', encodeCursor({ t: '2026-10-04T10:00:42Z', u: UUID, view: 'key' })],
  ])('decodes %s to undefined', (_name, raw) => {
    expect(decodeTimelineCursor(raw)).toBeUndefined()
  })

  it('decodes a tampered cursor to undefined', () => {
    const encoded = encodeTimelineCursor({ t: '2026-10-04T10:00:42.886001Z', u: UUID })
    const tampered = `${encoded.slice(0, 5)}A${encoded.slice(6)}`

    expect(decodeTimelineCursor(tampered)).toBeUndefined()
  })
})
