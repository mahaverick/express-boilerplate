/**
 * @file The one formatter for an absolute date and time in copy that lasts:
 * an email, a notification, a CLI line or an error naming a moment. Always
 * UTC, so two readers in two time zones read the same text.
 */

/**
 * The months' names, January first, as `getUTCMonth` indexes them.
 */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/**
 * Milliseconds in a minute, the formatter's precision.
 */
const MS_PER_MINUTE = 60_000

/**
 * A moment as a person reads it, to the minute, in UTC.
 * @param date - The moment.
 * @param round - `down` (the default) for an expiry, which then never reads later than it is; `up` for a "you can after" time, which then never reads early.
 * @returns For example "15:42 UTC on 20 October 2026".
 */
export function formatUtcDateTime(date: Date, round: 'down' | 'up' = 'down'): string {
  const minutes = date.getTime() / MS_PER_MINUTE
  const moment = new Date(
    (round === 'up' ? Math.ceil(minutes) : Math.floor(minutes)) * MS_PER_MINUTE
  )
  const hours = String(moment.getUTCHours()).padStart(2, '0')
  const mins = String(moment.getUTCMinutes()).padStart(2, '0')
  const month = MONTH_NAMES[moment.getUTCMonth()] ?? ''
  return `${hours}:${mins} UTC on ${String(moment.getUTCDate())} ${month} ${String(moment.getUTCFullYear())}`
}
