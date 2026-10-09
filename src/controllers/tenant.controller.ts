/**
 * @file Tenant, member, invitation and settings handlers, behind
 * tenant.routes.ts's router-wide `requireAuth`; every `/tenants/:slug` handler
 * also runs after `resolveTenant`. Writes pass the actor, never
 * `principal.role`: the services re-read the actor's role under lock and apply
 * policies/tenant.policy.ts there, so the router's `requireRole` is only the
 * early gate. A member or invitation write by staff through platform access
 * also passes on the `reason` its route middleware validated, for the audit
 * entry.
 */
import type { Request } from 'express'
import { MEMBER_NOT_FOUND_CODE, MEMBER_NOT_FOUND_MESSAGE } from '@/constants/tenant.constants'
import { BaseController } from '@/controllers/base.controller'
import { actorFrom, authenticatedUserId, tenantPrincipal } from '@/controllers/helpers.controller'
import { HttpError } from '@/errors/http-error'
import { toPublicTenant, toTenantDetail, toTenantListRow } from '@/presenters/tenant.presenter'
import { invite, listPending, resend, revoke } from '@/services/tenant-invitation.service'
import { changeRole, leaveTenant, removeMember } from '@/services/tenant-membership.service'
import {
  createTenant,
  getSettings,
  getTenant,
  listForUser,
  listMembers,
  updateSettings,
  updateTenant,
} from '@/services/tenant.service'
import type { StaffReasonOption } from '@/types/actor'
import { messageResponse, successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { parseIdParameter } from '@/validators/platform.validators'
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
 * The `:userId` route param on a member-management route, validated as a
 * UUID. A malformed id answers like an unknown member, so it never reaches
 * the database (a NUL would answer 500 there).
 * @param request - The incoming request.
 * @returns The `:userId` param.
 * @throws {HttpError} 404 `member_not_found` (message `Member not found`), when `:userId` is not a UUID.
 */
function targetUserIdParameter(request: Request): string {
  return parseIdParameter(request.params.userId, MEMBER_NOT_FOUND_MESSAGE, MEMBER_NOT_FOUND_CODE)
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
 * The reason staff gave for a member or invitation write, as
 * `requireRecentAuthAndReasonOnPlatformAccess` left it on the request.
 * @param request - The incoming request.
 * @returns `{ reason }` for a staff write, `{}` for a member's.
 */
function staffReasonOf(request: Request): StaffReasonOption {
  return request.staffReason === undefined ? {} : { reason: request.staffReason }
}

/**
 * Handlers for `/api/v1/tenants`.
 */
class TenantController extends BaseController {
  /**
   * `POST /tenants`: create a tenant. The caller becomes its sole `'owner'`
   * member: `TenantRepository.create` inserts the tenant, its settings row and
   * this owner membership in one transaction.
   */
  createTenant = this.handle(async (request, response) => {
    const actor = actorFrom(request)
    const input = parseBody(newTenantSchema, request.body)
    const tenant = await createTenant(actor, input)
    successResponse(response, toPublicTenant(tenant), 'Tenant created.', 201)
  })

  /**
   * `GET /tenants`: every tenant the caller belongs to, with their role in each.
   */
  listTenants = this.handle(async (request, response) => {
    const tenants = await listForUser(authenticatedUserId(request))
    successResponse(
      response,
      tenants.map((entry) => toTenantListRow(entry)),
      'Tenants retrieved.'
    )
  })

  /**
   * `GET /tenants/:slug`: one tenant's details, plus the caller's effective
   * `role` and `access` as `resolveTenant` found them. Anyone `resolveTenant`
   * admits may call this; there is no further role check.
   */
  getTenant = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const tenant = await getTenant(principal.tenantId)
    successResponse(response, toTenantDetail(tenant, principal), 'Tenant retrieved.')
  })

  /**
   * `PATCH /tenants/:slug`: update a tenant's `name`/`description`/`logo`/
   * `website`. Owner/admin only — `requireRole('owner', 'admin')`
   * (tenant.routes.ts) gates this before the handler runs. `slug` cannot be
   * changed here (see `updateTenantSchema`). The service re-reads the caller's
   * access under lock.
   */
  updateTenant = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const input = parseBody(updateTenantSchema, request.body)
    const tenant = await updateTenant(actorFrom(request), principal.tenantId, input)
    successResponse(response, toPublicTenant(tenant), 'Tenant updated.')
  })

  /**
   * `GET /tenants/:slug/members`: a tenant's members, each with their safe
   * user info (`UserMembershipRepository.listByTenant` never selects
   * `passwordHash`). Anyone `resolveTenant` admits may call this. Each row is
   * `{ membership, user: { id, email, firstName, lastName } }`, and a
   * soft-deleted user is not listed. On the platform tenant only, `user`
   * also carries `active`, false for a deactivated account: staff already
   * read every account's status, while a customer tenant's members, viewers
   * included, never learn that a co-member was deactivated. A client treats
   * a missing `active` as active.
   *
   * The rows are enough to reproduce the last-owner rule, the 409 on
   * demoting, removing or leaving as an owner: it refuses unless another
   * listed owner remains. On a customer tenant any listed owner counts,
   * deactivated or not (`countOwners`); on the platform tenant only one
   * whose `user.active` is true (`countActiveOwners`).
   */
  listMembers = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const members = await listMembers(principal.tenantId, principal.isPlatformTenant)
    successResponse(response, members, 'Members retrieved.')
  })

  /**
   * `PATCH /tenants/:slug/members/:userId`: change an existing member's role.
   * Owner only: `requireRole('owner')` (tenant.routes.ts), then `changeRole`
   * re-checks the actor's current role and the actor→target matrix under lock.
   * A `:userId` that is not a member (or not a UUID) answers 404
   * `member_not_found`, message `Member not found`.
   */
  updateMemberRole = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const targetUserId = targetUserIdParameter(request)
    const input = parseBody(updateMemberRoleSchema, request.body)

    const updated = await changeRole(actor, principal.tenantId, targetUserId, input.role, {
      isPlatformTenant: principal.isPlatformTenant,
      ...staffReasonOf(request),
    })
    successResponse(response, updated, 'Member role updated.')
  })

  /**
   * `DELETE /tenants/:slug/members/:userId`: remove a member from a tenant.
   * Owner/admin only: `requireRole('owner', 'admin')` (tenant.routes.ts),
   * then `removeMember` re-checks the actor's current role and the matrix
   * under lock. Under the matrix an admin can never remove another admin or
   * any owner, themselves included. A `:userId` that is not a member (or not
   * a UUID) answers 404 `member_not_found`, message `Member not found`.
   */
  removeMember = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const actor = actorFrom(request)
    const targetUserId = targetUserIdParameter(request)

    await removeMember(actor, principal.tenantId, targetUserId, {
      isPlatformTenant: principal.isPlatformTenant,
      ...staffReasonOf(request),
    })
    messageResponse(response, 'Member removed.')
  })

  /**
   * `DELETE /tenants/:slug/membership`: the caller leaves the tenant. Members
   * only (`requireMembership`, tenant.routes.ts); any role may leave except
   * the last owner, who gets 409 `LAST_OWNER`. Takes no body (`{}`).
   */
  leaveTenant = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    await leaveTenant(actorFrom(request), principal.tenantId, {
      isPlatformTenant: principal.isPlatformTenant,
    })
    messageResponse(response, 'You left the tenant.')
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
    await invite(actor, principal.tenantId, input.email, input.role, staffReasonOf(request))
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
    await resend(actor, principal.tenantId, invitationId, staffReasonOf(request))
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
    await revoke(actor, principal.tenantId, invitationId, staffReasonOf(request))
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
   * only (`requireRole('owner', 'admin')`, tenant.routes.ts). The service
   * re-reads the caller's access under lock.
   */
  updateSettings = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const input = parseBody(updateTenantSettingsSchema, request.body)
    const settings = await updateSettings(actorFrom(request), principal.tenantId, input)
    successResponse(response, settings, 'Settings updated.')
  })
}

/**
 * The tenant controller the tenant routes mount.
 */
export const tenantController = new TenantController()
