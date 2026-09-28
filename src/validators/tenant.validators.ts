/**
 * @file Tenant, member, invitation and settings request bodies. Every string
 * field is capped at its column's width in tenant.model.ts, which inlines the
 * widths, so they are repeated here: `name` 255, `slug` 100, `description`
 * 1000, `logo` and `website` 255, `timezone` 64, `locale` 10. An over-long
 * value would otherwise reach Postgres as a 22001 and answer 500 instead of
 * 400.
 */
import { z } from 'zod'
import { MEMBERSHIP_ROLES, RESERVED_SLUGS } from '@/constants/tenant.constants'
import { hostnameDomain } from '@/utilities/email.utilities'
import { emailSchema } from '@/validators/auth.validators'
import { normalizeMultilineText, safeText } from '@/validators/safe-text.validators'

const MAX_TENANT_NAME_LENGTH = 255
const MAX_TENANT_DESCRIPTION_LENGTH = 1000
const MAX_TENANT_LOGO_LENGTH = 255
const MAX_TENANT_WEBSITE_LENGTH = 255
const MAX_TENANT_TIMEZONE_LENGTH = 64
const MAX_TENANT_LOCALE_LENGTH = 10

/**
 * `RESERVED_SLUGS` as a `Set<string>`: the tuple's `.includes` accepts only
 * its literal union, not a parsed `string`.
 */
const RESERVED_SLUGS_SET: ReadonlySet<string> = new Set(RESERVED_SLUGS)

/**
 * A tenant's URL-safe identifier: lowercase alphanumeric, hyphen-separated,
 * neither leading nor trailing with a hyphen, 3-100 characters, and not one
 * of `RESERVED_SLUGS` (tenant.constants.ts). Trimmed but not lowercased,
 * unlike `emailSchema`: a slug is a caller-chosen public identifier in a URL,
 * so mixed case is rejected rather than silently stored as a different
 * string.
 */
export const slugSchema = z
  .string()
  .trim()
  .min(3, 'Slug must be at least 3 characters.')
  .max(100, 'Slug must be at most 100 characters.')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Slug must be lowercase alphanumeric characters and hyphens, and cannot start or end with a hyphen.'
  )
  .refine((slug) => !RESERVED_SLUGS_SET.has(slug), {
    message: 'This slug is reserved and cannot be used.',
  })

/**
 * The description field, shared by the create and update schemas. A separate
 * const keeps `unicorn/max-nested-calls` under its limit.
 */
const tenantDescriptionField = z
  .string()
  .trim()
  .min(1, 'Must not be empty.')
  .max(
    MAX_TENANT_DESCRIPTION_LENGTH,
    `Description must be at most ${MAX_TENANT_DESCRIPTION_LENGTH} characters.`
  )
  .refine(safeText({ multiline: true }), 'Description contains characters that are not allowed')

/**
 * `POST /api/v1/tenants` request body. The caller becomes the tenant's sole
 * `'owner'` member; the owner comes from `request.user.id`, never from this
 * body, so a caller cannot name a different owner.
 */
export const newTenantSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(MAX_TENANT_NAME_LENGTH, `Name must be at most ${MAX_TENANT_NAME_LENGTH} characters.`)
    .refine(safeText(), 'Name contains characters that are not allowed'),
  slug: slugSchema,
  description: z.preprocess(normalizeMultilineText, tenantDescriptionField).optional(),
  logo: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(MAX_TENANT_LOGO_LENGTH, `Logo must be at most ${MAX_TENANT_LOGO_LENGTH} characters.`)
    .refine(safeText(), 'Logo contains characters that are not allowed')
    .optional(),
  website: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(
      MAX_TENANT_WEBSITE_LENGTH,
      `Website must be at most ${MAX_TENANT_WEBSITE_LENGTH} characters.`
    )
    .refine(safeText(), 'Website contains characters that are not allowed')
    .optional(),
})

/**
 * The validated shape of a `POST /api/v1/tenants` request body.
 */
export type CreateTenantInput = z.infer<typeof newTenantSchema>

