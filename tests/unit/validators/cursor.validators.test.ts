import { describe, expect, it } from 'vitest'
import { isoInstantField, sortAtField } from '@/validators/cursor.validators'

describe('sortAtField', () => {
  it.each([
    '2026-10-07T12:34:56.123456Z',
    '2024-02-29T00:00:00.000000Z',
    '0001-01-01T00:00:00.000000Z',
    '9999-12-31T23:59:59.999999Z',
  ])('accepts %s', (value) => {
    expect(sortAtField.safeParse(value).success).toBe(true)
  })

  it.each([
    '9999-99-99T99:99:99.999999Z',
    '2026-02-30T00:00:00.000000Z',
    '2026-13-45T25:61:61.000000Z',
    '2025-02-29T00:00:00.000000Z',
    '0000-01-01T00:00:00.000000Z',
    '2026-10-07T12:34:56.123Z',
    '2026-10-07 12:34:56.123456Z',
  ])('refuses %s', (value) => {
    expect(sortAtField.safeParse(value).success).toBe(false)
  })
})

describe('isoInstantField', () => {
  it.each([
    '0001-01-01T00:00:00.000Z',
    '2026-10-07T12:34:56.123Z',
    '2026-10-07T12:34:56.123456789Z',
    '9999-12-31T23:59:59.999Z',
    '9999-12-31T23:59:59.999999999Z',
  ])('accepts %s', (value) => {
    expect(isoInstantField.safeParse(value).success).toBe(true)
  })

  it.each([
    '0000-01-01T00:00:00.000Z',
    '2026-13-01T00:00:00.000Z',
    '2026-10-07 12:34:56.123Z',
    'not a date',
  ])('refuses %s', (value) => {
    expect(isoInstantField.safeParse(value).success).toBe(false)
  })
})
