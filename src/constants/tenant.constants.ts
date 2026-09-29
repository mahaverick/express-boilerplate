/**
 * @file The fixed tenant enumerations, each mirrored into a CHECK constraint
 * (tenant.model.ts, user-membership.model.ts), plus reserved slugs and the
 * invitation token size.
 */

/**
 * Every lifecycle state a tenant can be in.
 *
 * - `active` — fully operational, the default for a newly created tenant.
 * - `suspended` — temporarily disabled (billing issue, abuse, etc.), not a
 *   deletion — the row and its data are untouched, only access is gated.
 * - `archived` — the terminal, soft-deleted state.
 */
export const TENANT_LIFECYCLE_STATES = ['active', 'suspended', 'archived'] as const

/**
 * One of the fixed set of states a `tenants` row may carry.
 */
export type TenantLifecycleState = (typeof TENANT_LIFECYCLE_STATES)[number]

/**
 * Every role a `user_memberships` row can carry, in descending order of
 * privilege. Which member each role may change is `canActorModifyTarget`
 * (tenant.policy.ts):
 *
 * - `owner` — full control, and the only role that changes member roles.
 * - `admin` — manages members below admin, invitations and settings.
 * - `manager` — manages resources and content, not members or settings.
 * - `editor` — creates and edits content.
 * - `viewer` — read-only access; the column default.
 */
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'manager', 'editor', 'viewer'] as const

/**
 * One of the fixed set of roles a `user_memberships` row may carry.
 */
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]

/**
 * Slugs no tenant may register: route segments under `/tenants/:slug/...`
 * (`new`, `settings`, `members`), misleading public identifiers (`admin`,
 * `api`, `www`), and strings that read as other values (`null`,
 * `undefined`, `true`, `false`), plus `platform`, the staff tenant's slug
 * (seeded by migration 0016). The slug validator in tenant.validators.ts
 * enforces it.
 */
export const RESERVED_SLUGS = [
  'admin',
  'api',
  'app',
  'auth',
  'login',
  'logout',
  'register',
  'signin',
  'signup',
  'settings',
  'billing',
  'support',
  'help',
  'docs',
  'status',
  'health',
  'static',
  'assets',
  'public',
  'cdn',
  'www',
  'mail',
  'ftp',
  'blog',
  'about',
  'contact',
  'terms',
  'privacy',
  'dashboard',
  'root',
  'system',
  'null',
  'undefined',
  'true',
  'false',
  'new',
  'edit',
  'delete',
  'create',
  'update',
  'tenants',
  'tenant',
  'users',
  'user',
  'members',
  'owner',
  'me',
  'test',
  'staging',
  'dev',
  'localhost',
  'platform',
] as const

/**
 * Random bytes in a raw invitation token.
 */
export const INVITATION_TOKEN_BYTES = 32

/**
 * Length of a raw invitation token: `INVITATION_TOKEN_BYTES` as unpadded
 * base64url.
 */
export const INVITATION_TOKEN_LENGTH = 43

/**
 * `code` on the 409 for a slug a live tenant already uses, so a form can put
 * the message on its slug field.
 */
export const SLUG_TAKEN_CODE = 'slug_taken'

/**
 * `code` on the 409 for an owner invitation to an address whose account is
 * deactivated, so a form can put the message on its email field.
 */
export const INVITEE_DEACTIVATED_CODE = 'invitee_deactivated'
