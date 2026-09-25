// src/validators/tenant.validators.ts
//
// Every string field below is bounded by exactly the width of the column it
// is written to — the same reasoning auth.validators.ts's own header comment
// gives for its length ceilings, audited here against tenant.model.ts as one
// pass: `name` -> tenants.name (255), `slug` -> tenants.slug (100, plus the
// shape/reserved-word rules below), `description` -> tenants.description
// (1000), `logo`/`website` -> tenants.logo/website (255 each),
// `timezone` -> tenant_settings.timezone (64), `locale` ->
// tenant_settings.locale (10). A schema that accepted more than its column
// holds would not merely fail — it would fail as a 500 (Postgres' 22001,
// which `BaseRepository`/`TenantSettingsRepository` do not translate to a
// 409 the way they do a unique violation) — see auth.validators.ts's header
// comment for the fuller version of this reasoning. `tenant.model.ts`
// itself inlines these widths rather than exporting `MAX_*` constants
// (unlike `auth.constants.ts`'s `MAX_EMAIL_LENGTH`/`MAX_NAME_LENGTH`, which
// `user.model.ts` imports) — that is Task 1's file, out of this task's
// scope to restructure, so the widths are duplicated here by audit rather
// than by shared constant, exactly like `auth.validators.ts` already does
// for every field it caps.
import { z } from 'zod'
import { MEMBERSHIP_ROLES, RESERVED_SLUGS } from '@/constants/tenant.constants'
import { hostnameDomain } from '@/utilities/email.utilities'
import { emailSchema } from '@/validators/auth.validators'

const MAX_TENANT_NAME_LENGTH = 255
const MAX_TENANT_DESCRIPTION_LENGTH = 1000
const MAX_TENANT_LOGO_LENGTH = 255
const MAX_TENANT_WEBSITE_LENGTH = 255
const MAX_TENANT_TIMEZONE_LENGTH = 64
const MAX_TENANT_LOCALE_LENGTH = 10

// `RESERVED_SLUGS` (tenant.constants.ts) is a `readonly [...] as const` tuple
// of string LITERALS — `ReadonlyArray<T>.includes` requires its argument to
// be assignable to that literal union, which a parsed `slug: string` is not.
// A `Set<string>` sidesteps that entirely (`.has(value: string)` accepts any
// string), the same fix `notification.validators.ts`'s
// `NON_DISABLEABLE_NOTIFICATION_TYPES` already applies to the identical
// shape of problem.
const RESERVED_SLUGS_SET: ReadonlySet<string> = new Set(RESERVED_SLUGS)

// `.trim()` before the regex, deliberately NOT `.toLowerCase()` the way
// `emailSchema` (auth.validators.ts) normalises casing before validating.
// An email's casing is incidental to the identity it names (RFC 5321's
// local-part aside, nothing in this codebase treats "Foo@x.com" and
// "foo@x.com" as different accounts — see `userModel`'s own
// `lower(email)` unique index). A tenant's slug is different: it is a
// user-CHOSEN public identifier that becomes part of a URL
// (`/tenants/:slug/...`), so silently lowercasing "MyOrg" to "myorg" would
// let a caller believe they registered one string while the database holds
// another. Rejecting mixed case outright, via the regex below, is what
// keeps the slug the caller sees in a 400 the same one a 201 would have
// stored.
/**
 * A tenant's URL-safe identifier: lowercase alphanumeric, hyphen-separated,
 * neither leading nor trailing with a hyphen, 3-100 characters, and not one
 * of `RESERVED_SLUGS` (tenant.constants.ts). Shared between
 * `newTenantSchema` below and, once a later change legitimately needs it
 * (nothing in this task does — `updateTenantSchema` deliberately excludes
 * `slug`; see its own comment), any other endpoint that accepts a caller-
 * supplied slug.
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
 * `POST /api/v1/tenants` request body. The caller becomes the tenant's sole
 * `'owner'` member (`TenantRepository.create`'s own `ownerId` parameter,
 * supplied by the controller from `request.user.id` — never from this
 * body, so a caller cannot name a different owner).
 */
