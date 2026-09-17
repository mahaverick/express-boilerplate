// src/controllers/tenant.controller.ts
//
// Ten handlers, in the same order tenant.routes.ts mounts them: create/list/
// get/update tenant, list/add/change-role/remove member, get/update
// settings. Every handler assumes `requireAuth` has already run (populating
// `request.user`) — `tenant.routes.ts` mounts it router-wide, the same
// convention `profile.routes.ts` established. Every handler on a
// `/tenants/:slug/...` route additionally assumes `resolveTenant` has
// already run (populating `request.principal`) — see
// `tenant.middleware.ts`'s own header comment for what that guarantees:
// the caller is confirmed to be a member of the tenant the route names,
// with `request.principal.role` holding THAT tenant's role, before this
// file's code ever runs.
//
// THE ACTOR->TARGET ROLE MATRIX (plan's spec correction #4) is enforced
// here, in `canActorModifyTarget` below, and used by both
// `updateMemberRole` and `removeMember` — the two endpoints that act on an
// EXISTING member, as opposed to `addMember`, which grants an INITIAL role
// to someone not yet a member (see `canActorGrantRole`'s own comment for
// why that is a deliberately separate function, not a second call to this
// one). Router-level `requireRole(...)` (tenant.routes.ts) already narrows
// which ACTOR roles can reach each handler at all (only `'owner'` reaches
// `updateMemberRole`; only `'owner'`/`'admin'` reach `removeMember`) — this
// function is what additionally checks the ACTOR against the TARGET's
// current role and self-ness, which no router-level check can express.
import { type NextFunction, type Request, type Response } from 'express'
import { type MembershipRole } from '@/constants/tenant.constants'
import type { NewTenant } from '@/database/models/tenant.model'
import { HttpError } from '@/middlewares/error.middleware'
import type { RequestPrincipal } from '@/middlewares/tenant.middleware'
import { TenantSettingsRepository } from '@/repositories/tenant-settings.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/auth.validators'
import {
  newMemberSchema,
  newTenantSchema,
  updateMemberRoleSchema,
  updateTenantSchema,
  updateTenantSettingsSchema,
  type UpdateTenantInput,
  type UpdateTenantSettingsInput,
} from '@/validators/tenant.validators'

const tenantRepository = new TenantRepository()
const tenantSettingsRepository = new TenantSettingsRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * The authenticated caller's id, guarding against a route reaching this
 * controller without `requireAuth` ahead of it — the same defensive check
 * `profile.controller.ts`'s own `authenticatedUserId` makes, and for the
 * identical reason: today this can only happen if a route is wired up
 * wrong (`tenant.routes.ts` mounts `requireAuth` router-wide), but a 401
 * here costs nothing and turns a future routing mistake into an auth
 * failure instead of `undefined` flowing into a repository call. Not
 * imported from `profile.controller.ts` — that helper is module-private
 * there, and a four-line check duplicated once, in this file's own terms,
 * is cheaper than exporting a cross-controller dependency for it.
 * @param request - The incoming request.
 * @returns The authenticated user's id.
 * @throws {HttpError} 401, when `request.user` was never populated.
 */
function authenticatedUserId(request: Request): string {
  if (!request.user) {
    throw new HttpError('Authentication required', 401)
  }
  return request.user.id
}

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
 * Whether `actorRole` may change or remove an EXISTING member currently
 * holding `targetRole`. Encodes the plan's actor->target matrix exactly:
 *
 * | Actor \ Target | owner      | admin | manager/editor/viewer |
 * | -------------- | ---------- | ----- | ---------------------- |
 * | owner           | self-only | yes   | yes                    |
 * | admin           | no        | no    | yes                    |
 *
 * `manager`/`editor`/`viewer` actor rows are not represented — router-level
 * `requireRole` (tenant.routes.ts) never lets those roles reach either
 * caller of this function, so there is no case for this function to encode
 * on their behalf; a defensive `false` is still returned for them below,
 * so a future route that forgets its `requireRole` fails closed rather
 * than falling through to `undefined`.
 *
 * The "last owner" guard is NOT part of this function — `isSelf` only
 * answers "is the actor targeting their own membership", not "would this
 * leave the tenant ownerless". `updateMemberRole`/`removeMember` each run
 * `UserMembershipRepository.countOwners` themselves, after this check
 * passes, only for the one case where it could matter (an owner target,
 * self-targeted) — counting owners on every call, including the 4-in-5
 * paths that can never remove the last owner, would be a wasted query.
 * @param actorRole - The caller's role in this tenant.
 * @param targetRole - The target member's CURRENT role.
 * @param isSelf - Whether the actor and the target are the same user.
 * @returns True when `actorRole` may act on a member currently holding `targetRole`.
 */
