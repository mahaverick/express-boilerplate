/**
 * @file The formatters for an absolute date in copy that lasts: an email, a
 * notification, a CLI line or an error naming a moment. A date and time is
 * always UTC, so two readers in two time zones read the same text. A billing
 * date is the one exception: it is a date alone, read in the workspace's time
 * zone, so it matches the day on the customer's bank message.
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

/**
 * A date alone, as a person reads it, in a time zone: the day, the month's
 * name and the year. A zone name the runtime does not know reads as UTC.
 * @param date - The moment.
 * @param timeZone - An IANA zone name, such as `Asia/Kolkata`.
 * @returns For example "2 November 2026".
 */
export function formatDateInZone(date: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    }).formatToParts(date)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return formatDateInZone(date, 'UTC')
  }
  /**
   * One numeric part of the formatted date.
   * @param type - The part.
   * @returns Its value.
   */
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value)
  const month = MONTH_NAMES[part('month') - 1] ?? ''
  return `${String(part('day'))} ${month} ${String(part('year'))}`
}
