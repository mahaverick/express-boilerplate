/**
 * @file The platform Overview: totals plus zero-filled daily series. The route
 * has already checked the platform role.
 */
import {
  EMAIL_MESSAGE_GROUPS,
  type EmailMessageGroup,
  type EmailMessageStatus,
} from '@/constants/email.constants'
import type { StatsRange } from '@/constants/platform.constants'
import {
  PlatformStatsRepository,
  type DayCount,
  type PlatformTotals,
} from '@/repositories/platform-stats.repository'
import { countStuckTenants } from '@/services/platform-onboarding.service'

const platformStatsRepository = new PlatformStatsRepository()

const RANGE_DAYS: Readonly<Record<StatsRange, number>> = { '7d': 7, '30d': 30 }
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * One UTC day of email messages: how many created that day are now in each
 * of the five disjoint groups of `EMAIL_MESSAGE_GROUPS` (`sent` also holds
 * `deferred`, `undelivered` holds `bounced` and `failed`). `queued` counts
 * in none.
 */
export type EmailMessageDay = { date: string } & Record<EmailMessageGroup, number>

/**
 * The Overview's response body.
 *
 * `signups[].users` counts every non-deleted user created that day, inactive
 * and staff included, while `totals.users` counts active users only.
 * `emailMessages[]` counts logical emails by their current status; with no
 * provider webhook configured every successful send stays in `sent`.
 * `totals.stuckTenants` counts the active, tracked tenants whose onboarding
 * is stuck now, whatever the range.
 */
export interface PlatformStats {
  range: StatsRange
  totals: PlatformTotals & { stuckTenants: number }
  signups: { date: string; users: number; tenants: number }[]
  /**
   * `email_logs` rows, which are one per delivery attempt: a mail retried
   * after a failure and then sent adds a failed row and a sent row, so
   * `failed` is failed attempts, not failed mails.
   * @deprecated Use `emailMessages`, which counts each email once.
   */
  emails: { date: string; sent: number; failed: number }[]
  emailMessages: EmailMessageDay[]
}

const EMAIL_GROUP_NAMES = Object.keys(EMAIL_MESSAGE_GROUPS) as EmailMessageGroup[]

/**
 * The stats group a status counts in.
 * @param status - A message status.
 * @returns Its group, or undefined for `queued`.
 */
function groupOf(status: EmailMessageStatus): EmailMessageGroup | undefined {
  return EMAIL_GROUP_NAMES.find((group) => EMAIL_MESSAGE_GROUPS[group].includes(status))
}

/**
 * Zero-filled daily message counts in the five groups.
 * @param days - The range's days, `YYYY-MM-DD`, oldest first.
 * @param rows - Per-day, per-status counts.
 * @returns One entry per day.
 */
export function emailMessageDays(
  days: readonly string[],
  rows: readonly { day: string; status: EmailMessageStatus; count: number }[]
): EmailMessageDay[] {
  const entries: EmailMessageDay[] = days.map((date) => ({
    date,
    delivered: 0,
    sent: 0,
    undelivered: 0,
    complained: 0,
    suppressed: 0,
  }))
  const byDate = new Map(entries.map((entry) => [entry.date, entry]))
  for (const row of rows) {
    const group = groupOf(row.status)
    const entry = byDate.get(row.day)
    if (group !== undefined && entry !== undefined) entry[group] += row.count
  }
  return entries
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
 * @returns Totals (the stuck-tenant count included), and one zero-filled entry per day for sign-ups, email attempts and email messages.
 */
export async function getPlatformStats(
  range: StatsRange,
  now: Date = new Date()
): Promise<PlatformStats> {
  const { from, to, days } = utcDays(range, now)
  const [totals, stuckTenants, signups, emails, messages] = await Promise.all([
    platformStatsRepository.totals(),
    countStuckTenants(now),
    platformStatsRepository.signupsByDay(from, to),
    platformStatsRepository.emailsByDay(from, to),
    platformStatsRepository.emailMessagesByDay(from, to),
  ])
  const users = byDay(signups.users)
  const tenants = byDay(signups.tenants)
  const sent = byDay(emails.filter((row) => row.status === 'sent'))
  const failed = byDay(emails.filter((row) => row.status === 'failed'))
  return {
    range,
    totals: { ...totals, stuckTenants },
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
    emailMessages: emailMessageDays(days, messages),
  }
}
