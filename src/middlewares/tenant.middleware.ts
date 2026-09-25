// src/middlewares/tenant.middleware.ts
//
// The tenant-scoping seam: `resolveTenant` (composed after `requireAuth` on
// every `/tenants/:slug/*` route) confirms the caller belongs to the tenant
// the route names and attaches that fact to the request; `requireRole`
// (composed after `resolveTenant`) gates on the role it found. Neither
// exists as a top-level `const` middleware the way `requestContext` does —
// both are FACTORIES, called where a router is assembled, matching this
// codebase's existing convention for parameterised middleware (see
// rate-limit.middleware.ts's own header comment on why every limiter there
// is a factory too).
//
// RULING G — NOT A 403. Both "no tenant with this slug exists" and "this
// tenant exists but you are not a member of it" answer with the exact same
// 404, from the same thrown `HttpError`, at the same point below. A 403
// would tell an unauthenticated-for-this-tenant caller that the slug they
// guessed or enumerated is real; 404 tells them nothing a truly nonexistent
// slug would not also tell them. This is the plan's spec correction #2,
// overriding the original design doc's illustrative 403.
//
// ONE STORE, NOT TWO. `resolveTenant` extends the SAME `RequestContext` ALS
// store `requestContext` (request-context.middleware.ts) already opened for
// this request, via `requestContextStore.enterWith(...)` — it does not open
// a second, parallel store. See that file's own header comment for why
// `tenant` lives on `RequestContext` rather than a dedicated
// `tenantContextStore` the original design doc sketched (spec correction
// #3).
import { type NextFunction, type Request, type Response } from 'express'
import { type MembershipRole } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import { isRoleAtLeast } from '@/policies/tenant.policy'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { requestContextStore, type TenantContext } from '@/services/request-context.service'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * Read `request.params.slug` — every tenant-scoped route names its tenant.
 * @param request - The incoming request.
 * @returns The slug as supplied, or undefined when the request supplies none.
 */
function tenantIdentifierFrom(request: Request): string | undefined {
  // `request.params.slug` types as `string | string[] | undefined`
  // (`ParamsDictionary`'s index signature allows an array value for a
  // repeated/splat param pattern) even though a plain `:slug` segment can
  // never actually produce one — narrowed explicitly rather than asserted,
  // so the type system's worst case and this function's return type agree.
  // An array here would mean the route itself is shaped unexpectedly, not
  // that a real slug was supplied; treating it as "no identifier" is the
  // same fail-safe direction as every other absent-identifier case below.
  const slug = request.params.slug
  return typeof slug === 'string' ? slug : undefined
}

/**
 * The middleware `resolveTenant` returns — see its JSDoc.
 * @param request - The incoming request.
 * @param _response - Unused.
 * @param next - Continues the chain, or forwards the 404.
 */
async function scopeRequestToTenant(
  request: Request,
  _response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const identifier = tenantIdentifierFrom(request)

    // `findActiveBySlug` already combines "not soft-deleted" and
    // "lifecycleState = 'active'" in one lookup (tenant.repository.ts),
    // which is exactly the gate a suspended/archived tenant must fail the
    // same way a nonexistent one does.
    const tenant = identifier ? await tenantRepository.findActiveBySlug(identifier) : undefined
    const membership =
      tenant && request.user
        ? await userMembershipRepository.findByUserAndTenant(request.user.id, tenant.id)
        : undefined

    // Ruling G: identical 404 whether the tenant does not exist or the
    // caller is simply not a member of it — see this file's header
    // comment.
    if (!tenant || !membership) {
      throw new HttpError('Tenant not found', 404)
    }

    const tenantContext: TenantContext = {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      role: membership.role,
    }
    request.principal = tenantContext

    // Extend the EXISTING store in place, not a new `.run()` — this
    // middleware does not own the rest of the request's control flow the
    // way `requestContext` itself does (it is composed into an
    // already-running chain), and spreading the current store rather than
    // hand-listing `requestId` keeps this from silently dropping any
    // field a later change adds to `RequestContext` alongside `tenant`.
    //
    // WHAT `enterWith` DOES AND DOES NOT MAKE VISIBLE, precisely — this
    // matters for anyone composing `resolveTenant` outside a normal
    // Express dispatch (a job worker, a test harness): the mutated store
    // is visible to whatever `next()` calls SYNCHRONOUSLY, and to
    // anything THAT code schedules afterward (an async handler it calls,
    // a repository query it awaits) — which is exactly how Express
    // itself dispatches to the next middleware/handler, so this is
    // correct for every real route with no special handling needed. It
    // is NOT visible in the continuation of a caller that instead
    // `await`s this whole `resolveTenant()(...)` call from OUTSIDE and
    // only then reads `requestContextStore.getStore()` — that caller's
    // own promise continuation was already linked to the PRE-`enterWith`
    // store at the moment the call was made, so it observes a stale
    // snapshot. This is standard, working-as-designed AsyncLocalStorage
    // behaviour (`enterWith` documents itself as affecting "the current
    // synchronous execution ... and then persists ... through any
    // following asynchronous calls" — not calls that were already
    // in flight beforehand) — not a bug here — and is exactly what
    // tests/unit/middlewares/tenant.middleware.test.ts's own tests
    // capture `next`'s SYNCHRONOUS invocation to read the store, not an
    // outer `await`, having hit this exact trap while writing them.
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
 * caller belongs to it. On success, attaches `request.principal` and
 * extends the request's `RequestContext` ALS store with `.tenant` — see
 * this file's header comment for both.
 *
 * Reads `request.params.slug` — the only tenant selector this codebase has,
 * by design. There is deliberately no header-based selector: one would let
 * a caller send one tenant in the URL and another in a header, with
 * whichever a handler forgets to re-check becoming a confused-deputy hole.
 *
 * Must run AFTER `requireAuth` — reads `request.user.id`. A route that
 * omits `requireAuth` ahead of this is a routing bug this middleware does
 * not itself defend against beyond failing safe: with no `request.user`,
 * the membership lookup is skipped and the request 404s exactly like
 * a real non-member would, rather than throwing on a missing id. That is
 * the safe direction for the mistake to fail in, but it also means such a
 * misconfigured route never surfaces as anything louder than a 404 in
 * testing.
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
 * Must run AFTER `resolveTenant` — reads `request.principal`, which only
 * `resolveTenant` sets. A route missing it ahead of this always answers 403
 * (a missing principal is treated as "no role granted", not specially
 * detected as a routing bug) — the same fail-safe direction `resolveTenant`
 * itself takes on a missing `request.user`.
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
