/**
 * @file The absolute date and time text lasting copy carries: a 24-hour UTC
 * time, then the day, the month's name and the year.
 */
import { describe, expect, it } from 'vite-plus/test'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'

describe('formatUtcDateTime', () => {
  it('writes the UTC time, then the date', () => {
    expect(formatUtcDateTime(new Date('2026-10-20T15:42:30.000Z'))).toBe(
      '15:42 UTC on 20 October 2026'
    )
  })

  it('pads the hour and minute, and reads the date in UTC', () => {
    expect(formatUtcDateTime(new Date('2027-01-01T00:05:00.000Z'))).toBe(
      '00:05 UTC on 1 January 2027'
    )
  })

  it('rounds down by default, so an expiry never reads later than it is', () => {
    expect(formatUtcDateTime(new Date('2026-10-20T15:42:59.999Z'))).toBe(
      '15:42 UTC on 20 October 2026'
    )
  })

  it('rounds up on request, so a "you can after" time is never early', () => {
    expect(formatUtcDateTime(new Date('2026-10-20T23:59:00.001Z'), 'up')).toBe(
      '00:00 UTC on 21 October 2026'
    )
    expect(formatUtcDateTime(new Date('2026-10-20T15:42:00.000Z'), 'up')).toBe(
      '15:42 UTC on 20 October 2026'
    )
  })
})
