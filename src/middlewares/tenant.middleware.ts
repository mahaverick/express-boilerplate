/**
 * @file The tenant-scoping seam: `resolveTenant` (after `requireAuth` on every
 * `/tenants/:slug/*` route) confirms the caller's access to the tenant the
 * route names and attaches it to the request; `requireRole` (after
 * `resolveTenant`) gates on the role it found, and `requireMembership` on how
 * the caller reached the tenant. All are factories, called where a router is
 * assembled.
 */
import { type NextFunction, type Request, type Response } from 'express'
import {
  REASON_REQUIRED_CODE,
  REASON_REQUIRED_MESSAGE,
  type MembershipRole,
} from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { requireRecentAuth } from '@/middlewares/auth.middleware'
import { platformRoleOf } from '@/middlewares/maintenance-mode.middleware'
import { isRoleAtLeast } from '@/policies/tenant.policy'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { recordPlatformAccess } from '@/services/audit.service'
import { logger } from '@/services/logger.service'
import { requestContextStore, type TenantContext } from '@/services/request-context.service'
import type { RequestPrincipal } from '@/types/actor'
import { reasonSchema } from '@/validators/platform.validators'
import { isSlugShaped } from '@/validators/tenant.validators'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * Read `request.params.slug`: every tenant-scoped route names its tenant.
 * `ParamsDictionary` also allows an array, which a plain `:slug` never
 * produces; it is treated as no slug, which fails safe as a 404, as is a
 * segment no stored slug could match (a NUL, an upper-case letter, an
 * over-long value), which is never sent to the database.
 * @param request - The incoming request.
 * @returns The slug as supplied, or undefined when the request supplies none.
 */
function tenantIdentifierFrom(request: Request): string | undefined {
  const slug = request.params.slug
  return typeof slug === 'string' && isSlugShaped(slug) ? slug : undefined
}

/**
 * Record a staff visit, logging a failure instead of failing the request.
 * @param userId - The staff user.
 * @param tenantId - The tenant visited.
 * @param platformRole - The platform role the visit used.
 */
async function recordStaffVisit(
  userId: string,
  tenantId: string,
  platformRole: MembershipRole
): Promise<void> {
  try {
    await recordPlatformAccess({ userId }, tenantId, platformRole)
  } catch (error) {
    logger.warn('Platform access audit failed', { error: redactedForLog(error), tenantId })
  }
}

/**
 * The caller's principal in `tenant`: their membership when they have one,
 * otherwise their platform role, except in the platform tenant itself.
 * @param userId - The authenticated caller.
 * @param tenant - The tenant the route names.
 * @param response - This request's response, which may already carry the platform role (`platformRoleOf`).
 * @returns The principal, or undefined when the caller has no access.
 */
async function principalFor(
  userId: string,
  tenant: Tenant,
  response: Response
): Promise<RequestPrincipal | undefined> {
  const scope = {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    isPlatformTenant: tenant.isPlatform,
  }
  // A pool read with no executor: tenant-actor-race.test.ts hooks this call shape.
  const membership = await userMembershipRepository.findByUserAndTenant(userId, tenant.id)
  if (membership) {
    return {
      ...scope,
      role: membership.role,
      memberRole: membership.role,
      // eslint-disable-next-line unicorn/no-null -- membership wins, so no platform role applies
      platformRole: null,
      access: 'member',
    }
  }
  if (tenant.isPlatform) return undefined

  const platformRole = await platformRoleOf(userId, response)
  if (platformRole === null) return undefined
  await recordStaffVisit(userId, tenant.id, platformRole)
  // eslint-disable-next-line unicorn/no-null -- staff reach this tenant with no membership
  return { ...scope, role: platformRole, memberRole: null, platformRole, access: 'platform' }
}

/**
 * The middleware `resolveTenant` returns — see its JSDoc.
 * @param request - The incoming request.
 * @param response - Read for a platform role this request already read.
 * @param next - Continues the chain, or forwards the 404.
 */
async function scopeRequestToTenant(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const identifier = tenantIdentifierFrom(request)

    // A suspended, archived or deleted tenant must 404 like a nonexistent one.
    const tenant = identifier ? await tenantRepository.findActiveBySlug(identifier) : undefined
    const principal =
      tenant && request.user ? await principalFor(request.user.id, tenant, response) : undefined

    // Not 403: that would confirm a guessed slug exists.
    if (!principal) {
      throw new HttpError('Tenant not found', 404)
    }

    request.principal = principal
    const tenantContext: TenantContext = {
      tenantId: principal.tenantId,
      tenantSlug: principal.tenantSlug,
      role: principal.role,
    }

    // enterWith, not run(): this middleware does not own the rest of the chain.
    requestContextStore.enterWith({
      ...(requestContextStore.getStore() ?? { requestId: request.id }),
      tenant: tenantContext,
    })

    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Resolve the tenant a request is scoped to, and confirm the authenticated
 * caller has access to it. A member acts with their membership role;
 * otherwise staff (platform-tenant members) act with their platform role,
 * except in the platform tenant itself, which is members-only. A staff visit
 * is audited (`recordPlatformAccess`); a failed audit write is logged at warn
 * and never fails the request.
 *
 * A missing tenant and a tenant the caller cannot access answer the same
 * 404, never a 403, which would confirm that a guessed slug exists.
 *
 * On success, attaches `request.principal` and adds `.tenant` to the
 * request's existing `RequestContext` store (request-context.service.ts) with
 * `enterWith`, keeping every field already there. The change is visible to
 * `next()` and everything it schedules, which is how Express dispatches. A
 * caller that awaits this middleware from outside and then reads the store
 * sees the store from before the call; tests read it inside `next`.
 *
 * Reads `request.params.slug` — the only tenant selector this codebase has,
 * by design. There is deliberately no header-based selector: one would let
 * a caller send one tenant in the URL and another in a header, with
 * whichever a handler forgets to re-check becoming a confused-deputy hole.
 *
 * Must run after `requireAuth`, since it reads `request.user.id`. Without
 * `request.user` the request 404s like a caller with no access, so a route
 * missing `requireAuth` fails safe but surfaces only as a 404.
 * @returns An Express middleware.
 */
export function resolveTenant(): (
  request: Request,
  response: Response,
  next: NextFunction
) => Promise<void> {
  return scopeRequestToTenant
}

/**
 * Require the caller's role in the current tenant to rank at or above one
 * of `allowedRoles` (`isRoleAtLeast`), so `requireRole('owner', 'admin')`
 * admits owners and admins. An empty list admits nobody.
 * Member and invitation writes re-check the same bar on the role read
 * inside their transaction; this is the early gate.
 *
 * Must run after `resolveTenant`, which sets `request.principal`. Without a
 * principal it answers 403, failing safe.
 * @param allowedRoles - The roles whose rank, or higher, may proceed.
 * @returns An Express middleware.
 */
export function requireRole(
  ...allowedRoles: MembershipRole[]
): (request: Request, response: Response, next: NextFunction) => void {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const role = request.principal?.role
    const isAdmitted =
      role !== undefined && allowedRoles.some((allowed) => isRoleAtLeast(role, allowed))
    if (!isAdmitted) {
      next(new HttpError('Insufficient permissions', 403))
      return
    }
    next()
  }
}