export const newTenantSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(MAX_TENANT_NAME_LENGTH, `Name must be at most ${MAX_TENANT_NAME_LENGTH} characters.`),
  slug: slugSchema,
  description: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(
      MAX_TENANT_DESCRIPTION_LENGTH,
      `Description must be at most ${MAX_TENANT_DESCRIPTION_LENGTH} characters.`
    )
    .optional(),
  logo: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(MAX_TENANT_LOGO_LENGTH, `Logo must be at most ${MAX_TENANT_LOGO_LENGTH} characters.`)
    .optional(),
  website: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(
      MAX_TENANT_WEBSITE_LENGTH,
      `Website must be at most ${MAX_TENANT_WEBSITE_LENGTH} characters.`
    )
    .optional(),
})

/**
 * The validated shape of a `POST /api/v1/tenants` request body.
 */
export type CreateTenantInput = z.infer<typeof newTenantSchema>

// `.nullable().optional()` on `description`/`logo`/`website` — the same
// three-state PATCH contract `profile.validators.ts`'s `optionalNameField`
// already establishes: omitted -> leave the column alone; explicit `null`
// -> clear it (all three are nullable columns); a string -> set it. `name`
// stays required-when-present but never nullable — `tenants.name` is
// `NOT NULL`, so there is no "clear" state for it to express.
//
// `slug` IS DELIBERATELY ABSENT. Three independent reasons, each alone
// sufficient: (1) it is this tenant's URL identity
// (`/tenants/:slug/...`) — every bookmarked link, every `resolveTenant`
// lookup, and this very endpoint's own route param would need to change in
// lockstep with a rename, which this single-field PATCH has no way to
// signal to a caller holding the OLD slug; (2) changing it would need the
// exact same shape/reserved-word validation `newTenantSchema.slug`
// already has, which is a second copy of `slugSchema` this task's brief
// never asked for; (3) the uniqueness story is asymmetric with creation —
// `tenants_slug_unique` (tenant.model.ts) is a partial index over
// non-deleted rows, so a rename would need the identical 409-on-collision
// handling `TenantRepository.create` already has, again duplicated for no
// endpoint this task specifies. The safe default is "immutable via this
// endpoint"; a dedicated rename flow (with redirect/history handling) is
// real product work for a future task, not an omission here.
/**
 * `PATCH /api/v1/tenants/:slug` request body. Every field optional — a
 * caller changes only what it names. See this schema's own comment for why
 * `slug` is not one of them.
 */
export const updateTenantSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(MAX_TENANT_NAME_LENGTH, `Name must be at most ${MAX_TENANT_NAME_LENGTH} characters.`)
    .optional(),
  description: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(
      MAX_TENANT_DESCRIPTION_LENGTH,
      `Description must be at most ${MAX_TENANT_DESCRIPTION_LENGTH} characters.`
    )
    .nullable()
    .optional(),
  logo: z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(MAX_TENANT_LOGO_LENGTH, `Logo must be at most ${MAX_TENANT_LOGO_LENGTH} characters.`)
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
 * new role. The actor->target safety matrix is enforced by
 * `src/policies/tenant.policy.ts`'s `canActorModifyTarget`, applied inside
 * `src/services/tenant-membership.service.ts`'s `changeRole` — not this
 * schema, and not the controller. A schema only knows the SHAPE of a valid
 * role, never who is asking or who they are asking about.
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
 * are bounded to their column widths only — this deliberately does not
 * validate that a submitted value is a real IANA timezone or BCP 47 locale
 * tag (e.g. via `Intl.supportedValuesOf('timeZone')`), matching
 * `tenant_settings.metadata`'s own "extensible, unstructured" ethos
 * (tenant.model.ts's header comment): nothing in this codebase reads either
 * column for a specific value yet, so there is no behaviour a bogus one
 * could corrupt beyond display — a derived project that DOES depend on a
 * valid IANA zone is the right place to add that check, not this
 * boilerplate. `metadata` accepts `null` to clear it (the column is
 * nullable) and otherwise any JSON object — `z.record(z.string(),
 * z.unknown())` rather than `z.unknown()` alone, so a caller cannot send a
 * bare array or primitive where an object is expected.
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
