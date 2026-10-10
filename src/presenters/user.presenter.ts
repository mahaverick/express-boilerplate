/**
 * @file The projections of a `users` row. `PublicUser` extends
 * `AuthenticatedUser` instead of re-declaring its fields, so the two cannot
 * drift; `AuthenticatedUser` lives here because presenters may not import
 * middlewares.
 */
import type { MembershipRole } from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'

/**
 * The subset of a user row it is safe to attach to `request.user`.
 * Deliberately excludes `passwordHash` and anything else a route handler
 * has no business reading off the authenticated principal.
 *
 * Everything here is client-visible, since `PublicUser` inherits it and
 * `GET /api/v1/profile` returns that. Server-only principal data (a role, a
 * tenant id) goes on `request.principal` (types/express.d.ts), never here.
 */
export interface AuthenticatedUser {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
}

/**
 * Narrow a full user row to the fields `request.user` exposes.
 * @param user - The loaded, already-validated user row.
 * @returns The fields safe to attach to a request.
 */
export function toAuthenticatedUser(user: User): AuthenticatedUser {
  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
}

/**
 * The fields of a user row it is safe to return to a client. An explicit
 * allow-list, not a `delete`-the-sensitive-key projection.
 *
 * `AuthenticatedUser` plus `createdAt`.
 */
interface PublicUser extends AuthenticatedUser {
  createdAt: Date
}

/**
 * Narrow a full user row to the fields `PublicUser` exposes.
 * @param user - The full row read from or written to the database.
 * @returns The public projection of that row.
 */
function toPublicUser(user: User): PublicUser {
  return { ...toAuthenticatedUser(user), createdAt: user.createdAt }
}

/**
 * Every client-facing user (profile GET and PATCH, and the login user): the
 * public user plus their platform role and their browser analytics opt-out.
 * The role is client-visible on purpose: it only drives the staff UI, and
 * the server re-checks the platform role on every request. The opt-out only
 * tells the frontends to stop capturing; server events ignore it.
 */
export interface ProfileResponse extends PublicUser {
  platformRole: MembershipRole | null
  analyticsOptOut: boolean
}

/**
 * Build the profile response.
 * @param user - The full user row.
 * @param platformRole - Their role in the platform tenant, or null.
 * @returns The public projection plus `platformRole` and `analyticsOptOut`.
 */
export function toProfileResponse(
  user: User,
  platformRole: MembershipRole | null
): ProfileResponse {
  return { ...toPublicUser(user), platformRole, analyticsOptOut: user.analyticsOptOut }
}