export function canActorModifyTarget(
  actorRole: MembershipRole,
  targetRole: MembershipRole,
  isSelf: boolean
): boolean {
  if (targetRole === 'owner') return actorRole === 'owner' && isSelf
  if (targetRole === 'admin') return actorRole === 'owner'
  return actorRole === 'owner' || actorRole === 'admin'
}

/**
 * Whether `actorRole` may GRANT `role` to a brand-new member via
 * `addMember`. Deliberately a SEPARATE function from
 * `canActorModifyTarget`, not a second call to it with some synthetic
 * `isSelf: false` — the plan's matrix describes acting on an EXISTING
 * member's CURRENT role, and adding someone has no "current role" to
 * plug into that shape; reusing it here would silently read `role` as if
 * it meant "the target's role before this action", which is backwards for
 * a grant.
 *
 * Beyond the plan's own text — the plan's per-endpoint bullets list the
 * matrix as a `PATCH`/`DELETE`-only rule, and router-level
 * `requireRole('owner', 'admin')` (tenant.routes.ts) already lets an admin
 * reach `POST /tenants/:slug/members` at all. Without this check, an admin
 * could add a brand-new member with `role: 'admin'` (or `'owner'`) directly
 * — a strictly larger grant than the matrix lets that same admin apply to
 * an EXISTING admin/owner member, and the exact privilege-escalation seam
 * the matrix exists to close one call site over. Owners are unrestricted,
 * matching the matrix's own "owner: yes" for every non-self target role.
 * @param actorRole - The caller's role in this tenant.
 * @param role - The role `addMember`'s caller is trying to grant.
 * @returns True when `actorRole` may grant `role` to a new member.
 */
