// src/utilities/cursor.utilities.ts
//
// Opaque keyset cursors: base64url JSON, checked against a Zod schema on the
// way back in. A cursor is client input, so decoding never throws.
import type { z } from 'zod'

/**
 * Encode a page's last-row keys as an opaque, URL-safe cursor.
 * @param value - The keys the next page resumes after.
 * @returns A base64url string.
 */
export function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * Decode a cursor produced by `encodeCursor` and validate it.
 * @param raw - The cursor as the client sent it.
 * @param schema - The shape the decoded value must have.
 * @returns The decoded keys, or undefined for anything malformed.
 */
export function decodeCursor<TSchema extends z.ZodType>(
  raw: string,
  schema: TSchema
): z.infer<TSchema> | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    const parsed = schema.safeParse(decoded)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
