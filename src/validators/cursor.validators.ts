/**
 * @file The cursor query field for keyset endpoints that reject a bad cursor:
 * a malformed cursor is a 400 through `parseBody`, not a silent first page.
 * Also the `sortAt` field the staff list cursors share.
 */
import { z } from 'zod'
import { decodeCursor } from '@/utilities/cursor.utilities'

/**
 * Room for any cursor the server issues. A 255-character value is at most
 * 1,530 bytes of JSON (a control character escapes to six); with a uuid
 * beside it that encodes to 2,119 base64url characters.
 */
const MAX_CURSOR_LENGTH = 4096

/**
 * A `cursor` query field that decodes against `schema`, or fails validation
 * with "cursor is invalid.".
 * @param schema - The decoded cursor's shape.
 * @returns A Zod field whose output is the decoded cursor.
 */
export function cursorField<TSchema extends z.ZodType>(schema: TSchema) {
  return z
    .string()
    .max(MAX_CURSOR_LENGTH)
    .transform((raw, context): z.infer<TSchema> => {
      const decoded = decodeCursor(raw, schema)
      if (decoded === undefined) {
        context.addIssue({ code: 'custom', message: 'cursor is invalid.' })
        return z.NEVER
      }
      return decoded
    })
}

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

/**
 * An ISO 8601 UTC instant that is real and in year 0001 or later. Postgres has
 * no year 0, so `0000-…` would pass the format check and then fail a
 * `::timestamptz` cast as a 500.
 */
export const isoInstantField = z.iso
  .datetime()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)) && new Date(value).getUTCFullYear() >= 1,
    'Not a real timestamp.'
  )
