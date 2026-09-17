// src/middlewares/request-context.middleware.ts
//
// Carries the request-id from requestId (request-id.middleware.ts) into an
// AsyncLocalStorage context so logger.service.ts can attach it to every log
// line emitted while handling this request — including from code that has
// no `Request` object in scope at all (a repository, a service, a utility
// several calls deep). Must run immediately after requestId: it reads
// `request.id`, which requestId is what sets.
//
// `tenant` (below) is added by `resolveTenant` (tenant.middleware.ts), NOT
// by this file — this remains the single ALS context for a request, per the
// RBAC plan's spec correction #3 ("no second store, no new file"). This
// file only owns the shape; `resolveTenant` is the one caller that ever
// populates it, via `requestContextStore.enterWith(...)` on the SAME store
// this middleware already opened with `.run()`, not a nested store of its
// own.
import { AsyncLocalStorage } from 'node:async_hooks'
import { type NextFunction, type Request, type Response } from 'express'
import type { MembershipRole } from '@/constants/tenant.constants'

/**
 * The tenant a request is scoped to, once `resolveTenant` has resolved one
 * — the same three fields `resolveTenant` also attaches to `request` as
 * `request.principal` (tenant.middleware.ts's `RequestPrincipal`, defined
 * as an alias of this type so the two never drift apart the way
 * `AuthenticatedUser`/`PublicUser` used to before `PublicUser` was rebuilt
 * on top of `toAuthenticatedUser` — see auth.middleware.ts's own comment).
 * `request.principal` is what a controller reads; this is what code with no
 * `Request` in scope (a repository, a query builder) reads instead, and
 * what the logger attaches to every log line for a tenant-scoped request as
 * `tenantId` (logger.service.ts).
 */
export interface TenantContext {
  tenantId: string
  tenantSlug: string
  role: MembershipRole
}

/**
 * Per-request data carried through `AsyncLocalStorage` for the lifetime of
 * one request. `tenant` is absent until (and unless) `resolveTenant` runs
 * and finds one — most requests (anything not under a tenant-scoped route)
 * never populate it.
 */
export interface RequestContext {
  requestId: string
  tenant?: TenantContext
}

/**
 * The store backing `requestContext` below. Exported so `logger.service.ts`
 * can read the current request's id without either module importing the
 * other's middleware/handler surface — and so tests can assert directly
 * against `getStore()`.
 */
export const requestContextStore = new AsyncLocalStorage<RequestContext>()

/**
 * Wrap the rest of the request in an AsyncLocalStorage context carrying the
 * request-id. Runs immediately after the requestId middleware in the chain.
 * @param request - The request (with `id` already set by requestId middleware).
 * @param _response - Unused.
 * @param next - Passes control into the ALS context.
 */
export function requestContext(request: Request, _response: Response, next: NextFunction): void {
  requestContextStore.run({ requestId: request.id }, next)
}
