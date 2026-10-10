import { describe, expect, it, vi } from 'vitest'
import { emailMessageDays, getPlatformStats, utcDays } from '@/services/platform-stats.service'

vi.mock('@/repositories/platform-stats.repository', () => ({
  PlatformStatsRepository: class {
    totals = () => Promise.resolve({ tenants: 2, users: 3, staff: 1 })
    signupsByDay = () => Promise.resolve({ users: [], tenants: [] })
    emailMessagesByDay = () => Promise.resolve([])
  },
}))
vi.mock('@/services/platform-onboarding.service', () => ({
  countStuckTenants: () => Promise.resolve(0),
}))

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

describe('emailMessageDays', () => {
  const days = ['2026-09-28', '2026-09-29']

  it('zero-fills every day in the five groups', () => {
    expect(emailMessageDays(days, [])).toEqual([
      { date: '2026-09-28', delivered: 0, sent: 0, undelivered: 0, complained: 0, suppressed: 0 },
      { date: '2026-09-29', delivered: 0, sent: 0, undelivered: 0, complained: 0, suppressed: 0 },
    ])
  })

  it('puts each status in exactly one group and leaves queued out', () => {
    const rows = [
      { day: '2026-09-29', status: 'delivered', count: 5 },
      { day: '2026-09-29', status: 'sent', count: 3 },
      { day: '2026-09-29', status: 'deferred', count: 2 },
      { day: '2026-09-29', status: 'bounced', count: 1 },
      { day: '2026-09-29', status: 'failed', count: 4 },
      { day: '2026-09-29', status: 'complained', count: 6 },
      { day: '2026-09-29', status: 'suppressed', count: 7 },
      { day: '2026-09-29', status: 'queued', count: 100 },
    ] as const
    const [, today] = emailMessageDays(days, rows)
    expect(today).toEqual({
      date: '2026-09-29',
      delivered: 5,
      sent: 5,
      undelivered: 5,
      complained: 6,
      suppressed: 7,
    })
    const total = rows
      .filter((row) => row.status !== 'queued')
      .reduce((sum, row) => sum + row.count, 0)
    const grouped = (
      ['delivered', 'sent', 'undelivered', 'complained', 'suppressed'] as const
    ).reduce((sum, group) => sum + (today?.[group] ?? 0), 0)
    expect(grouped).toBe(total)
  })

  it('ignores a row outside the range', () => {
    expect(
      emailMessageDays(days, [{ day: '2026-09-27', status: 'delivered', count: 9 }]).map(
        (day) => day.delivered
      )
    ).toEqual([0, 0])
  })
})

describe('getPlatformStats', () => {
  it('answers exactly range, totals, signups and emailMessages', async () => {
    const stats = await getPlatformStats('7d', new Date('2026-09-29T12:00:00.000Z'))
    expect(Object.keys(stats).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'emailMessages',
      'range',
      'signups',
      'totals',
    ])
    expect(stats.totals).toEqual({ tenants: 2, users: 3, staff: 1, stuckTenants: 0 })
  })
})
