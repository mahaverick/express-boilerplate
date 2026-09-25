// src/validators/cursor.validators.ts
//
// The cursor query field for keyset endpoints that reject a bad cursor. A
// malformed cursor is a 400 through parseBody, not a silent first page.
import { z } from 'zod'
import { decodeCursor } from '@/utilities/cursor.utilities'

// Room for any cursor the server issues. A 255-character value is at most
// 1,530 bytes of JSON (a control character escapes to six); with a uuid
// beside it that encodes to 2,119 base64url characters.
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
