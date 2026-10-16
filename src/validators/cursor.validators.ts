/**
 * @file The `sortAt` field the platform email and onboarding cursors share.
 */
import { z } from 'zod'

const SORT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

/**
 * Whether a `sortAt` names a real instant Postgres can hold: the date and time
 * survive a round trip through `Date` unchanged to the millisecond (so no
 * month 13, no 30 February, no hour 25), in year 0001 or later.
 * @param value - Text already matching the microsecond UTC shape.
 * @returns True when the value is a real timestamp.
 */
function isRealSortAt(value: string): boolean {
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime()) || instant.getUTCFullYear() < 1) return false
  return instant.toISOString().slice(0, 23) === value.slice(0, 23)
}

/**
 * A keyset cursor's `sortAt`: a row's timestamp as UTC text with
 * microseconds, exactly as the repositories select it, and a real instant.
 */
export const sortAtField = z
  .string()
  .regex(SORT_AT_PATTERN)
  .refine(isRealSortAt, 'sortAt is not a real timestamp.')
