import { describe, expect, it } from 'vitest'
import { parseDurationMs } from '@/utilities/duration.utilities'

describe('parseDurationMs', () => {
  it('parses a minute-style duration string', () => {
    expect(parseDurationMs('15m')).toBe(15 * 60 * 1000)
  })

  it('parses a day-style duration string', () => {
    expect(parseDurationMs('30d')).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('parses a bare millisecond number string', () => {
    expect(parseDurationMs('900000')).toBe(900_000)
  })

  it('returns undefined for a string ms() cannot parse', () => {
    expect(parseDurationMs('not-a-duration')).toBeUndefined()
  })

  it('returns undefined rather than throwing for an empty string', () => {
    // ms('') throws internally (it fails ms's own non-empty-string guard) —
    // this function's contract is to never throw, so it must catch that.
    expect(() => parseDurationMs('')).not.toThrow()
    expect(parseDurationMs('')).toBeUndefined()
  })

  it('rejects a zero duration', () => {
    expect(parseDurationMs('0')).toBeUndefined()
  })

  it('rejects a negative duration', () => {
    expect(parseDurationMs('-5m')).toBeUndefined()
  })
})
