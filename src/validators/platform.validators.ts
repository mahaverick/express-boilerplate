/**
 * @file The staff request bodies and queries. List queries come from `listParamsSchema`.
 */
import { z } from 'zod'
import { BILLING_STATES } from '@/constants/billing.constants'
import { FLAG_STATES } from '@/constants/flags.constants'
import { STATS_RANGES } from '@/constants/platform.constants'
import { TENANT_LIFECYCLE_STATES } from '@/constants/tenant.constants'
import { notFoundError, type NotFoundKind } from '@/errors/not-found-errors'
import { emailSchema } from '@/validators/auth.validators'
import { booleanFilter, listFilter, listParamsSchema } from '@/validators/list.validators'
import { updateProfileSchema } from '@/validators/profile.validators'
import { normalizeMultilineText, safeText } from '@/validators/safe-text.validators'
import { newTenantSchema } from '@/validators/tenant.validators'

/**
 * `GET /api/v1/platform/tenants` query: the shared list params; `state` is
 * a comma list of lifecycle states, active and suspended unless given;
 * `billingState` a comma list of stored billing states, any unless given.
 */
export const platformTenantListSchema = listParamsSchema({
  sorts: ['name', 'created', '-created'],
  defaultSort: 'name',
  filters: {
    state: listFilter('state', TENANT_LIFECYCLE_STATES).default(['active', 'suspended']),
    billingState: listFilter('billingState', BILLING_STATES).optional(),
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
 * `GET /platform/flags` query: the shared list params over the registry,
 * `search` matching the key and the description.
 */
export const platformFlagListSchema = listParamsSchema({
  sorts: ['key'],
  defaultSort: 'key',
  filters: {
    kind: listFilter('kind', ['boolean', 'multivariate']).optional(),
    state: listFilter('state', FLAG_STATES).optional(),
  },
})

/**
 * A parsed flags list query.
 */
export type PlatformFlagListQuery = z.output<typeof platformFlagListSchema>

/**
 * `GET /platform/flags/unregistered` query: the shared list params over the
 * flags PostHog has that the registry lacks, `search` matching the key.
 */
export const platformUnregisteredFlagListSchema = listParamsSchema({
  sorts: ['key'],
  defaultSort: 'key',
  filters: {},
})

/**
 * A parsed unregistered-flags list query.
 */
export type PlatformUnregisteredFlagListQuery = z.output<typeof platformUnregisteredFlagListSchema>

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
    /**
     * `true` keeps users with a recorded sign-in (`lastLoggedInAt` set), `false`
     * those who have never signed in. A verified account can have none.
     */
    signedIn: booleanFilter.optional(),
    staff: booleanFilter.optional(),
  },
})

/**
 * A parsed staff user list query.
 */
export type PlatformUserListQuery = z.output<typeof platformUserListSchema>

const idParameterSchema = z.uuid()

/**
 * A route's `:id` as a uuid, or the 404 an unknown id of that kind answers:
 * a malformed id answers like an unknown one, code and message alike, so the
 * two cannot be told apart, and Postgres never sees a non-uuid.
 * @param raw - `request.params.id` as Express supplies it.
 * @param notFound - What the id names, e.g. 'platformTenant'.
 * @returns The id.
 * @throws {HttpError} 404 when `raw` is not a uuid.
 */
export function parseIdParameter(
  raw: unknown,
  notFound: Exclude<NotFoundKind, 'taxDocumentsDisabled'>
): string {
  const parsed = idParameterSchema.safeParse(raw)
  if (!parsed.success) throw notFoundError(notFound)
  return parsed.data
}

/**
 * `POST /platform/users`: an address and optional names. Strict: staff never
 * set a status, nor pick the frontend the welcome link opens (the server
 * does).
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
    message: 'Enter a first name or a last name.',
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
