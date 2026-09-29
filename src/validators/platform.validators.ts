/**
 * @file The staff request bodies and queries. Search `q` is trimmed first, so
 * whitespace alone is a 400 rather than a match-everything search.
 */
import { z } from 'zod'
import { PAGE_DIRECTIONS, STATS_RANGES, TENANT_STATE_FILTERS } from '@/constants/platform.constants'
import { HttpError } from '@/errors/http-error'
import { emailSchema, frontendAppSchema } from '@/validators/auth.validators'
import { cursorField } from '@/validators/cursor.validators'
import { updateProfileSchema } from '@/validators/profile.validators'
import { normalizeMultilineText, safeText } from '@/validators/safe-text.validators'
import { newTenantSchema } from '@/validators/tenant.validators'

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
 * The `direction` query field of a keyset search: forward unless asked otherwise.
 */
export const directionField = z.enum(PAGE_DIRECTIONS).default('next')

/**
 * `GET /api/v1/platform/tenants` query string. `direction=prev` pages back
 * from `cursor`, so it needs one.
 */
export const platformTenantSearchSchema = z
  .object({
    q: searchQueryField.optional(),
    state: z.enum(TENANT_STATE_FILTERS).optional(),
    cursor: cursorField(platformTenantCursorSchema).optional(),
    direction: directionField,
    limit: pageLimitField,
  })
  .superRefine((query, context) => {
    if (query.direction === 'prev' && query.cursor === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['cursor'],
        message: 'cursor is required when direction is prev.',
      })
    }
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
 * A query-string boolean: exactly `true` or `false`.
 */
const booleanQueryField = z.enum(['true', 'false']).transform((value) => value === 'true')

/**
 * The user search cursor's decoded shape: the last row's `lower(email)` and id.
 */
export const platformUserCursorSchema = z
  .object({ sortEmail: z.string().refine(hasNoNul), id: z.uuid() })
  .strict()

/**
 * `GET /api/v1/platform/users` query string. `direction=prev` needs a cursor:
 * there is no "last page" to start from.
 */
export const platformUserSearchSchema = z
  .object({
    q: searchQueryField.optional(),
    status: z.enum(['active', 'inactive', 'deleted']).optional(),
    verified: booleanQueryField.optional(),
    staff: booleanQueryField.optional(),
    cursor: cursorField(platformUserCursorSchema).optional(),
    direction: directionField,
    limit: pageLimitField,
  })
  .superRefine((query, context) => {
    if (query.direction === 'prev' && query.cursor === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['cursor'],
        message: 'cursor is required when direction is prev.',
      })
    }
  })

/**
 * The validated user search query, with the cursor already decoded.
 */
export type PlatformUserSearchQuery = z.infer<typeof platformUserSearchSchema>

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

/**
 * `POST /platform/users`: an address, optional names, and which frontend the
 * set-password link opens. Strict: staff never set a password or a status.
 */
export const newPlatformUserSchema = z.strictObject({
  email: emailSchema,
  firstName: updateProfileSchema.shape.firstName,
  lastName: updateProfileSchema.shape.lastName,
  app: frontendAppSchema,
})

/**
 * The validated create-user body.
 */
export type CreatePlatformUserInput = z.infer<typeof newPlatformUserSchema>

/**
 * `PATCH /platform/users/:id`: names only (null clears one), at least one
 * given. Strict, so a status or email field is a 400 rather than ignored.
 */
export const updatePlatformUserSchema = z
  .strictObject({
    firstName: updateProfileSchema.shape.firstName,
    lastName: updateProfileSchema.shape.lastName,
  })
  .refine((input) => input.firstName !== undefined || input.lastName !== undefined, {
    message: 'Provide firstName or lastName.',
  })

/**
 * The validated update-user body.
 */
export type UpdatePlatformUserInput = z.infer<typeof updatePlatformUserSchema>

/**
 * `POST /platform/tenants` body: the tenant's columns (no logo) and the
 * address its owner invitation goes to. Slug rules, reserved slugs
 * included, are the customer create path's.
 */
export const platformNewTenantSchema = newTenantSchema
  .omit({ logo: true })
  .extend({ ownerEmail: emailSchema })

/**
 * The validated create body.
 */
export type CreatePlatformTenantInput = z.infer<typeof platformNewTenantSchema>

/**
 * `POST /platform/tenants/:id/owner-invitation` body: the new owner's
 * address and the staff member's reason. Strict.
 */
export const ownerInvitationBodySchema = z.strictObject({
  email: emailSchema,
  reason: reasonSchema,
})
