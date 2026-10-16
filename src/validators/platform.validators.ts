/**
 * @file The staff request bodies and queries. List queries come from `listParamsSchema`.
 */
import { z } from 'zod'
import { STATS_RANGES } from '@/constants/platform.constants'
import { TENANT_LIFECYCLE_STATES } from '@/constants/tenant.constants'
import {
  TIMELINE_DEFAULT_RANGE,
  TIMELINE_DEFAULT_VIEW,
  TIMELINE_RANGES,
  TIMELINE_VIEWS,
} from '@/constants/timeline.constants'
import { HttpError } from '@/errors/http-error'
import { emailSchema } from '@/validators/auth.validators'
import { booleanFilter, listFilter, listParamsSchema } from '@/validators/list.validators'
import { updateProfileSchema } from '@/validators/profile.validators'
import { normalizeMultilineText, safeText } from '@/validators/safe-text.validators'
import { newTenantSchema } from '@/validators/tenant.validators'

/**
 * `GET /api/v1/platform/tenants` query: the shared list params; `state` is
 * a comma list of lifecycle states, active and suspended unless given.
 */
export const platformTenantListSchema = listParamsSchema({
  sorts: ['name', 'created', '-created'],
  defaultSort: 'name',
  filters: {
    state: listFilter('state', TENANT_LIFECYCLE_STATES).default(['active', 'suspended']),
  },
})

/**
 * A parsed staff tenant list query.
 */
export type PlatformTenantListQuery = z.output<typeof platformTenantListSchema>

/**
 * `GET /platform/stats` query: the window, 7 days unless asked otherwise.
 */
export const platformStatsQuerySchema = z.object({
  range: z.enum(STATS_RANGES).default('7d'),
})

/**
 * Room for any timeline cursor the server issues (about 110 characters).
 */
const MAX_TIMELINE_CURSOR_LENGTH = 512

/**
 * `GET /platform/users/:id/timeline` and `GET /platform/tenants/:id/timeline`
 * query: the window (7 days), the view (everything) and the opaque `before`
 * cursor of a later page. The cursor is decoded by the timeline service,
 * which answers 400 for one that is not shaped like those it issues. Unknown
 * keys are ignored.
 */
export const platformTimelineQuerySchema = z.object({
  range: z.enum(TIMELINE_RANGES).default(TIMELINE_DEFAULT_RANGE),
  view: z.enum(TIMELINE_VIEWS).default(TIMELINE_DEFAULT_VIEW),
  before: z.string().min(1).max(MAX_TIMELINE_CURSOR_LENGTH).optional(),
})

/**
 * `GET /platform/flags/evaluate` query: the user, an optional tenant the
 * user belongs to (none for `apex`), and the app whose client slice the
 * result is read for.
 */
export const platformFlagsEvaluateQuerySchema = z.object({
  userId: z.uuid(),
  tenantId: z.uuid().optional(),
  app: z.enum(['react', 'apex']),
})

/**
 * A validated `GET /platform/flags/evaluate` query.
 */
export type PlatformFlagsEvaluateQuery = z.infer<typeof platformFlagsEvaluateQuerySchema>

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
 * The user statuses a list may ask for: live accounts by `users.active`, or soft-deleted ones.
 */
const PLATFORM_USER_STATUSES = ['active', 'inactive', 'deleted'] as const

/**
 * `GET /api/v1/platform/users` query: the shared list params; `status` is a
 * comma list, live accounts (active and inactive) unless given.
 */
export const platformUserListSchema = listParamsSchema({
  sorts: ['email', 'created', '-created', '-lastSignIn'],
  defaultSort: 'email',
  filters: {
    status: listFilter('status', PLATFORM_USER_STATUSES).default(['active', 'inactive']),
    verified: booleanFilter.optional(),
    staff: booleanFilter.optional(),
  },
})

/**
 * A parsed staff user list query.
 */
export type PlatformUserListQuery = z.output<typeof platformUserListSchema>

const idParameterSchema = z.uuid()

/**
 * A route's `:id` as a uuid, or a 404 with `notFoundMessage`: a malformed id
 * answers like an unknown one, so the two cannot be told apart, and Postgres
 * never sees a non-uuid.
 * @param raw - `request.params.id` as Express supplies it.
 * @param notFoundMessage - The 404's message, e.g. 'Tenant not found'.
 * @param notFoundCode - The 404's code, when the unknown-id answer carries one, so the malformed id answers with it too.
 * @throws {HttpError} 404 when `raw` is not a uuid.
 */
export function parseIdParameter(
  raw: unknown,
  notFoundMessage: string,
  notFoundCode?: string
): string {
  const parsed = idParameterSchema.safeParse(raw)
  if (!parsed.success) throw new HttpError(notFoundMessage, 404, notFoundCode)
  return parsed.data
}

/**
 * `POST /platform/users`: an address and optional names. Strict: staff never
 * set a password or a status, nor pick the frontend the set-password link
 * opens (the server does).
 */
export const newPlatformUserSchema = z.strictObject({
  email: emailSchema,
  firstName: updateProfileSchema.shape.firstName,
  lastName: updateProfileSchema.shape.lastName,
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
