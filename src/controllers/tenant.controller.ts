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
// the caller is confirmed to have access to the tenant the route names, as
// a member or through their platform role, with `request.principal.role`
// holding their effective role there, before this file's code ever runs.
//
// Member and invitation writes pass the actor, never `principal.role`: the
// services re-read the actor's role under lock inside their transaction and
// apply policies/tenant.policy.ts there. The router's `requireRole(...)` is
// only the early gate.
import type { Request } from 'express'
import { BaseController } from '@/controllers/base.controller'
import { actorFrom, authenticatedUserId } from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import { invite, listPending, resend, revoke } from '@/services/tenant-invitation.service'
import { changeRole, removeMember } from '@/services/tenant-membership.service'
import {
  createTenant,
  getSettings,
  getTenant,
  listForUser,
  listMembers,
  updateSettings,
  updateTenant,
} from '@/services/tenant.service'
import type { RequestPrincipal } from '@/types/actor'
import { messageResponse, successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  invitationIdSchema,
  inviteMemberSchema,
  newTenantSchema,
  updateMemberRoleSchema,
  updateTenantSchema,
  updateTenantSettingsSchema,
} from '@/validators/tenant.validators'

const INVITATION_SENT_MESSAGE = 'If that address can be invited, an invitation has been sent.'

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
 * The `:id` route param on an invitation route, validated as a UUID.
 * @param request - The incoming request.
 * @returns The invitation id.
 * @throws {HttpError} 400, when `:id` is not a UUID.
 */
function invitationIdParameter(request: Request): string {
  return parseBody(invitationIdSchema, request.params).id
}

/**
 * Handlers for `/api/v1/tenants`.
 */
class TenantController extends BaseController {
  /**
   * `POST /tenants`: create a tenant. The caller becomes its sole `'owner'`
   * member — `TenantRepository.create` inserts the tenant, its settings row,
   * and this owner membership atomically (tenant.repository.ts's own header
   * comment).
   */
  createTenant = this.handle(async (request, response) => {
    const actor = actorFrom(request)
    const input = parseBody(newTenantSchema, request.body)
    const tenant = await createTenant(actor, input)
    successResponse(response, tenant, 'Tenant created.', 201)
  })

  /**
   * `GET /tenants`: every tenant the caller belongs to, with their role in each.
   */
  listTenants = this.handle(async (request, response) => {
    const tenants = await listForUser(authenticatedUserId(request))
    successResponse(response, tenants, 'Tenants retrieved.')
  })

  /**
   * `GET /tenants/:slug`: one tenant's details. Anyone `resolveTenant`
   * admits may call this; there is no further role check.
   */
  getTenant = this.handle(async (request, response) => {
    const tenant = await getTenant(tenantPrincipal(request).tenantId)
    successResponse(response, tenant, 'Tenant retrieved.')
  })

  /**
   * `PATCH /tenants/:slug`: update a tenant's `name`/`description`/`logo`/
   * `website`. Owner/admin only — `requireRole('owner', 'admin')`
   * (tenant.routes.ts) gates this before the handler runs. `slug` cannot be
   * changed here — see `updateTenantSchema`'s own comment for why.
   */
  updateTenant = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const input = parseBody(updateTenantSchema, request.body)
    const tenant = await updateTenant(principal.tenantId, input)
    successResponse(response, tenant, 'Tenant updated.')
  })

  /**
   * `GET /tenants/:slug/members`: a tenant's members, each with their safe
   * user info (`UserMembershipRepository.listByTenant` never joins
   * `passwordHash` — see that method's own comment). Anyone `resolveTenant`
   * admits may call this.
   */
  listMembers = this.handle(async (request, response) => {
    const members = await listMembers(tenantPrincipal(request).tenantId)
    successResponse(response, members, 'Members retrieved.')
  })

  /**
   * `PATCH /tenants/:slug/members/:userId`: change an existing member's role.
   * Owner only: `requireRole('owner')` (tenant.routes.ts), then `changeRole`
   * re-checks the actor's current role and the actor→target matrix under lock.
   */
  updateMemberRole = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const targetUserId = targetUserIdParameter(request)
    const input = parseBody(updateMemberRoleSchema, request.body)

    const updated = await changeRole(actor, principal.tenantId, targetUserId, input.role)
    successResponse(response, updated, 'Member role updated.')
  })

  /**
   * `DELETE /tenants/:slug/members/:userId`: remove a member from a tenant.
   * Owner/admin only: `requireRole('owner', 'admin')` (tenant.routes.ts),
   * then `removeMember` re-checks the actor's current role and the matrix
   * under lock. Under the matrix an admin can never remove another admin or
   * any owner, themselves included.
   */
  removeMember = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const targetUserId = targetUserIdParameter(request)

    await removeMember(actor, principal.tenantId, targetUserId)
    messageResponse(response, 'Member removed.')
  })

  /**
   * `GET /tenants/:slug/invitations`: a tenant's pending invitations.
   * Owner/admin only (`requireRole('owner', 'admin')`, tenant.routes.ts).
   * Never returns a token or its hash.
   */
  listInvitations = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const invitations = await listPending(principal.tenantId)
    successResponse(response, invitations, 'Invitations retrieved.')
  })

  /**
   * `POST /tenants/:slug/invitations`: invite an address to the tenant.
   * Owner/admin only; `invite` re-checks the actor's current role and
   * `canActorGrantRole` under lock. Answers 202 with one fixed body whether
   * or not the address has an account; only a current member gets 409
   * `already_member`.
   */
  inviteMember = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const input = parseBody(inviteMemberSchema, request.body)
    await invite(actor, principal.tenantId, input.email, input.role)
    messageResponse(response, INVITATION_SENT_MESSAGE, 202)
  })

  /**
   * `POST /tenants/:slug/invitations/:id/resend`: mail a pending invitation
   * again with a new link; the old link stops working. Owner/admin only, it
   * shares the invite endpoint's limiter, and `resend` re-checks
   * `canActorGrantRole` on the invitation's role. Takes no body. A `:id`
   * that is not a UUID answers 400 validation, not 404 `invitation_not_found`.
   */
  resendInvitation = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const invitationId = invitationIdParameter(request)
    await resend(actor, principal.tenantId, invitationId)
    messageResponse(response, INVITATION_SENT_MESSAGE, 202)
  })

  /**
   * `DELETE /tenants/:slug/invitations/:id`: revoke a pending invitation.
   * Owner/admin only. A `:id` that is not a UUID answers 400 validation, not
   * 404 `invitation_not_found`.
   */
  revokeInvitation = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const invitationId = invitationIdParameter(request)
    await revoke(actor, principal.tenantId, invitationId)
    messageResponse(response, 'Invitation revoked.')
  })

  /**
   * `GET /tenants/:slug/settings`: a tenant's settings. Anyone `resolveTenant` admits
   * may call this.
   */
  getSettings = this.handle(async (request, response) => {
    const settings = await getSettings(tenantPrincipal(request).tenantId)
    successResponse(response, settings, 'Settings retrieved.')
  })

  /**
   * `PATCH /tenants/:slug/settings`: update a tenant's settings. Owner/admin
   * only (`requireRole('owner', 'admin')`, tenant.routes.ts).
   */
  updateSettings = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const input = parseBody(updateTenantSettingsSchema, request.body)
    const settings = await updateSettings(principal.tenantId, input)
    successResponse(response, settings, 'Settings updated.')
  })
}

/**
 * The tenant controller the tenant routes mount.
 */
export const tenantController = new TenantController()
