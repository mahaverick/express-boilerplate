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
 * The search cursor's decoded shape: the last row's `lower(name)` and id.
 */
export const platformTenantCursorSchema = z
  .object({ sortName: z.string().max(255), id: z.string().min(1).max(36) })
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
