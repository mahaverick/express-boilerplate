/**
 * @file The opaque timeline page cursor: base64url JSON `{ t, u }`, the last
 * row's timestamp exactly as PostHog returned it and its uuid. The timestamp
 * stays a string end to end: a JS `Date` keeps milliseconds only, and PostHog
 * keeps microseconds, so a round trip through one would repeat or skip rows
 * that share a millisecond.
 */
import { z } from 'zod'
import type { TimelineCursor } from '@/types/timeline'
import { decodeCursor, encodeCursor } from '@/utilities/cursor.utilities'

/**
 * An ISO 8601 timestamp with up to six fractional digits and a `Z` or a
 * numeric offset of at most 14 hours, as PostHog returns `timestamp`. Hours,
 * minutes and seconds are in range; the day is checked by `isRealTimelineT`.
 */
const CURSOR_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|[+-](0\d|1[0-4]):[0-5]\d)$/

/**
 * Whether a cursor timestamp's date is a real calendar day in ClickHouse
 * DateTime64's range (years 1900-2299). Anything else PostHog would reject
 * with a 400, which would surface as a 502 and spend a query budget unit.
 * @param t - Text already matching `CURSOR_TIMESTAMP`; kept verbatim.
 * @returns True when the date part is real and in range.
 */
function isRealTimelineT(t: string): boolean {
  const day = t.slice(0, 10)
  const year = Number(day.slice(0, 4))
  if (year < 1900 || year > 2299) return false
  const instant = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === day
}

/**
 * A UUID's shape, of any version: PostHog event uuids are not all v4 or v7.
 */
const CURSOR_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

const timelineCursorSchema = z.strictObject({
  t: z.string().regex(CURSOR_TIMESTAMP).refine(isRealTimelineT),
  u: z.string().regex(CURSOR_UUID),
})

/**
 * Encode the cursor of the page after a row.
 * @param cursor - The row's timestamp string and uuid.
 * @returns The opaque cursor.
 */
export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return encodeCursor({ t: cursor.t, u: cursor.u })
}

/**
 * Decode and check a cursor from a request.
 * @param raw - The `before` query value.
 * @returns The cursor, or undefined when it is not one this API issued in shape.
 */
export function decodeTimelineCursor(raw: string): TimelineCursor | undefined {
  return decodeCursor(raw, timelineCursorSchema)
}
