import { describe, expect, it } from 'vitest'
import { utcDays } from '@/services/platform-stats.service'

describe('utcDays', () => {
  it('covers the last 7 UTC days, today included, oldest first', () => {
    const { from, to, days } = utcDays('7d', new Date('2026-09-29T15:30:00.000Z'))
    expect(days).toEqual([
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
    ])
    expect(from.toISOString()).toBe('2026-09-23T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-09-30T00:00:00.000Z')
  })

  it('covers 30 days for 30d', () => {
    const { days } = utcDays('30d', new Date('2026-09-29T00:00:00.000Z'))
    expect(days).toHaveLength(30)
    expect(days[0]).toBe('2026-08-31')
    expect(days.at(-1)).toBe('2026-09-29')
  })

  it('puts the last millisecond of a day in that day', () => {
    const { days } = utcDays('7d', new Date('2026-09-29T23:59:59.999Z'))
    expect(days.at(-1)).toBe('2026-09-29')
  })
})
