// src/controllers/tenant.controller.ts
//
// Thirteen handlers, in the same order tenant.routes.ts mounts them:
// create/list/get/update tenant, list/change-role/remove member,
// list/invite/resend/revoke invitation, get/update settings. Every handler
// assumes `requireAuth` has already run (populating
// `request.user`) — `tenant.routes.ts` mounts it router-wide, the same
// convention `profile.routes.ts` established. Every handler on a
// `/tenants/:slug/...` route additionally assumes `resolveTenant` has
// already run (populating `request.principal`) — see
// `tenant.middleware.ts`'s own header comment for what that guarantees:
// the caller is confirmed to be a member of the tenant the route names,
// with `request.principal.role` holding THAT tenant's role, before this
// file's code ever runs.
//
// Member and invitation writes pass the actor, never `principal.role`: the
// services re-read the actor's role under lock inside their transaction and
// apply policies/tenant.policy.ts there. The router's `requireRole(...)` is
// only the early gate.
import { type NextFunction, type Request, type Response } from 'express'
import { actorFrom, authenticatedUserId } from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import type { RequestPrincipal } from '@/middlewares/tenant.middleware'
import { invite, listPending, resend, revoke } from '@/services/tenant-invitation.service'
import {
  changeRole,
  removeMember as removeTenantMember,
} from '@/services/tenant-membership.service'
import {
  createTenant as createTenantRecord,
  getTenant as getTenantRecord,
  getSettings as getTenantSettings,
  listForUser,
  listMembers as listTenantMembers,
  updateTenant as updateTenantRecord,
  updateSettings as updateTenantSettings,
} from '@/services/tenant.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  invitationIdSchema,
  inviteMemberSchema,
  newTenantSchema,
  updateMemberRoleSchema,
  updateTenantSchema,
  updateTenantSettingsSchema,
} from '@/validators/tenant.validators'

/**
 * The caller's tenant-scoped principal, guarding against a route reaching
 * this controller without `resolveTenant` ahead of it. Every `/tenants/
 * :slug/...` handler below (everything except `createTenant`/`listTenants`,
 * which have no `:slug` to resolve) calls this first.
 * @param request - The incoming request.
 * @returns The caller's principal for the tenant this route names.
 * @throws {HttpError} 404, when `request.principal` was never populated — the same fail-safe direction `requireRole` (tenant.middleware.ts) already takes on a missing principal, so a misconfigured route never behaves more permissively than a real non-member would.
 */
function tenantPrincipal(request: Request): RequestPrincipal {
  if (!request.principal) {
    throw new HttpError('Tenant not found', 404)
  }
  return request.principal
}

/**
 * The `:userId` route param on a member-management route, narrowed to a
 * plain string.
 *
 * `request.params.userId` types as `string | string[] | undefined`
 * (`ParamsDictionary`'s index signature allows an array value for a
 * repeated/splat param pattern) even though a plain `:userId` segment can
 * never actually produce one — same narrowing `tenant.middleware.ts`'s own
 * `tenantIdentifierFrom` already applies to `:slug`, for the identical
 * reason.
 * @param request - The incoming request.
 * @returns The `:userId` param.
 * @throws {HttpError} 400, when the route did not supply a single string param — a routing bug, not a real request shape.
 */
function targetUserIdParameter(request: Request): string {
  const userId = request.params.userId
  if (typeof userId !== 'string') {
    throw new HttpError('Malformed member id', 400)
  }
  return userId
}

