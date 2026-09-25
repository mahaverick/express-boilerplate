// src/presenters/user.presenter.ts
//
// Two related projections of a `users` row, in one file so the narrower
// (`AuthenticatedUser`) and the wider (`PublicUser`) can never drift the
// way two independent hand-maintained copies would. AuthenticatedUser
// lives here rather than in a middleware because presenters may not import
// middlewares, and PublicUser must still be built by extending it, not by
// re-declaring its field list a second time.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'

/**
 * The subset of a user row it is safe to attach to `request.user`.
 * Deliberately excludes `passwordHash` and anything else a route handler
 * has no business reading off the authenticated principal.
 *
 * The NARROWER of this file's two projections, and the one `PublicUser`
 * extends. Everything on this interface is CLIENT-VISIBLE by construction
 * — `PublicUser` inherits it and `GET /api/v1/profile` returns that.
 * Server-only principal data (a role, a tenant id) must never be added
 * here — see `request.principal` (types/express.d.ts) for where that goes
 * instead.
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
 * DERIVED from `AuthenticatedUser` plus `createdAt` — the only field the
 * two ever differed by — so a field added to one reaches the other
 * automatically instead of the two silently drifting.
 */
export interface PublicUser extends AuthenticatedUser {
  createdAt: Date
}

/**
 * Narrow a full user row to the fields `PublicUser` exposes.
 * @param user - The full row read from or written to the database.
 * @returns The public projection of that row.
 */
export function toPublicUser(user: User): PublicUser {
  return { ...toAuthenticatedUser(user), createdAt: user.createdAt }
}

/**
 * Every client-facing user (profile GET and PATCH, and the login user): the
 * public user plus their platform role. It's client-visible on purpose: it
 * only drives the staff UI, and the server re-checks the platform role on
 * every request.
 */
export interface ProfileResponse extends PublicUser {
  platformRole: MembershipRole | null
}

/**
 * Build the profile response.
 * @param user - The full user row.
 * @param platformRole - Their role in the platform tenant, or null.
 * @returns The public projection plus `platformRole`.
 */
export function toProfileResponse(
  user: User,
  platformRole: MembershipRole | null
): ProfileResponse {
  return { ...toPublicUser(user), platformRole }
}