/**
 * `PATCH /api/v1/tenants/:slug` request body. Every field optional; a
 * caller changes only what it names. `description`, `logo` and `website`
 * take the three PATCH states (absent leaves the column, `null` clears it, a
 * string sets it); `name` is `NOT NULL`, so it cannot be cleared.
 *
 * `slug` is deliberately absent: it is the tenant's URL identity, so a
 * rename would break every link and needs its own flow, with the create
 * path's validation and its 409 on collision with the partial
 * `tenants_slug_unique` index.
 */
export const updateTenantSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(MAX_TENANT_NAME_LENGTH, `Name must be at most ${MAX_TENANT_NAME_LENGTH} characters.`)
    .refine(safeText(), 'Name contains characters that are not allowed')
    .optional(),
  description: z.preprocess(normalizeMultilineText, tenantDescriptionField).nullable().optional(),
  logo: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(MAX_TENANT_LOGO_LENGTH, `Logo must be at most ${MAX_TENANT_LOGO_LENGTH} characters.`)
    .refine(safeText(), 'Logo contains characters that are not allowed')
    .nullable()
    .optional(),
  website: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(
      MAX_TENANT_WEBSITE_LENGTH,
      `Website must be at most ${MAX_TENANT_WEBSITE_LENGTH} characters.`
    )
    .refine(safeText(), 'Website contains characters that are not allowed')
    .nullable()
    .optional(),
})

/**
 * The validated shape of a `PATCH /api/v1/tenants/:slug` request body.
 */
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>

/**
 * `POST /api/v1/tenants/:slug/invitations` request body: the address to
 * invite and the role the invitee gets on accepting. `role` is required, not
 * defaulted: an owner or admin is consciously granting access, and a silent
 * default would hide the one field that matters. The address's domain must
 * also be a dotted hostname, the shape the audit log records; sign-up and
 * sign-in keep the plain `emailSchema`.
 */
export const inviteMemberSchema = z.object({
  email: emailSchema.refine((email) => hostnameDomain(email) !== undefined, {
    message: 'Email must have a valid domain.',
  }),
  role: z.enum(MEMBERSHIP_ROLES),
})

/**
 * The validated shape of a `POST /api/v1/tenants/:slug/invitations` body.
 */
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>

/**
 * The `:id` path parameter of `/tenants/:slug/invitations/:id` routes.
 */
export const invitationIdSchema = z.object({
  id: z.uuid('id must be a valid UUID.'),
})

/**
 * `PATCH /api/v1/tenants/:slug/members/:userId` request body: the member's
 * new role. The actor->target matrix (`canActorModifyTarget`,
 * tenant.policy.ts) is applied in `changeRole` (tenant-membership.service.ts),
 * not here: a schema knows only the shape of a valid role.
 */
export const updateMemberRoleSchema = z.object({
  role: z.enum(MEMBERSHIP_ROLES),
})

/**
 * The validated shape of a `PATCH /api/v1/tenants/:slug/members/:userId`
 * request body.
 */
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>

/**
 * `PATCH /api/v1/tenants/:slug/settings` request body. `timezone`/`locale`
 * are bounded to their column widths only, not checked as a real IANA zone
 * or BCP 47 tag: nothing in this codebase interprets either value, so a project
 * that depends on one should add that check. `metadata` is `null` to clear
 * it or any JSON object, never a bare array or primitive.
 */
export const updateTenantSettingsSchema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(
      MAX_TENANT_TIMEZONE_LENGTH,
      `Timezone must be at most ${MAX_TENANT_TIMEZONE_LENGTH} characters.`
    )
    .optional(),
  locale: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(MAX_TENANT_LOCALE_LENGTH, `Locale must be at most ${MAX_TENANT_LOCALE_LENGTH} characters.`)
    .optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})

/**
 * The validated shape of a `PATCH /api/v1/tenants/:slug/settings` request
 * body.
 */
export type UpdateTenantSettingsInput = z.infer<typeof updateTenantSettingsSchema>