/**
 * Create a tenant. The caller becomes its sole `'owner'` member —
 * `TenantRepository.create` inserts the tenant, its settings row, and this
 * owner membership atomically (tenant.repository.ts's own header comment).
 * @param request - The incoming request, carrying the create-tenant body.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function createTenant(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const actor = actorFrom(request)
    const input = parseBody(newTenantSchema, request.body)
    const tenant = await createTenantRecord(actor, input)
    successResponse(response, tenant, 'Tenant created.', 201)
  } catch (error) {
    next(error)
  }
}

/**
 * List every tenant the caller belongs to, with their role in each.
 * @param request - The incoming request.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function listTenants(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const tenants = await listForUser(authenticatedUserId(request))
    successResponse(response, tenants, 'Tenants retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * Get one tenant's details. Any member may call this — `resolveTenant`
 * (composed ahead of this handler on the route) already confirmed
 * membership; there is no further role check.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function getTenant(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const tenant = await getTenantRecord(tenantPrincipal(request).tenantId)
    successResponse(response, tenant, 'Tenant retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * Update a tenant's `name`/`description`/`logo`/`website`. Owner/admin
 * only — `requireRole('owner', 'admin')` (tenant.routes.ts) gates this
 * before the handler runs. `slug` cannot be changed here — see
 * `updateTenantSchema`'s own comment for why.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`, carrying the update body.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function updateTenant(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const principal = tenantPrincipal(request)
    const input = parseBody(updateTenantSchema, request.body)
    const tenant = await updateTenantRecord(principal.tenantId, input)
    successResponse(response, tenant, 'Tenant updated.')
  } catch (error) {
    next(error)
  }
}

/**
 * List a tenant's members, each with their safe user info
 * (`UserMembershipRepository.listByTenant` never joins `passwordHash` —
 * see that method's own comment). Any member may call this.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function listMembers(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const members = await listTenantMembers(tenantPrincipal(request).tenantId)
    successResponse(response, members, 'Members retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * Change an existing member's role. Owner only: `requireRole('owner')`
 * (tenant.routes.ts), then `changeRole` re-checks the actor's current role
 * and the actor→target matrix under lock.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`, carrying `{ role }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function updateMemberRole(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const targetUserId = targetUserIdParameter(request)
    const input = parseBody(updateMemberRoleSchema, request.body)

    const updated = await changeRole(actor, principal.tenantId, targetUserId, input.role)
    successResponse(response, updated, 'Member role updated.')
  } catch (error) {
    next(error)
  }
}

/**
 * Remove a member from a tenant. Owner/admin only: `requireRole('owner',
 * 'admin')` (tenant.routes.ts), then `removeMember` re-checks the actor's
 * current role and the matrix under lock. Under the matrix an admin can
 * never remove another admin or any owner, themselves included.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function removeMember(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const targetUserId = targetUserIdParameter(request)

    await removeTenantMember(actor, principal.tenantId, targetUserId)
    successResponse(response, undefined, 'Member removed.')
  } catch (error) {
    next(error)
  }
}

const INVITATION_SENT_MESSAGE = 'If that address can be invited, an invitation has been sent.'

/**
 * Send the invite/resend response: 202, no data, one fixed message,
 * whether or not the address has an account.
 * @param response - The response.
 */
function respondInvitationSent(response: Response): void {
  // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
  successResponse(response, null, INVITATION_SENT_MESSAGE, 202)
}

/**
 * The `:id` route param on an invitation route, validated as a UUID.
 * @param request - The incoming request.
 * @returns The invitation id.
 * @throws {HttpError} 400, when `:id` is not a UUID.
 */
function invitationIdParameter(request: Request): string {
  return parseBody(invitationIdSchema, request.params).id
}

/**
 * List a tenant's pending invitations. Owner/admin only
 * (`requireRole('owner', 'admin')`, tenant.routes.ts). Never returns a
 * token or its hash.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function listInvitations(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const principal = tenantPrincipal(request)
    const invitations = await listPending(principal.tenantId)
    successResponse(response, invitations, 'Invitations retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * Invite an address to the tenant. Owner/admin only; `invite` re-checks
 * the actor's current role and `canActorGrantRole` under lock. Answers 202
 * with one fixed body whether or not the address has an account; only a
 * current member gets 409 `already_member`.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`, carrying `{ email, role }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function inviteMember(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const input = parseBody(inviteMemberSchema, request.body)
    await invite(actor, principal.tenantId, input.email, input.role)
    respondInvitationSent(response)
  } catch (error) {
    next(error)
  }
}

/**
 * Mail a pending invitation again with a new link; the old link stops
 * working. Owner/admin only, it shares the invite endpoint's limiter, and
 * `resend` re-checks `canActorGrantRole` on the invitation's role. Takes
 * no body. A `:id` that is not a UUID answers 400 validation, not 404
 * `invitation_not_found`.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`, carrying `:id`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function resendInvitation(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const invitationId = invitationIdParameter(request)
    await resend(actor, principal.tenantId, invitationId)
    respondInvitationSent(response)
  } catch (error) {
    next(error)
  }
}

/**
 * Revoke a pending invitation. Owner/admin only. A `:id` that is not a UUID
 * answers 400 validation, not 404 `invitation_not_found`.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`, carrying `:id`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function revokeInvitation(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const invitationId = invitationIdParameter(request)
    await revoke(actor, principal.tenantId, invitationId)
    // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
    successResponse(response, null, 'Invitation revoked.')
  } catch (error) {
    next(error)
  }
}

/**
 * Get a tenant's settings. Any member may call this.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function getSettings(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const settings = await getTenantSettings(tenantPrincipal(request).tenantId)
    successResponse(response, settings, 'Settings retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * Update a tenant's settings. Owner/admin only
 * (`requireRole('owner', 'admin')`, tenant.routes.ts).
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`, carrying the update body.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function updateSettings(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const principal = tenantPrincipal(request)
    const input = parseBody(updateTenantSettingsSchema, request.body)
    const settings = await updateTenantSettings(principal.tenantId, input)
    successResponse(response, settings, 'Settings updated.')
  } catch (error) {
    next(error)
  }
}
