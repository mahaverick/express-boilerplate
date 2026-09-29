/**
 * @file The staff tenant search query. `q` is trimmed first, so whitespace
 * alone is a 400 rather than a match-everything search.
 */
import { z } from 'zod'
import { PAGE_DIRECTIONS, STATS_RANGES } from '@/constants/platform.constants'
import { HttpError } from '@/errors/http-error'
import { cursorField } from '@/validators/cursor.validators'
import { normalizeMultilineText, safeText } from '@/validators/safe-text.validators'

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
 * The trimmed search text both staff searches take. Whitespace alone is a
 * 400 rather than a match-everything search.
 */
export const searchQueryField = z
  .string()
  .trim()
  .min(1, 'q must not be empty.')
  .max(MAX_SEARCH_QUERY_LENGTH, `q must be at most ${MAX_SEARCH_QUERY_LENGTH} characters.`)
  .refine(hasNoNul, 'q must not contain a NUL character.')

/**
 * Page size for both staff searches: 1–50, 20 by default.
 */
export const pageLimitField = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_SEARCH_PAGE_SIZE, `limit must be at most ${MAX_SEARCH_PAGE_SIZE}.`)
  .default(DEFAULT_SEARCH_PAGE_SIZE)

/**
 * `GET /api/v1/platform/tenants` query string.
 */
export const platformTenantSearchSchema = z.object({
  q: searchQueryField.optional(),
  cursor: cursorField(platformTenantCursorSchema).optional(),
  limit: pageLimitField,
})

/**
 * The validated search query, with the cursor already decoded.
 */
export type PlatformTenantSearchQuery = z.infer<typeof platformTenantSearchSchema>

/**
 * `GET /platform/stats` query: the window, 7 days unless asked otherwise.
 */
export const platformStatsQuerySchema = z.object({
  range: z.enum(STATS_RANGES).default('7d'),
})

/**
 * The validated stats query.
 */
export type PlatformStatsQuery = z.infer<typeof platformStatsQuerySchema>

/**
 * The longest reason a staff member may give; the audit schema re-checks it.
 */
export const MAX_REASON_LENGTH = 500

/**
 * Why a staff member is taking a state-changing action, stored in its audit
 * entry and shown back in Apex. Multi-line text is allowed (`\r\n` becomes
 * `\n` first); every other control character and bidi overrides are refused.
 */
export const reasonSchema = z.preprocess(
  normalizeMultilineText,
  z
    .string()
    .trim()
    .min(1, 'reason must not be empty.')
    .max(MAX_REASON_LENGTH, `reason must be at most ${MAX_REASON_LENGTH} characters.`)
    .refine(safeText({ multiline: true }), 'reason contains characters that are not allowed.')
)

/**
 * The body of every action that takes only a reason. Strict, so no other field
 * (a state, a role) can ride along.
 */
export const reasonBodySchema = z.strictObject({ reason: reasonSchema })

/**
 * The validated `{ reason }` body.
 */
export type ReasonBody = z.infer<typeof reasonBodySchema>

/**
 * The `direction` query field of a keyset search: forward unless asked otherwise.
 */
export const directionField = z.enum(PAGE_DIRECTIONS).default('next')

const idParameterSchema = z.uuid()

/**
 * A route's `:id` as a uuid, or a 404 with `notFoundMessage`: a malformed id
 * answers like an unknown one, so ids can't be probed by format.
 * @param raw - `request.params.id` as Express supplies it.
 * @param notFoundMessage - The 404's message, e.g. 'Tenant not found'.
 * @returns The id.
 * @throws {HttpError} 404 when `raw` is not a uuid.
 */
export function parseIdParameter(raw: unknown, notFoundMessage: string): string {
  const parsed = idParameterSchema.safeParse(raw)
  if (!parsed.success) throw new HttpError(notFoundMessage, 404)
  return parsed.data
}
