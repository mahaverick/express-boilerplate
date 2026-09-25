// src/services/request-context.service.ts
//
// The AsyncLocalStorage store request-context.middleware.ts's
// requestContext function opens with .run(), and resolveTenant
// (tenant.middleware.ts) extends in place via .enterWith(). Moved out of
// the middleware so logger.service.ts (and any other non-middleware code)
// can read it without importing middlewares/** — see spec §1.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { MembershipRole } from '@/constants/tenant.constants'

/**
 * The tenant a request is scoped to, once `resolveTenant` has resolved one
 * — the same three fields `resolveTenant` also attaches to `request` as
 * `request.principal` (tenant.middleware.ts's `RequestPrincipal`).
 */
export interface TenantContext {
  tenantId: string
  tenantSlug: string
  role: MembershipRole
}

/**
 * Per-request data carried through `AsyncLocalStorage` for the lifetime of
 * one request. `tenant` is absent until (and unless) `resolveTenant` runs
 * and finds one.
 */
export interface RequestContext {
  requestId: string
  tenant?: TenantContext
}

/**
 * The store backing `requestContext` (request-context.middleware.ts).
 * Exported so `logger.service.ts` can read the current request's id
 * without importing a middleware, and so tests can assert directly
 * against `getStore()`.
 */
export const requestContextStore = new AsyncLocalStorage<RequestContext>()