export function canActorGrantRole(actorRole: MembershipRole, role: MembershipRole): boolean {
  if (actorRole === 'owner') return true
  if (actorRole === 'admin') return role !== 'owner' && role !== 'admin'
  return false
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
    const userId = authenticatedUserId(request)
    const input = parseBody(newTenantSchema, request.body)
    const tenant = await tenantRepository.create({ ...input, ownerId: userId })
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
    const userId = authenticatedUserId(request)
    const tenants = await tenantRepository.listForUser(userId)
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
    const principal = tenantPrincipal(request)
    const tenant = await tenantRepository.findById(principal.tenantId)
    if (!tenant) {
      // Unreachable in practice — `resolveTenant` already looked this
      // tenant up moments earlier via `findActiveBySlug` — but a defensive
      // 404 rather than trusting that fact costs nothing. See
      // `TenantRepository.insertOne`'s own comment for this codebase's
      // general stance on guarding "cannot happen" cases anyway.
      throw new HttpError('Tenant not found', 404)
    }
    successResponse(response, tenant, 'Tenant retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * The row columns a validated `PATCH /api/v1/tenants/:slug` body should
 * write, built from `input` with `Object.hasOwn` — not
 * `input.field !== undefined` — the same PATCH-presence distinction
 * `profile.controller.ts`'s `toUpdateValues` already establishes: an
 * omitted key leaves the column alone; an explicit `null` (on the three
 * nullable columns) clears it. `name` never carries `null` — the schema
 * itself does not allow it (`updateTenantSchema`'s own comment) — so
 * `Object.hasOwn(input, 'name')` implies a real string.
 * @param input - The already-validated request body.
 * @returns Only the columns the caller actually supplied.
 */
function toTenantUpdateValues(
  input: UpdateTenantInput
): Partial<Pick<NewTenant, 'name' | 'description' | 'logo' | 'website'>> {
  const values: Partial<Pick<NewTenant, 'name' | 'description' | 'logo' | 'website'>> = {}
  if (Object.hasOwn(input, 'name') && input.name !== undefined) values.name = input.name
  if (Object.hasOwn(input, 'description')) values.description = input.description
  if (Object.hasOwn(input, 'logo')) values.logo = input.logo
  if (Object.hasOwn(input, 'website')) values.website = input.website
  return values
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
    const values = toTenantUpdateValues(input)
    const hasChanges = Object.keys(values).length > 0
    const tenant = hasChanges
      ? await tenantRepository.update(principal.tenantId, values)
      : await tenantRepository.findById(principal.tenantId)
    if (!tenant) {
      throw new HttpError('Tenant not found', 404)
    }
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
    const principal = tenantPrincipal(request)
    const members = await userMembershipRepository.listByTenant(principal.tenantId)
    successResponse(response, members, 'Members retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * Add an existing user to a tenant by email. Owner/admin only
 * (`requireRole('owner', 'admin')`, tenant.routes.ts) — `canActorGrantRole`
 * above then further restricts WHICH role an admin (never an owner) may
 * grant; see that function's own comment for why this check exists beyond
 * the plan's literal text.
 *
 * A caller supplying an email with no matching user gets a 404 — unlike
 * `register`/`forgot-password` (auth.controller.ts, Ruling G), this is
 * NOT answered identically for "no such user" and "already a member": both
 * this endpoint's own gate (owner/admin of an EXISTING tenant) and its rate
 * limiter (`createAddTenantMemberRateLimiter`, user-keyed) already require
 * a privileged, authenticated, budget-limited caller, which is a
 * fundamentally different threat model from the unauthenticated
 * registration/login/password-reset surface Ruling G was written for —
 * see this task's own report for where that line was drawn.
 * @param request - The incoming request, resolved to a tenant by `resolveTenant`, carrying `{ email, role }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function addMember(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const principal = tenantPrincipal(request)
    const input = parseBody(newMemberSchema, request.body)

    if (!canActorGrantRole(principal.role, input.role)) {
      throw new HttpError('Insufficient permissions to grant this role', 403)
    }

    const targetUser = await userRepository.findByEmail(input.email)
    if (!targetUser) {
      throw new HttpError('No user found with this email', 404)
    }

    const membership = await userMembershipRepository.create({
      userId: targetUser.id,
      tenantId: principal.tenantId,
      role: input.role,
    })

    successResponse(
      response,
      {
        membership,
        user: {
          id: targetUser.id,
          email: targetUser.email,
          firstName: targetUser.firstName,
          lastName: targetUser.lastName,
        },
      },
      'Member added.',
      201
    )
  } catch (error) {
    next(error)
  }
}

/**
 * Change an existing member's role. Owner only
 * (`requireRole('owner')`, tenant.routes.ts) — so `principal.role` is
 * always `'owner'` by the time this handler runs, and `canActorModifyTarget`
 * below therefore only ever evaluates its owner row. Kept as a real call
 * (not inlined as `targetMembership.role !== 'owner' ||
 * targetUserId === actorUserId`) so this handler and `removeMember` share
 * one definition of the matrix rather than two copies that could drift.
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
    const actorUserId = authenticatedUserId(request)
    const targetUserId = targetUserIdParameter(request)
    const input = parseBody(updateMemberRoleSchema, request.body)

    const targetMembership = await userMembershipRepository.findByUserAndTenant(
      targetUserId,
      principal.tenantId
    )
    if (!targetMembership) {
      throw new HttpError('Member not found', 404)
    }

    const isSelf = targetUserId === actorUserId
    if (!canActorModifyTarget(principal.role, targetMembership.role, isSelf)) {
      throw new HttpError("Insufficient permissions to change this member's role", 403)
    }

    // The last-owner guard only ever applies to THIS one case —
    // `canActorModifyTarget` already proved `isSelf` whenever
    // `targetMembership.role === 'owner'` reaches here (the matrix's
    // "owner target: self-only"), so a non-self target can never trip
    // this branch. `input.role !== 'owner'` is what makes this a REAL
    // demotion — an owner re-submitting `{ role: 'owner' }` on their own
    // membership is a no-op the last-owner rule has no reason to block.
    if (isSelf && targetMembership.role === 'owner' && input.role !== 'owner') {
      const ownerCount = await userMembershipRepository.countOwners(principal.tenantId)
      if (ownerCount <= 1) {
        throw new HttpError('Cannot change role: you are the last owner', 409)
      }
    }

    const updated = await userMembershipRepository.updateRole(targetMembership.id, input.role)
    if (!updated) {
      throw new HttpError('Member not found', 404)
    }
    successResponse(response, updated, 'Member role updated.')
  } catch (error) {
    next(error)
  }
}

/**
 * Remove a member from a tenant. Owner/admin only
 * (`requireRole('owner', 'admin')`, tenant.routes.ts) — `canActorModifyTarget`
 * then narrows further: an admin can never remove another admin or any
 * owner (including, per the matrix, THEMSELVES — an admin target is
 * `'no'` regardless of `isSelf`; see this task's own report for that
 * consequence).
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
    const actorUserId = authenticatedUserId(request)
    const targetUserId = targetUserIdParameter(request)

    const targetMembership = await userMembershipRepository.findByUserAndTenant(
      targetUserId,
      principal.tenantId
    )
    if (!targetMembership) {
      throw new HttpError('Member not found', 404)
    }

    const isSelf = targetUserId === actorUserId
    if (!canActorModifyTarget(principal.role, targetMembership.role, isSelf)) {
      throw new HttpError('Insufficient permissions to remove this member', 403)
    }

    // Same reasoning as `updateMemberRole`'s own last-owner guard: only
    // reachable when `isSelf` (the matrix already proved that for an owner
    // target), and unconditional here — unlike a role change, removal is
    // ALWAYS a real loss of ownership, so there is no "no-op" case to
    // exempt.
    if (isSelf && targetMembership.role === 'owner') {
      const ownerCount = await userMembershipRepository.countOwners(principal.tenantId)
      if (ownerCount <= 1) {
        throw new HttpError('Cannot remove the last owner', 409)
      }
    }

    const wasDeleted = await userMembershipRepository.delete(targetMembership.id)
    if (!wasDeleted) {
      throw new HttpError('Member not found', 404)
    }
    successResponse(response, undefined, 'Member removed.')
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
    const principal = tenantPrincipal(request)
    const settings = await tenantSettingsRepository.findByTenantId(principal.tenantId)
    if (!settings) {
      // Unreachable in practice — `TenantRepository.create` writes the
      // settings row atomically alongside the tenant itself
      // (tenant.repository.ts), so a visible, resolvable tenant always has
      // one. Guarded anyway, same reasoning as `getTenant` above.
      throw new HttpError('Tenant settings not found', 404)
    }
    successResponse(response, settings, 'Settings retrieved.')
  } catch (error) {
    next(error)
  }
}

/**
 * The row columns a validated `PATCH /api/v1/tenants/:slug/settings` body
 * should write. Same `Object.hasOwn`-based presence check as
 * `toTenantUpdateValues` above — see that function's own comment.
 * @param input - The already-validated request body.
 * @returns Only the columns the caller actually supplied.
 */
function toSettingsUpdateValues(
  input: UpdateTenantSettingsInput
): Partial<{ timezone: string; locale: string; metadata: Record<string, unknown> | null }> {
  const values: Partial<{
    timezone: string
    locale: string
    metadata: Record<string, unknown> | null
  }> = {}
  if (Object.hasOwn(input, 'timezone') && input.timezone !== undefined) {
    values.timezone = input.timezone
  }
  if (Object.hasOwn(input, 'locale') && input.locale !== undefined) {
    values.locale = input.locale
  }
  if (Object.hasOwn(input, 'metadata') && input.metadata !== undefined) {
    values.metadata = input.metadata
  }
  return values
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
    const values = toSettingsUpdateValues(input)
    const hasChanges = Object.keys(values).length > 0
    const settings = hasChanges
      ? await tenantSettingsRepository.update(principal.tenantId, values)
      : await tenantSettingsRepository.findByTenantId(principal.tenantId)
    if (!settings) {
      throw new HttpError('Tenant settings not found', 404)
    }
    successResponse(response, settings, 'Settings updated.')
  } catch (error) {
    next(error)
  }
}
