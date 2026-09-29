/**
 * @file The platform Overview: totals plus zero-filled daily series. The route
 * has already checked the platform role.
 */
import type { StatsRange } from '@/constants/platform.constants'
import {
  PlatformStatsRepository,
  type DayCount,
  type PlatformTotals,
} from '@/repositories/platform-stats.repository'

const platformStatsRepository = new PlatformStatsRepository()

const RANGE_DAYS: Readonly<Record<StatsRange, number>> = { '7d': 7, '30d': 30 }
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The Overview's response body.
 *
 * `signups[].users` counts every non-deleted user created that day, inactive
 * and staff included, while `totals.users` counts active users only.
 * `emails[]` counts `email_logs` rows, which are one per delivery attempt: a
 * mail retried after a failure and then sent adds a failed row and a sent row,
 * so `failed` is failed attempts, not failed mails.
 */
export interface PlatformStats {
  range: StatsRange
  totals: PlatformTotals
  signups: { date: string; users: number; tenants: number }[]
  emails: { date: string; sent: number; failed: number }[]
}

/**
 * The UTC days a range covers, ending with today.
 * @param range - The window.
 * @param now - The current instant.
 * @returns `from` (inclusive) and `to` (exclusive) as UTC midnights, and each day as `YYYY-MM-DD`, oldest first.
 */
export function utcDays(range: StatsRange, now: Date): { from: Date; to: Date; days: string[] } {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const count = RANGE_DAYS[range]
  const from = new Date(todayStart - (count - 1) * DAY_MS)
  const to = new Date(todayStart + DAY_MS)
  const days = Array.from({ length: count }, (_, index) =>
    new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10)
  )
  return { from, to, days }
}

/**
 * A lookup from day to count.
 * @param rows - Per-day counts.
 * @returns The counts keyed by day.
 */
function byDay(rows: readonly DayCount[]): Map<string, number> {
  return new Map(rows.map((row) => [row.day, row.count]))
}

/**
 * The Overview for one range.
 * @param range - The window.
 * @param now - The current instant; injectable for tests.
 * @returns Totals, and one zero-filled entry per day for sign-ups and emails.
 */
export async function getPlatformStats(
  range: StatsRange,
  now: Date = new Date()
): Promise<PlatformStats> {
  const { from, to, days } = utcDays(range, now)
  const [totals, signups, emails] = await Promise.all([
    platformStatsRepository.totals(),
    platformStatsRepository.signupsByDay(from, to),
    platformStatsRepository.emailsByDay(from, to),
  ])
  const users = byDay(signups.users)
  const tenants = byDay(signups.tenants)
  const sent = byDay(emails.filter((row) => row.status === 'sent'))
  const failed = byDay(emails.filter((row) => row.status === 'failed'))
  return {
    range,
    totals,
    signups: days.map((date) => ({
      date,
      users: users.get(date) ?? 0,
      tenants: tenants.get(date) ?? 0,
    })),
    emails: days.map((date) => ({
      date,
      sent: sent.get(date) ?? 0,
      failed: failed.get(date) ?? 0,
    })),
  }
}
