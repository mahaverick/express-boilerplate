// src/constants/tenant.constants.ts
//
// Single source of truth for the two fixed enumerations the multi-tenancy
// seam introduces — same "one array, one place" pattern as AUTH_PROVIDERS
// (auth-provider.constants.ts) and EMAIL_LOG_STATUSES (email-log.model.ts).
// Both `TENANT_LIFECYCLE_STATES` and `MEMBERSHIP_ROLES` are mirrored into a
// database CHECK constraint (tenant.model.ts, user-membership.model.ts) —
// this is a small, deliberately-closed set each (unlike
// NOTIFICATION_TYPES, which is meant to grow freely), so the migration a
// CHECK constraint needs is not a cost worth avoiding.

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
 * One of the fixed set of states a `tenants` row may carry. Derived from
 * `TENANT_LIFECYCLE_STATES` so this type can never list a value the runtime
 * array — and therefore the database CHECK constraint built from it — does
 * not also recognise.
 */
export type TenantLifecycleState = (typeof TENANT_LIFECYCLE_STATES)[number]

/**
 * Every role a `user_memberships` row can carry, in descending order of
 * privilege (see the plan's actor→target safety matrix for exactly which
 * actions each role may take on another member):
 *
 * - `owner` — full control; can transfer ownership, can delete the tenant.
 * - `admin` — manages members (below admin) and settings, not other admins
 *   or the owner.
 * - `manager` — manages resources/content, not members or settings.
 * - `editor` — creates and edits content.
 * - `viewer` — read-only access. The default for a newly added member.
 */
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'manager', 'editor', 'viewer'] as const

/**
 * One of the fixed set of roles a `user_memberships` row may carry. Derived
 * from `MEMBERSHIP_ROLES` so this type can never list a value the runtime
 * array — and therefore the database CHECK constraint built from it — does
 * not also recognise.
 */
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]

/**
 * Slugs no tenant may register — reserved because they either collide with
 * a real or plausible future route segment under `/tenants/:slug/...`
 * (`new`, `settings`, `members`), a term that would be actively misleading
 * as an organization's public identifier (`admin`, `api`, `www`), or a
 * value that has caused real bugs elsewhere as a string masquerading as
 * something else (`null`, `undefined`, `true`, `false`). Checked by a later
 * task's slug validator (`z.string()....refine((slug) => !RESERVED_SLUGS
 * .includes(slug))`) — this file only owns the list, not the check.
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