/**
 * The middleware `requireMembership` returns — see its JSDoc.
 * @param request - The incoming request.
 * @param _response - Unused.
 * @param next - Continues the chain, or forwards the 404.
 */
function admitMembersOnly(request: Request, _response: Response, next: NextFunction): void {
  if (request.principal?.access !== 'member') {
    next(new HttpError('Tenant not found', 404))
    return
  }
  next()
}

/**
 * Admit only a caller who reached the tenant through a membership, refusing
 * staff who reached it through their platform role with the same 404 a
 * non-member gets. For an action only a member can take for themselves
 * (dismissing the checklist, ticking their own step): `requireRole` alone
 * would admit a platform role. Must run after `resolveTenant`; without a
 * principal it answers 404, failing safe.
 * @returns An Express middleware.
 */
export function requireMembership(): (
  request: Request,
  response: Response,
  next: NextFunction
) => void {
  return admitMembersOnly
}

const recentAuth = requireRecentAuth()

/**
 * The middleware `requireRecentAuthOnPlatformTenant` returns — see its JSDoc.
 * @param request - The incoming request, after `resolveTenant`.
 * @param response - The response, passed to the step-up check.
 * @param next - Continues the chain, or forwards the 401 or 500.
 */
function stepUpOnPlatformTenant(request: Request, response: Response, next: NextFunction): void {
  if (request.principal === undefined) {
    next(new HttpError('Tenant step-up check is misconfigured', 500))
    return
  }
  if (!request.principal.isPlatformTenant) {
    next()
    return
  }
  recentAuth(request, response, next)
}

/**
 * Step-up on the platform tenant only: a request that changes who holds
 * staff power (a member's role, a removal, an invitation of any role, a
 * resend) needs a recent sign-in there, as the `/platform` staff actions
 * do. Customer tenants pass straight through. Must run after
 * `resolveTenant`, which sets `request.principal`; without a principal it
 * answers 500, failing closed, since it cannot tell which tenant it guards.
 * @returns An Express middleware.
 */
export function requireRecentAuthOnPlatformTenant(): (
  request: Request,
  response: Response,
  next: NextFunction
) => void {
  return stepUpOnPlatformTenant
}

/**
 * The middleware `requireRecentAuthAndReasonOnPlatformAccess` returns — see its JSDoc.
 * @param request - The incoming request, after `resolveTenant`.
 * @param response - The response, passed to the step-up check.
 * @param next - Continues the chain, or forwards the 401, 400 or 500.
 */
function admitStaffWithReason(request: Request, response: Response, next: NextFunction): void {
  if (request.principal === undefined) {
    next(new HttpError('Staff reason check is misconfigured', 500))
    return
  }
  if (request.principal.access !== 'platform') {
    next()
    return
  }
  recentAuth(request, response, (error?: unknown) => {
    if (error !== undefined) {
      next(error)
      return
    }
    const parsed = reasonSchema.safeParse(
      (request.body as { reason?: unknown } | undefined)?.reason
    )
    if (!parsed.success) {
      next(new HttpError(REASON_REQUIRED_MESSAGE, 400, REASON_REQUIRED_CODE))
      return
    }
    request.staffReason = parsed.data
    next()
  })
}

/**
 * Step-up and a stated reason for staff acting on a customer tenant through
 * their platform role: a member or invitation write by a caller whose
 * access is `platform` needs a recent sign-in (401 `REAUTH_REQUIRED`) and a
 * body `reason` (trimmed, 1 to 500 characters, multi-line text allowed;
 * otherwise 400 `REASON_REQUIRED`), which is kept on `request.staffReason`
 * for the audit entry. A member, the platform tenant's staff included,
 * passes straight through and may omit `reason`. Must run after
 * `resolveTenant`; without a principal it answers 500, failing closed.
 * @returns An Express middleware.
 */
export function requireRecentAuthAndReasonOnPlatformAccess(): (
  request: Request,
  response: Response,
  next: NextFunction
) => void {
  return admitStaffWithReason
}
