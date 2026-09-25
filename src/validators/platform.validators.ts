// src/validators/platform.validators.ts
//
// The staff tenant search query. q is trimmed first, so whitespace alone is
// a 400 rather than a match-everything search.
import { z } from 'zod'
import { cursorField } from '@/validators/cursor.validators'

const DEFAULT_SEARCH_PAGE_SIZE = 20
const MAX_SEARCH_PAGE_SIZE = 50
const MAX_SEARCH_QUERY_LENGTH = 100

/**
 * Postgres text can't hold NUL, so a value carrying one would fail in the query.
 * @param value - The string to check.
 * @returns Whether `value` has no NUL character.
 */
function hasNoNul(value: string): boolean {
  return !value.includes('\0')
}

/**
 * The search cursor's decoded shape: the last row's `lower(name)` and id.
 */
export const platformTenantCursorSchema = z
  .object({ sortName: z.string().refine(hasNoNul), id: z.uuid() })
  .strict()

/**
 * `GET /api/v1/platform/tenants` query string.
 */
export const platformTenantSearchSchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, 'q must not be empty.')
    .max(MAX_SEARCH_QUERY_LENGTH, `q must be at most ${MAX_SEARCH_QUERY_LENGTH} characters.`)
    .refine(hasNoNul, 'q must not contain a NUL character.')
    .optional(),
  cursor: cursorField(platformTenantCursorSchema).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_PAGE_SIZE, `limit must be at most ${MAX_SEARCH_PAGE_SIZE}.`)
    .default(DEFAULT_SEARCH_PAGE_SIZE),
})

/**
 * The validated search query, with the cursor already decoded.
 */
export type PlatformTenantSearchQuery = z.infer<typeof platformTenantSearchSchema>
